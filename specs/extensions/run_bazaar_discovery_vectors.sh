#!/usr/bin/env bash
# Conformance checks for GET /discovery/resources filter behavior.
#
#   bash run_bazaar_discovery_vectors.sh --self-test
#   bash run_bazaar_discovery_vectors.sh https://example.com/discovery/resources
#
# Exit 0: conforming; 1: a conformance failure; 2: incomplete/unusable run.

set -uo pipefail
exec python3 - "$@" <<'PY'
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
from collections import namedtuple


VECTORS = [
    ("V1", "type",       "well-formed", "mcp"),
    ("V2", "payTo",      "well-formed", "0x0000000000000000000000000000000000000001"),
    ("V3", "scheme",     "well-formed", "batch-settlement"),
    ("V4", "network",    "well-formed", "eip155:999999999"),
    ("V5", "extensions", "well-formed", "payment-identifier"),
    ("V6", "network",    "malformed",   "!!!"),
]
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
Response = namedtuple("Response", "status body raw error")


def items(body):
    if isinstance(body, dict) and isinstance(body.get("items"), list):
        return body["items"]
    return None


def resources_are_usable(rows):
    if not isinstance(rows, list):
        return False
    for resource in rows:
        if not isinstance(resource, dict):
            return False
        if not isinstance(resource.get("type"), str):
            return False
        accepts = resource.get("accepts")
        if not isinstance(accepts, list) or not all(isinstance(a, dict) for a in accepts):
            return False
        extensions = resource.get("extensions")
        if extensions is not None and not isinstance(extensions, dict):
            return False
    return True


def unapplied(body):
    value = body.get("unappliedFilters") if isinstance(body, dict) else None
    if value is None:
        return []
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return value
    return None


def satisfies(resource, param, value):
    accepts = resource["accepts"]
    if param in ("network", "scheme"):
        return any(str(a.get(param)) == value for a in accepts)
    if param == "payTo":
        return any(str(a.get("payTo")).casefold() == value.casefold() for a in accepts)
    if param == "type":
        return resource["type"] == value
    if param == "extensions":
        extensions = resource.get("extensions")
        return isinstance(extensions, dict) and value in extensions
    return False


def has_error_reason(body):
    return (
        isinstance(body, dict)
        and isinstance(body.get("error"), str)
        and bool(body["error"].strip())
    )


def empty_total_is_zero(body):
    pagination = body.get("pagination") if isinstance(body, dict) else None
    return not (
        isinstance(pagination, dict)
        and "total" in pagination
        and pagination["total"] != 0
    )


def evaluate(param, value_kind, value, response, baseline=None, same_bytes=False):
    """Return (verdict, note), where verdict is ok, fail, or incomplete."""
    status, body, _raw, transport_error = response
    if transport_error:
        return "incomplete", transport_error
    if status == 400:
        if value_kind != "malformed":
            return "fail", "400 is allowed only for malformed input"
        if not has_error_reason(body):
            return "fail", "400 body needs a non-empty JSON string field named error"
        return "ok", "rejected malformed input with a JSON error"
    if status != 200:
        return "incomplete", f"unexpected HTTP status {status}"

    rows = items(body)
    if rows is None:
        return "incomplete", "response has no items array"
    if not resources_are_usable(rows):
        return "incomplete", "items contains an unusable resource shape"
    declared = unapplied(body)
    if declared is None:
        return "incomplete", "unappliedFilters is not an array of strings"
    if param in declared:
        return "ok", "declared in unappliedFilters"

    if value_kind == "positive":
        if not rows:
            return "fail", "empty although the baseline contains this value"
        bad = [resource for resource in rows if not satisfies(resource, param, value)]
        if bad:
            identity = "; byte-identical to V0" if same_bytes else ""
            return "fail", (
                f"{len(bad)} of {len(rows)} items do not satisfy the filter{identity}"
            )
        if baseline is not None and rows == baseline:
            return "fail", "all items match, but the response did not exclude known non-matches"
        return "ok", f"{len(rows)} items; all satisfy the filter"

    if not rows:
        if not empty_total_is_zero(body):
            return "fail", "items is empty but pagination.total is not zero"
        return "ok", "empty result set"
    bad = [resource for resource in rows if not satisfies(resource, param, value)]
    if not bad:
        return "ok", f"{len(rows)} items; all satisfy the filter"
    identity = "; byte-identical to V0" if same_bytes else ""
    return "fail", (
        f"{len(bad)} of {len(rows)} items do not satisfy the filter and it is not declared"
        f" unapplied{identity}"
    )


def control_network(baseline):
    counts = {}
    for resource in baseline:
        networks = {
            a.get("network") for a in resource["accepts"] if isinstance(a.get("network"), str)
        }
        for network in networks:
            counts[network] = counts.get(network, 0) + 1
    candidates = [(count, network) for network, count in counts.items() if count < len(baseline)]
    return min(candidates) if candidates else None


def digest(raw):
    return hashlib.sha256(raw).hexdigest() if raw else "no-body"


def run(fetch, endpoint, emit=print):
    emit(f"endpoint: {endpoint}")
    baseline_response = fetch({"limit": 50}, "V0")
    baseline = items(baseline_response.body)
    if (
        baseline_response.error
        or baseline_response.status != 200
        or baseline is None
        or not resources_are_usable(baseline)
    ):
        detail = baseline_response.error or f"HTTP {baseline_response.status}; expected usable items"
        emit(f"  [INCOMPLETE] V0 baseline: {detail}")
        return 2
    baseline_raw = baseline_response.raw
    emit(
        f"  [ok] V0 status=200 baseline: {len(baseline)} items; "
        f"sha256={digest(baseline_raw)}"
    )

    failures = incomplete = 0

    def check(vid, param, value_kind, value, response, baseline_for_check=baseline):
        nonlocal failures, incomplete
        verdict, note = evaluate(
            param,
            value_kind,
            value,
            response,
            baseline_for_check,
            bool(baseline_raw) and response.raw == baseline_raw,
        )
        tag = {"ok": "ok", "fail": "FAIL", "incomplete": "INCOMPLETE"}[verdict]
        emit(f"  [{tag}] {vid} status={response.status} {param}={value!r}: {note}")
        failures += verdict == "fail"
        incomplete += verdict == "incomplete"

    for vid, param, value_kind, value in VECTORS:
        check(vid, param, value_kind, value, fetch({"limit": 50, param: value}, vid))

    control = control_network(baseline)
    if control is None:
        emit("  [INCOMPLETE] V7 positive control: baseline has no discriminating network")
        incomplete += 1
    else:
        matching, network = control
        response = fetch({"limit": 50, "network": network}, "V7")
        check("V7", "network", "positive", network, response)
        emit(f"       control source: {matching}/{len(baseline)} baseline items carry {network!r}")

    if incomplete:
        suffix = f"; {failures} conformance failure(s) also observed" if failures else ""
        emit(f"INCOMPLETE: {incomplete} vector(s) could not be evaluated{suffix}.")
        return 2
    if failures:
        emit(f"NON-CONFORMING: {failures} vector(s) failed.")
        return 1
    emit("CONFORMING: every vector passed.")
    return 0


def fetch_http(base_url, params, directory, name):
    url = base_url + "?" + urllib.parse.urlencode(params)
    path = os.path.join(directory, name + ".json")
    try:
        result = subprocess.run(
            [
                "curl", "--silent", "--show-error", "--max-time", "40",
                "--max-filesize", str(MAX_RESPONSE_BYTES), "--output", path,
                "--write-out", "%{http_code}", url,
            ],
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        return Response(0, None, b"", f"could not run curl: {exc}")
    raw = b""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError:
        pass
    code = (result.stdout or "").strip()
    status = int(code) if code.isdigit() else 0
    if result.returncode != 0:
        detail = (result.stderr or f"curl exited {result.returncode}").strip()
        return Response(status, None, raw, detail)
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        body = None
    return Response(status, body, raw, "")


def self_test():
    def resource(network, *, resource_type="http", scheme="exact", pay_to="0xabc", ext=None):
        return {
            "resource": "https://example.test/" + network,
            "type": resource_type,
            "x402Version": 2,
            "accepts": [{"network": network, "scheme": scheme, "payTo": pay_to}],
            "lastUpdated": 1,
            "extensions": {"bazaar": {}} if ext is None else ext,
        }

    first = resource("eip155:1")
    second = resource(
        "eip155:2",
        resource_type="mcp",
        scheme="batch-settlement",
        pay_to="0x0000000000000000000000000000000000000001",
        ext={"payment-identifier": {}},
    )
    third = resource("eip155:999999999")
    baseline = [first, second, third]

    def response(status, body, error=""):
        raw = json.dumps(body, sort_keys=True).encode()
        return Response(status, body, raw, error)

    unit_cases = [
        ("malformed 400", ("network", "malformed", "!!!", response(400, {"error": "bad"})), "ok"),
        ("empty error", ("network", "malformed", "!!!", response(400, {"error": ""})), "fail"),
        ("well-formed 400", ("network", "well-formed", "eip155:9", response(400, {"error": "bad"})), "fail"),
        ("positive 400", ("network", "positive", "eip155:1", response(400, {"error": "bad"})), "fail"),
        ("wrong array key", ("network", "well-formed", "eip155:9", response(200, {"resources": []})), "incomplete"),
        ("empty total mismatch", ("network", "well-formed", "eip155:9", response(200, {"items": [], "pagination": {"total": 2}})), "fail"),
        ("transport error", ("network", "well-formed", "eip155:9", response(200, {"items": []}, "curl failed")), "incomplete"),
        ("bad item shape", ("network", "well-formed", "eip155:9", response(200, {"items": [None]})), "incomplete"),
        ("bad unapplied shape", ("network", "well-formed", "eip155:9", response(200, {"items": baseline, "unappliedFilters": "network"})), "incomplete"),
        ("unapplied", ("network", "well-formed", "eip155:9", response(200, {"items": baseline, "unappliedFilters": ["network"]})), "ok"),
        ("ignored", ("network", "well-formed", "eip155:9", response(200, {"items": baseline})), "fail"),
        (
            "accepts.extra is not a resource extension",
            (
                "extensions",
                "well-formed",
                "payment-identifier",
                response(200, {"items": [{
                    **first,
                    "extensions": {},
                    "accepts": [{**first["accepts"][0], "extra": {"payment-identifier": {}}}],
                }]}),
            ),
            "fail",
        ),
    ]
    failures = 0
    for name, args, expected in unit_cases:
        actual, _note = evaluate(*args, baseline=baseline)
        if actual != expected:
            failures += 1
            print(f"  [FAIL] {name}: expected {expected}, got {actual}")
        else:
            print(f"  [ok] {name}: {actual}")

    base_body = {"items": baseline, "pagination": {"total": len(baseline)}}

    def good_fetch(params, name):
        if name == "V0":
            return response(200, base_body)
        if name == "V6":
            return response(400, {"error": "network must be CAIP-2"})
        param, value = next((key, val) for key, val in params.items() if key != "limit")
        matches = [r for r in baseline if satisfies(r, param, value)]
        return response(200, {"items": matches, "pagination": {"total": len(matches)}})

    def ignored_fetch(_params, _name):
        return response(200, base_body)

    def broken_fetch(_params, name):
        return response(200, base_body) if name == "V0" else response(500, {})

    single_body = {"items": [first], "pagination": {"total": 1}}

    def single_network_fetch(params, name):
        if name == "V0":
            return response(200, single_body)
        if name == "V6":
            return response(400, {"error": "network must be CAIP-2"})
        return response(200, {"items": [], "pagination": {"total": 0}})

    scenarios = [
        ("end-to-end conforming exit", good_fetch, 0),
        ("end-to-end failure exit", ignored_fetch, 1),
        ("end-to-end incomplete exit", broken_fetch, 2),
        ("single-network control is incomplete", single_network_fetch, 2),
    ]
    for name, fetch, expected in scenarios:
        actual = run(fetch, "fixture://catalog", emit=lambda _line: None)
        if actual != expected:
            failures += 1
            print(f"  [FAIL] {name}: expected {expected}, got {actual}")
        else:
            print(f"  [ok] {name}: {actual}")

    if failures:
        print(f"SELF-TEST FAILED: {failures} assertion(s)")
        return 1
    count = len(unit_cases) + len(scenarios)
    print(f"SELF-TEST PASSED: {count} assertions, including exits 0/1/2")
    return 0


def main():
    args = sys.argv[1:]
    if args == ["--self-test"]:
        return self_test()
    if len(args) != 1:
        print("usage: bash run_bazaar_discovery_vectors.sh <url> | --self-test")
        return 2
    parsed = urllib.parse.urlsplit(args[0])
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or "?" in args[0]
        or "#" in args[0]
    ):
        print("error: URL must be an http(s) endpoint without a query string or fragment")
        return 2
    with tempfile.TemporaryDirectory(prefix="x402-bazaar-vectors-") as directory:
        fetch = lambda params, name: fetch_http(args[0], params, directory, name)
        return run(fetch, args[0])


sys.exit(main())
PY
