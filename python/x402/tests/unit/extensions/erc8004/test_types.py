"""Tests for ERC-8004 extension types."""

from x402.extensions.erc8004.types import (
    ERC8004Config,
    FeedbackParams,
    InteractionReceipt,
    FeedbackArtifact,
    ERC8004ExtensionInfo,
)


def test_config_no_gateway_field() -> None:
    cfg = ERC8004Config(
        network="eip155:8453",
        reputation_registry="0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
        identity_registry="0x8004A18C4f0D0307C40Bd9176E1A53569b73e6a3",
        rpc_url="http://localhost:8545",
        agent_id=42,
    )
    assert cfg.identity_registry.startswith("0x")
    assert "feedback_gateway" not in ERC8004Config.model_fields


def test_feedback_params_defaults() -> None:
    p = FeedbackParams(agent_id=42, value=90)
    assert p.value_decimals == 0
    assert p.feedback_uri == ""
    assert p.feedback_hash == b"\x00" * 32


def test_extension_info_accepts_wire_agent_id_alias() -> None:
    info = ERC8004ExtensionInfo.model_validate({"agentId": 7})
    assert info.agent_id == 7


def test_interaction_receipt_roundtrip() -> None:
    r = InteractionReceipt(
        ticket_id=42,
        interaction_hash=b"\x22" * 32,
        chain_id=8453,
        signature=b"\x33" * 65,
    )
    d = r.to_dict()
    assert d["ticketId"] == "42"
    assert d["interactionHash"] == "0x" + "22" * 32
    assert d["chainId"] == 8453
    assert d["signature"] == "0x" + "33" * 65
    back = InteractionReceipt.from_dict(d)
    assert back == r


def test_feedback_artifact_minimal() -> None:
    art = FeedbackArtifact(
        settlement={
            "txHash": "0x" + "ab" * 32,
            "chainId": "eip155:8453",
            "scheme": "exact",
            "paymentMethod": "eip3009",
            "asset": "0x" + "01" * 20,
            "payer": "0x" + "02" * 20,
            "payTo": "0x" + "03" * 20,
            "amount": "1000000",
        },
        interaction={
            "request": {"method": "GET", "url": "https://x/y", "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "00" * 32},
            "response": {"status": 200, "headerDigest": "0x" + "00" * 32, "bodyDigest": "0x" + "0a" * 32, "agentSignature": None},
        },
        feedback={"agentId": 42, "value": 90, "valueDecimals": 0, "tag1": "", "tag2": "", "endpoint": "", "comment": ""},
    )
    assert art.version == "x402-erc8004/1"
    assert art.to_dict()["version"] == "x402-erc8004/1"
