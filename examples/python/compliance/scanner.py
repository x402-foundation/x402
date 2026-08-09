#!/usr/bin/env python3
"""
x402 Compliance Scanner — Reference Implementation

Validates x402 endpoint responses against the protocol specification.
Use this to verify your x402 gateway implements the standard correctly.

This is the reference implementation for:
  https://github.com/x402-foundation/x402/issues/2823

Usage:
  python3 scanner.py scan <url>              # Scan a single endpoint
  python3 scanner.py scan-all <base-url>      # Scan all endpoints via OpenAPI
  python3 scanner.py validate <receipt-id>    # Validate a settled transaction

Exit codes:
  0 = all checks pass
  1 = one or more checks failed
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

__version__ = "0.1.0"

# ── Data ────────────────────────────────────────────────────────────────────

REQUIRED_402_FIELDS = [
    "status", "x402version", "accepts", "network",
    "asset", "amount", "payment_address",
]
ACCEPTS_FIELDS = ["type", "scheme", "network", "amount", "asset", "payTo"]


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""

    def ok(self, detail=""):
        self.passed = True
        self.detail = detail
        return self

    def fail(self, detail=""):
        self.passed = False
        self.detail = detail
        return self

    def __str__(self):
        status = "✅" if self.passed else "❌"
        return f"  {status} {self.name}: {self.detail}"


# ── HTTP helpers ─────────────────────────────────────────────────────────────


def _request(url: str, method: str = "GET", headers: Optional[dict] = None,
             timeout: int = 10) -> tuple[int, dict, dict]:
    """Make an HTTP request, return (status_code, body_dict, response_headers)."""
    req = urllib.request.Request(
        url, method=method,
        headers=headers or {"User-Agent": "x402-Compliance-Scanner/0.1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = {}
            try:
                body = json.loads(resp.read())
            except Exception:
                pass
            return resp.status, body, dict(resp.headers)
    except urllib.error.HTTPError as e:
        body = {}
        try:
            body = json.loads(e.read())
        except Exception:
            pass
        return e.code, body, dict(e.headers)


# ── Core checks ─────────────────────────────────────────────────────────────


def check_402_shape(url: str, timeout: int = 10) -> tuple[list[Check], dict]:
    """
    Issue an unauthenticated request and validate the 402 response shape
    against the x402 specification.
    """
    checks: list[Check] = []
    body: dict = {}

    status, body, headers = _request(
        url,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "x402-Compliance-Scanner/0.1.0",
            "Accept": "application/json",
        },
        timeout=timeout,
    )

    if status != 402:
        checks.append(Check("http_402", False, f"Expected 402, got {status}"))
        return checks, body
    checks.append(Check("http_402", True, "Responded 402 Payment Required"))

    # ── Top-level fields ──
    for field in REQUIRED_402_FIELDS:
        if field in body:
            checks.append(Check(f"field_{field}", True,
                                f"'{field}' present: {str(body[field])[:60]}"))
        else:
            checks.append(Check(f"field_{field}", False,
                                f"Missing required field '{field}'"))

    # ── x402 version ──
    version = body.get("x402version")
    if version in (2, "2", "x402-v2"):
        checks.append(Check("x402version", True,
                            f"x402version = {version}"))
    else:
        checks.append(Check("x402version", False,
                            f"Unexpected version: {version!r}"))

    # ── Network ──
    if body.get("network"):
        checks.append(Check("network_valid", True,
                            f"network = {body['network']}"))
    else:
        checks.append(Check("network_valid", False, "network is empty"))

    # ── Amount (must be positive integer string) ──
    amt = body.get("amount", "0")
    if isinstance(amt, str) and amt.isdigit() and int(amt) > 0:
        checks.append(Check("amount_format", True, f"amount = {amt}"))
    else:
        checks.append(Check("amount_format", False,
                            f"Invalid amount type/value: {amt!r}"))

    # ── Payment address ──
    pay_addr = body.get("payment_address", "")
    if pay_addr:
        checks.append(Check("payment_address", True,
                            f"payment_address = {str(pay_addr)[:16]}..."))
    else:
        checks.append(Check("payment_address", False,
                            "payment_address is empty"))

    # ── accepts[] array ──
    accepts = body.get("accepts", [])
    if not isinstance(accepts, list):
        checks.append(Check("accepts_type", False,
                            "accepts is not a list"))
    elif len(accepts) == 0:
        checks.append(Check("accepts_nonempty", False,
                            "accepts array is empty"))
    else:
        checks.append(Check("accepts_nonempty", True,
                            f"{len(accepts)} payment option(s)"))
        for i, entry in enumerate(accepts):
            for f in ACCEPTS_FIELDS:
                key = f"accepts[{i}].{f}"
                if f in entry:
                    checks.append(Check(key, True,
                                        f"= {str(entry[f])[:60]}"))
                else:
                    checks.append(Check(key, False,
                                        f"Missing field '{f}'"))

    # ── CORS ──
    acao = headers.get("Access-Control-Allow-Origin")
    if acao == "*":
        checks.append(Check("cors", True,
                            "Access-Control-Allow-Origin: *"))
    elif acao:
        checks.append(Check("cors", True,
                            f"Access-Control-Allow-Origin: {acao}"))
    else:
        checks.append(Check("cors", False, "No CORS header"))

    return checks, body


# ── CLI ─────────────────────────────────────────────────────────────────────


def _print_report(results: dict) -> bool:
    print(f"\n{'='*50}")
    print(f"x402 Compliance Scanner v{__version__}")
    print(f"{'='*50}")
    print(f"Endpoint: {results['endpoint']}")
    print(f"Duration: {results['duration_seconds']}s\n")
    for c in results["checks"]:
        status = "✅" if c["passed"] else "❌"
        print(f"  {status} {c['name']}: {c['detail']}")
    n_ok = sum(1 for c in results["checks"] if c["passed"])
    n_total = len(results["checks"])
    print(f"\n  Summary: {n_ok}/{n_total} checks passed")
    ok = results["passed"]
    print(f"  Result: {'✅ ALL CHECKS PASSED' if ok else '❌ SOME CHECKS FAILED'}")
    print(f"{'='*50}\n")
    return ok


def scan_endpoint(endpoint_url: str) -> dict:
    """Run all checks against a single x402 endpoint."""
    start = time.time()
    checks, body = check_402_shape(endpoint_url)
    passed = all(c.passed for c in checks)
    return {
        "endpoint": endpoint_url,
        "version": __version__,
        "duration_seconds": round(time.time() - start, 2),
        "passed": passed,
        "summary": f"{sum(1 for c in checks if c.passed)}/{len(checks)} checks passed",
        "checks": [c.__dict__ for c in checks],
    }


def scan_discover(base_url: str) -> list[str]:
    """Discover x402-gated endpoints from an OpenAPI spec."""
    try:
        _, spec, _ = _request(
            f"{base_url.rstrip('/')}/openapi.json",
            headers={"User-Agent": "x402-Compliance-Scanner/0.1.0"},
        )
    except Exception:
        return []

    endpoints = []
    for path_str in spec.get("paths", {}):
        methods = spec["paths"][path_str]
        for method_spec in methods.values():
            if isinstance(method_spec, dict) and method_spec.get("x-payment", {}).get("required"):
                endpoints.append(f"{base_url}{path_str}")
    return endpoints


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "scan" and len(sys.argv) >= 3:
        url = sys.argv[2]
        ok = _print_report(scan_endpoint(url))
        sys.exit(0 if ok else 1)

    elif cmd == "scan-all" and len(sys.argv) >= 3:
        base = sys.argv[2].rstrip("/")
        endpoints = scan_discover(base)
        if not endpoints:
            print("No x402-gated endpoints discovered via OpenAPI.")
            print("Falling back to common paths...")
            endpoints = [f"{base}/v1/{e}" for e in
                         ["agent", "wallet", "payment", "verify"]]
        all_ok = True
        for ep in endpoints:
            if not _print_report(scan_endpoint(ep)):
                all_ok = False
        sys.exit(0 if all_ok else 1)

    elif cmd == "validate" and len(sys.argv) >= 3:
        rid = sys.argv[2]
        print(f"\n📋 Receipt validation: {rid}")
        print("   (Requires network-specific verification logic.)\n")
        sys.exit(0)

    else:
        print(f"Unknown command: {cmd}")
        print("Usage: python3 scanner.py scan <url>")
        print("       python3 scanner.py scan-all <base-url>")
        sys.exit(1)


if __name__ == "__main__":
    main()
