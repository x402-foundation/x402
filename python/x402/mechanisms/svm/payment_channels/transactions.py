"""Build partially signed v0 transactions without address lookup tables."""

import base64
import secrets
from collections.abc import Sequence

from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.message import MessageV0, to_bytes_versioned
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from ..constants import MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS, MAX_MEMO_BYTES, MEMO_PROGRAM_ADDRESS
from .codec import checked_int, sign_message, signer_address
from .constants import (
    MAX_TRANSACTION_BYTES,
    OPEN_DEFAULT_COMPUTE_UNIT_LIMIT,
    OPEN_MAX_COMPUTE_UNIT_LIMIT,
    PAYMENT_CHANNELS_PROGRAM_ID,
)
from .instructions import (
    build_open_instruction,
    build_request_close_instruction,
    build_top_up_instruction,
)
from .types import ChannelSplit, MessageSigner


def compile_transaction(
    instructions: Sequence[Instruction],
    *,
    fee_payer: str,
    blockhash: str,
    signers: Sequence[MessageSigner | Keypair] = (),
) -> VersionedTransaction:
    message = MessageV0.try_compile(
        Pubkey.from_string(fee_payer), list(instructions), [], Hash.from_string(blockhash)
    )
    required = list(message.account_keys[: message.header.num_required_signatures])
    signatures = [Signature.default() for _ in required]
    data = to_bytes_versioned(message)
    for signer in signers:
        key = Pubkey.from_string(signer_address(signer))
        if key not in required:
            raise ValueError("signer is not required by this transaction")
        signatures[required.index(key)] = sign_message(signer, data)
    transaction = VersionedTransaction.populate(message, signatures)
    if len(bytes(transaction)) > MAX_TRANSACTION_BYTES:
        raise ValueError(f"transaction exceeds the {MAX_TRANSACTION_BYTES}-byte packet limit")
    return transaction


def _compute_instructions(limit: int, price: int) -> list[Instruction]:
    checked_int(limit, 32, "compute_unit_limit")
    checked_int(price, 64, "compute_unit_price")
    if limit > OPEN_MAX_COMPUTE_UNIT_LIMIT or price > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS:
        raise ValueError("compute budget exceeds sponsor caps")
    return ([set_compute_unit_limit(limit)] if limit else []) + (
        [set_compute_unit_price(price)] if price else []
    )


def _memo_instruction(memo: str | None) -> Instruction:
    data = (secrets.token_hex(16) if memo is None else memo).encode("utf-8")
    if len(data) > MAX_MEMO_BYTES:
        raise ValueError(f"memo exceeds {MAX_MEMO_BYTES} bytes")
    return Instruction(Pubkey.from_string(MEMO_PROGRAM_ADDRESS), data, [])


def build_open_transaction(
    *,
    payer: MessageSigner | Keypair,
    fee_payer: str,
    payee: str,
    mint: str,
    authorized_signer: str,
    token_program: str,
    deposit: int,
    salt: int,
    open_slot: int,
    grace_period: int,
    blockhash: str,
    recipients: Sequence[ChannelSplit] = (),
    memo: str | None = None,
    binding_memo: str | None = None,
    compute_unit_limit: int = OPEN_DEFAULT_COMPUTE_UNIT_LIMIT,
    compute_unit_price: int = 1,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> str:
    instruction = build_open_instruction(
        payer=signer_address(payer),
        rent_payer=fee_payer,
        payee=payee,
        mint=mint,
        authorized_signer=authorized_signer,
        token_program=token_program,
        deposit=deposit,
        salt=salt,
        open_slot=open_slot,
        grace_period=grace_period,
        recipients=recipients,
        program_id=program_id,
    )
    instructions = [
        *_compute_instructions(compute_unit_limit, compute_unit_price),
        instruction,
        _memo_instruction(memo),
    ]
    if binding_memo is not None:
        instructions.append(_memo_instruction(binding_memo))
    return base64.b64encode(
        bytes(
            compile_transaction(
                instructions,
                fee_payer=fee_payer,
                blockhash=blockhash,
                signers=[payer],
            )
        )
    ).decode()


def build_top_up_transaction(
    *,
    payer: MessageSigner | Keypair,
    channel_id: str,
    mint: str,
    token_program: str,
    fee_payer: str,
    amount: int,
    blockhash: str,
    memo: str | None = None,
    compute_unit_limit: int = OPEN_DEFAULT_COMPUTE_UNIT_LIMIT,
    compute_unit_price: int = 1,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> str:
    instruction = build_top_up_instruction(
        payer=signer_address(payer),
        channel_id=channel_id,
        mint=mint,
        token_program=token_program,
        amount=amount,
        program_id=program_id,
    )
    return base64.b64encode(
        bytes(
            compile_transaction(
                [
                    *_compute_instructions(compute_unit_limit, compute_unit_price),
                    instruction,
                    _memo_instruction(memo),
                ],
                fee_payer=fee_payer,
                blockhash=blockhash,
                signers=[payer],
            )
        )
    ).decode()


def build_request_close_transaction(
    *,
    payer: MessageSigner | Keypair,
    channel_id: str,
    fee_payer: str,
    blockhash: str,
    memo: str | None = None,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> str:
    return base64.b64encode(
        bytes(
            compile_transaction(
                [
                    build_request_close_instruction(
                        payer=signer_address(payer), channel_id=channel_id, program_id=program_id
                    ),
                    _memo_instruction(memo),
                ],
                fee_payer=fee_payer,
                blockhash=blockhash,
                signers=[payer],
            )
        )
    ).decode()
