"""Tests for universal signature verification helpers."""

import pytest

try:
    from eth_abi import encode as eth_abi_encode
except ImportError:
    pytest.skip("eth-abi not available", allow_module_level=True)

from x402.mechanisms.evm.verify import verify_universal_signature

# ERC-6492 magic bytes suffix
ERC6492_MAGIC = bytes.fromhex("6492649264926492649264926492649264926492649264926492649264926492")


def make_erc6492_sig(factory: bytes, calldata: bytes, inner_sig: bytes) -> bytes:
    """Build a valid ERC-6492 wrapped signature for testing.

    Format: abi.encode(address, bytes, bytes) + magic
    """
    encoded = eth_abi_encode(["address", "bytes", "bytes"], [factory, calldata, inner_sig])
    return encoded + ERC6492_MAGIC


FACTORY_ADDR = bytes.fromhex("1111111111111111111111111111111111111111")
FACTORY_CALLDATA = bytes.fromhex("deadbeef")
GARBAGE_INNER_SIG = b"\x00" * 65  # All-zero 65-byte "signature" — forged/invalid
WALLET_ADDRESS = "0x1234567890123456789012345678901234567890"
TEST_HASH = b"\x01" * 32


class MockFacilitatorSigner:
    """Minimal mock facilitator signer for verify tests."""

    def __init__(self, read_contract_result=None, read_contract_raises=None, code=b""):
        self._read_contract_result = read_contract_result
        self._read_contract_raises = read_contract_raises
        self._code = code

    def get_code(self, address: str) -> bytes:
        return self._code

    def read_contract(self, address, abi, function_name, *args):
        if self._read_contract_raises is not None:
            raise self._read_contract_raises
        return self._read_contract_result


class TestVerifyUniversalSignature:
    """Generic verification should stay generic and not perform EIP-3009 simulation."""

    def test_allow_undeployed_true_accepts_erc6492_wrapper(self):
        erc6492_sig = make_erc6492_sig(FACTORY_ADDR, FACTORY_CALLDATA, GARBAGE_INNER_SIG)
        signer = MockFacilitatorSigner(
            code=b"",
        )

        valid, sig_data = verify_universal_signature(
            signer,
            WALLET_ADDRESS,
            TEST_HASH,
            erc6492_sig,
            allow_undeployed=True,
        )

        assert valid is True
        assert sig_data.factory == FACTORY_ADDR

    def test_allow_undeployed_false_raises(self):
        erc6492_sig = make_erc6492_sig(FACTORY_ADDR, FACTORY_CALLDATA, GARBAGE_INNER_SIG)
        signer = MockFacilitatorSigner(
            code=b"",
        )

        with pytest.raises(ValueError, match="not allowed"):
            verify_universal_signature(
                signer,
                WALLET_ADDRESS,
                TEST_HASH,
                erc6492_sig,
                allow_undeployed=False,
            )

    def test_non_erc6492_non_eoa_signature_returns_false_for_undeployed_wallet(self):
        signer = MockFacilitatorSigner(code=b"")
        valid, _ = verify_universal_signature(
            signer,
            WALLET_ADDRESS,
            TEST_HASH,
            b"\x99" * 66,
            allow_undeployed=True,
        )
        assert valid is False
