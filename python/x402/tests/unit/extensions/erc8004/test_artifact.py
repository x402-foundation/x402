"""Tests for ERC-8004 canonical artifact + hashing."""

from eth_account import Account
from eth_utils import keccak

from x402.extensions.erc8004.artifact import (
    canonical_bytes,
    compute_interaction_hash,
    compute_feedback_hash,
    build_artifact,
    receipt_digest,
    sign_interaction_receipt,
    verify_interaction_receipt,
)
from x402.schemas.payments import PaymentPayload, PaymentRequirements


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x" + "01" * 20,
        amount="1000000",
        pay_to="0x" + "03" * 20,
        max_timeout_seconds=60,
    )


def test_canonical_bytes_sorted_compact() -> None:
    out = canonical_bytes({"b": 1, "a": 2})
    assert out == b'{"a":2,"b":1}'


def test_canonical_bytes_deterministic() -> None:
    a = canonical_bytes({"x": [1, 2], "y": {"k": "v"}})
    b = canonical_bytes({"y": {"k": "v"}, "x": [1, 2]})
    assert a == b


def test_build_artifact_shape() -> None:
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    art = build_artifact(
        requirements=_requirements(),
        payment_payload=payload,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        payment_method="eip3009",
        agent_id=42,
        request={"method": "GET", "url": "https://x/y", "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "00" * 32},
        response={"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0a" * 32},
        feedback={"agentId": 42, "value": 90, "valueDecimals": 0, "tag1": "", "tag2": "", "endpoint": "", "comment": ""},
    )
    d = art.to_dict()
    assert d["settlement"]["payer"] == "0x" + "02" * 20
    assert d["settlement"]["agentId"] == 42
    assert d["settlement"]["payTo"] == "0x" + "03" * 20
    assert d["settlement"]["amount"] == "1000000"
    assert d["interaction"]["response"]["agentSignature"] is None


def test_interaction_hash_excludes_feedback_and_agentsig() -> None:
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    base = dict(
        requirements=_requirements(),
        payment_payload=payload,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        payment_method="eip3009",
        agent_id=42,
        request={"method": "GET", "url": "https://x/y", "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "00" * 32},
        response={"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0a" * 32},
    )
    art1 = build_artifact(feedback={"agentId": 42, "value": 90, "valueDecimals": 0, "tag1": "", "tag2": "", "endpoint": "", "comment": "a"}, **base)
    art2 = build_artifact(feedback={"agentId": 42, "value": 10, "valueDecimals": 0, "tag1": "", "tag2": "", "endpoint": "", "comment": "z"}, **base)
    # interaction hash identical regardless of feedback content
    assert compute_interaction_hash(art1.to_dict()) == compute_interaction_hash(art2.to_dict())
    # feedback hash differs because rating differs
    assert compute_feedback_hash(art1.to_dict()) != compute_feedback_hash(art2.to_dict())


def test_interaction_hash_covers_request_and_response() -> None:
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    base = dict(
        requirements=_requirements(),
        payment_payload=payload,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        payment_method="eip3009",
        agent_id=42,
        feedback={"agentId": 42, "value": 90, "valueDecimals": 0, "tag1": "", "tag2": "", "endpoint": "", "comment": ""},
    )
    req = {"method": "GET", "url": "https://x/y", "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "00" * 32}
    art_a = build_artifact(request=req, response={"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0a" * 32}, **base)
    art_b = build_artifact(request=req, response={"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "ff" * 32}, **base)
    # different response body digest => different interaction hash
    assert compute_interaction_hash(art_a.to_dict()) != compute_interaction_hash(art_b.to_dict())


def test_interaction_hash_ignores_embedded_agent_signature() -> None:
    payload = PaymentPayload(payload={"sig": "0xdead"}, accepted=_requirements())
    art = build_artifact(
        requirements=_requirements(),
        payment_payload=payload,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        payment_method="eip3009",
        agent_id=42,
        request={"method": "GET", "url": "https://x/y", "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "00" * 32},
        response={"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0a" * 32},
        feedback={"agentId": 42, "value": 90},
    )
    before = compute_interaction_hash(art.to_dict())
    d = art.to_dict()
    d["interaction"]["response"]["agentSignature"] = {"signature": "0xdeadbeef"}
    after = compute_interaction_hash(d)
    # embedding the agent signature must not change the signed preimage
    assert before == after


def test_receipt_sign_and_verify() -> None:
    agent = Account.create()
    ticket_id = 7
    interaction_hash = b"\xcd" * 32
    chain_id = 8453
    receipt = sign_interaction_receipt(agent, chain_id, ticket_id, interaction_hash)
    assert receipt.chain_id == chain_id
    assert receipt.ticket_id == ticket_id
    assert verify_interaction_receipt(receipt, agent.address) is True
    assert verify_interaction_receipt(receipt, "0x" + "00" * 20) is False


def test_receipt_digest_binds_all_fields() -> None:
    d1 = receipt_digest(8453, 7, b"\xcd" * 32)
    d2 = receipt_digest(1, 7, b"\xcd" * 32)
    d3 = receipt_digest(8453, 8, b"\xcd" * 32)
    assert d1 != d2
    assert d1 != d3  # ticket id is part of the preimage
    assert d1 == keccak(
        b"x402-erc8004-receipt"
        + (8453).to_bytes(32, "big")
        + (7).to_bytes(32, "big")
        + b"\xcd" * 32
    )
