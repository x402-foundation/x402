"""Identity-based instruction classification for exact SVM Path 1 (V2).

Top-level instructions are classified by program ID + discriminator rather than
position, so wallet-injected guard instructions (Lighthouse) may appear anywhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from solders.instruction import CompiledInstruction
from solders.pubkey import Pubkey

from ..constants import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ERR_NO_TRANSFER_INSTRUCTION,
    ERR_PREFLIGHT_POSTFLIGHT_FEE_PAYER_NOT_ISOLATED,
    ERR_PROTOCOL_INSTRUCTION_ORDER,
    ERR_UNKNOWN_INSTRUCTION,
    LIGHTHOUSE_PROGRAM_ADDRESS,
    MEMO_PROGRAM_ADDRESS,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
)

_COMPUTE_BUDGET = Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS)
_TOKEN_PROGRAMS = (
    Pubkey.from_string(TOKEN_PROGRAM_ADDRESS),
    Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS),
)
_MEMO = Pubkey.from_string(MEMO_PROGRAM_ADDRESS)
_LIGHTHOUSE = Pubkey.from_string(LIGHTHOUSE_PROGRAM_ADDRESS)

_IX_SET_COMPUTE_UNIT_LIMIT = 2
_IX_SET_COMPUTE_UNIT_PRICE = 3
_IX_TOKEN_TRANSFER_CHECKED = 12


class InstructionRole(Enum):
    """An instruction's role; GUARD (currently only Lighthouse) may appear anywhere."""

    COMPUTE_LIMIT = "compute_limit"
    COMPUTE_PRICE = "compute_price"
    TRANSFER = "transfer"
    MEMO = "memo"
    GUARD = "guard"
    UNKNOWN = "unknown"


# Protocol roles, in the fixed relative order they must appear.
_PROTOCOL_ORDER = (
    InstructionRole.COMPUTE_LIMIT,
    InstructionRole.COMPUTE_PRICE,
    InstructionRole.TRANSFER,
    InstructionRole.MEMO,
)


class LayoutError(Exception):
    """Path 1's instruction layout was rejected; `reason` is the invalid reason."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _classify(static_accounts: list[Pubkey], ix: CompiledInstruction) -> InstructionRole:
    """Classify by program ID + discriminator (payload validity is checked elsewhere)."""
    program = static_accounts[ix.program_id_index]
    data = bytes(ix.data)
    discriminator = data[0] if data else None

    if program == _COMPUTE_BUDGET:
        if discriminator == _IX_SET_COMPUTE_UNIT_LIMIT:
            return InstructionRole.COMPUTE_LIMIT
        if discriminator == _IX_SET_COMPUTE_UNIT_PRICE:
            return InstructionRole.COMPUTE_PRICE
    elif program in _TOKEN_PROGRAMS:
        if len(data) >= 10 and discriminator == _IX_TOKEN_TRANSFER_CHECKED:
            return InstructionRole.TRANSFER
    elif program == _MEMO:
        return InstructionRole.MEMO
    elif program == _LIGHTHOUSE:
        return InstructionRole.GUARD
    return InstructionRole.UNKNOWN


@dataclass(frozen=True)
class PartitionedInstructions:
    """Protocol instructions found by identity. `memo_ix` is the first Memo and
    `memo_count` the total (only enforced when extra.memo is set)."""

    compute_limit_ix: CompiledInstruction
    compute_price_ix: CompiledInstruction
    transfer_ix: CompiledInstruction
    memo_ix: CompiledInstruction | None
    memo_count: int


@dataclass(frozen=True)
class InstructionIdentity:
    """An instruction identified by program address and a non-empty discriminator
    matched as a byte prefix of its data (an empty one never matches, so a whole
    program can't be allowlisted by accident)."""

    program_address: Pubkey
    discriminator: bytes


# An ordered block of instructions (guards aside) allowed before or after the
# protocol instructions.
InstructionTuple = list[InstructionIdentity]


def _match_tuple(
    static_accounts: list[Pubkey],
    instructions: list[CompiledInstruction],
    tuple_: InstructionTuple,
    from_end: bool,
) -> tuple[list[CompiledInstruction], list[CompiledInstruction]] | None:
    """Match `tuple_` against the front (or back) of `instructions`, skipping guards
    while scanning. Returns (matched incl. guards, rest), or None on no match."""
    if not tuple_:
        return None
    ordered = instructions[::-1] if from_end else instructions
    identities = tuple_[::-1] if from_end else tuple_
    consumed = matched = 0
    while matched < len(identities):
        if consumed >= len(ordered):
            return None
        ix = ordered[consumed]
        if _classify(static_accounts, ix) is not InstructionRole.GUARD:
            identity = identities[matched]
            if (
                not identity.discriminator
                or static_accounts[ix.program_id_index] != identity.program_address
                or not bytes(ix.data).startswith(identity.discriminator)
            ):
                return None
            matched += 1
        consumed += 1
    split = len(instructions) - consumed if from_end else consumed
    if from_end:
        return instructions[split:], instructions[:split]
    return instructions[:split], instructions[split:]


def _is_fee_payer_isolated(
    static_accounts: list[Pubkey],
    instructions: list[CompiledInstruction],
    fee_payer: Pubkey,
) -> bool:
    """Whether `fee_payer` appears in none of `instructions` (as program or account)."""
    for ix in instructions:
        # Account indexes past the static keys are lookup-table entries, which can
        # never hold the fee payer (a static signer).
        referenced = [static_accounts[ix.program_id_index]] + [
            static_accounts[i] for i in ix.accounts if i < len(static_accounts)
        ]
        if fee_payer in referenced:
            return False
    return True


def resolve_protocol_layout(
    static_accounts: list[Pubkey],
    instructions: list[CompiledInstruction],
    preflight: list[InstructionTuple],
    postflight: list[InstructionTuple],
    fee_payer: Pubkey,
) -> PartitionedInstructions:
    """Resolve the Path 1 layout.

    Strips a matched allowlisted preflight block from the front and postflight block
    from the back (each must be fee-payer-isolated, guards included, since it is
    operator-configured arbitrary code), then partitions the rest: protocol
    instructions (compute limit -> compute price -> transfer -> optional memo(s))
    must keep that relative order, guards may appear anywhere, and any other
    program, duplicate/out-of-order protocol instruction or missing transfer is rejected.

    Raises:
        LayoutError: with the invalid reason.
    """
    for tuples, from_end in ((preflight, False), (postflight, True)):
        for tuple_ in tuples:
            match = _match_tuple(static_accounts, instructions, tuple_, from_end)
            if match is None:
                continue
            block, instructions = match
            if not _is_fee_payer_isolated(static_accounts, block, fee_payer):
                raise LayoutError(ERR_PREFLIGHT_POSTFLIGHT_FEE_PAYER_NOT_ISOLATED)
            break

    found: dict[InstructionRole, CompiledInstruction] = {}
    memo_count = 0
    for ix in instructions:
        role = _classify(static_accounts, ix)
        if role is InstructionRole.GUARD:
            continue
        if role is InstructionRole.UNKNOWN:
            raise LayoutError(ERR_UNKNOWN_INSTRUCTION)
        if role is InstructionRole.MEMO and role in found:
            memo_count += 1
            continue
        if len(found) >= len(_PROTOCOL_ORDER) or role is not _PROTOCOL_ORDER[len(found)]:
            raise LayoutError(ERR_PROTOCOL_INSTRUCTION_ORDER)
        found[role] = ix
        if role is InstructionRole.MEMO:
            memo_count = 1

    if InstructionRole.TRANSFER not in found:
        raise LayoutError(ERR_NO_TRANSFER_INSTRUCTION)
    return PartitionedInstructions(
        compute_limit_ix=found[InstructionRole.COMPUTE_LIMIT],
        compute_price_ix=found[InstructionRole.COMPUTE_PRICE],
        transfer_ix=found[InstructionRole.TRANSFER],
        memo_ix=found.get(InstructionRole.MEMO),
        memo_count=memo_count,
    )
