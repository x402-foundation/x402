#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Conformance checker for the x402 Settlement-Receipt Binding extension.

Written from extension-settlement-receipt-binding.md (section 5) and the
receipt format in draft-sirkkavaara-vaara-receipt (sections 2, 3, 4).
Imports the standard library plus rfc8785 (JCS) and cryptography (ES256).
It imports no x402 package and no receipt framework.

Run from this directory:  python3 check.py
Exit status 0 means every verdict matched expected.json.
"""

import hashlib
import json
import sys
from pathlib import Path

import rfc8785
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

HERE = Path(__file__).resolve().parent
VECTORS = HERE / "vectors"

# The action tuple (spec section 3.2). Nothing rail-specific enters it.
TUPLE_FIELDS = ("agentId", "actionType", "scope", "timestampMs", "seq", "terminal")

# Labels a consumer MUST accept for evidenceRef.canonicalization (draft section 2).
JCS_LABELS = {"jcs-rfc8785", "JCS", "jcs-json-v1"}

# Members allowed in a decision receipt (draft section 3, tables 1-6).
# The schema is closed: any other member is a rejection.
ALLOWED = {
    "envelope": {
        "version",
        "alg",
        "backLink",
        "decisionDerived",
        "issuerAsserted",
        "signature",
        "timestampAnchors",
    },
    "backLink": {"attestationDigest", "attestationNonce", "fallbackProjection"},
    "decisionDerived": {
        "decision",
        "decidedAt",
        "reason",
        "policyId",
        "riskScore",
        "thresholdAllow",
        "thresholdBlock",
        "clientTurnId",
        "evidenceRef",
        "rationale",
        "binding",
        "decisionProof",
    },
    "evidenceRef": {"canonicalization", "digest", "schema", "ref"},
    "issuerAsserted": {
        "iss",
        "sub",
        "iat",
        "nonce",
        "alg",
        "secretVersion",
        "aud",
        "taskId",
        "completeness",
        "cryptoPosture",
    },
}

# The signed payload of a decision receipt (draft section 3.2).
SIGNED_MEMBERS = ("version", "alg", "backLink", "decisionDerived", "issuerAsserted")


def digest(value):
    """'sha256:' + lowercase hex of SHA-256 over the JCS encoding of value."""
    return "sha256:" + hashlib.sha256(rfc8785.dumps(value)).hexdigest()


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def action_ref_recomputes(record):
    tuple_ = {k: record[k] for k in TUPLE_FIELDS}
    return digest(tuple_) == record["actionRef"]


def settlement_binding_resolves(record, receipt):
    ref = receipt.get("decisionDerived", {}).get("evidenceRef", {})
    return ref.get("canonicalization") in JCS_LABELS and ref.get("digest") == digest(record)


def schema_is_closed(receipt):
    if not set(receipt) <= ALLOWED["envelope"]:
        return False
    dd = receipt.get("decisionDerived", {})
    blocks = {
        "backLink": receipt.get("backLink", {}),
        "decisionDerived": dd,
        "evidenceRef": dd.get("evidenceRef", {}),
        "issuerAsserted": receipt.get("issuerAsserted", {}),
    }
    return all(isinstance(b, dict) and set(b) <= ALLOWED[name] for name, b in blocks.items())


def receipt_signature_ok(receipt, public_key):
    if not schema_is_closed(receipt):
        return False
    if any(m not in receipt for m in SIGNED_MEMBERS + ("signature",)):
        return False
    if receipt["version"] != 1:
        return False
    if receipt["decisionDerived"].get("decision") not in {"allow", "block", "escalate"}:
        return False
    # The envelope alg and the issuer block alg MUST match, checked before any key.
    if receipt["alg"] != receipt["issuerAsserted"].get("alg"):
        return False
    if receipt["alg"] != "ES256":
        return False  # this kit's vectors are ES256 only
    try:
        raw = bytes.fromhex(receipt["signature"])
    except ValueError:
        return False
    if len(raw) != 64:
        return False
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    payload = rfc8785.dumps({m: receipt[m] for m in SIGNED_MEMBERS})
    try:
        public_key.verify(der, payload, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        return False
    return True


def main():
    expected = load(HERE / "expected.json")
    with open(HERE / "keys" / "es256_public.pem", "rb") as f:
        public_key = serialization.load_pem_public_key(f.read())

    got = {}
    for rail in ("generic", "sui"):
        steps = {}
        for step in ("step0", "step1"):
            record = load(VECTORS / rail / step / "settlement.json")
            receipt = load(VECTORS / rail / step / "receipt.json")
            steps[step] = (record, receipt)
            got[f"{rail}.{step}.action_ref_recomputes"] = action_ref_recomputes(record)
            got[f"{rail}.{step}.settlement_binding_resolves"] = settlement_binding_resolves(
                record, receipt
            )
            got[f"{rail}.{step}.receipt_signature_ok"] = receipt_signature_ok(receipt, public_key)
        (r0, rc0), (r1, _) = steps["step0"], steps["step1"]
        got[f"{rail}.lifecycle_distinguishes_terminal"] = (
            r0["terminal"] is False
            and r1["terminal"] is True
            and r0["actionRef"] != r1["actionRef"]
            and not settlement_binding_resolves(r1, rc0)
        )

    # Section 7: the join key is the same on every rail at each step.
    for step in ("step0", "step1"):
        refs = {
            load(VECTORS / rail / step / "settlement.json")["actionRef"]
            for rail in ("generic", "sui")
        }
        got[f"{step}.join_is_rail_agnostic"] = len(refs) == 1

    # Negative cases: each one breaks exactly what its name says.
    for case in sorted(p for p in (VECTORS / "negative").iterdir() if p.is_dir()):
        record = load(case / "settlement.json")
        receipt = load(case / "receipt.json")
        got[f"negative.{case.name}.action_ref_recomputes"] = action_ref_recomputes(record)
        got[f"negative.{case.name}.settlement_binding_resolves"] = settlement_binding_resolves(
            record, receipt
        )
        got[f"negative.{case.name}.receipt_signature_ok"] = receipt_signature_ok(
            receipt, public_key
        )

    ok = True
    for key in sorted(set(expected) | set(got)):
        match = expected.get(key) == got.get(key)
        ok &= match
        print(
            f"[{'OK' if match else 'MISMATCH'}] {key}: {got.get(key)} (expected {expected.get(key)})"
        )
    print("\nall verdicts matched expected.json" if ok else "\nMISMATCH: see above")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
