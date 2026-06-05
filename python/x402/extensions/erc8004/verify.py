"""Verification and dedup for ERC-8004 x402 feedback."""

from __future__ import annotations

from enum import IntEnum
from typing import Any

from eth_utils import keccak, to_checksum_address

from x402.mechanisms.evm.constants import X402_EXACT_PERMIT2_PROXY_ADDRESS

from .artifact import (
    attestation_matches_artifact,
    compute_feedback_hash,
    verify_interaction_attestation,
)
from .constants import X402_AGENT_REPUTATION_ABI
from .types import ARTIFACT_VERSION, ARTIFACT_VERSION_V1, InteractionAttestation

TRANSFER_TOPIC = "0x" + keccak(b"Transfer(address,address,uint256)").hex()

IDENTITY_ABI = [
    {
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "name": "ownerOf",
        "outputs": [{"name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function",
    }
]


class TrustTier(IntEnum):
    FULL = 0
    CLIENT_ONLY = 1
    DISPUTED = 2
    REJECTED = 3


def verify_integrity(content: bytes, feedback_hash: bytes) -> bool:
    """Legacy helper — prefer compute_feedback_hash for v2 artifacts."""
    try:
        import json

        artifact = json.loads(content.decode("utf-8"))
        return compute_feedback_hash(artifact) == feedback_hash
    except Exception:
        return keccak(content) == feedback_hash


def _topic_addr(topic: bytes) -> str:
    return to_checksum_address("0x" + topic.hex()[-40:])


def _parse_eip155_chain_id(chain_id: str) -> int:
    prefix, value = chain_id.split(":", 1)
    if prefix != "eip155":
        raise ValueError(f"unsupported chain id format: {chain_id}")
    return int(value)


def _canon_tx_hash(tx_hash: Any) -> str:
    if isinstance(tx_hash, (bytes, bytearray)):
        return "0x" + bytes(tx_hash).hex()
    s = str(tx_hash)
    if not s.startswith("0x"):
        s = "0x" + s
    return "0x" + s[2:].lower()


def _canon_addr(addr: Any) -> str:
    return to_checksum_address(str(addr))


def _agent_owner(w3: Any, identity_registry: str, agent_id: int) -> str:
    contract = w3.eth.contract(address=_canon_addr(identity_registry), abi=IDENTITY_ABI)
    owner = contract.functions.ownerOf(agent_id).call()
    return _canon_addr(owner)


def verify_settlement(w3: Any, artifact: dict[str, Any]) -> bool:
    """Confirm settlement via on-chain ticket or legacy ERC-20 Transfer."""
    if artifact.get("version") == ARTIFACT_VERSION and artifact.get("settlement", {}).get("ticketId") is not None:
        return True
    try:
        s = artifact["settlement"]
        expected_chain_id = _parse_eip155_chain_id(s["chainId"])
        if int(w3.eth.chain_id) != expected_chain_id:
            return False
        receipt = w3.eth.get_transaction_receipt(s["txHash"])
        if receipt.get("status") != 1:
            return False

        asset = _canon_addr(s["asset"])
        payer = _canon_addr(s["payer"])
        pay_to = _canon_addr(s["payTo"])
        amount = int(s["amount"])
        if amount <= 0:
            return False

        tx = w3.eth.get_transaction(s["txHash"])
        tx_to = _canon_addr(tx["to"])
        pm = str(s.get("paymentMethod", "")).lower()
        if tx_to != asset:
            if not (pm == "permit2" and tx_to == _canon_addr(X402_EXACT_PERMIT2_PROXY_ADDRESS)):
                return False

        reqs = s.get("paymentRequirements") or {}
        extra = reqs.get("extra") if isinstance(reqs, dict) else None
        if not isinstance(extra, dict):
            extra = {}
        allowed_from = {payer}
        if pm == "permit2":
            allowed_from.add(_canon_addr("0x000000000022D473030F116dDEE9F6B43aC78BA3"))
        spender = extra.get("facilitatorAddress") or extra.get("spender")
        if spender:
            allowed_from.add(_canon_addr(str(spender)))
    except Exception:
        return False

    for log in receipt["logs"]:
        if _canon_addr(log["address"]) != asset:
            continue
        topics = log["topics"]
        if len(topics) != 3 or ("0x" + bytes(topics[0]).hex()) != TRANSFER_TOPIC:
            continue
        topic_from = _topic_addr(bytes(topics[1]))
        topic_to = _topic_addr(bytes(topics[2]))
        if topic_from not in allowed_from or topic_to != pay_to:
            continue
        data = bytes(log["data"])
        if len(data) != 32:
            continue
        if int(data.hex(), 16) == amount:
            return True
    return False


def verify_ticket_settlement(
    w3: Any,
    wrapper_address: str,
    artifact: dict[str, Any],
) -> bool:
    """Load wrapper ticket and confirm payment fields match artifact settlement."""
    try:
        s = artifact["settlement"]
        ticket_id = int(s["ticketId"])
        contract = w3.eth.contract(address=_canon_addr(wrapper_address), abi=X402_AGENT_REPUTATION_ABI)
        ticket = contract.functions.tickets(ticket_id).call()
        payer, agent_id, agent_address, token, amount, _consumed = ticket
        return (
            _canon_addr(payer) == _canon_addr(s["payer"])
            and int(agent_id) == int(s.get("agentId") or artifact["feedback"]["agentId"])
            and _canon_addr(agent_address) == _canon_addr(s["payTo"])
            and _canon_addr(token) == _canon_addr(s["asset"])
            and int(amount) == int(s["amount"])
        )
    except Exception:
        return False


def verify_agent_binding(w3: Any, identity_registry: str, artifact: dict[str, Any]) -> bool:
    """For v1 artifacts: ownerOf(agentId) must equal settlement payTo."""
    try:
        agent_id = int(artifact["feedback"]["agentId"])
        pay_to = _canon_addr(artifact["settlement"]["payTo"])
        owner = _agent_owner(w3, identity_registry, agent_id)
        return owner == pay_to
    except Exception:
        return False


def verify_feedback(
    w3: Any,
    identity_registry: str,
    content: bytes,
    feedback_hash: bytes,
    artifact: dict[str, Any],
    *,
    submitter: str | None = None,
    wrapper_address: str | None = None,
) -> TrustTier:
    """Full verification pipeline returning a trust tier."""
    try:
        if compute_feedback_hash(artifact) != feedback_hash:
            return TrustTier.REJECTED

        expected_chain_id = _parse_eip155_chain_id(artifact["settlement"]["chainId"])
        if int(w3.eth.chain_id) != expected_chain_id:
            return TrustTier.REJECTED

        agent_id = int(artifact["feedback"]["agentId"])
        owner = _agent_owner(w3, identity_registry, agent_id)

        if submitter is not None and _canon_addr(submitter) != _canon_addr(artifact["settlement"]["payer"]):
            return TrustTier.REJECTED

        version = artifact.get("version", ARTIFACT_VERSION_V1)
        if version == ARTIFACT_VERSION and artifact["settlement"].get("ticketId") is not None:
            if wrapper_address is None:
                return TrustTier.REJECTED
            if not verify_ticket_settlement(w3, wrapper_address, artifact):
                return TrustTier.REJECTED
        elif not verify_settlement(w3, artifact):
            return TrustTier.REJECTED

        if artifact["settlement"].get("agentId") is not None and int(artifact["settlement"]["agentId"]) != agent_id:
            return TrustTier.REJECTED

    except Exception:
        return TrustTier.REJECTED

    attestation_data = (artifact.get("interaction") or {}).get("response", {}).get("agentAttestation")
    if not attestation_data:
        return TrustTier.CLIENT_ONLY

    try:
        attestation = InteractionAttestation.from_dict(attestation_data)
    except Exception:
        return TrustTier.REJECTED

    if wrapper_address is None:
        return TrustTier.REJECTED

    if attestation.chain_id != expected_chain_id:
        return TrustTier.REJECTED

    if not verify_interaction_attestation(
        attestation, wrapper_address=wrapper_address, expected_owner=owner
    ):
        return TrustTier.REJECTED

    if not attestation_matches_artifact(attestation, artifact):
        return TrustTier.DISPUTED

    return TrustTier.FULL


def dedup_feedback(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the latest (by block) record per (payer, agentId, txHash)."""
    best: dict[tuple, dict[str, Any]] = {}
    for r in records:
        payer = r.get("payer")
        agent_id = r.get("agentId")
        tx_hash = r.get("txHash")
        if payer is None or agent_id is None or tx_hash is None:
            continue
        key = (
            _canon_addr(payer),
            int(agent_id),
            _canon_tx_hash(tx_hash),
        )
        if key not in best or r["block"] > best[key]["block"]:
            best[key] = r
    return list(best.values())
