"""Client tests for the XRPL exact scheme."""

from __future__ import annotations

import pytest

from x402.mechanisms.xrpl.exact import (
    ExactXrplClientScheme,
    ExactXrplFacilitatorScheme,
    ExactXrplServerScheme,
)
from x402.mechanisms.xrpl.utils import (
    decode_signed_transaction_blob,
    invoice_id_to_invoice_id_field,
)
from x402.schemas import AssetAmount, PaymentRequirements, SupportedKind

from .builders import (
    CURRENT_LEDGER,
    INVOICE_ID,
    ISSUER,
    MERCHANT,
    make_client_options,
    make_options,
    make_payload,
    make_requirements,
    make_wallet,
)


def _client(wallet, **kwargs) -> ExactXrplClientScheme:
    return ExactXrplClientScheme(wallet, make_client_options(**kwargs))


class TestClient:
    def test_builds_a_payment_matching_the_requirements(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = _client(wallet).create_payment_payload(requirements)
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])

        assert tx["TransactionType"] == "Payment"
        assert tx["Account"] == wallet.address
        assert tx["Destination"] == MERCHANT
        assert tx["Amount"] == requirements.amount
        assert tx["Sequence"] == 7

    def test_expiry_sits_ahead_of_the_current_ledger(self):
        wallet = make_wallet()
        requirements = make_requirements(max_timeout_seconds=60)
        payload = _client(wallet).create_payment_payload(requirements)
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert CURRENT_LEDGER < tx["LastLedgerSequence"] <= CURRENT_LEDGER + 17

    def test_commits_to_the_invoice_when_one_is_required(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "invoiceId": INVOICE_ID}
        )
        payload = _client(wallet).create_payment_payload(requirements)
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert tx["InvoiceID"] == invoice_id_to_invoice_id_field(INVOICE_ID)

    def test_consumes_a_ticket_under_the_ticket_method(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        payload = _client(wallet).create_payment_payload(requirements)
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert tx["Sequence"] == 0
        assert tx["TicketSequence"] == 42

    def test_creates_a_ticket_when_the_payer_holds_none(self):
        # The scheme requires the client to create one rather than fail: a
        # ticketSequence payment cannot be built without a ticket.
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        payload = _client(wallet, ticket=None, created_tickets=[77]).create_payment_payload(
            requirements
        )
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert tx["TicketSequence"] == 77
        assert tx["Sequence"] == 0

    def test_prefers_a_ticket_the_payer_already_holds(self):
        # Each ticket locks owner reserve, so creating one the payer does not
        # need is a real cost.
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        payload = _client(wallet, ticket=42, created_tickets=[77]).create_payment_payload(
            requirements
        )
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert tx["TicketSequence"] == 42

    def test_creation_can_be_turned_off(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        client = _client(wallet, ticket=None, ticket_create_count=0)
        with pytest.raises(ValueError, match="disabled"):
            client.create_payment_payload(requirements)

    def test_a_creation_that_yields_nothing_is_an_error(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        client = _client(wallet, ticket=None, created_tickets=[])
        with pytest.raises(ValueError, match="no tickets"):
            client.create_payment_payload(requirements)

    def test_builds_an_issued_currency_amount(self):
        wallet = make_wallet()
        requirements = make_requirements(
            asset="USD",
            amount="1.5",
            extra={"assetTransferMethod": "sequence", "issuer": MERCHANT},
        )
        payload = _client(wallet).create_payment_payload(requirements)
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert tx["Amount"] == {"currency": "USD", "issuer": MERCHANT, "value": "1.5"}
        # Mandatory for issued currencies, or the facilitator must reject it.
        assert tx["SendMax"] == tx["Amount"]

    def test_requires_an_issuer_for_issued_currencies(self):
        wallet = make_wallet()
        requirements = make_requirements(asset="USD", amount="1.5", extra={})
        with pytest.raises(ValueError, match="issuer"):
            _client(wallet).create_payment_payload(requirements)

    def test_rejects_a_scheme_it_does_not_implement(self):
        wallet = make_wallet()
        requirements = make_requirements()
        requirements.scheme = "upto"
        with pytest.raises(ValueError, match="scheme"):
            _client(wallet).create_payment_payload(requirements)

    def test_rejects_an_unknown_transfer_method(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "telepathy"})
        with pytest.raises(ValueError, match="asset_transfer_method"):
            _client(wallet).create_payment_payload(requirements)

    def test_sets_the_destination_tag_a_hosted_account_requires(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": 12345}
        )
        payload = _client(wallet).create_payment_payload(requirements)
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert tx["DestinationTag"] == 12345

    @pytest.mark.parametrize("tag", [2**32, -1, 2**40])
    def test_rejects_a_destination_tag_outside_the_uint32_range(self, tag):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": tag}
        )
        with pytest.raises(ValueError, match="destinationTag"):
            _client(wallet).create_payment_payload(requirements)

    @pytest.mark.parametrize("tag", [1.5, "12345", None.__class__, True])
    def test_refuses_to_coerce_a_non_integer_destination_tag(self, tag):
        # int(1.5) is 1: a silently different tag credits a different customer.
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": tag}
        )
        with pytest.raises(ValueError, match="destinationTag"):
            _client(wallet).create_payment_payload(requirements)

    def test_rejects_a_non_xrpl_network(self):
        wallet = make_wallet()
        requirements = make_requirements()
        requirements.network = "eip155:1"
        with pytest.raises(ValueError, match="network"):
            _client(wallet).create_payment_payload(requirements)


class TestClientFacilitatorAgreement:
    """The client must build what the facilitator accepts."""

    def test_a_client_built_payment_verifies(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "invoiceId": INVOICE_ID}
        )
        payload_dict = _client(wallet).create_payment_payload(requirements)
        payload = make_payload(payload_dict["signedTxBlob"], requirements)

        facilitator = ExactXrplFacilitatorScheme(
            make_options(ledger_index=CURRENT_LEDGER, sequence=7)
        )
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is True, result.invalid_reason
        assert result.payer == wallet.address

    def test_a_client_built_ticket_payment_verifies(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        payload_dict = _client(wallet).create_payment_payload(requirements)
        payload = make_payload(payload_dict["signedTxBlob"], requirements)

        facilitator = ExactXrplFacilitatorScheme(make_options(ledger_index=CURRENT_LEDGER))
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is True, result.invalid_reason


class TestClientRefusesMalformedAmounts:
    """A malformed amount would otherwise surface as an opaque serialiser
    error after the ledger reads already happened."""

    def test_an_xrp_amount_that_is_not_drops_is_refused(self):
        wallet = make_wallet()
        requirements = make_requirements(amount="10.50")
        with pytest.raises(ValueError, match="drops"):
            _client(wallet).create_payment_payload(requirements)

    def test_an_issued_amount_that_is_not_a_plain_decimal_is_refused(self):
        wallet = make_wallet()
        requirements = make_requirements(
            asset="USD",
            amount="1e5",
            extra={"assetTransferMethod": "sequence", "issuer": ISSUER},
        )
        with pytest.raises(ValueError, match="decimal string"):
            _client(wallet).create_payment_payload(requirements)

    def test_an_issuer_that_is_not_an_address_is_refused(self):
        wallet = make_wallet()
        requirements = make_requirements(
            asset="USD",
            amount="1.5",
            extra={"assetTransferMethod": "sequence", "issuer": "not-an-address"},
        )
        with pytest.raises(ValueError, match="issuer"):
            _client(wallet).create_payment_payload(requirements)

    def test_a_currency_code_the_ledger_cannot_express_is_refused(self):
        # Without the check this surfaces as the serialiser's own exception,
        # after the account sequence was already fetched.
        wallet = make_wallet()
        requirements = make_requirements(
            asset="TOOLONG",
            amount="1.5",
            extra={"assetTransferMethod": "sequence", "issuer": ISSUER},
        )
        reads: list[str] = []
        options = make_client_options()
        options.get_account_sequence = lambda _account, _net: reads.append("sequence") or 7

        with pytest.raises(ValueError, match="3-character code"):
            ExactXrplClientScheme(wallet, options).create_payment_payload(requirements)
        assert reads == []


class TestTicketCreateCountIsValidated:
    @pytest.mark.parametrize("count", [-1, 1.5, 251, True])
    def test_an_impossible_count_is_refused_before_any_network_call(self, count):
        # A fractional or out-of-range count must not reach a live
        # TicketCreate, and a negative one must not read as creation disabled.
        # "Before any network call" includes the ledger-index read, so the
        # check runs before the transaction is built rather than beside the
        # ticket lookup.
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        reads: list[str] = []
        options = make_client_options(ticket=None, ticket_create_count=count)
        options.get_current_ledger_index = lambda _net: reads.append("ledger") or CURRENT_LEDGER

        with pytest.raises(ValueError, match="ticket_create_count"):
            ExactXrplClientScheme(wallet, options).create_payment_payload(requirements)
        assert reads == []

    def test_a_malformed_destination_tag_is_refused_before_any_network_call(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": 1.5}
        )
        reads: list[str] = []
        options = make_client_options()
        options.get_current_ledger_index = lambda _net: reads.append("ledger") or CURRENT_LEDGER

        with pytest.raises(ValueError, match="destinationTag"):
            ExactXrplClientScheme(wallet, options).create_payment_payload(requirements)
        assert reads == []


class TestClientBindsHighIdNetworks:
    """Above 1024 a signed NetworkID is what stops a payment replaying on
    another chain, and the facilitator requires it. A client that omits it
    builds payments no facilitator will accept."""

    HIGH_ID_NETWORK = "xrpl:2000"

    def test_a_high_id_network_payment_carries_its_network_id(self):
        wallet = make_wallet()
        requirements = make_requirements(network=self.HIGH_ID_NETWORK)
        payload = _client(wallet).create_payment_payload(requirements)
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert tx["NetworkID"] == 2000

    def test_a_standard_network_payment_omits_it(self):
        # rippled rejects the field outright below the ceiling.
        wallet = make_wallet()
        payload = _client(wallet).create_payment_payload(make_requirements())
        tx = decode_signed_transaction_blob(payload["signedTxBlob"])
        assert "NetworkID" not in tx

    def test_the_facilitator_accepts_what_the_client_builds(self):
        # The round trip is the point: neither side is checked against a
        # hard-coded expectation, only against the other.
        wallet = make_wallet()
        requirements = make_requirements(network=self.HIGH_ID_NETWORK)
        blob = _client(wallet).create_payment_payload(requirements)["signedTxBlob"]
        scheme = ExactXrplFacilitatorScheme(make_options())
        result = scheme.verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is True, result.invalid_reason


class TestClientRefusesDoomedRequirements:
    """Signing a payment the facilitator is bound to reject spends the payer's
    sequence on a request that cannot be paid, and reports the fault against
    the payer rather than the server that published the terms."""

    def test_requirements_that_omit_fee_sponsorship_are_refused(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence"}, fees_sponsored=None
        )
        with pytest.raises(ValueError, match="areFeesSponsored"):
            _client(wallet).create_payment_payload(requirements)

    def test_requirements_claiming_sponsored_fees_are_refused(self):
        wallet = make_wallet()
        requirements = make_requirements(fees_sponsored=True)
        with pytest.raises(ValueError, match="areFeesSponsored"):
            _client(wallet).create_payment_payload(requirements)

    @pytest.mark.parametrize("invoice_id", ["", 7, {}])
    def test_an_unusable_invoice_id_is_refused(self, invoice_id):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "invoiceId": invoice_id}
        )
        with pytest.raises(ValueError, match="invoiceId"):
            _client(wallet).create_payment_payload(requirements)


class TestTheThreeSidesAgree:
    """Every other test drives one side with requirements a test wrote. These
    drive the real chain: the server prices and enriches, the client pays what
    it was given, the facilitator judges what the client produced. A rule
    tightened on one side and not another shows up here and nowhere else."""

    def _requirements(self, price, network="xrpl:1", extra=None):
        server = ExactXrplServerScheme()
        parsed = server.parse_price(price, network)
        base = PaymentRequirements(
            scheme="exact",
            network=network,
            asset=parsed.asset,
            amount=parsed.amount,
            pay_to=MERCHANT,
            max_timeout_seconds=60,
            extra={**(parsed.extra or {}), **(extra or {})},
        )
        kind = SupportedKind(x402_version=2, scheme="exact", network=network, extra=None)
        return server.enhance_payment_requirements(base, kind, [])

    def test_an_xrp_payment_priced_by_the_server_verifies_and_settles(self):
        wallet = make_wallet()
        requirements = self._requirements(AssetAmount(amount="1000", asset="XRP", extra={}))

        blob = _client(wallet).create_payment_payload(requirements)["signedTxBlob"]
        facilitator = ExactXrplFacilitatorScheme(make_options())
        payload = make_payload(blob, requirements)

        assert facilitator.verify(payload, requirements).is_valid is True
        assert facilitator.settle(payload, requirements).success is True

    def test_an_issued_currency_payment_priced_by_the_server_verifies(self):
        wallet = make_wallet()
        requirements = self._requirements(
            AssetAmount(amount="1.5", asset="USD", extra={"issuer": ISSUER})
        )
        blob = _client(wallet).create_payment_payload(requirements)["signedTxBlob"]
        result = ExactXrplFacilitatorScheme(make_options()).verify(
            make_payload(blob, requirements), requirements
        )
        assert result.is_valid is True, result.invalid_reason

    def test_an_invoice_bound_payment_priced_by_the_server_verifies(self):
        wallet = make_wallet()
        requirements = self._requirements(
            AssetAmount(amount="1000", asset="XRP", extra={}), extra={"invoiceId": INVOICE_ID}
        )
        blob = _client(wallet).create_payment_payload(requirements)["signedTxBlob"]
        result = ExactXrplFacilitatorScheme(make_options()).verify(
            make_payload(blob, requirements), requirements
        )
        assert result.is_valid is True, result.invalid_reason

    def test_a_tagged_ticket_payment_priced_by_the_server_verifies(self):
        wallet = make_wallet()
        requirements = self._requirements(
            AssetAmount(amount="1000", asset="XRP", extra={}),
            extra={"assetTransferMethod": "ticketSequence", "destinationTag": 42},
        )
        blob = _client(wallet).create_payment_payload(requirements)["signedTxBlob"]
        result = ExactXrplFacilitatorScheme(make_options()).verify(
            make_payload(blob, requirements), requirements
        )
        assert result.is_valid is True, result.invalid_reason

    def test_the_server_declares_fee_sponsorship_the_other_two_sides_demand(self):
        # Both the client and the facilitator now require this field. If the
        # server ever stopped emitting it, every payment would stop.
        requirements = self._requirements(AssetAmount(amount="1000", asset="XRP", extra={}))
        assert requirements.extra["areFeesSponsored"] is False
