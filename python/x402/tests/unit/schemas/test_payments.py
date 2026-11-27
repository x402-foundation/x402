import pytest
from pydantic import ValidationError

from x402.schemas.payments import PaymentPayload, PaymentRequired, PaymentRequirements
from x402.schemas.responses import VerifyRequest
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


def _payload(version: object) -> dict[str, object]:
    return {"x402Version": version, "payload": {}, "accepted": VALID_PAYMENT_REQUIREMENTS_V2}


def _required(version: object) -> dict[str, object]:
    return {"x402Version": version, "accepts": [VALID_PAYMENT_REQUIREMENTS_V2]}


class TestV2VersionRejectsNonNumbers:
    @pytest.mark.parametrize("version", [True, False, "2", 1.5, None])
    def test_payment_payload_rejects_non_number_x402_version(self, version: object) -> None:
        with pytest.raises(ValidationError):
            PaymentPayload.model_validate(_payload(version))

    @pytest.mark.parametrize("version", [True, False, "2", 1.5, None])
    def test_payment_required_rejects_non_number_x402_version(self, version: object) -> None:
        with pytest.raises(ValidationError):
            PaymentRequired.model_validate(_required(version))


class TestV2VersionAcceptsWholeNumberFloats:
    @pytest.mark.parametrize("version", [2, 2.0])
    def test_payment_payload_accepts_whole_number_float(self, version: object) -> None:
        # JSON does not distinguish 2 from 2.0, so both are protocol version 2.
        result = PaymentPayload.model_validate(_payload(version))
        assert result.x402_version == 2

    @pytest.mark.parametrize("version", [2, 2.0])
    def test_payment_required_accepts_whole_number_float(self, version: object) -> None:
        result = PaymentRequired.model_validate(_required(version))
        assert result.x402_version == 2


VALID_PAYMENT_PAYLOAD_V2 = {
    "x402Version": 2,
    "payload": {},
    "accepted": VALID_PAYMENT_REQUIREMENTS_V2,
}


def _verify_request(version: object) -> dict[str, object]:
    return {
        "x402Version": version,
        "paymentPayload": VALID_PAYMENT_PAYLOAD_V2,
        "paymentRequirements": VALID_PAYMENT_REQUIREMENTS_V2,
    }


class TestVerifyRequestVersion:
    @pytest.mark.parametrize("version", [True, False, "2", 1.5, None])
    def test_rejects_non_number_x402_version(self, version: object) -> None:
        with pytest.raises(ValidationError):
            VerifyRequest.model_validate(_verify_request(version))

    @pytest.mark.parametrize("version", [2, 2.0])
    def test_accepts_whole_number_float(self, version: object) -> None:
        result = VerifyRequest.model_validate(_verify_request(version))
        assert result.x402_version == 2
