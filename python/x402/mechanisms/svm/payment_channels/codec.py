"""Canonical account, PDA, distribution, and Ed25519 voucher encoding."""

import hashlib
import struct
from collections.abc import Sequence
from functools import lru_cache

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature

from .constants import (
    ASSOCIATED_TOKEN_PROGRAM_ID,
    BASIS_POINTS_DENOMINATOR,
    CHANNEL_ACCOUNT_SIZE,
    CHANNEL_DISCRIMINATOR,
    CHANNEL_VERSION,
    PAYMENT_CHANNELS_PROGRAM_ID,
    VOUCHER_MAGIC,
)
from .types import Channel, ChannelSplit, ChannelStatus, MessageSigner


def checked_int(value: int, bits: int, name: str, *, signed: bool = False) -> int:
    lower = -(1 << (bits - 1)) if signed else 0
    upper = (1 << (bits - int(signed))) - 1
    if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= upper:
        raise ValueError(
            f"{name} must be a {'signed' if signed else 'unsigned'} {bits}-bit integer"
        )
    return value


def decode_channel_account(data: bytes) -> Channel:
    """Reject unsupported layouts instead of decoding misleading account state."""
    if len(data) != CHANNEL_ACCOUNT_SIZE:
        raise ValueError(f"channel account must be {CHANNEL_ACCOUNT_SIZE} bytes")
    if data[0] != CHANNEL_DISCRIMINATOR or data[1] != CHANNEL_VERSION:
        raise ValueError("unsupported channel account discriminator or version")
    salt, deposit, settled, payout, closing, withdrawn, grace = struct.unpack_from(
        "<QQQQqqI", data, 4
    )
    return Channel(
        payer=str(Pubkey.from_bytes(data[88:120])),
        payee=str(Pubkey.from_bytes(data[120:152])),
        authorized_signer=str(Pubkey.from_bytes(data[152:184])),
        mint=str(Pubkey.from_bytes(data[184:216])),
        rent_payer=str(Pubkey.from_bytes(data[216:248])),
        salt=salt,
        open_slot=struct.unpack_from("<Q", data, 248)[0],
        deposit=deposit,
        settled=settled,
        payout_watermark=payout,
        grace_period=grace,
        distribution_hash=data[56:88],
        status=ChannelStatus(data[3]),
        closure_started_at=closing,
        payer_withdrawn_at=withdrawn,
        version=data[1],
        bump=data[2],
    )


def find_payment_channel_pda(
    *,
    payer: str,
    payee: str,
    mint: str,
    authorized_signer: str,
    salt: int,
    open_slot: int,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> str:
    seeds = (
        b"channel",
        bytes(Pubkey.from_string(payer)),
        bytes(Pubkey.from_string(payee)),
        bytes(Pubkey.from_string(mint)),
        bytes(Pubkey.from_string(authorized_signer)),
        struct.pack("<Q", checked_int(salt, 64, "salt")),
        struct.pack("<Q", checked_int(open_slot, 64, "open_slot")),
    )
    return _find_pda(seeds, program_id)


@lru_cache(maxsize=4096)
def _find_pda(seeds: tuple[bytes, ...], program_id: str) -> str:
    return str(Pubkey.find_program_address(seeds, Pubkey.from_string(program_id))[0])


def find_event_authority_pda(program_id: str = PAYMENT_CHANNELS_PROGRAM_ID) -> str:
    return _find_pda((b"event_authority",), program_id)


def find_ata(owner: str, mint: str, token_program: str) -> str:
    return _find_pda(
        tuple(bytes(Pubkey.from_string(key)) for key in (owner, token_program, mint)),
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )


def encode_splits(splits: Sequence[ChannelSplit]) -> bytes:
    data = bytearray(struct.pack("<I", len(splits)))
    total = 0
    seen: set[str] = set()
    for split in splits:
        bps = checked_int(split.bps, 16, "bps")
        if bps == 0 or split.recipient in seen:
            raise ValueError("distribution recipients must be unique with positive shares")
        total += bps
        seen.add(split.recipient)
        data.extend(bytes(Pubkey.from_string(split.recipient)))
        data.extend(struct.pack("<H", bps))
    if total > BASIS_POINTS_DENOMINATOR:
        raise ValueError("distribution shares exceed 10000 basis points")
    return bytes(data)


def distribution_hash(splits: Sequence[ChannelSplit]) -> bytes:
    return hashlib.sha256(encode_splits(splits)).digest()


def encode_voucher_message(channel_id: str, cumulative_amount: int, expires_at: int = 0) -> bytes:
    return (
        VOUCHER_MAGIC
        + bytes(Pubkey.from_string(channel_id))
        + struct.pack(
            "<Qq",
            checked_int(cumulative_amount, 64, "cumulative_amount"),
            checked_int(expires_at, 64, "expires_at", signed=True),
        )
    )


def signer_address(signer: MessageSigner | Keypair) -> str:
    return str(signer.pubkey()) if isinstance(signer, Keypair) else signer.address


def sign_message(signer: MessageSigner | Keypair, message: bytes) -> Signature:
    """Accept keypairs, existing KeypairSigner wrappers, and wallet message signers."""
    provider = getattr(signer, "keypair", signer)
    signature = provider.sign_message(message)
    if isinstance(signature, str):
        signature = Signature.from_string(signature)
    elif not isinstance(signature, Signature):
        signature = Signature.from_bytes(bytes(signature))
    if not signature.verify(Pubkey.from_string(signer_address(signer)), message):
        raise ValueError("signer returned an invalid signature")
    return signature


def sign_voucher(
    signer: MessageSigner | Keypair,
    channel_id: str,
    cumulative_amount: int,
    expires_at: int = 0,
) -> str:
    return str(
        sign_message(signer, encode_voucher_message(channel_id, cumulative_amount, expires_at))
    )


def verify_voucher(
    signature: str,
    authorized_signer: str,
    channel_id: str,
    cumulative_amount: int,
    expires_at: int = 0,
) -> bool:
    try:
        return Signature.from_string(signature).verify(
            Pubkey.from_string(authorized_signer),
            encode_voucher_message(channel_id, cumulative_amount, expires_at),
        )
    except (ValueError, TypeError):
        return False
