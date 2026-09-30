"""Tests for the ERC-20 Approval Gas Sponsoring extension."""

from __future__ import annotations

from typing import Any

from x402.extensions.erc20_approval_gas_sponsoring import (
    ERC20_APPROVAL_GAS_SPONSORING_KEY,
    Erc20ApprovalGasSponsoringInfo,
    declare_erc20_approval_gas_sponsoring_extension,
    extract_erc20_approval_gas_sponsoring_info,
    validate_erc20_approval_gas_sponsoring_info,
)
from x402.extensions.erc20_approval_gas_sponsoring.client import (
    sign_erc20_approval_transaction,
)
from x402.mechanisms.evm.constants import (
    DEFAULT_MAX_FEE_PER_GAS,
    DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
    PERMIT2_ADDRESS,
)
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYER = "0x1234567890123456789012345678901234567890"


def _make_info(**overrides: Any) -> Erc20ApprovalGasSponsoringInfo:
    defaults = {
        "from_address": PAYER,
        "asset": TOKEN_ADDRESS,
        "spender": PERMIT2_ADDRESS,
        "amount": str(2**256 - 1),
        "signed_transaction": "0x" + "ff" * 100,
        "version": "1",
    }
    defaults.update(overrides)
    return Erc20ApprovalGasSponsoringInfo(**defaults)


def _make_payload(info: Erc20ApprovalGasSponsoringInfo | None = None) -> PaymentPayload:
    ext = {}
    if info is not None:
        ext = {ERC20_APPROVAL_GAS_SPONSORING_KEY: {"info": info.to_dict()}}
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(url="http://example.com", description="test", mime_type="text"),
        accepted=PaymentRequirements(
            scheme="exact",
            network="eip155:84532",
            asset=TOKEN_ADDRESS,
            amount="1000",
            pay_to="0x0987654321098765432109876543210987654321",
            max_timeout_seconds=3600,
            extra={"assetTransferMethod": "permit2"},
        ),
        payload={"permit2Authorization": {"from": PAYER}},
        extensions=ext,
    )


class TestDeclaration:
    def test_declare_returns_correct_key(self):
        result = declare_erc20_approval_gas_sponsoring_extension()
        assert ERC20_APPROVAL_GAS_SPONSORING_KEY in result
        ext = result[ERC20_APPROVAL_GAS_SPONSORING_KEY]
        assert "info" in ext
        assert "schema" in ext
        assert ext["info"]["version"] == "1"


class TestSerialization:
    def test_roundtrip(self):
        info = _make_info()
        d = info.to_dict()
        restored = Erc20ApprovalGasSponsoringInfo.from_dict(d)
        assert restored.from_address == info.from_address
        assert restored.asset == info.asset
        assert restored.spender == info.spender
        assert restored.amount == info.amount
        assert restored.signed_transaction == info.signed_transaction
        assert restored.version == info.version

    def test_to_dict_uses_camel_case(self):
        info = _make_info()
        d = info.to_dict()
        assert "from" in d
        assert "signedTransaction" in d
        assert "from_address" not in d
        assert "signed_transaction" not in d


class TestExtraction:
    def test_extract_from_payload(self):
        info = _make_info()
        payload = _make_payload(info)
        result = extract_erc20_approval_gas_sponsoring_info(payload)
        assert result is not None
        assert result.from_address == PAYER

    def test_extract_returns_none_when_missing(self):
        payload = _make_payload(None)
        result = extract_erc20_approval_gas_sponsoring_info(payload)
        assert result is None


class TestValidation:
    def test_valid_info(self):
        info = _make_info()
        assert validate_erc20_approval_gas_sponsoring_info(info) is True

    def test_invalid_address(self):
        info = _make_info(from_address="not-an-address")
        assert validate_erc20_approval_gas_sponsoring_info(info) is False

    def test_invalid_signed_transaction(self):
        info = _make_info(signed_transaction="not-hex")
        assert validate_erc20_approval_gas_sponsoring_info(info) is False


class _StubSigner:
    """Minimal signer that records the transaction it was asked to sign."""

    def __init__(self, fees: tuple[int, int] | None = None, raise_on_estimate: bool = False):
        self.address = PAYER
        self._fees = fees
        self._raise = raise_on_estimate
        self.signed_tx: dict[str, Any] | None = None
        if fees is not None or raise_on_estimate:

            def estimate_fees_per_gas() -> tuple[int, int]:
                if self._raise:
                    raise RuntimeError("rpc unavailable")
                assert self._fees is not None
                return self._fees

            self.estimate_fees_per_gas = estimate_fees_per_gas

    def get_transaction_count(self, address: str) -> int:
        return 0

    def sign_transaction(self, tx: dict[str, Any]) -> str:
        self.signed_tx = tx
        return "0x" + "ab" * 100


class TestGasFeeFallback:
    def test_constants_exported_with_expected_values(self):
        assert DEFAULT_MAX_FEE_PER_GAS == 1_000_000_000
        assert DEFAULT_MAX_PRIORITY_FEE_PER_GAS == 100_000_000

    def test_uses_defaults_when_signer_has_no_estimator(self):
        signer = _StubSigner()
        sign_erc20_approval_transaction(signer, TOKEN_ADDRESS, chain_id=84532)
        assert signer.signed_tx is not None
        assert signer.signed_tx["maxFeePerGas"] == DEFAULT_MAX_FEE_PER_GAS
        assert signer.signed_tx["maxPriorityFeePerGas"] == DEFAULT_MAX_PRIORITY_FEE_PER_GAS

    def test_uses_defaults_when_estimator_raises(self):
        signer = _StubSigner(raise_on_estimate=True)
        sign_erc20_approval_transaction(signer, TOKEN_ADDRESS, chain_id=84532)
        assert signer.signed_tx is not None
        assert signer.signed_tx["maxFeePerGas"] == DEFAULT_MAX_FEE_PER_GAS
        assert signer.signed_tx["maxPriorityFeePerGas"] == DEFAULT_MAX_PRIORITY_FEE_PER_GAS

    def test_uses_estimated_fees_when_available(self):
        signer = _StubSigner(fees=(5_000_000_000, 250_000_000))
        sign_erc20_approval_transaction(signer, TOKEN_ADDRESS, chain_id=84532)
        assert signer.signed_tx is not None
        assert signer.signed_tx["maxFeePerGas"] == 5_000_000_000
        assert signer.signed_tx["maxPriorityFeePerGas"] == 250_000_000
