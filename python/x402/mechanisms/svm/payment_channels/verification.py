"""Static sponsor validation before signing any client-supplied transaction."""

import base64
import re
import struct
from typing import Any

from solders.instruction import Instruction
from solders.message import to_bytes_versioned
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from ..constants import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    LIGHTHOUSE_PROGRAM_ADDRESS,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MAX_MEMO_BYTES,
    MEMO_PROGRAM_ADDRESS,
)
from .constants import MAX_TRANSACTION_BYTES, OPEN_MAX_COMPUTE_UNIT_LIMIT, OPEN_SLOT_WINDOW
from .instructions import (
    build_open_instruction,
    build_request_close_instruction,
    build_top_up_instruction,
)
from .types import ChannelSplit

_BINDING_PREFIX = b"x402:batch-settlement:svm:rcvauth:v1:"


def _writable(message: Any, index: int) -> bool:
    header = message.header
    if index < header.num_required_signatures:
        return index < header.num_required_signatures - header.num_readonly_signed_accounts
    return index < len(message.account_keys) - header.num_readonly_unsigned_accounts


def verify_transaction_envelope(
    transaction: str,
    *,
    expected_instruction: Instruction,
    payer: str,
    fee_payer: str,
    memo: str | None = None,
    binding_memo: str | None = None,
    require_memo: bool = True,
    max_compute_units: int = OPEN_MAX_COMPUTE_UNIT_LIMIT,
    max_priority_fee: int = MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    max_required_signatures: int = 2,
) -> VersionedTransaction:
    """Check the whole message, including compiled privilege unions and suffixes."""
    wire = base64.b64decode(transaction, validate=True)
    if len(wire) > MAX_TRANSACTION_BYTES:
        raise ValueError("transaction exceeds Solana packet limit")
    decoded = VersionedTransaction.from_bytes(wire)
    decoded.sanitize()
    if bytes(decoded) != wire:
        raise ValueError("noncanonical or trailing transaction bytes")
    message = decoded.message
    keys = [str(key) for key in message.account_keys]
    if getattr(message, "address_table_lookups", []):
        raise ValueError("address lookup tables are not permitted")
    required_count = message.header.num_required_signatures
    if (
        payer == fee_payer
        or keys[0] != fee_payer
        or required_count != 2
        or required_count > max_required_signatures
        or set(keys[:required_count]) != {payer, fee_payer}
    ):
        raise ValueError("required signers must be payer and sponsor, with sponsor as fee payer")
    if not decoded.signatures[keys.index(payer)].verify(
        Pubkey.from_string(payer), to_bytes_versioned(message)
    ):
        raise ValueError("invalid payer signature")

    index, seen_limit, seen_price = 0, False, False
    max_units = min(max_compute_units, OPEN_MAX_COMPUTE_UNIT_LIMIT)
    max_price = min(max_priority_fee, MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS)
    instructions = message.instructions
    while (
        index < len(instructions)
        and keys[instructions[index].program_id_index] == COMPUTE_BUDGET_PROGRAM_ADDRESS
    ):
        ix = instructions[index]
        data = bytes(ix.data)
        if ix.accounts:
            raise ValueError("compute budget instruction must have no accounts")
        if data[:1] == b"\x02" and len(data) == 5 and not seen_limit and not seen_price:
            if struct.unpack_from("<I", data, 1)[0] > max_units:
                raise ValueError("compute unit limit exceeds sponsor cap")
            seen_limit = True
        elif data[:1] == b"\x03" and len(data) == 9 and not seen_price:
            if struct.unpack_from("<Q", data, 1)[0] > max_price:
                raise ValueError("compute unit price exceeds sponsor cap")
            seen_price = True
        else:
            raise ValueError("invalid compute budget prefix")
        index += 1
    if index >= len(instructions):
        raise ValueError("missing payment-channel instruction")
    setup = instructions[index]
    if (
        keys[setup.program_id_index] != str(expected_instruction.program_id)
        or bytes(setup.data) != expected_instruction.data
        or [keys[i] for i in setup.accounts]
        != [str(a.pubkey) for a in expected_instruction.accounts]
    ):
        raise ValueError("payment-channel instruction differs from canonical data or accounts")

    # Compiler deduplication permits only the privileges already required by the canonical roles.
    roles: dict[str, tuple[bool, bool]] = {fee_payer: (True, True)}
    for account in expected_instruction.accounts:
        key = str(account.pubkey)
        old_signer, old_writable = roles.get(key, (False, False))
        roles[key] = old_signer or account.is_signer, old_writable or account.is_writable
    for i, key in enumerate(keys):
        if (i < required_count, _writable(message, i)) != roles.get(key, (False, False)):
            raise ValueError("unexpected compiled account privileges")

    memos, lighthouse_count = [], 0
    for ix in instructions[index + 1 :]:
        program = keys[ix.program_id_index]
        if program == fee_payer or any(keys[i] == fee_payer for i in ix.accounts):
            raise ValueError("sponsor cannot appear in suffix accounts")
        if program == LIGHTHOUSE_PROGRAM_ADDRESS:
            lighthouse_count += 1
            if lighthouse_count > 3:
                raise ValueError("too many Lighthouse instructions")
        elif program == MEMO_PROGRAM_ADDRESS:
            data = bytes(ix.data)
            if len(data) > MAX_MEMO_BYTES:
                raise ValueError("memo exceeds byte limit")
            memos.append(data)
        else:
            raise ValueError("unexpected program after payment-channel instruction")
    if binding_memo is not None:
        bindings = [data for data in memos if data.startswith(_BINDING_PREFIX)]
        if bindings != [binding_memo.encode("utf-8")]:
            raise ValueError("open must have exactly one matching receiver binding memo")
        memos = [data for data in memos if not data.startswith(_BINDING_PREFIX)]
    if len(memos) != int(require_memo) and not (not require_memo and len(memos) == 1):
        raise ValueError("incorrect memo count")
    if memos:
        if memo is not None:
            if memos[0] != memo.encode("utf-8"):
                raise ValueError("memo differs from advertised memo")
        elif require_memo and re.fullmatch(rb"[0-9a-fA-F]{32,}", memos[0]) is None:
            raise ValueError("nonce memo must contain at least 16 hexadecimal bytes")
    return decoded


def verify_open_transaction(
    transaction: str,
    *,
    channel_config: dict[str, Any],
    fee_payer: str,
    token_program: str,
    deposit: int,
    memo: str | None = None,
    current_slot: int | None = None,
    **limits: Any,
) -> VersionedTransaction:
    config = channel_config
    if config["payerAuthorizer"] == fee_payer:
        raise ValueError("sponsor cannot be voucher authorizer")
    slot = config["openSlot"]
    if current_slot is not None and not slot <= current_slot <= slot + OPEN_SLOT_WINDOW:
        raise ValueError("open slot outside freshness window")
    expected = build_open_instruction(
        payer=config["payer"],
        rent_payer=fee_payer,
        payee=fee_payer,
        mint=config["token"],
        authorized_signer=config["payerAuthorizer"],
        token_program=token_program,
        deposit=deposit,
        salt=int(config["salt"]),
        open_slot=slot,
        grace_period=config["withdrawDelay"],
        recipients=[ChannelSplit(config["receiver"], 10_000)],
    )
    if [i for i, a in enumerate(expected.accounts) if str(a.pubkey) == fee_payer] != [1, 2]:
        raise ValueError("sponsor may occupy only canonical rent-payer and payee roles")
    return verify_transaction_envelope(
        transaction,
        expected_instruction=expected,
        payer=config["payer"],
        fee_payer=fee_payer,
        memo=memo,
        binding_memo=(_BINDING_PREFIX.decode() + config["receiverAuthorizer"]),
        **limits,
    )


def verify_top_up_transaction(
    transaction: str,
    *,
    channel_id: str,
    channel_config: dict[str, Any],
    fee_payer: str,
    token_program: str,
    amount: int,
    memo: str | None = None,
    **limits: Any,
) -> VersionedTransaction:
    expected = build_top_up_instruction(
        payer=channel_config["payer"],
        channel_id=channel_id,
        mint=channel_config["token"],
        token_program=token_program,
        amount=amount,
    )
    if any(str(a.pubkey) == fee_payer for a in expected.accounts):
        raise ValueError("sponsor must not be a top-up instruction account")
    return verify_transaction_envelope(
        transaction,
        expected_instruction=expected,
        payer=channel_config["payer"],
        fee_payer=fee_payer,
        memo=memo,
        **limits,
    )


def verify_request_close_transaction(
    transaction: str,
    *,
    payer: str,
    channel_id: str,
    fee_payer: str,
    memo: str | None = None,
    **limits: Any,
) -> VersionedTransaction:
    return verify_transaction_envelope(
        transaction,
        expected_instruction=build_request_close_instruction(payer=payer, channel_id=channel_id),
        payer=payer,
        fee_payer=fee_payer,
        memo=memo,
        require_memo=False,
        **limits,
    )
