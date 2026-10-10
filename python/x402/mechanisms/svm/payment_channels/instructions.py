"""Solders builders matching the canonical payment-channels IDL."""

import struct
from collections.abc import Sequence

from solders.instruction import AccountMeta, Instruction
from solders.pubkey import Pubkey
from solders.signature import Signature

from .codec import (
    checked_int,
    encode_splits,
    encode_voucher_message,
    find_ata,
    find_event_authority_pda,
    find_payment_channel_pda,
)
from .constants import (
    ASSOCIATED_TOKEN_PROGRAM_ID,
    DISTRIBUTE_DISCRIMINATOR,
    ED25519_PROGRAM_ADDRESS,
    INSTRUCTIONS_SYSVAR_ADDRESS,
    OPEN_DISCRIMINATOR,
    PAYMENT_CHANNELS_PROGRAM_ID,
    RECLAIM_DISCRIMINATOR,
    RENT_SYSVAR_ADDRESS,
    REQUEST_CLOSE_DISCRIMINATOR,
    SEAL_DISCRIMINATOR,
    SETTLE_AND_SEAL_DISCRIMINATOR,
    SETTLE_DISCRIMINATOR,
    SYSTEM_PROGRAM_ID,
    TOP_UP_DISCRIMINATOR,
    WITHDRAW_PAYER_DISCRIMINATOR,
    get_payment_channels_treasury_owner,
)
from .types import ChannelSplit, SettleVoucher


def _meta(address: str, *, writable: bool = False, signer: bool = False) -> AccountMeta:
    return AccountMeta(Pubkey.from_string(address), signer, writable)


def _instruction(program_id: str, data: bytes, accounts: Sequence[AccountMeta]) -> Instruction:
    return Instruction(Pubkey.from_string(program_id), data, list(accounts))


def build_open_instruction(
    *,
    payer: str,
    rent_payer: str,
    payee: str,
    mint: str,
    authorized_signer: str,
    token_program: str,
    deposit: int,
    salt: int,
    open_slot: int,
    grace_period: int,
    recipients: Sequence[ChannelSplit] = (),
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> Instruction:
    channel = find_payment_channel_pda(
        payer=payer,
        payee=payee,
        mint=mint,
        authorized_signer=authorized_signer,
        salt=salt,
        open_slot=open_slot,
        program_id=program_id,
    )
    if deposit <= 0:
        raise ValueError("deposit must be positive")
    data = (
        bytes([OPEN_DISCRIMINATOR])
        + struct.pack(
            "<QQIQ",
            checked_int(salt, 64, "salt"),
            checked_int(deposit, 64, "deposit"),
            checked_int(grace_period, 32, "grace_period"),
            checked_int(open_slot, 64, "open_slot"),
        )
        + encode_splits(recipients)
    )
    return _instruction(
        program_id,
        data,
        [
            _meta(payer, writable=True, signer=True),
            _meta(rent_payer, writable=True, signer=True),
            _meta(payee),
            _meta(mint),
            _meta(authorized_signer),
            _meta(channel, writable=True),
            _meta(find_ata(payer, mint, token_program), writable=True),
            _meta(find_ata(channel, mint, token_program), writable=True),
            _meta(token_program),
            _meta(SYSTEM_PROGRAM_ID),
            _meta(RENT_SYSVAR_ADDRESS),
            _meta(ASSOCIATED_TOKEN_PROGRAM_ID),
            _meta(find_event_authority_pda(program_id)),
            _meta(program_id),
        ],
    )


def build_top_up_instruction(
    *,
    payer: str,
    channel_id: str,
    mint: str,
    token_program: str,
    amount: int,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> Instruction:
    if amount <= 0:
        raise ValueError("top-up amount must be positive")
    return _instruction(
        program_id,
        bytes([TOP_UP_DISCRIMINATOR]) + struct.pack("<Q", checked_int(amount, 64, "amount")),
        [
            _meta(payer, writable=True, signer=True),
            _meta(channel_id, writable=True),
            _meta(find_ata(payer, mint, token_program), writable=True),
            _meta(find_ata(channel_id, mint, token_program), writable=True),
            _meta(mint),
            _meta(token_program),
        ],
    )


def build_request_close_instruction(
    *,
    payer: str,
    channel_id: str,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> Instruction:
    return _instruction(
        program_id,
        bytes([REQUEST_CLOSE_DISCRIMINATOR]),
        [_meta(payer, signer=True), _meta(channel_id, writable=True)],
    )


def build_ed25519_verify_instruction(
    message: bytes, signature: bytes, signer: bytes
) -> Instruction:
    if len(signer) != 32 or len(signature) != 64:
        raise ValueError("Ed25519 signer must be 32 bytes and signature must be 64 bytes")
    if len(message) > 0xFFFF:
        raise ValueError("Ed25519 message exceeds 65535 bytes")
    header = struct.pack("<BB7H", 1, 0, 48, 0xFFFF, 16, 0xFFFF, 112, len(message), 0xFFFF)
    return _instruction(ED25519_PROGRAM_ADDRESS, header + signer + signature + message, [])


def _voucher_instruction(channel_id: str, voucher: SettleVoucher) -> Instruction:
    return build_ed25519_verify_instruction(
        encode_voucher_message(channel_id, voucher.cumulative_amount, voucher.expires_at),
        bytes(Signature.from_string(voucher.signature_base58)),
        bytes(Pubkey.from_string(voucher.authorized_signer)),
    )


def build_settle_instructions(
    channel_id: str,
    voucher: SettleVoucher,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> list[Instruction]:
    return [
        _voucher_instruction(channel_id, voucher),
        _instruction(
            program_id,
            bytes([SETTLE_DISCRIMINATOR]),
            [_meta(channel_id, writable=True), _meta(INSTRUCTIONS_SYSVAR_ADDRESS)],
        ),
    ]


def build_settle_and_seal_instructions(
    channel_id: str,
    payee: str,
    voucher: SettleVoucher | None = None,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> list[Instruction]:
    instructions = [_voucher_instruction(channel_id, voucher)] if voucher else []
    instructions.append(
        _instruction(
            program_id,
            bytes([SETTLE_AND_SEAL_DISCRIMINATOR, int(voucher is not None)]),
            [
                _meta(payee, signer=True),
                _meta(channel_id, writable=True),
                _meta(INSTRUCTIONS_SYSVAR_ADDRESS),
            ],
        )
    )
    return instructions


def build_seal_instruction(
    channel_id: str,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> Instruction:
    return _instruction(program_id, bytes([SEAL_DISCRIMINATOR]), [_meta(channel_id, writable=True)])


def build_distribute_instruction(
    *,
    channel_id: str,
    payee: str,
    payer: str,
    rent_payer: str,
    mint: str,
    token_program: str,
    splits: Sequence[ChannelSplit],
    network: str,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> Instruction:
    return _instruction(
        program_id,
        bytes([DISTRIBUTE_DISCRIMINATOR]) + encode_splits(splits),
        [
            _meta(channel_id, writable=True),
            _meta(payer, writable=True),
            _meta(rent_payer, writable=True),
            _meta(find_ata(channel_id, mint, token_program), writable=True),
            _meta(find_ata(payer, mint, token_program), writable=True),
            _meta(find_ata(payee, mint, token_program), writable=True),
            _meta(
                find_ata(get_payment_channels_treasury_owner(network), mint, token_program),
                writable=True,
            ),
            _meta(mint),
            _meta(token_program),
            _meta(find_event_authority_pda(program_id)),
            _meta(program_id),
            *[
                _meta(find_ata(split.recipient, mint, token_program), writable=True)
                for split in splits
            ],
        ],
    )


def build_withdraw_payer_instruction(
    *,
    channel_id: str,
    payer: str,
    mint: str,
    token_program: str,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> Instruction:
    return _instruction(
        program_id,
        bytes([WITHDRAW_PAYER_DISCRIMINATOR]),
        [
            _meta(payer, signer=True),
            _meta(channel_id, writable=True),
            _meta(find_ata(channel_id, mint, token_program), writable=True),
            _meta(find_ata(payer, mint, token_program), writable=True),
            _meta(mint),
            _meta(token_program),
        ],
    )


def build_reclaim_instruction(
    channel_id: str,
    rent_payer: str,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> Instruction:
    return _instruction(
        program_id,
        bytes([RECLAIM_DISCRIMINATOR]),
        [_meta(channel_id, writable=True), _meta(rent_payer, writable=True)],
    )
