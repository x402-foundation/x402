"""Tests for ERC-6492 unwrapping in onchain calldata builders."""

from __future__ import annotations

from eth_abi import encode
from eth_utils import to_checksum_address

from x402.mechanisms.evm.constants import ERC6492_MAGIC_VALUE
from x402.mechanisms.evm.exact.permit2_utils import _build_permit2_settle_args
from x402.mechanisms.evm.types import (
    ExactPermit2Authorization,
    ExactPermit2Payload,
    ExactPermit2TokenPermissions,
    ExactPermit2Witness,
    UptoPermit2Authorization,
    UptoPermit2Payload,
    UptoPermit2Witness,
)
from x402.mechanisms.evm.upto.permit2_utils import _build_upto_permit2_settle_args

PAYER = "0x1234567890123456789012345678901234567890"
TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
RECEIVER = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"
FACILITATOR = "0xeF4f6ABbC1Cb87Aea6Cd86B5a4019fC6599178AC"
INNER_SIGNATURE = "0x" + "ab" * 65


def _wrap_erc6492_signature(inner_signature: bytes) -> str:
    factory = to_checksum_address("0xca11bde05977b3631167028862be2a173976ca11")
    payload = encode(
        ["address", "bytes", "bytes"],
        [factory, b"\xde\xad\xbe\xef", inner_signature],
    )
    wrapped = payload + ERC6492_MAGIC_VALUE
    return "0x" + wrapped.hex()


def _make_exact_payload(signature: str) -> ExactPermit2Payload:
    return ExactPermit2Payload(
        signature=signature,
        permit2_authorization=ExactPermit2Authorization(
            from_address=PAYER,
            permitted=ExactPermit2TokenPermissions(token=TOKEN, amount="1000000"),
            spender="0x4020a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a000",
            nonce="123",
            deadline="9999999999",
            witness=ExactPermit2Witness(to=RECEIVER, valid_after="0"),
        ),
    )


def _make_upto_payload(signature: str) -> UptoPermit2Payload:
    return UptoPermit2Payload(
        signature=signature,
        permit2_authorization=UptoPermit2Authorization(
            from_address=PAYER,
            permitted=ExactPermit2TokenPermissions(token=TOKEN, amount="1000000"),
            spender="0x4020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b000",
            nonce="123",
            deadline="9999999999",
            witness=UptoPermit2Witness(
                to=RECEIVER,
                facilitator=FACILITATOR,
                valid_after="0",
            ),
        ),
    )


def test_build_permit2_settle_args_unwraps_erc6492_signature() -> None:
    inner_bytes = bytes.fromhex(INNER_SIGNATURE.removeprefix("0x"))
    wrapped = _wrap_erc6492_signature(inner_bytes)

    _, _, _, sig_bytes = _build_permit2_settle_args(_make_exact_payload(wrapped))

    assert sig_bytes == inner_bytes


def test_build_upto_permit2_settle_args_unwraps_erc6492_signature() -> None:
    inner_bytes = bytes.fromhex(INNER_SIGNATURE.removeprefix("0x"))
    wrapped = _wrap_erc6492_signature(inner_bytes)

    _, _, _, _, sig_bytes = _build_upto_permit2_settle_args(_make_upto_payload(wrapped), 1_000_000)

    assert sig_bytes == inner_bytes


def test_build_permit2_settle_args_leaves_non_wrapped_signature_unchanged() -> None:
    inner_bytes = bytes.fromhex(INNER_SIGNATURE.removeprefix("0x"))

    _, _, _, sig_bytes = _build_permit2_settle_args(_make_exact_payload(INNER_SIGNATURE))

    assert sig_bytes == inner_bytes
