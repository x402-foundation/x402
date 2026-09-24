"""Tests for XRPL ledger access.

The settlement path polls until the ledger reports validation. That loop decides
whether a resource server releases paid content, so it is exercised here against
a fake node rather than only in the live tests.
"""

from __future__ import annotations

import asyncio

import pytest
from xrpl.core import binarycodec
from xrpl.models.transactions import Payment
from xrpl.transaction import sign
from xrpl.wallet import Wallet

from x402.mechanisms.xrpl import ledger
from x402.mechanisms.xrpl.constants import XRPL_MAINNET, XRPL_TESTNET


class FakeClient:
    """Returns queued responses and records the requests it received."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []

    def request(self, request):
        self.requests.append(request)
        result = self._responses.pop(0) if self._responses else {}

        class Response:
            def __init__(self, payload, ok=True):
                self.result = payload
                self._ok = ok

            def is_successful(self):
                return self._ok

        if isinstance(result, Exception):
            raise result
        ok = result.pop("__ok__", True)
        return Response(result, ok)


def _signed_blob() -> str:
    """A real signed payment, since simulation decodes what it is given."""
    wallet = Wallet.create()
    payment = Payment(
        account=wallet.address,
        destination="rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
        amount="1000",
        fee="12",
        sequence=1,
        last_ledger_sequence=100,
    )
    return binarycodec.encode(sign(payment, wallet).to_xrpl())


@pytest.fixture
def fake(monkeypatch):
    """Install a fake client and return a factory for queueing responses."""

    def install(responses):
        client = FakeClient(responses)
        monkeypatch.setattr(ledger, "get_client", lambda *a, **k: client)
        monkeypatch.setattr(ledger.time, "sleep", lambda _s: None)
        return client

    return install


class TestEndpointResolution:
    def test_defaults_per_network(self):
        assert ledger.resolve_rpc_url(XRPL_MAINNET).startswith("https://s1.ripple.com")
        assert "altnet" in ledger.resolve_rpc_url(XRPL_TESTNET)

    def test_an_override_wins(self):
        assert (
            ledger.resolve_rpc_url(XRPL_TESTNET, {XRPL_TESTNET: "https://my.node/"})
            == "https://my.node/"
        )

    def test_an_unknown_network_is_an_error(self):
        with pytest.raises(ValueError, match="No JSON-RPC endpoint"):
            ledger.resolve_rpc_url("xrpl:9")

    def test_clients_are_reused_per_endpoint(self):
        first = ledger.get_client(XRPL_TESTNET)
        assert ledger.get_client(XRPL_TESTNET) is first


class TestReads:
    def test_reads_the_validated_ledger_index(self, fake):
        fake([{"ledger_index": 42}])
        assert ledger.get_current_ledger_index(XRPL_TESTNET) == 42

    def test_falls_back_to_the_nested_ledger_index(self, fake):
        # Some nodes report it only inside the ledger object.
        fake([{"ledger": {"ledger_index": 43}}])
        assert ledger.get_current_ledger_index(XRPL_TESTNET) == 43

    def test_reads_the_account_sequence(self, fake):
        fake([{"account_data": {"Sequence": 7}}])
        assert ledger.get_account_sequence("rAcct", XRPL_TESTNET) == 7

    def test_a_node_failure_is_raised_not_swallowed(self, fake):
        fake([{"__ok__": False, "error": "actNotFound"}])
        with pytest.raises(RuntimeError, match="XRPL request failed"):
            ledger.get_account_sequence("rAcct", XRPL_TESTNET)

    def test_reads_signing_authority(self, fake):
        fake([{"account_data": {"RegularKey": "rReg", "Flags": 0}}])
        auth = ledger.get_account_authorization("rAcct", XRPL_TESTNET)
        assert auth.regular_key == "rReg"
        assert auth.is_master_key_disabled is False

    def test_detects_a_disabled_master_key(self, fake):
        fake([{"account_data": {"Flags": ledger.LSF_DISABLE_MASTER}}])
        auth = ledger.get_account_authorization("rAcct", XRPL_TESTNET)
        assert auth.is_master_key_disabled is True
        assert auth.regular_key is None


class TestTickets:
    def test_finds_a_ticket(self, fake):
        fake([{"account_objects": [{"LedgerEntryType": "Ticket", "TicketSequence": 9}]}])
        assert ledger.is_ticket_available("rAcct", 9, XRPL_TESTNET) is True

    def test_reports_a_missing_ticket(self, fake):
        fake([{"account_objects": []}])
        assert ledger.is_ticket_available("rAcct", 9, XRPL_TESTNET) is False

    def test_follows_pagination_before_giving_up(self, fake):
        client = fake(
            [
                {
                    "account_objects": [{"LedgerEntryType": "Ticket", "TicketSequence": 1}],
                    "marker": "m",
                },
                {"account_objects": [{"LedgerEntryType": "Ticket", "TicketSequence": 9}]},
            ]
        )
        assert ledger.is_ticket_available("rAcct", 9, XRPL_TESTNET) is True
        assert len(client.requests) == 2

    def test_a_node_that_repeats_markers_cannot_hang_the_walk(self, monkeypatch):
        # Pagination trusts the node to terminate, and every response in this
        # loop is "successful", so no per-request timeout fires. An honest
        # answer fits in one page per ticket; anything past that bound is a
        # node misbehaving, and the only safe reply is "not found".
        from x402.mechanisms.xrpl.constants import MAX_ACCOUNT_TICKETS

        class RepeatingMarkerClient:
            def __init__(self):
                self.requests = 0

            def request(self, _request):
                self.requests += 1
                if self.requests > MAX_ACCOUNT_TICKETS:
                    raise AssertionError("pagination did not stop at the bound")

                class Response:
                    result = {"account_objects": [], "marker": "again"}

                    def is_successful(self):
                        return True

                return Response()

        client = RepeatingMarkerClient()
        monkeypatch.setattr(ledger, "get_client", lambda *a, **k: client)
        assert ledger.is_ticket_available("rAcct", 9, XRPL_TESTNET) is False
        assert client.requests == MAX_ACCOUNT_TICKETS

    def test_returns_the_lowest_available_ticket(self, fake):
        fake(
            [
                {
                    "account_objects": [
                        {"LedgerEntryType": "Ticket", "TicketSequence": 12},
                        {"LedgerEntryType": "Ticket", "TicketSequence": 5},
                    ]
                }
            ]
        )
        assert ledger.get_available_ticket_sequence("rAcct", XRPL_TESTNET) == 5

    def test_the_lowest_ticket_is_found_past_the_first_page(self, fake):
        # A one-page read would report an account whose tickets sit on a later
        # page as holding none, and the client would create an unnecessary
        # ticket, locking owner reserve.
        client = fake(
            [
                {
                    "account_objects": [{"LedgerEntryType": "Ticket", "TicketSequence": 12}],
                    "marker": "m",
                },
                {"account_objects": [{"LedgerEntryType": "Ticket", "TicketSequence": 5}]},
            ]
        )
        assert ledger.get_available_ticket_sequence("rAcct", XRPL_TESTNET) == 5
        assert len(client.requests) == 2

    def test_returns_none_when_the_account_holds_no_ticket(self, fake):
        fake([{"account_objects": []}])
        assert ledger.get_available_ticket_sequence("rAcct", XRPL_TESTNET) is None


class TestSubmissionIsFailHard:
    def test_submission_asks_the_node_not_to_hold_a_failing_transaction(self, fake):
        # Without fail_hard, rippled may queue a transaction whose preliminary
        # result is not tesSUCCESS and retry it. This call would report it
        # unvalidated, the resource server would refuse to serve, and the
        # payment could still land afterwards, charging the payer for nothing.
        client = fake(
            [
                {"engine_result": "tesSUCCESS", "tx_json": {"hash": "H"}},
                {"validated": True, "meta": {"TransactionResult": "tesSUCCESS"}},
            ]
        )
        ledger.submit_signed_transaction("00", XRPL_TESTNET, timeout_seconds=5)
        assert client.requests[0].fail_hard is True


class TestSettlementWaitsForValidation:
    def test_reports_success_only_once_the_ledger_validates(self, fake):
        fake(
            [
                {"engine_result": "tesSUCCESS", "tx_json": {"hash": "H1"}},
                {"validated": False},
                {"validated": True, "meta": {"TransactionResult": "tesSUCCESS"}},
            ]
        )
        result = ledger.submit_signed_transaction("00", XRPL_TESTNET, timeout_seconds=5)
        assert result.validated is True
        assert result.result_code == "tesSUCCESS"
        # Derived from the blob rather than read back from the node.
        assert result.hash == ledger.get_signed_transaction_hash("00")

    def test_surfaces_a_validated_failure(self, fake):
        # Provisionally applied, then failed on validation: exactly the case
        # that must not be reported as a successful payment.
        fake(
            [
                {"engine_result": "tesSUCCESS", "tx_json": {"hash": "H2"}},
                {"validated": True, "meta": {"TransactionResult": "tecUNFUNDED_PAYMENT"}},
            ]
        )
        result = ledger.submit_signed_transaction("00", XRPL_TESTNET, timeout_seconds=5)
        assert result.validated is True
        assert result.result_code == "tecUNFUNDED_PAYMENT"

    def test_does_not_claim_validation_when_the_wait_times_out(self, fake):
        fake([{"engine_result": "tesSUCCESS", "tx_json": {"hash": "H3"}}, {"validated": False}])
        result = ledger.submit_signed_transaction(
            "00", XRPL_TESTNET, timeout_seconds=0.01, poll_interval_seconds=0.001
        )
        assert result.validated is False

    def test_gives_up_immediately_on_an_outright_rejection(self, fake):
        # temMALFORMED can never validate, so polling would only waste time.
        client = fake([{"engine_result": "temMALFORMED", "tx_json": {"hash": "H4"}}])
        result = ledger.submit_signed_transaction("00", XRPL_TESTNET, timeout_seconds=5)
        assert result.validated is False
        assert result.result_code == "temMALFORMED"
        assert len(client.requests) == 1

    def test_keeps_polling_while_the_transaction_is_not_yet_visible(self, fake):
        client = fake(
            [
                {"engine_result": "tesSUCCESS", "tx_json": {"hash": "H5"}},
                {"__ok__": False, "error": "txnNotFound"},
                {"validated": True, "meta": {"TransactionResult": "tesSUCCESS"}},
            ]
        )
        result = ledger.submit_signed_transaction("00", XRPL_TESTNET, timeout_seconds=5)
        assert result.validated is True
        assert len(client.requests) == 3


class TestSimulation:
    """The dry run is what lets verification refuse a payment that would fail
    on ledger, so its result must be read rather than assumed."""

    def test_reads_the_engine_result(self, fake):
        fake([{"engine_result": "tecUNFUNDED_PAYMENT"}])
        assert (
            ledger.simulate_signed_transaction(_signed_blob(), XRPL_TESTNET)
            == "tecUNFUNDED_PAYMENT"
        )

    def test_missing_engine_result_is_empty_not_an_exception(self, fake):
        fake([{}])
        assert ledger.simulate_signed_transaction(_signed_blob(), XRPL_TESTNET) == ""

    def test_the_signature_is_stripped_before_simulating(self, fake):
        # rippled refuses to simulate a signed transaction (it answers
        # `transactionSigned`) because simulate exists to dry-run a
        # transaction still being built. Sending the blob as-is fails against
        # every real node while passing against any fake that does not check.
        client = fake([{"engine_result": "tesSUCCESS"}])
        ledger.simulate_signed_transaction(_signed_blob(), XRPL_TESTNET)

        sent = binarycodec.decode(client.requests[0].tx_blob)
        assert "TxnSignature" not in sent
        assert sent["SigningPubKey"] == ""

    def test_every_non_signing_field_is_stripped_before_simulating(self, fake):
        # rippled refuses to simulate anything carrying signature material, and
        # the set is wider than TxnSignature alone. Stripping only the ones this
        # scheme happens to know about would send the rest to the node.
        from x402.mechanisms.xrpl.utils import ALLOWED_NON_SIGNING_FIELDS

        client = fake([{"engine_result": "tesSUCCESS"}])
        blob = _signed_blob()
        decoded = binarycodec.decode(blob)
        decoded["Signers"] = [
            {
                "Signer": {
                    "Account": Wallet.create().address,
                    "SigningPubKey": "ED" + "A" * 64,
                    "TxnSignature": "AB" * 32,
                }
            }
        ]
        ledger.simulate_signed_transaction(binarycodec.encode(decoded), XRPL_TESTNET)

        sent = binarycodec.decode(client.requests[0].tx_blob)
        for field in ALLOWED_NON_SIGNING_FIELDS:
            assert field not in sent, f"{field} reached the node"

    def test_the_simulated_fields_are_otherwise_untouched(self, fake):
        # A dry run of different terms tells the facilitator nothing.
        client = fake([{"engine_result": "tesSUCCESS"}])
        blob = _signed_blob()
        ledger.simulate_signed_transaction(blob, XRPL_TESTNET)

        original = binarycodec.decode(blob)
        sent = binarycodec.decode(client.requests[0].tx_blob)
        ignored = {"TxnSignature", "SigningPubKey"}
        assert {k: v for k, v in sent.items() if k not in ignored} == {
            k: v for k, v in original.items() if k not in ignored
        }


class TestTicketCreation:
    """A ticketSequence payer that holds no ticket must create one before it
    can sign. Each ticket locks owner reserve until it is spent."""

    def _meta(self, sequences, other_nodes=()):
        return {
            "AffectedNodes": [
                *other_nodes,
                *(
                    {
                        "CreatedNode": {
                            "LedgerEntryType": "Ticket",
                            "NewFields": {"TicketSequence": sequence},
                        }
                    }
                    for sequence in sequences
                ),
            ]
        }

    def test_reads_the_sequences_the_ledger_assigned(self):
        # The ledger picks them, so they are read from metadata, not predicted.
        assert ledger.created_ticket_sequences(self._meta([31, 30])) == [30, 31]

    def test_ignores_nodes_that_are_not_created_tickets(self):
        other = [
            {"ModifiedNode": {"LedgerEntryType": "AccountRoot"}},
            {"CreatedNode": {"LedgerEntryType": "Offer", "NewFields": {"TicketSequence": 9}}},
            {"CreatedNode": {"LedgerEntryType": "Ticket", "NewFields": {}}},
        ]
        assert ledger.created_ticket_sequences(self._meta([7], other)) == [7]

    def test_a_node_entry_that_is_not_a_mapping_is_skipped(self):
        assert ledger.created_ticket_sequences({"AffectedNodes": ["junk", None, 7]}) == []

    @pytest.mark.parametrize("meta", [None, "", [], {}, {"AffectedNodes": []}])
    def test_metadata_without_tickets_yields_nothing_rather_than_raising(self, meta):
        assert ledger.created_ticket_sequences(meta) == []

    @pytest.mark.parametrize("count", [0, -1, 251])
    def test_an_impossible_ticket_count_is_refused_before_the_network(self, count):
        # An account may hold at most 250 outstanding tickets.
        with pytest.raises(ValueError, match="between 1 and 250"):
            ledger.create_tickets(Wallet.create(), XRPL_TESTNET, count)


class TestRunsInsideAnEventLoop:
    """xrpl-py's sync client is an ``asyncio.run`` wrapper, so a bare call on
    an event-loop thread raises RuntimeError, the exact shape of an async
    facilitator or client invoking this sync scheme inline. The ledger module
    must survive that, or every ledger read fails under an async wrapper."""

    class LoopHostileClient:
        """Mimics xrpl-py: request() runs its own asyncio.run."""

        def __init__(self, payload):
            self._payload = payload

        def request(self, _request):
            async def respond():
                class Response:
                    result = self._payload

                    def is_successful(self):
                        return True

                return Response()

            coro = respond()
            try:
                return asyncio.run(coro)
            except RuntimeError:
                # Closed so the refused coroutine does not warn at GC time;
                # xrpl-py's real client leaks it, which is fine for a test
                # double not to reproduce.
                coro.close()
                raise

    def test_a_ledger_read_works_on_an_event_loop_thread(self, monkeypatch):
        client = self.LoopHostileClient({"ledger_index": 42})
        monkeypatch.setattr(ledger, "get_client", lambda *a, **k: client)

        # The client alone reproduces the failure this guards against.
        async def bare():
            return client.request(None)

        with pytest.raises(RuntimeError, match="running event loop"):
            asyncio.run(bare())

        async def through_ledger():
            return ledger.get_current_ledger_index(XRPL_TESTNET)

        assert asyncio.run(through_ledger()) == 42

    def test_a_ledger_read_still_works_without_a_loop(self, monkeypatch):
        client = self.LoopHostileClient({"ledger_index": 42})
        monkeypatch.setattr(ledger, "get_client", lambda *a, **k: client)
        assert ledger.get_current_ledger_index(XRPL_TESTNET) == 42
