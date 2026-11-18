"""Provider reads distinguish historical outputs from live UTxOs."""

import json
from fractions import Fraction
from pathlib import Path

import httpx
import pytest
from pycardano import Address, Network, VerificationKeyHash

from x402.mechanisms.cardano.provider import (
    BlockfrostConfig,
    CardanoProvider,
    CardanoProviderConfig,
    KoiosConfig,
)

ADDRESS = str(Address(VerificationKeyHash(bytes(28)), network=Network.TESTNET))
TX = "ab" * 32


def test_koios_protocol_parameters_use_koios_field_names():
    # Public Preprod epoch_params response; cost model arrays are not needed by this check.
    raw = json.loads(
        (Path(__file__).parent / "fixtures/koios_protocol_parameters.json").read_text()
    )
    calls = []

    def handler(request):
        calls.append(str(request.url))
        assert request.url.path == "/epoch_params"
        return httpx.Response(200, json=[raw])

    instance = CardanoProvider(
        CardanoProviderConfig(koios=KoiosConfig("https://example.invalid")),
        "cardano:preprod",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    parameters = instance.protocol_param
    assert parameters.max_block_header_size == 1100
    assert parameters.protocol_major_version == raw["protocol_major"]
    assert parameters.pool_influence == Fraction("0.3")
    assert parameters.coins_per_utxo_byte == 4310
    assert instance.protocol_param is parameters
    assert len(calls) == 1


def provider(handler):
    return CardanoProvider(
        CardanoProviderConfig(blockfrost=BlockfrostConfig("https://example.invalid")),
        "cardano:preprod",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


@pytest.mark.parametrize("consumed,exists", [(None, True), ("cd" * 32, False)])
def test_historical_output_spent_flag(consumed, exists):
    def handler(request):
        assert request.url.path == f"/txs/{TX}/utxos"
        return httpx.Response(
            200,
            json={
                "outputs": [
                    {
                        "output_index": 0,
                        "address": ADDRESS,
                        "amount": [{"unit": "lovelace", "quantity": "5000000"}],
                        "consumed_by_tx": consumed,
                    }
                ]
            },
        )

    snapshot = provider(handler).get_utxo(TX + "#0")
    assert snapshot.exists is exists
    assert snapshot.address == ADDRESS
    assert snapshot.payment_key_hash == "00" * 28
    assert snapshot.coin == (5_000_000 if exists else None)


def test_old_provider_falls_back_to_live_address_utxos():
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.startswith("/txs/"):
            return httpx.Response(
                200,
                json={
                    "outputs": [
                        {
                            "output_index": 0,
                            "address": ADDRESS,
                            "amount": [{"unit": "lovelace", "quantity": "5000000"}],
                        }
                    ]
                },
            )
        return httpx.Response(200, json=[])

    snapshot = provider(handler).get_utxo(TX + "#0")
    assert not snapshot.exists and snapshot.address == ADDRESS
    assert len(calls) == 2


def test_reference_script_output_remains_unspent_but_is_not_selected_for_funding():
    row = {
        "tx_hash": TX,
        "output_index": 0,
        "address": ADDRESS,
        "amount": [{"unit": "lovelace", "quantity": "5000000"}],
        "reference_script_hash": "cd" * 28,
    }

    def handler(request):
        return httpx.Response(
            200, json={"outputs": [row]} if request.url.path.startswith("/txs/") else [row]
        )

    instance = provider(handler)
    assert instance.get_utxo(TX + "#0").exists
    assert instance.utxos(ADDRESS) == []


def test_pagination_shares_one_request_deadline(monkeypatch):
    from x402.mechanisms.cardano import provider as module

    now = [0.0]
    calls = []
    monkeypatch.setattr(module.time, "monotonic", lambda: now[0])

    def handler(request):
        calls.append(request.extensions["timeout"]["read"])
        assert len(calls) <= 2, "Pagination exceeded the operation deadline"
        now[0] += 6
        return httpx.Response(200, json=[{}] * 100)

    with pytest.raises(TimeoutError):
        provider(handler).utxos(ADDRESS)
    assert calls == [10.0, 4.0]


@pytest.mark.parametrize("valid,depth", [(True, 3), (False, -2)])
def test_evidence_counts_blocks_after_inclusion(valid, depth):
    def handler(request):
        return httpx.Response(
            200,
            json=(
                {"valid_contract": valid, "block_height": 100}
                if request.url.path.startswith("/txs/")
                else {"height": 103}
            ),
        )

    assert provider(handler).get_transaction_evidence(TX).confirmations == depth


def test_provider_failures_do_not_report_unspent_or_confirmed():
    instance = provider(lambda request: httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        instance.get_utxo(TX + "#0")
    with pytest.raises(httpx.HTTPStatusError):
        instance.get_transaction_evidence(TX)


@pytest.mark.parametrize("timeout", [0, -1, 120001, True, 1.5])
def test_invalid_timeout(timeout):
    with pytest.raises(ValueError):
        CardanoProvider(
            CardanoProviderConfig(
                blockfrost=BlockfrostConfig("https://example.invalid"), request_timeout_ms=timeout
            ),
            "cardano:preprod",
        )
