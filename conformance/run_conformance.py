#!/usr/bin/env python3
# Copyright 2026 Michael K. Saleme
# SPDX-License-Identifier: Apache-2.0
"""x402 conformance-vector runner (stdlib-only, no dependencies).

A conformance vector is *data*: a normative x402 requirement plus the request
that exercises it. This runner either validates the vector set or replays it
against a live x402 implementation and reports how the implementation responds,
so you can judge conformance against each requirement.

Usage:
    python run_conformance.py --validate                 # schema-check all vectors
    python run_conformance.py --url https://your-x402    # replay against your endpoint
    python run_conformance.py --url https://your-x402 --report out.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
VECTORS_DIR = HERE / "vectors"

_REQUIRED = {
    "id": str, "title": str, "category": str, "requirement": str,
    "method": str, "request": dict, "normative": str, "expected": str,
}
_METHODS = {"GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"}


def load_vectors() -> list[tuple[Path, dict]]:
    return [(p, json.loads(p.read_text())) for p in sorted(VECTORS_DIR.rglob("*.json"))]


def validate(vecs: list[tuple[Path, dict]]) -> list[str]:
    """Minimal, dependency-free check against schema.json's core constraints."""
    errs: list[str] = []
    seen: set[str] = set()
    for path, v in vecs:
        for key, typ in _REQUIRED.items():
            if key not in v:
                errs.append(f"{path.name}: missing '{key}'")
            elif not isinstance(v[key], typ):
                errs.append(f"{path.name}: '{key}' must be {typ.__name__}")
        if v.get("normative") not in ("MUST", "SHOULD"):
            errs.append(f"{path.name}: 'normative' must be MUST or SHOULD")
        if v.get("method", "").upper() not in _METHODS:
            errs.append(f"{path.name}: unknown method '{v.get('method')}'")
        vid = v.get("id")
        if vid in seen:
            errs.append(f"{path.name}: duplicate id '{vid}'")
        seen.add(vid)
    return errs


def replay(target: str, vec: dict) -> dict:
    req = vec.get("request", {})
    path = req.get("path", "/") or "/"
    url = target.rstrip("/") + (path if path.startswith("/") else "/" + path)
    method = vec.get("method", "GET").upper()
    body = req.get("body")
    if isinstance(body, (dict, list)):
        data = json.dumps(body).encode()
    elif isinstance(body, str):
        data = body.encode()
    else:
        data = None
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={k: str(v) for k, v in (req.get("headers") or {}).items()})
    try:
        with urllib.request.urlopen(request, timeout=15) as resp:
            return {"status": resp.status, "headers": dict(resp.headers)}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "headers": dict(e.headers)}
    except Exception as e:  # transport failure
        return {"error": str(e)[:160]}


def main() -> None:
    ap = argparse.ArgumentParser(description="x402 conformance-vector runner (stdlib-only)")
    ap.add_argument("--validate", action="store_true", help="schema-check all vectors and exit")
    ap.add_argument("--url", help="replay vectors against a live x402 implementation")
    ap.add_argument("--report", help="write a JSON report to this path")
    args = ap.parse_args()

    vecs = load_vectors()
    if not vecs:
        print(f"no vectors found under {VECTORS_DIR}", file=sys.stderr)
        sys.exit(1)

    # Always validate first (also the whole job for --validate / no --url).
    errs = validate(vecs)
    if errs:
        print("INVALID:")
        for e in errs:
            print("  " + e)
        sys.exit(1)
    print(f"OK — {len(vecs)} vectors valid")
    if args.validate or not args.url:
        return

    # Live replay + conformance report.
    results = []
    print(f"\nReplaying {len(vecs)} vectors against {args.url}\n")
    for _, v in vecs:
        obs = replay(args.url, v)
        outcome = obs.get("status", obs.get("error"))
        results.append({"id": v["id"], "category": v["category"], "normative": v["normative"],
                        "requirement": v["requirement"], "observed": obs})
        print(f"  {v['id']} [{v['normative']}] {v['category']}: {v['requirement'][:58]} -> {outcome}")
    if args.report:
        Path(args.report).write_text(json.dumps(
            {"target": args.url, "count": len(results), "results": results}, indent=2))
        print(f"\nreport written to {args.report}")


if __name__ == "__main__":
    main()
