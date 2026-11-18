"""Tests for verify_typed_data_strict — the strict EIP-712 verification primitive."""

from unittest.mock import MagicMock

from x402.mechanisms.evm.types import TypedDataDomain, TypedDataField
from x402.mechanisms.evm.verify import verify_typed_data_strict

SAMPLE_DOMAIN = TypedDataDomain(
    name="USDC",
    version="2",
    chain_id=84532,
    verifying_contract="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
)
SAMPLE_TYPES = {
    "TransferWithAuthorization": [
        TypedDataField(name="from", type="address"),
        TypedDataField(name="to", type="address"),
        TypedDataField(name="value", type="uint256"),
        TypedDataField(name="validAfter", type="uint256"),
        TypedDataField(name="validBefore", type="uint256"),
        TypedDataField(name="nonce", type="bytes32"),
    ]
}
SAMPLE_MESSAGE = {
    "from": "0xabcA8d06A3925a6C06D142788a1A90ae431ccB00",
    "to": "0x122F8Fcaf2152420445Aa424E1D8C0306935B5c9",
    "value": 1000,
    "validAfter": 0,
    "validBefore": 9999999999,
    "nonce": b"\xaa" * 32,
}

EIP1271_MAGIC = b"\x16\x26\xba\x7e"
EIP1271_FAIL = b"\xff\xff\xff\xff"


def _mock_signer(code: bytes, is_valid_sig_result: bytes | None = None):
    signer = MagicMock()
    signer.get_code.return_value = code
    signer.read_contract.return_value = is_valid_sig_result
    return signer


class TestVerifyTypedDataStrict:
    def test_eoa_valid_sig(self):
        """Plain EOA with valid ECDSA signature → accepted without on-chain call."""
        from eth_account import Account

        acct = Account.from_key("0x" + "a" * 64)
        typed = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "TransferWithAuthorization": [
                    {"name": "from", "type": "address"},
                    {"name": "to", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "validAfter", "type": "uint256"},
                    {"name": "validBefore", "type": "uint256"},
                    {"name": "nonce", "type": "bytes32"},
                ],
            },
            "primaryType": "TransferWithAuthorization",
            "domain": {
                "name": "USDC",
                "version": "2",
                "chainId": 84532,
                "verifyingContract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            },
            "message": {
                "from": acct.address,
                "to": "0x122F8Fcaf2152420445Aa424E1D8C0306935B5c9",
                "value": 1000,
                "validAfter": 0,
                "validBefore": 9999999999,
                "nonce": "0x" + "aa" * 32,
            },
        }
        sig = acct.sign_typed_data(full_message=typed)
        signer = _mock_signer(code=b"")  # EOA: no code
        result = verify_typed_data_strict(
            signer,
            acct.address,
            SAMPLE_DOMAIN,
            SAMPLE_TYPES,
            "TransferWithAuthorization",
            {**SAMPLE_MESSAGE, "from": acct.address},
            sig.signature,
        )
        assert result is True
        signer.read_contract.assert_not_called()

    def test_contract_1271_accepts(self):
        """Deployed contract whose isValidSignature returns magic → accepted."""
        signer = _mock_signer(code=b"\x60\x80", is_valid_sig_result=EIP1271_MAGIC)
        result = verify_typed_data_strict(
            signer,
            "0x1234567890123456789012345678901234567890",
            SAMPLE_DOMAIN,
            SAMPLE_TYPES,
            "TransferWithAuthorization",
            SAMPLE_MESSAGE,
            b"\x00" * 65,
        )
        assert result is True

    def test_contract_1271_rejects(self):
        """Deployed contract whose isValidSignature returns failure → rejected."""
        signer = _mock_signer(code=b"\x60\x80", is_valid_sig_result=EIP1271_FAIL)
        result = verify_typed_data_strict(
            signer,
            "0x1234567890123456789012345678901234567890",
            SAMPLE_DOMAIN,
            SAMPLE_TYPES,
            "TransferWithAuthorization",
            SAMPLE_MESSAGE,
            b"\x00" * 65,
        )
        assert result is False

    def test_regression_7702_delegate_rejects_no_ecdsa_fallback(self):
        """REGRESSION: 7702 EOA whose delegate rejects → must return False (no ECDSA fallback).

        Empirically verified on Base Sepolia: when a 7702 EOA's delegate returns
        0xffffffff from isValidSignature, on-chain USDC.transferWithAuthorization
        reverts with 'FiatTokenV2: invalid signature'. The strict primitive must
        match that — NOT fall back to ECDSA (which would return True because the
        owner's sig recovers correctly).
        """
        erc7702_code = b"\xef\x01\x00" + bytes(20)  # 7702 delegation designation
        signer = _mock_signer(code=erc7702_code, is_valid_sig_result=EIP1271_FAIL)
        result = verify_typed_data_strict(
            signer,
            "0xabcA8d06A3925a6C06D142788a1A90ae431ccB00",  # EOA address
            SAMPLE_DOMAIN,
            SAMPLE_TYPES,
            "TransferWithAuthorization",
            SAMPLE_MESSAGE,
            b"\x00" * 65,  # owner's ECDSA sig — ECDSA fallback would accept this
        )
        # Must reject: delegate's isValidSignature said no, on-chain would also reject
        assert result is False

    def test_contract_1271_reverts_no_ecdsa_fallback(self):
        """isValidSignature reverts → returns False without ECDSA fallback."""
        signer = _mock_signer(code=b"\x60\x80", is_valid_sig_result=None)
        signer.read_contract.side_effect = Exception("revert")
        result = verify_typed_data_strict(
            signer,
            "0x1234567890123456789012345678901234567890",
            SAMPLE_DOMAIN,
            SAMPLE_TYPES,
            "TransferWithAuthorization",
            SAMPLE_MESSAGE,
            b"\x00" * 65,
        )
        assert result is False
