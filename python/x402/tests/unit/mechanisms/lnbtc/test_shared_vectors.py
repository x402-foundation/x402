"""Load the same versioned Lightning vectors as the TypeScript SDK."""

import copy
import json
import sqlite3
from collections.abc import Callable
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from x402 import x402ClientSync
from x402.mechanisms.lnbtc import (
    MAINNET,
    LightningPayment,
    RequestBinding,
    SQLiteReplayStore,
    http_request_binding,
    mcp_request_binding,
)
from x402.mechanisms.lnbtc.constants import LightningValidationError
from x402.mechanisms.lnbtc.exact.client import ExactLnbtcScheme as Client
from x402.mechanisms.lnbtc.exact.facilitator import ExactLnbtcScheme as Facilitator
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements
from x402.schemas.errors import PaymentAbortedError

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[6] / "specs/schemes/exact/vectors/exact_lnbtc.json"
    ).read_text(encoding="utf-8")
)
assert VECTORS["fixture_version"] == 1


def patched(base: dict[str, Any], patch: list[dict[str, Any]]) -> dict[str, Any]:
    document = copy.deepcopy(base)
    for operation in patch:
        parts = [
            part.replace("~1", "/").replace("~0", "~") for part in operation["path"].split("/")[1:]
        ]
        parent = document
        for part in parts[:-1]:
            parent = parent[part]
        if operation["op"] == "remove":
            del parent[parts[-1]]
        else:
            assert operation["op"] in ("add", "replace")
            if operation["op"] == "replace":
                assert parts[-1] in parent
            parent[parts[-1]] = copy.deepcopy(operation["value"])
    return document


def assert_outcome(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    outcomes = expected["outcomes"].values() if "open" in expected else [expected]
    if "open" in expected:
        assert expected["open"] in VECTORS["open_questions"]
    if "forbidden_request_hash" in expected:
        assert actual.get("request_hash") != expected["forbidden_request_hash"]
    assert any(
        actual == {key: value for key, value in outcome.items() if key != "canonical_description"}
        and (
            "canonical_description" not in outcome
            or sha256(outcome["canonical_description"].encode()).hexdigest()
            == actual["request_hash"]
        )
        for outcome in outcomes
    ), (actual, expected)


def binding_outcome(binding: Callable[[], RequestBinding]) -> dict[str, Any]:
    try:
        return {"request_hash": binding().digest}
    except (LightningValidationError, json.JSONDecodeError) as exc:
        return {
            "error": str(exc)
            if isinstance(exc, LightningValidationError)
            else "invalid_exact_lnbtc_request_binding"
        }


def http_binding(data: dict[str, Any], origin: str) -> RequestBinding:
    return http_request_binding(
        data["method"],
        data["url"],
        public_origin=origin,
        body=bytes.fromhex(data["body_hex"]),
        headers=data["header_lines"],
        bound_headers=data["bound_headers"],
    )


@pytest.mark.parametrize("case", VECTORS["http_binding"], ids=lambda case: case["id"])
def test_shared_http_binding(case: dict[str, Any]) -> None:
    data = case["input"]
    url = urlsplit(data["url"])
    assert_outcome(
        binding_outcome(lambda: http_binding(data, f"{url.scheme}://{url.netloc}")), case["expect"]
    )


@pytest.mark.parametrize("case", VECTORS["http_server_adapter"], ids=lambda case: case["id"])
def test_shared_http_server_adapter(case: dict[str, Any]) -> None:
    data = {**case["input"], "bound_headers": case["config"]["bound_headers"]}
    assert_outcome(
        binding_outcome(lambda: http_binding(data, case["config"]["public_origin"])), case["expect"]
    )


@pytest.mark.parametrize("case", VECTORS["mcp_binding"], ids=lambda case: case["id"])
def test_shared_mcp_binding(case: dict[str, Any]) -> None:
    data = case["input"]

    def bind() -> RequestBinding:
        params = json.loads(data["params_json"]) if "params_json" in data else data["params"]
        return mcp_request_binding(
            data["server"],
            params,
            resource_url="https://api.example.com/article/A",
            bound_metadata=data["bound_metadata"],
        )

    assert_outcome(binding_outcome(bind), case["expect"])


@pytest.mark.parametrize("case", VECTORS["client"]["cases"], ids=lambda case: case["id"])
def test_shared_client(case: dict[str, Any]) -> None:
    document = patched(VECTORS["client"]["base"], case["patch"])
    required = PaymentRequired.model_validate(document["payment_required"])
    intended = document["intended_request"]
    calls = []

    class Payer:
        def pay_invoice(self, invoice: str, network: str) -> LightningPayment:
            calls.append((invoice, network))
            result = document["payer_result"]
            return LightningPayment(**{**result, "amount_msat": int(result["amount_msat"])})

    def bind() -> RequestBinding:
        if intended["profile"] == "http:1":
            data = intended["http"]
            url = urlsplit(data["url"])
            return http_binding(data, f"{url.scheme}://{url.netloc}")
        data = intended["mcp"]
        assert required.resource is not None
        return mcp_request_binding(
            data["server"],
            data["params"],
            resource_url=required.resource.url,
            bound_metadata=data["bound_metadata"],
        )

    client = (
        x402ClientSync()
        .set_spend_controls(
            {
                "allowed_assets": [
                    {"network": MAINNET, "asset": "BTC", "max_amount_per_payment": "25000"}
                ]
            }
        )
        .register(
            MAINNET, Client(Payer(), bind, clock=lambda: case["now"], clock_skew=case["skew"])
        )
    )
    try:
        payload = client.create_payment_payload(required)
        actual = {"preimage": payload.payload["preimage"]}
        assert len(calls) == 1
    except (LightningValidationError, PaymentAbortedError) as exc:
        actual = {
            "error": exc.reason if isinstance(exc, PaymentAbortedError) else str(exc),
            "payer_called": bool(calls),
        }
    assert len(calls) <= 1
    assert_outcome(actual, case["expect"])


@pytest.mark.parametrize(
    "case", VECTORS["facilitator_settle"]["cases"], ids=lambda case: case["id"]
)
def test_shared_facilitator_settle(case: dict[str, Any], tmp_path: Path) -> None:
    store = SQLiteReplayStore(tmp_path / "replay.db")
    for step in case["steps"]:
        document = patched(VECTORS["facilitator_settle"]["base"], step["patch"])
        payload = PaymentPayload.model_validate(document["payload"])
        required = PaymentRequirements.model_validate(document["requirements"])

        def clock(now: float = step["now"]) -> float:
            return now

        facilitator = Facilitator(store, clock=clock, clock_skew=step["skew"])
        with closing(sqlite3.connect(store.path)) as connection:
            before = connection.execute(
                "SELECT key, retain_until FROM x402_lightning_consumed"
            ).fetchall()
        result = facilitator.settle(payload, required)
        expected = step["expect"]
        assert result.success is expected["success"]
        with closing(sqlite3.connect(store.path)) as connection:
            after = connection.execute(
                "SELECT key, retain_until FROM x402_lightning_consumed"
            ).fetchall()
        if not expected["success"]:
            assert result.error_reason == expected["error_reason"]
            assert result.transaction == ""
            assert after == before
        else:
            assert result.transaction == expected["transaction"]
            assert result.network == expected["network"]
            assert "payer" not in result.model_dump(exclude_none=True)
            assert dict(after)[expected["replay_key"]] >= expected["retain_until_at_least"]
