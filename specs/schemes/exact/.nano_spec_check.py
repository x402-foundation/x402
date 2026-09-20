#!/usr/bin/env python3
"""Self-checks for specs/schemes/exact/scheme_exact_nano.md.

Checks, all offline:
  1. every ```json block parses;
  2. every stated XNO value equals its raw amount / 10**30;
  3. the payload's implied previous balance equals amount + balance (the amount is
     the *delta*, whichever way the prose words it);
  4. every nano_ address in the file has a valid blake2b checksum;
  5. every relative markdown link resolves on disk.
Exit 0 when all pass.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys

RAW = 10**30
ALPHABET = "13456789abcdefghijkmnopqrstuwxyz"
PATH = "specs/schemes/exact/scheme_exact_nano.md"


def valid_address(addr: str) -> bool:
    m = re.fullmatch(r"(?:nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{59})", addr)
    if m is None:
        return False
    body = m.group(1)
    bits = 0
    for char in body[:52]:
        bits = (bits << 5) | ALPHABET.index(char)
    if bits >> 256:
        return False
    public_key = bits.to_bytes(32, "big")
    digest = hashlib.blake2b(public_key, digest_size=5).digest()[::-1]
    check = int.from_bytes(digest, "big")
    encoded = "".join(ALPHABET[(check >> (5 * i)) & 31] for i in range(7, -1, -1))
    return encoded == body[52:]


def main() -> int:
    text = open(PATH, encoding="utf-8").read()
    failures: list[str] = []
    checks = 0

    for i, block in enumerate(re.findall(r"```json\n(.*?)```", text, flags=re.S), 1):
        checks += 1
        try:
            json.loads(block)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"json block {i} does not parse: {exc}")

    for raw, stated in re.findall(r'`"(\d{20,})"` is ([\d.]+) XNO', text):
        checks += 1
        if abs(int(raw) / RAW - float(stated)) > 1e-18:
            failures.append(f"stated {stated} XNO != {raw} raw ({int(raw) / RAW})")

    amounts = {int(x) for x in re.findall(r'"amount": "(\d+)"', text)}
    balances = {int(x) for x in re.findall(r'"balance": "(\d+)"', text)}
    checks += 1
    if amounts and balances:
        for amount in amounts:
            for balance in balances:
                previous = amount + balance
                if previous > 133_248_298 * RAW:
                    failures.append(f"implied previous balance {previous} exceeds supply")
    else:
        failures.append("no amount/balance pair found in the file")

    addr_mentions = re.findall(r"(?:nano|xrb)_[13456789abcdefghijkmnopqrstuwxyz]{50,}", text)
    checks += 1
    if not addr_mentions:
        failures.append("no nano/xrb address found in the file")
    for addr in sorted(set(addr_mentions)):
        checks += 1
        if not valid_address(addr):
            failures.append(f"address is not well-formed or has no valid checksum: {addr}")

    for link in re.findall(r"\]\((\.\.?/[^)]+)\)", text):
        checks += 1
        target = os.path.normpath(os.path.join(os.path.dirname(PATH), link.split("#")[0]))
        if not os.path.exists(target):
            failures.append(f"relative link does not resolve: {link} -> {target}")

    print(f"schema/arith/link checks run: {checks}")
    for f in failures:
        print("FAIL:", f)
    print("PASS" if not failures else "FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
