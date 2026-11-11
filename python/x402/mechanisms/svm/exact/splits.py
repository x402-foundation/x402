"""Multi-payee splits for the exact scheme (scheme_exact_svm.md §5).

Shared by the client (transaction construction), the server (requirements
checks against the facilitator's advertisement) and the facilitator (Path 1
static verification).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

try:
    from solders.pubkey import Pubkey
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from ....schemas import PaymentRequirements
from ..constants import (
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    ERR_FEE_PAYER_NOT_ISOLATED,
    ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED,
    ERR_SPLIT_COUNT_EXCEEDED,
    ERR_SPLIT_REMAINDER_NOT_POSITIVE,
    ERR_SPLITS_INVALID,
    MAX_SPLIT_MEMO_BYTES,
    MAX_SPLITS,
    SVM_ADDRESS_REGEX,
    SYSTEM_PROGRAM_ADDRESS,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
)
from ..utils import derive_ata

U64_MAX = (1 << 64) - 1
_CANONICAL_AMOUNT = re.compile(r"[1-9][0-9]*")
IX_CREATE_IDEMPOTENT = 1

TOKEN_PROGRAMS = frozenset({TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS})


class SplitsError(ValueError):
    """A split rule violation, carrying the reason code a facilitator reports."""

    def __init__(self, reason: str, message: str | None = None):
        super().__init__(f"{reason}: {message}" if message else reason)
        self.reason = reason


@dataclass(frozen=True)
class PaymentLeg:
    """One payment leg: the primary remainder to ``payTo``, or one split."""

    owner: str
    amount: int
    is_primary: bool
    ata_creation_required: bool


@dataclass(frozen=True)
class SplitCapabilities:
    """Split capabilities a facilitator advertises in ``/supported`` ``kinds[].extra``.

    Both fail closed: absent means no support (§5.5).
    """

    max_splits: int = 0
    ata_creation_sponsored: bool = False


def is_valid_split_address(value: object) -> bool:
    """Whether value is a base58 string decoding to a 32-byte public key."""
    if not isinstance(value, str) or not re.fullmatch(SVM_ADDRESS_REGEX, value):
        return False
    try:
        return str(Pubkey.from_string(value)) == value
    except Exception:
        return False


def uses_split_terms(requirements: PaymentRequirements) -> bool:
    """Whether the requirements use the splits extension.

    True for a non-empty ``extra.splits`` or a primary marked
    ``extra.ataCreationRequired: true``.
    """
    extra = requirements.extra or {}
    splits = extra.get("splits")
    if splits is not None and not (isinstance(splits, list) and len(splits) == 0):
        return True
    return extra.get("ataCreationRequired") is True


def get_splits(requirements: PaymentRequirements) -> list[dict[str, Any]]:
    """Return the ``extra.splits`` entries, or an empty list when absent.

    Call only on requirements already validated by :func:`parse_payment_legs`.
    """
    splits = (requirements.extra or {}).get("splits")
    return list(splits) if isinstance(splits, list) else []


def _parse_amount(value: object, field_name: str) -> int:
    """Parse a canonical positive u64 decimal string."""
    if not isinstance(value, str) or not _CANONICAL_AMOUNT.fullmatch(value):
        raise SplitsError(ERR_SPLITS_INVALID, f"{field_name} must be a positive integer string")
    amount = int(value)
    if amount > U64_MAX:
        raise SplitsError(ERR_SPLITS_INVALID, f"{field_name} exceeds u64")
    return amount


def parse_payment_legs(requirements: PaymentRequirements) -> list[PaymentLeg]:
    """Validate ``extra.splits`` / ``extra.ataCreationRequired`` and return the legs.

    The primary remainder comes first, then one leg per split in order.

    Raises:
        SplitsError: When the requirements violate §5.1 or §5.2.
    """
    extra = requirements.extra or {}
    raw_splits = extra.get("splits")
    if raw_splits is None:
        raw_splits = []
    if not isinstance(raw_splits, list):
        raise SplitsError(ERR_SPLITS_INVALID, "extra.splits must be an array")
    if len(raw_splits) > MAX_SPLITS:
        raise SplitsError(ERR_SPLITS_INVALID, f"extra.splits allows at most {MAX_SPLITS}")
    primary_ata = extra.get("ataCreationRequired")
    if primary_ata is not None and not isinstance(primary_ata, bool):
        raise SplitsError(ERR_SPLITS_INVALID, "extra.ataCreationRequired must be a boolean")

    total = _parse_amount(requirements.amount, "amount")
    seen = {requirements.pay_to}
    split_legs: list[PaymentLeg] = []
    split_total = 0

    for i, raw in enumerate(raw_splits):
        name = f"extra.splits[{i}]"
        if not isinstance(raw, dict):
            raise SplitsError(ERR_SPLITS_INVALID, f"{name} must be an object")
        pay_to = raw.get("payTo")
        if not isinstance(pay_to, str) or not is_valid_split_address(pay_to):
            raise SplitsError(ERR_SPLITS_INVALID, f"{name}.payTo is not a valid address")
        if pay_to in seen:
            raise SplitsError(ERR_SPLITS_INVALID, f"{name}.payTo duplicates another recipient")
        seen.add(pay_to)
        amount = _parse_amount(raw.get("amount"), f"{name}.amount")
        memo = raw.get("memo")
        if memo is not None:
            if not isinstance(memo, str):
                raise SplitsError(ERR_SPLITS_INVALID, f"{name}.memo must be a string")
            if len(memo.encode("utf-8")) > MAX_SPLIT_MEMO_BYTES:
                raise SplitsError(
                    ERR_SPLITS_INVALID, f"{name}.memo exceeds {MAX_SPLIT_MEMO_BYTES} bytes"
                )
        ata_required = raw.get("ataCreationRequired")
        if ata_required is not None and not isinstance(ata_required, bool):
            raise SplitsError(ERR_SPLITS_INVALID, f"{name}.ataCreationRequired must be a boolean")
        split_total += amount
        split_legs.append(
            PaymentLeg(
                owner=pay_to,
                amount=amount,
                is_primary=False,
                ata_creation_required=ata_required is True,
            )
        )

    if split_total >= total:
        raise SplitsError(ERR_SPLIT_REMAINDER_NOT_POSITIVE)

    primary = PaymentLeg(
        owner=requirements.pay_to,
        amount=total - split_total,
        is_primary=True,
        ata_creation_required=primary_ata is True,
    )
    return [primary, *split_legs]


def get_split_capabilities(extra: Mapping[str, Any] | None) -> SplitCapabilities:
    """Read the split capabilities from a ``/supported`` kind's ``extra``.

    Non-int (bools are not ints here) or absent ``maxSplits`` reads as 0, and
    anything but ``ataCreationSponsored: true`` reads as False.
    """
    extra = extra or {}
    max_splits = extra.get("maxSplits")
    if not isinstance(max_splits, int) or isinstance(max_splits, bool) or max_splits < 0:
        max_splits = 0
    return SplitCapabilities(
        max_splits=min(max_splits, MAX_SPLITS),
        ata_creation_sponsored=extra.get("ataCreationSponsored") is True,
    )


def assert_within_capabilities(legs: Sequence[PaymentLeg], capabilities: SplitCapabilities) -> None:
    """Check parsed legs against advertised capabilities.

    Raises:
        SplitsError: When the legs exceed the capabilities.
    """
    split_count = len(legs) - 1
    if split_count > capabilities.max_splits:
        raise SplitsError(
            ERR_SPLIT_COUNT_EXCEEDED,
            f"{split_count} splits, facilitator accepts {capabilities.max_splits}",
        )
    if not capabilities.ata_creation_sponsored and any(leg.ata_creation_required for leg in legs):
        raise SplitsError(
            ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED,
            "a recipient is marked ataCreationRequired but the facilitator does not "
            "sponsor ATA creation",
        )


@dataclass(frozen=True)
class InstructionView:
    """A top-level instruction with its program and accounts resolved to addresses."""

    program: str
    accounts: list[str] = field(default_factory=list)
    data: bytes = b""


def is_ata_program_instruction(ix: InstructionView) -> bool:
    """Whether an instruction targets the Associated Token Account program."""
    return ix.program == ASSOCIATED_TOKEN_PROGRAM_ADDRESS


def validate_ata_creation(
    ix: InstructionView,
    *,
    asset: str,
    fee_payer: str,
    marked_owners: set[str] | frozenset[str],
    created_owners: set[str],
    token_program: str | None = None,
) -> str:
    """Validate an ATA-program instruction against §5.4 and §2.1.1.

    It must be a ``CreateIdempotent`` funded by the fee payer that creates the
    ATA, for the asset, of a recipient marked ``ataCreationRequired``, at most
    once per owner. ``created_owners`` is updated.

    Returns:
        The owner of the created ATA.

    Raises:
        SplitsError: When the instruction is not an authorized creation.
    """

    def reject(detail: str) -> SplitsError:
        return SplitsError(ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED, detail)

    if ix.data != bytes([IX_CREATE_IDEMPOTENT]):
        raise reject("ATA program instruction is not CreateIdempotent")
    if len(ix.accounts) != 6:
        raise reject("CreateIdempotent must have exactly 6 accounts")
    payer, ata, owner, mint, system_program, ix_token_program = ix.accounts
    if payer != fee_payer:
        raise reject("CreateIdempotent must be funded by the fee payer")
    if owner not in marked_owners:
        raise reject(f"owner {owner} is not a recipient marked ataCreationRequired")
    if owner in created_owners:
        raise reject(f"duplicate CreateIdempotent for owner {owner}")
    if mint != asset:
        raise reject("CreateIdempotent mint does not match asset")
    if system_program != SYSTEM_PROGRAM_ADDRESS or ix_token_program not in TOKEN_PROGRAMS:
        raise reject("CreateIdempotent has unexpected program accounts")
    if token_program and ix_token_program != token_program:
        raise reject("CreateIdempotent token program differs from the transfers'")
    if ata != derive_ata(owner, asset, ix_token_program):
        raise reject("CreateIdempotent account is not the owner's ATA")
    created_owners.add(owner)
    return owner


def assert_fee_payer_isolated_with_ata_creation(
    instructions: Sequence[InstructionView],
    fee_payer: str,
    *,
    asset: str,
    marked_owners: set[str] | frozenset[str],
    token_program: str | None = None,
) -> set[str]:
    """Fee payer isolation with the bounded §2.1.1 ``CreateIdempotent`` exception.

    Inside a validated ``CreateIdempotent`` the fee payer may be the funding
    payer (account 0) and, when it is itself a recipient, the wallet owner
    (account 2). It must not appear anywhere else or be invoked as a program.
    Every ATA-program instruction is validated by :func:`validate_ata_creation`.

    Returns:
        The owners whose ATAs the transaction creates.

    Raises:
        SplitsError: When isolation is violated or a creation is unauthorized.
    """
    created_owners: set[str] = set()
    for ix in instructions:
        if ix.program == fee_payer:
            raise SplitsError(
                ERR_FEE_PAYER_NOT_ISOLATED, f"fee payer {fee_payer} invoked as program"
            )
        if is_ata_program_instruction(ix):
            validate_ata_creation(
                ix,
                asset=asset,
                fee_payer=fee_payer,
                marked_owners=marked_owners,
                created_owners=created_owners,
                token_program=token_program,
            )
            # Account 0 is the fee payer by construction; account 2 may be the
            # fee payer only as a marked recipient's owner. Accounts 1, 3, 4, 5
            # are the ATA, mint and programs, none of which can be the fee payer.
            continue
        if fee_payer in ix.accounts:
            raise SplitsError(
                ERR_FEE_PAYER_NOT_ISOLATED,
                f"fee payer {fee_payer} appears in instruction accounts (program: {ix.program})",
            )
    return created_owners
