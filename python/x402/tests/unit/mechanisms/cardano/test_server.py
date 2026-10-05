"""Cardano quote issuance and binding through the existing resource server hooks."""

import base64
from hashlib import blake2b

import cbor2
import pytest
from nacl.signing import SigningKey
from pycardano import Address

from x402 import x402ResourceServerSync
from x402.mechanisms.cardano.constants import ERR_DUPLICATE_SETTLEMENT, ERR_MASUMI_TERMS_UNKNOWN
from x402.mechanisms.cardano.exact.masumi.blueprint import masumi_escrow_address
from x402.mechanisms.cardano.exact.masumi.issue import to_masumi_seller_signer
from x402.mechanisms.cardano.exact.masumi.verify import verify_masumi_authorization
from x402.mechanisms.cardano.exact.masumi_issuer import MasumiIssuerConfig
from x402.mechanisms.cardano.exact.server import ExactCardanoScheme
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceInfo,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)

NETWORK = "cardano:preprod"


class Facilitator:
    def get_supported(self):
        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=2,
                    scheme="exact",
                    network=NETWORK,
                    extra={
                        "assetTransferMethods": ["default", "masumi", "script"],
                        "areFeesSponsored": False,
                        "l1Confirmations": {"minimum": 0, "maximum": 20},
                    },
                )
            ]
        )

    def verify(self, payload, requirements):
        return VerifyResponse(is_valid=True)


def server():
    seller = to_masumi_seller_signer("abandon " * 11 + "about", NETWORK)
    resource = x402ResourceServerSync(Facilitator()).register(
        "cardano:*", ExactCardanoScheme(masumi=MasumiIssuerConfig(seller))
    )
    resource.initialize()
    return resource


def template():
    return PaymentRequirements(
        scheme="exact",
        network=NETWORK,
        asset="lovelace",
        amount="5000000",
        pay_to=masumi_escrow_address(NETWORK),
        max_timeout_seconds=120,
        extra={"assetTransferMethod": "masumi"},
    )


def payment(requirements, index=0):
    key = SigningKey(bytes(32))
    body = {
        0: [[bytes(32), index]],
        1: [{0: bytes(Address.from_primitive(requirements.pay_to)), 1: 5_000_000}],
        2: 200_000,
    }
    digest = blake2b(cbor2.dumps(body), digest_size=32).digest()
    raw = cbor2.dumps(
        [body, {0: [[bytes(key.verify_key), key.sign(digest).signature]]}, True, None]
    )
    return PaymentPayload(
        accepted=requirements,
        payload={"transaction": base64.b64encode(raw).decode(), "nonce": "00" * 32 + f"#{index}"},
    )


def test_quote_issued_once_then_bound_and_reused_for_same_paid_retry():
    resource = server()
    response = resource.create_payment_required_response(
        [template()], ResourceInfo(url="https://example.test/service")
    )
    issued = response.accepts[0]
    assert verify_masumi_authorization(issued.extra, issued).ok
    payload = payment(issued)
    assert resource.verify_payment(payload, issued).is_valid
    assert resource.verify_payment(payload, issued).is_valid
    retry = resource.create_payment_required_response(
        [template()], ResourceInfo(url="https://example.test/service"), payment_payload=payload
    )
    assert retry.accepts[0] == issued
    result = resource.verify_payment(payment(issued, index=1), issued)
    assert not result.is_valid and result.invalid_reason == ERR_DUPLICATE_SETTLEMENT


def test_fresh_server_rejects_quote_it_did_not_issue():
    issuer = server()
    issued = issuer.create_payment_required_response(
        [template()], ResourceInfo(url="https://example.test/service")
    ).accepts[0]
    result = server().verify_payment(payment(issued), issued)
    assert not result.is_valid and result.invalid_reason == ERR_MASUMI_TERMS_UNKNOWN


def test_paid_quote_is_not_reused_for_a_different_resource():
    resource = server()
    issued = resource.create_payment_required_response(
        [template()], ResourceInfo(url="https://example.test/job-a")
    ).accepts[0]
    retry = resource.create_payment_required_response(
        [template()],
        ResourceInfo(url="https://example.test/job-b"),
        payment_payload=payment(issued),
    )
    assert retry.accepts[0] != issued
    assert retry.accepts[0].extra["inputCommitment"]["parts"][0]["content"] == {
        "url": "https://example.test/job-b"
    }


def test_transport_header_recovers_issued_quote():
    resource = server()
    issued = resource.create_payment_required_response(
        [template()], ResourceInfo(url="https://example.test/service")
    ).accepts[0]
    payload = payment(issued)
    # The scheme also accepts a generic transport dictionary; no HTTP dependency is required.
    header = base64.b64encode(payload.model_dump_json(by_alias=True).encode()).decode()
    retry = resource.create_payment_required_response(
        [template()],
        ResourceInfo(url="https://example.test/service"),
        transport_context={"request": {"payment_header": header}},
    )
    assert retry.accepts[0] == issued


@pytest.mark.parametrize(
    "price",
    [
        {"asset": "lovelace", "amount": "0"},
        {"asset": "lovelace", "amount": "01"},
        {"asset": "AB" * 28 + ".", "amount": "1"},
        "$0",
        "-1",
    ],
)
def test_noncanonical_or_nonpositive_price_rejected(price):
    with pytest.raises(ValueError):
        ExactCardanoScheme().parse_price(price, NETWORK)


def test_price_and_capability_validation():
    scheme = ExactCardanoScheme()
    assert scheme.parse_price("$1.25", NETWORK).amount == "1250000"
    kind = Facilitator().get_supported().kinds[0]
    request = template().model_copy(
        update={"extra": {"confirmationPolicy": {"l1Confirmations": 2}}}
    )
    assert scheme.enhance_payment_requirements(request, kind, []).extra["areFeesSponsored"] is False
    kind.extra["l1Confirmations"]["maximum"] = 0
    with pytest.raises(ValueError, match="confirmation range"):
        scheme.enhance_payment_requirements(request, kind, [])


@pytest.mark.parametrize("first_method", ["default", "masumi"])
@pytest.mark.parametrize("separate_instances", [False, True])
def test_quote_enrichment_follows_accept_order_across_networks(first_method, separate_instances):
    def seller(network):
        return to_masumi_seller_signer("abandon " * 11 + "about", network)

    resource = x402ResourceServerSync(Facilitator())
    if separate_instances:
        for network in (NETWORK, "cardano:mainnet"):
            resource.register(
                network, ExactCardanoScheme(masumi=MasumiIssuerConfig(seller(network)))
            )
    else:
        resource.register("cardano:*", ExactCardanoScheme(masumi=MasumiIssuerConfig(seller)))
    first = template().model_copy(update={"extra": {"assetTransferMethod": first_method}})
    second = template().model_copy(
        update={"network": "cardano:mainnet", "pay_to": masumi_escrow_address("cardano:mainnet")}
    )
    for _ in range(2):
        response = resource.create_payment_required_response(
            [first, second], ResourceInfo(url="https://example.test/multiple-networks")
        )
        assert verify_masumi_authorization(response.accepts[1].extra, response.accepts[1]).ok
        if first_method == "masumi":
            assert verify_masumi_authorization(response.accepts[0].extra, response.accepts[0]).ok
        else:
            assert response.accepts[0] == first
        assert "_cardano_enriched_accepts" not in response.model_dump_json()
    assert "terms" not in first.extra and "terms" not in second.extra
