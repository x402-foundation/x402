"""Real Cardano Preprod payments through the Python client, server and facilitator.

Required: CARDANO_CLIENT_MNEMONIC (or CLIENT_CARDANO_MNEMONIC),
BLOCKFROST_PROJECT_ID and CARDANO_RESOURCE_SERVER_ADDRESS (or SERVER_CARDANO_ADDRESS).
Masumi additionally requires SERVER_CARDANO_SELLER_MNEMONIC. An optional
CARDANO_TEST_ASSET enables the native-token case; CARDANO_TEST_TOKEN_AMOUNT
is an atomic integer. Every enabled case submits one transaction on Preprod.
"""

from __future__ import annotations

import os
import time

import pytest

pytest.importorskip("pycardano")

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.cardano import (
    BlockfrostConfig,
    CardanoProviderConfig,
    CardanoSettlementEvidence,
    ClientCardanoSignerConfig,
    FacilitatorCardanoSignerConfig,
    MasumiIssuerConfig,
    masumi_escrow_address,
    to_client_cardano_signer,
    to_facilitator_cardano_signer,
    to_masumi_seller_signer,
)
from x402.mechanisms.cardano.exact import (
    ExactCardanoClientScheme,
    ExactCardanoFacilitatorScheme,
    ExactCardanoServerScheme,
)
from x402.schemas import PaymentRequirements, ResourceInfo

NETWORK = "cardano:preprod"
MNEMONIC = os.getenv("CARDANO_CLIENT_MNEMONIC") or os.getenv("CLIENT_CARDANO_MNEMONIC")
RECIPIENT = os.getenv("CARDANO_RESOURCE_SERVER_ADDRESS") or os.getenv("SERVER_CARDANO_ADDRESS")
PROJECT_ID = os.getenv("BLOCKFROST_PROJECT_ID")
SELLER_MNEMONIC = os.getenv("SERVER_CARDANO_SELLER_MNEMONIC")

pytestmark = pytest.mark.skipif(
    not MNEMONIC or not RECIPIENT or not PROJECT_ID,
    reason="Cardano client mnemonic, resource server address and BLOCKFROST_PROJECT_ID are required",
)


class CountingSigner:
    """Keep real submission while making the pending response deterministic."""

    def __init__(self, signer):
        self.signer = signer
        self.force_pending = False
        self.submissions = 0

    def __getattr__(self, name):
        return getattr(self.signer, name)

    def get_transaction_evidence(self, tx_hash, network):
        if self.force_pending:
            return CardanoSettlementEvidence("unknown", -2)
        return self.signer.get_transaction_evidence(tx_hash, network)

    def submit_transaction(self, transaction, network):
        self.submissions += 1
        return self.signer.submit_transaction(transaction, network)


@pytest.fixture
def participants():
    if not PROJECT_ID.startswith("preprod"):
        pytest.fail("Cardano integration tests require a Preprod Blockfrost project")
    provider = CardanoProviderConfig(
        blockfrost=BlockfrostConfig("https://cardano-preprod.blockfrost.io/api/v0", PROJECT_ID)
    )
    buyer = to_client_cardano_signer(ClientCardanoSignerConfig(MNEMONIC, NETWORK, provider))
    relay = to_facilitator_cardano_signer(
        FacilitatorCardanoSignerConfig(NETWORK, provider, await_confirmation=False)
    )
    counter = CountingSigner(relay)
    client = x402ClientSync().register("cardano:*", ExactCardanoClientScheme(buyer))
    client.set_spend_controls(False)
    scheme = ExactCardanoFacilitatorScheme(counter, confirmation_timeout_ms=0)
    facilitator = x402FacilitatorSync().register([NETWORK], scheme)
    masumi = (
        MasumiIssuerConfig(to_masumi_seller_signer(SELLER_MNEMONIC, NETWORK))
        if SELLER_MNEMONIC
        else None
    )
    server = x402ResourceServerSync(facilitator).register(
        "cardano:*", ExactCardanoServerScheme(masumi=masumi)
    )
    server.initialize()
    yield client, server, scheme, counter, buyer
    buyer.close()
    relay.close()


def _settle_until_confirmed(server, payload, requirements):
    deadline = time.monotonic() + 240
    while True:
        result = server.settle_payment(payload, requirements)
        if result.success:
            return result
        assert result.error_reason == "settlement_pending", result.model_dump(exclude_none=True)
        assert result.extra["transactionId"] == result.transaction
        if time.monotonic() >= deadline:
            pytest.fail(
                "Cardano payment was broadcast but confirmation did not arrive within 240 seconds"
            )
        time.sleep(3)


@pytest.mark.parametrize(
    "method,asset",
    [
        ("default", "lovelace"),
        ("script", "lovelace"),
        ("masumi", "lovelace"),
        ("default", "native"),
    ],
)
def test_cardano_payment_flow(participants, method, asset):
    if method == "masumi" and not SELLER_MNEMONIC:
        pytest.skip("SERVER_CARDANO_SELLER_MNEMONIC is required for a live Masumi lock")
    if asset == "native" and not os.getenv("CARDANO_TEST_ASSET"):
        pytest.skip("CARDANO_TEST_ASSET is required for native-token integration")
    client, server, scheme, counter, buyer = participants
    pay_to = RECIPIENT
    extra = {"assetTransferMethod": method, "confirmationPolicy": {"l1Confirmations": 0}}
    if method == "masumi":
        pay_to = masumi_escrow_address(NETWORK)
    elif method == "script":
        pay_to = "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682"
        extra.update(
            script={"type": "plutusV3", "code": "4d01000033222220051200120011"},
            datum="d8799f182aff",
        )
    requirements = PaymentRequirements(
        scheme="exact",
        network=NETWORK,
        asset="lovelace" if asset == "lovelace" else os.environ["CARDANO_TEST_ASSET"],
        amount="5000000" if asset == "lovelace" else os.getenv("CARDANO_TEST_TOKEN_AMOUNT", "1"),
        pay_to=pay_to,
        max_timeout_seconds=600,
        extra=extra,
    )
    required = server.create_payment_required_response(
        [requirements], ResourceInfo(url="https://example.test/cardano")
    )
    requirements = required.accepts[0]
    payload = client.create_payment_payload(required)
    verified = server.verify_payment(payload, requirements)
    assert verified.is_valid, verified.model_dump(exclude_none=True)
    assert counter.submissions == 0
    # Exercise pending reconciliation through the resource server on every route.
    counter.force_pending = True
    pending = server.settle_payment(payload, requirements)
    assert pending.error_reason == "settlement_pending"
    counter.force_pending = False
    settled = _settle_until_confirmed(server, payload, requirements)
    assert settled.transaction == pending.transaction
    assert settled.payer == buyer.get_address()
    assert counter.submissions == 1
    # Wait for wallet change indexing before the next case selects funding inputs.
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if any(
            str(utxo.input.transaction_id) == settled.transaction
            for utxo in buyer._provider.utxos(buyer.get_address())
        ):
            break
        time.sleep(3)
    else:
        pytest.fail("Cardano wallet change was not indexed after settlement")
