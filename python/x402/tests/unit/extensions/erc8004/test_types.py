"""Tests for ERC-8004 extension types."""

from x402.extensions.erc8004.types import (
    ARTIFACT_VERSION,
    ERC8004Config,
    FeedbackParams,
    FeedbackArtifact,
    ERC8004ExtensionInfo,
    InteractionAttestation,
)


def test_config_wrapper_address() -> None:
    cfg = ERC8004Config(
        network="eip155:8453",
        reputation_registry="0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
        identity_registry="0x8004A18C4f0D0307C40Bd9176E1A53569b73e6a3",
        wrapper_address="0x" + "aa" * 20,
        rpc_url="http://localhost:8545",
        agent_id=42,
    )
    assert cfg.feedback_contract == "0x" + "aa" * 20


def test_feedback_params_defaults() -> None:
    p = FeedbackParams(agent_id=42, value=90)
    assert p.value_decimals == 0
    assert p.feedback_uri == ""
    assert p.feedback_hash == b"\x00" * 32


def test_extension_info_accepts_wire_agent_id_alias() -> None:
    info = ERC8004ExtensionInfo.model_validate({"agentId": 7})
    assert info.agent_id == 7


def test_interaction_attestation_roundtrip() -> None:
    att = InteractionAttestation(
        ticket_id=42,
        chain_id=8453,
        method="GET",
        url="https://x/y",
        request_body_digest=b"\x11" * 32,
        response_body_digest=b"\x22" * 32,
        response_status=200,
        signature=b"\x33" * 65,
    )
    d = att.to_dict()
    assert d["ticketId"] == "42"
    assert d["method"] == "GET"
    back = InteractionAttestation.from_dict(d)
    assert back.ticket_id == att.ticket_id
    assert back.url == att.url


def test_feedback_artifact_v2_default_version() -> None:
    art = FeedbackArtifact(
        settlement={"ticketId": 1},
        interaction={"request": {}, "response": {}},
        feedback={"agentId": 42},
    )
    assert art.version == ARTIFACT_VERSION
