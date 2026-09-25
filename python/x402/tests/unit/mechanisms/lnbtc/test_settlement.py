"""Accepted wire proof, strict invoice validation and durable single consumption."""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from bech32 import bech32_decode, bech32_encode

from x402.mechanisms.lnbtc import MAINNET, TESTNET, SQLiteReplayStore, http_request_binding
from x402.mechanisms.lnbtc.exact.facilitator import ExactLnbtcScheme
from x402.schemas import PaymentPayload, PaymentRequirements

from .helpers import NOW, PREIMAGE, invoice


@pytest.fixture
def proof():
    # Verbatim public JSON examples from specs/schemes/exact/scheme_exact_lnbtc.md.
    vector = json.loads(Path(__file__).with_name("spec_http.json").read_text())
    return (
        PaymentPayload.model_validate(vector["payload"]),
        PaymentRequirements.model_validate(vector["requirements"]),
    )


@pytest.fixture
def facilitator(tmp_path):
    return ExactLnbtcScheme(SQLiteReplayStore(tmp_path / "replay.db"), clock=lambda: NOW)


def test_spec_proof_settles_without_node_access_and_omits_payer(proof, facilitator):
    result = facilitator.settle(*proof)
    assert result.success, result.error_reason
    assert result.transaction == "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e"
    assert result.network == MAINNET
    assert "payer" not in result.model_dump(exclude_none=True)
    assert facilitator.settle(*proof).error_reason == "duplicate_settlement"


def test_fresh_challenge_does_not_replace_accepted_invoice(proof, facilitator):
    payload, requirements = proof
    requirements.extra["invoice"] = invoice(
        requirements.extra["requestHash"], amount=int(requirements.amount)
    )
    assert requirements.extra["invoice"] != payload.accepted.extra["invoice"]
    assert facilitator.settle(payload, requirements).success


@pytest.mark.parametrize(
    "field,value,reason",
    [
        ("scheme", "other", "unsupported_scheme"),
        ("network", TESTNET, "network_mismatch"),
        ("asset", "btc", "invalid_exact_lnbtc_asset"),
        ("amount", "0", "invalid_exact_lnbtc_amount"),
        ("amount", "1", "invalid_exact_lnbtc_amount_mismatch"),
        ("pay_to", "bad", "invalid_exact_lnbtc_pay_to_mismatch"),
        ("max_timeout_seconds", 1, "invalid_exact_lnbtc_max_timeout_mismatch"),
    ],
)
def test_mismatched_terms(proof, facilitator, field, value, reason):
    setattr(proof[0].accepted, field, value)
    assert facilitator.settle(*proof).error_reason == reason


@pytest.mark.parametrize(
    "field,value,reason",
    [
        ("requestHash", None, "request_binding"),
        ("requestBindingProfile", "unknown", "request_binding"),
        ("requestBindingParams", {"headers": [], "unknown": True}, "request_binding"),
        ("requestBindingParams", {"headers": ["accept"]}, "request_mismatch"),
        ("assetTransferMethod", "other", "asset_transfer_method"),
        ("paymentFlow", None, "payment_flow"),
        ("invoice", "", "invoice_missing"),
        ("invoice", "garbage", "invoice_decode_failed"),
    ],
)
def test_untrusted_extra(proof, facilitator, field, value, reason):
    proof[0].accepted.extra[field] = value
    assert facilitator.settle(*proof).error_reason == "invalid_exact_lnbtc_" + reason


def test_defaults_and_additive_client_fields(proof, facilitator):
    payload, requirements = proof
    payload.accepted.extra.pop("assetTransferMethod")
    payload.accepted.extra["clientNote"] = "ignored"
    assert facilitator.settle(payload, requirements).success


def test_server_declared_extra_is_not_ignored(proof, facilitator):
    proof[1].extra["merchant"] = "expected"
    assert facilitator.settle(*proof).error_reason == "invalid_exact_lnbtc_extra_mismatch"


@pytest.mark.parametrize("echo", [False, True])
def test_article_substitution(proof, facilitator, echo):
    payload, requirements = proof
    binding = http_request_binding(
        "GET", "https://api.example.com/article/B", public_origin="https://api.example.com"
    )
    requirements.extra.update(binding.extra())
    if echo:
        payload.accepted.extra.update(binding.extra())
    expected = "invoice_request_mismatch" if echo else "request_mismatch"
    assert (
        facilitator.settle(payload, requirements).error_reason == "invalid_exact_lnbtc_" + expected
    )


@pytest.mark.parametrize(
    "kwargs,reason",
    [
        ({"inline_description": True}, "invoice_description"),
        ({"key": "2" * 64}, "invoice_payee_mismatch"),
        ({"currency": "tb"}, "invoice_currency_mismatch"),
        ({"amount": 1}, "invoice_amount_mismatch"),
        ({"expiry": 1}, "invoice_expiry_mismatch"),
        ({"date": NOW + 61}, "invoice_created_in_future"),
    ],
)
def test_signed_invoice_mismatches(proof, facilitator, kwargs, reason):
    payload, requirements = proof
    options = {"amount": int(requirements.amount), **kwargs}
    payload.accepted.extra["invoice"] = invoice(requirements.extra["requestHash"], **options)
    payload.payload["preimage"] = PREIMAGE
    assert facilitator.settle(payload, requirements).error_reason == "invalid_exact_lnbtc_" + reason


def test_invoice_created_at_clock_skew_boundary_is_valid(proof, tmp_path):
    """Spec: creation time equal to now + clock skew is valid; one second later is not."""
    payload, requirements = proof
    payload.accepted.extra["invoice"] = invoice(
        requirements.extra["requestHash"],
        amount=int(requirements.amount),
        date=NOW + 60,
    )
    payload.payload["preimage"] = PREIMAGE
    facility = ExactLnbtcScheme(SQLiteReplayStore(tmp_path / "skew.db"), clock=lambda: NOW)
    assert facility.settle(payload, requirements).success


@pytest.mark.parametrize(
    "preimage,reason",
    [
        (None, "preimage_missing"),
        ("ABC", "preimage_malformed"),
        ("a" * 63, "preimage_length"),
        ("00" * 32, "preimage_hash_mismatch"),
    ],
)
def test_bad_proof_does_not_consume_invoice(proof, facilitator, preimage, reason):
    payload, requirements = proof
    original = payload.payload["preimage"]
    payload.payload["preimage"] = preimage
    assert facilitator.settle(payload, requirements).error_reason == "invalid_exact_lnbtc_" + reason
    payload.payload["preimage"] = original
    assert facilitator.settle(payload, requirements).success


@pytest.mark.parametrize("offset,success", [(300, True), (360, True), (361, False)])
def test_paid_expiry_boundary(proof, tmp_path, offset, success):
    facility = ExactLnbtcScheme(
        SQLiteReplayStore(tmp_path / "expiry.db"), clock=lambda: NOW + offset
    )
    result = facility.settle(*proof)
    assert result.success is success
    if not success:
        assert result.error_reason == "invalid_exact_lnbtc_invoice_expired"


def test_concurrent_instances_restart_and_retention(proof, tmp_path):
    path = tmp_path / "shared.db"
    instances = [ExactLnbtcScheme(SQLiteReplayStore(path), clock=lambda: NOW) for _ in range(12)]
    with ThreadPoolExecutor(max_workers=12) as workers:
        results = list(workers.map(lambda item: item.settle(*proof), instances))
    assert sum(result.success for result in results) == 1
    assert sum(result.error_reason == "duplicate_settlement" for result in results) == 11
    restarted = ExactLnbtcScheme(SQLiteReplayStore(path), clock=lambda: NOW)
    assert restarted.settle(*proof).error_reason == "duplicate_settlement"
    with sqlite3.connect(path) as connection:
        key, retain_until = connection.execute(
            "SELECT key, retain_until FROM x402_lightning_consumed"
        ).fetchone()
    assert (
        key
        == MAINNET
        + ":"
        + results[next(i for i, result in enumerate(results) if result.success)].transaction
    )
    assert retain_until == NOW + 300 + 60 + 3600


def test_store_failure_cannot_grant_access(proof):
    class BrokenStore:
        def consume(self, key, retain_until):
            raise OSError("unavailable")

    result = ExactLnbtcScheme(BrokenStore(), clock=lambda: NOW).settle(*proof)
    assert not result.success
    assert result.error_reason == "settlement_failed"


def test_verify_never_consumes(proof, facilitator):
    assert not facilitator.verify(*proof).is_valid
    assert facilitator.settle(*proof).success


@pytest.mark.parametrize("path", ["", ":memory:", "file:memory?mode=memory"])
def test_nonpersistent_sqlite_rejected(path):
    with pytest.raises(ValueError, match="persistent"):
        SQLiteReplayStore(path)


@pytest.mark.parametrize(
    "mutation", ["mixed-case", "checksum", "duplicate-h", "padding", "fractional-msat"]
)
def test_strict_bolt11_rejections(proof, facilitator, mutation):
    payload, _ = proof
    original = payload.accepted.extra["invoice"]
    hrp, words = bech32_decode(original)
    if mutation == "mixed-case":
        modified = original[:4].upper() + original[4:]
    elif mutation == "checksum":
        modified = original[:-1] + ("q" if original[-1] != "q" else "p")
    elif mutation == "fractional-msat":
        modified = bech32_encode("lnbc11p", words)
    else:
        # Insert another h tag or corrupt p padding while preserving Bech32 checksum.
        if mutation == "duplicate-h":
            from bech32 import CHARSET

            modified = bech32_encode(
                hrp, words[:-104] + [CHARSET.index("h"), 1, 20] + [0] * 52 + words[-104:]
            )
        else:
            words[61] |= 1
            modified = bech32_encode(hrp, words)
    payload.accepted.extra["invoice"] = modified
    expected = "invoice_description" if mutation == "duplicate-h" else "invoice_decode_failed"
    assert facilitator.settle(*proof).error_reason == "invalid_exact_lnbtc_" + expected


def test_same_hash_has_separate_consumption_on_each_network(proof, facilitator):
    payload, requirements = proof
    for network, currency in ((MAINNET, "bc"), (TESTNET, "tb")):
        payload.accepted.network = requirements.network = network
        value = invoice(
            requirements.extra["requestHash"], amount=int(requirements.amount), currency=currency
        )
        payload.accepted.extra["invoice"] = requirements.extra["invoice"] = value
        payload.payload["preimage"] = PREIMAGE
        assert facilitator.settle(payload, requirements).success
