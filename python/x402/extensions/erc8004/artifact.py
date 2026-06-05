"""Canonical artifact construction, hashing, and interaction attestations."""

from __future__ import annotations

import json
from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address

from x402.schemas.payments import PaymentPayload, PaymentRequirements

from .types import ARTIFACT_VERSION, FeedbackArtifact, InteractionAttestation

EIP712_DOMAIN_NAME = "X402AgentReputation"
EIP712_DOMAIN_VERSION = "1"

INTERACTION_ATTESTATION_TYPES: dict[str, list[dict[str, str]]] = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "InteractionAttestation": [
        {"name": "ticketId", "type": "uint256"},
        {"name": "chainId", "type": "uint256"},
        {"name": "method", "type": "string"},
        {"name": "url", "type": "string"},
        {"name": "requestBodyDigest", "type": "bytes32"},
        {"name": "responseBodyDigest", "type": "bytes32"},
        {"name": "responseStatus", "type": "uint16"},
    ],
}


def canonical_bytes(obj: Any) -> bytes:
    """Deterministic JSON encoding: sorted keys, compact, UTF-8, no floats."""
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def body_digest(raw: bytes) -> bytes:
    """keccak256 over raw HTTP body bytes (empty body → keccak256(''))."""
    return keccak(raw)


def build_artifact(
    requirements: PaymentRequirements,
    payment_payload: PaymentPayload,
    tx_hash: str,
    payer: str,
    payment_method: str,
    agent_id: int | None,
    ticket_id: int | None,
    request: dict[str, Any],
    response: dict[str, Any],
    feedback: dict[str, Any],
) -> FeedbackArtifact:
    """Assemble the canonical v2 feedback artifact."""
    response_with_att = dict(response)
    response_with_att.setdefault("agentAttestation", None)
    settlement: dict[str, Any] = {
        "txHash": tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash,
        "chainId": requirements.network,
        "scheme": requirements.scheme,
        "paymentMethod": payment_method,
        "agentId": agent_id,
        "asset": to_checksum_address(requirements.asset),
        "payer": to_checksum_address(payer),
        "payTo": to_checksum_address(requirements.pay_to),
        "amount": requirements.amount,
        "paymentPayload": payment_payload.model_dump(mode="json"),
        "paymentRequirements": requirements.model_dump(mode="json"),
    }
    if ticket_id is not None:
        settlement["ticketId"] = int(ticket_id)
    return FeedbackArtifact(
        version=ARTIFACT_VERSION,
        settlement=settlement,
        interaction={"request": request, "response": response_with_att},
        feedback=feedback,
    )


def compute_feedback_hash(artifact: dict[str, Any]) -> bytes:
    """keccak256 over the canonical full artifact (on-chain commitment)."""
    return keccak(canonical_bytes(artifact))


def _attestation_domain(chain_id: int, wrapper_address: str) -> dict[str, Any]:
    return {
        "name": EIP712_DOMAIN_NAME,
        "version": EIP712_DOMAIN_VERSION,
        "chainId": chain_id,
        "verifyingContract": to_checksum_address(wrapper_address),
    }


def _attestation_message(
    *,
    ticket_id: int,
    chain_id: int,
    method: str,
    url: str,
    request_body_digest: bytes,
    response_body_digest: bytes,
    response_status: int,
) -> dict[str, Any]:
    return {
        "ticketId": int(ticket_id),
        "chainId": int(chain_id),
        "method": method,
        "url": url,
        "requestBodyDigest": request_body_digest,
        "responseBodyDigest": response_body_digest,
        "responseStatus": int(response_status),
    }


def sign_interaction_attestation(
    signer: Any,
    *,
    wrapper_address: str,
    ticket_id: int,
    chain_id: int,
    method: str,
    url: str,
    request_body_digest: bytes,
    response_body_digest: bytes,
    response_status: int,
) -> InteractionAttestation:
    """Sign InteractionAttestation with the agent owner key (EIP-712)."""
    domain = _attestation_domain(chain_id, wrapper_address)
    message = _attestation_message(
        ticket_id=ticket_id,
        chain_id=chain_id,
        method=method,
        url=url,
        request_body_digest=request_body_digest,
        response_body_digest=response_body_digest,
        response_status=response_status,
    )
    signable = encode_typed_data(
        full_message={
            "types": INTERACTION_ATTESTATION_TYPES,
            "primaryType": "InteractionAttestation",
            "domain": domain,
            "message": message,
        }
    )
    signed = signer.sign_message(signable)
    sig = signed.signature if hasattr(signed, "signature") else signed
    return InteractionAttestation(
        ticket_id=int(ticket_id),
        chain_id=chain_id,
        method=method,
        url=url,
        request_body_digest=request_body_digest,
        response_body_digest=response_body_digest,
        response_status=response_status,
        signature=bytes(sig),
    )


def verify_interaction_attestation(
    attestation: InteractionAttestation,
    *,
    wrapper_address: str,
    expected_owner: str,
) -> bool:
    """Recover the attestation signer and compare to the expected agent owner."""
    domain = _attestation_domain(attestation.chain_id, wrapper_address)
    message = _attestation_message(
        ticket_id=attestation.ticket_id,
        chain_id=attestation.chain_id,
        method=attestation.method,
        url=attestation.url,
        request_body_digest=attestation.request_body_digest,
        response_body_digest=attestation.response_body_digest,
        response_status=attestation.response_status,
    )
    try:
        signable = encode_typed_data(
            full_message={
                "types": INTERACTION_ATTESTATION_TYPES,
                "primaryType": "InteractionAttestation",
                "domain": domain,
                "message": message,
            }
        )
        recovered = Account.recover_message(signable, signature=attestation.signature)
    except Exception:
        return False
    return to_checksum_address(recovered) == to_checksum_address(expected_owner)


def attestation_matches_artifact(attestation: InteractionAttestation, artifact: dict[str, Any]) -> bool:
    """Field-by-field compare attestation vs artifact interaction + settlement ticketId."""
    settlement = artifact.get("settlement") or {}
    interaction = artifact.get("interaction") or {}
    req = interaction.get("request") or {}
    resp = interaction.get("response") or {}

    if int(attestation.ticket_id) != int(settlement.get("ticketId", -1)):
        return False
    if attestation.method != req.get("method"):
        return False
    if attestation.url != req.get("url"):
        return False

    req_digest = req.get("bodyDigest", "")
    if isinstance(req_digest, str):
        req_digest_bytes = bytes.fromhex(req_digest.removeprefix("0x"))
    else:
        return False
    if attestation.request_body_digest != req_digest_bytes:
        return False

    resp_digest = resp.get("bodyDigest", "")
    if isinstance(resp_digest, str):
        resp_digest_bytes = bytes.fromhex(resp_digest.removeprefix("0x"))
    else:
        return False
    if attestation.response_body_digest != resp_digest_bytes:
        return False

    return int(attestation.response_status) == int(resp.get("status", -1))
