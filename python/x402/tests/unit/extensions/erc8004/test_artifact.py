"""Tests for ERC-8004 canonical artifact + attestation."""

from eth_account import Account
from eth_utils import keccak

from x402.extensions.erc8004.artifact import (
    attestation_matches_artifact,
    body_digest,
    build_artifact,
    canonical_bytes,
    compute_feedback_hash,
    sign_interaction_attestation,
    verify_interaction_attestation,
)


def test_canonical_bytes_sorted_compact() -> None:
    out = canonical_bytes({"b": 1, "a": 2})
    assert out == b'{"a":2,"b":1}'


def test_body_digest_empty() -> None:
    assert body_digest(b"") == keccak(b"")


def test_build_artifact_v2_shape(make_requirements, make_payload) -> None:
    payload = make_payload(payload={"sig": "0xdead"})
    art = build_artifact(
        requirements=make_requirements(),
        payment_payload=payload,
        tx_hash="0x" + "ab" * 32,
        payer="0x" + "02" * 20,
        payment_method="eip3009",
        agent_id=42,
        ticket_id=7,
        request={"method": "GET", "url": "https://x/y", "bodyDigest": "0x" + "00" * 32},
        response={"status": 200, "bodyDigest": "0x" + "0a" * 32},
        feedback={"agentId": 42, "value": 90, "valueDecimals": 0, "tag1": "", "tag2": "", "endpoint": ""},
    )
    d = art.to_dict()
    assert d["version"] == "x402-erc8004/2"
    assert d["settlement"]["ticketId"] == 7
    assert d["interaction"]["response"]["agentAttestation"] is None


def test_attestation_sign_verify_and_match() -> None:
    agent = Account.create()
    wrapper = "0x" + "aa" * 20
    req_digest = body_digest(b"request-body")
    resp_digest = body_digest(b"response-body")

    att = sign_interaction_attestation(
        agent,
        wrapper_address=wrapper,
        ticket_id=7,
        chain_id=8453,
        method="GET",
        url="https://x/y",
        request_body_digest=req_digest,
        response_body_digest=resp_digest,
        response_status=200,
    )
    assert verify_interaction_attestation(att, wrapper_address=wrapper, expected_owner=agent.address)

    artifact = {
        "version": "x402-erc8004/2",
        "settlement": {"ticketId": 7},
        "interaction": {
            "request": {"method": "GET", "url": "https://x/y", "bodyDigest": "0x" + req_digest.hex()},
            "response": {"status": 200, "bodyDigest": "0x" + resp_digest.hex()},
        },
        "feedback": {"agentId": 42},
    }
    assert attestation_matches_artifact(att, artifact) is True


def test_feedback_hash_changes_with_rating(make_requirements, make_payload) -> None:
    payload = make_payload(payload={"sig": "0xdead"})
    base = {
        "requirements": make_requirements(),
        "payment_payload": payload,
        "tx_hash": "0x" + "ab" * 32,
        "payer": "0x" + "02" * 20,
        "payment_method": "eip3009",
        "agent_id": 42,
        "ticket_id": 1,
        "request": {"method": "GET", "url": "https://x/y", "bodyDigest": "0x" + "00" * 32},
        "response": {"status": 200, "bodyDigest": "0x" + "0a" * 32},
    }
    art1 = build_artifact(feedback={"agentId": 42, "value": 90}, **base)
    art2 = build_artifact(feedback={"agentId": 42, "value": 10}, **base)
    assert compute_feedback_hash(art1.to_dict()) != compute_feedback_hash(art2.to_dict())
