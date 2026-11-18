import pytest
from pydantic import ValidationError

from x402.schemas.payments import PaymentRequirements
from x402.schemas.v1 import PaymentRequirementsV1

VALID_PAYMENT_REQUIREMENTS_V2 = {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {"name": "USDC", "version": "2"},
}


def _requirements(network: str) -> dict[str, object]:
    return {**VALID_PAYMENT_REQUIREMENTS_V2, "network": network}


class TestV2NetworkCaip2:
    def test_should_accept_valid_caip2_format_for_v2(self) -> None:
        result = PaymentRequirements.model_validate(_requirements("eip155:84532"))
        assert result.network == "eip155:84532"

    def test_should_accept_solana_caip2_format_for_v2(self) -> None:
        result = PaymentRequirements.model_validate(_requirements("solana:devnet"))
        assert result.network == "solana:devnet"

    def test_should_reject_v1_style_network_names_for_v2(self) -> None:
        with pytest.raises(ValidationError, match="Network must be in CAIP-2 format"):
            PaymentRequirements.model_validate(_requirements("base-sepolia"))

    def test_should_reject_network_without_colon_for_v2(self) -> None:
        with pytest.raises(ValidationError, match="Network must be in CAIP-2 format"):
            PaymentRequirements.model_validate(_requirements("ethereum"))

    def test_should_reject_network_too_short_for_v2(self) -> None:
        with pytest.raises(ValidationError, match="Network must be in CAIP-2 format"):
            PaymentRequirements.model_validate(_requirements("a:"))

    def test_should_accept_minimum_valid_caip2_for_v2(self) -> None:
        result = PaymentRequirements.model_validate(_requirements("abc:d"))
        assert result.network == "abc:d"

    @pytest.mark.parametrize(
        "network",
        [
            "a:b",
            "EIP155:84532",
            "123456789:1",
            "eip155:",
            "eip155:" + "a" * 33,
            "eip155:base.mainnet",
            ":84532",
            "eip155:84532:extra",
        ],
    )
    def test_should_reject_malformed_caip2_network_for_v2(self, network: str) -> None:
        with pytest.raises(ValidationError, match="Network must be in CAIP-2 format"):
            PaymentRequirements.model_validate(_requirements(network))


class TestV1NetworkStaysLoose:
    def test_should_accept_legacy_network_name(self) -> None:
        result = PaymentRequirementsV1.model_validate(
            {
                "scheme": "exact",
                "network": "base-sepolia",
                "maxAmountRequired": "10000",
                "resource": "https://example.com",
                "description": "",
                "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
                "maxTimeoutSeconds": 60,
                "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            }
        )
        assert result.network == "base-sepolia"
