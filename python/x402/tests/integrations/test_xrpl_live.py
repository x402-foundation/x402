"""Live XRPL testnet round trip for the exact scheme.

Opt-in: set ``X402_XRPL_LIVE=1``. The test funds throwaway wallets from the
testnet faucet, so it needs network access and takes a few seconds.

Everything else in the suite runs against fakes. This is the only test that can
catch a wrong assumption about real ledger behaviour: account sequencing,
signing authority, fee handling and submission semantics are all exercised
against a real node here.
"""

from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("X402_XRPL_LIVE") != "1",
    reason="live XRPL testnet test; set X402_XRPL_LIVE=1 to run",
)

TESTNET = "xrpl:1"
AMOUNT_DROPS = "1000"


def _faucet_wallet():
    from xrpl.clients import JsonRpcClient
    from xrpl.wallet import generate_faucet_wallet

    return generate_faucet_wallet(JsonRpcClient("https://s.altnet.rippletest.net:51234/"))


@pytest.fixture(scope="module")
def merchant():
    """Fund a merchant account once for the module.

    Returns:
        The merchant wallet.
    """
    return _faucet_wallet()


@pytest.fixture
def payer():
    """Fund a fresh payer per test.

    Each test gets its own account because the ``sequence`` transfer method
    serialises an account: a second payment built before the first has validated
    reads a stale sequence and is rejected with ``tefPAST_SEQ``.

    Returns:
        A freshly funded wallet.
    """
    return _faucet_wallet()


def _requirements(merchant, invoice_id: str = "inv_live_001"):
    from x402.schemas.payments import PaymentRequirements

    return PaymentRequirements(
        scheme="exact",
        network=TESTNET,
        asset="XRP",
        amount=AMOUNT_DROPS,
        pay_to=merchant.address,
        max_timeout_seconds=60,
        # areFeesSponsored is what a resource server always publishes, and both
        # the client and the facilitator require it.
        extra={
            "assetTransferMethod": "sequence",
            "invoiceId": invoice_id,
            "areFeesSponsored": False,
        },
    )


def _payload(blob: str, requirements):
    from x402.schemas.payments import PaymentPayload

    return PaymentPayload(payload={"signedTxBlob": blob}, accepted=requirements)


def test_client_payment_verifies_and_settles_on_testnet(payer, merchant):
    """A client-built payment verifies and settles against a real node."""
    from x402.mechanisms.xrpl.exact import ExactXrplClientScheme, ExactXrplFacilitatorScheme

    requirements = _requirements(merchant)

    blob = ExactXrplClientScheme(payer).create_payment_payload(requirements)["signedTxBlob"]
    payload = _payload(blob, requirements)

    facilitator = ExactXrplFacilitatorScheme()

    verification = facilitator.verify(payload, requirements)
    assert verification.is_valid is True, verification.invalid_reason
    assert verification.payer == payer.address

    settlement = facilitator.settle(payload, requirements)
    assert settlement.success is True, settlement.error_reason
    assert settlement.transaction

    # The same blob must not settle twice. Settlement waits for validation, so
    # by now the account's sequence has advanced and verification fails before
    # the duplicate guard is even reached; either refusal is correct.
    replay = facilitator.settle(payload, requirements)
    assert replay.success is False
    assert replay.error_reason in {
        "duplicate_settlement",
        "invalid_exact_xrpl_payload_sequence_not_current",
    }


def test_a_fresh_facilitator_cannot_replay_a_settled_payment(payer, merchant):
    """A settled sequence cannot be reused, even by a fresh facilitator."""
    from x402.mechanisms.xrpl.exact import ExactXrplClientScheme, ExactXrplFacilitatorScheme

    requirements = _requirements(merchant, invoice_id="inv_live_002")

    blob = ExactXrplClientScheme(payer).create_payment_payload(requirements)["signedTxBlob"]
    payload = _payload(blob, requirements)

    assert ExactXrplFacilitatorScheme().settle(payload, requirements).success is True

    # A new facilitator has an empty cache, so only the ledger stops the replay:
    # the sequence has been consumed.
    replay = ExactXrplFacilitatorScheme().settle(payload, requirements)
    assert replay.success is False


def test_a_stale_sequence_is_rejected(payer, merchant):
    """Verification catches a sequence the account has already moved past."""
    from x402.mechanisms.xrpl.exact import ExactXrplClientScheme, ExactXrplFacilitatorScheme
    from x402.mechanisms.xrpl.exact.client import XrplClientOptions

    requirements = _requirements(merchant, invoice_id="inv_live_003")

    client = ExactXrplClientScheme(payer, XrplClientOptions(get_account_sequence=lambda _a, _n: 1))
    blob = client.create_payment_payload(requirements)["signedTxBlob"]

    result = ExactXrplFacilitatorScheme().verify(_payload(blob, requirements), requirements)
    assert result.is_valid is False
    assert result.invalid_reason == "invalid_exact_xrpl_payload_sequence_not_current"


def test_simulation_refuses_a_payment_the_payer_cannot_afford(payer, merchant):
    """A payment beyond the payer's balance is refused before settlement.

    Nothing static reveals this: the transaction is well formed, correctly
    signed and correctly sequenced. Only a dry run against a real node can tell
    the facilitator that the resource server would do the work for nothing.
    """
    from x402.mechanisms.xrpl.exact import ExactXrplClientScheme, ExactXrplFacilitatorScheme

    requirements = _requirements(merchant, invoice_id="inv_live_004")
    # Far beyond any faucet balance, but still a valid drops amount.
    requirements.amount = "99999999999999999"

    blob = ExactXrplClientScheme(payer).create_payment_payload(requirements)["signedTxBlob"]
    result = ExactXrplFacilitatorScheme().verify(_payload(blob, requirements), requirements)

    assert result.is_valid is False
    assert (
        result.invalid_reason == "invalid_exact_xrpl_payload_simulation_failed: tecUNFUNDED_PAYMENT"
    )


def test_simulation_accepts_a_payment_the_payer_can_afford(payer, merchant):
    """The dry run must not reject a payment that would actually succeed."""
    from x402.mechanisms.xrpl.exact import ExactXrplClientScheme, ExactXrplFacilitatorScheme

    requirements = _requirements(merchant, invoice_id="inv_live_005")
    blob = ExactXrplClientScheme(payer).create_payment_payload(requirements)["signedTxBlob"]
    result = ExactXrplFacilitatorScheme().verify(_payload(blob, requirements), requirements)

    assert result.is_valid is True, result.invalid_reason


def test_a_payer_with_no_ticket_creates_one_and_pays_with_it(payer, merchant):
    """The scheme requires the client to create a ticket rather than fail.

    A fresh faucet account holds none, so this exercises TicketCreate, reading
    the assigned sequence back from the ledger's metadata, and spending it --
    none of which a fake node can confirm.
    """
    from x402.mechanisms.xrpl.exact import ExactXrplClientScheme, ExactXrplFacilitatorScheme
    from x402.mechanisms.xrpl.utils import decode_signed_transaction_blob

    requirements = _requirements(merchant, invoice_id="inv_live_006")
    requirements.extra = {**requirements.extra, "assetTransferMethod": "ticketSequence"}

    blob = ExactXrplClientScheme(payer).create_payment_payload(requirements)["signedTxBlob"]
    transaction = decode_signed_transaction_blob(blob)
    assert transaction["Sequence"] == 0
    assert transaction["TicketSequence"] > 0

    result = ExactXrplFacilitatorScheme().settle(_payload(blob, requirements), requirements)
    assert result.success is True, result.error_reason
