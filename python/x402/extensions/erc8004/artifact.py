"""Canonical artifact construction, hashing, and interaction receipts."""

from __future__ import annotations

import json
from typing import Any

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak, to_checksum_address

from x402.schemas.payments import PaymentPayload, PaymentRequirements

from .types import ARTIFACT_VERSION, FeedbackArtifact, InteractionReceipt

RECEIPT_PREFIX = b"x402-erc8004-receipt"


def canonical_bytes(obj: Any) -> bytes:
    """Deterministic JSON encoding: sorted keys, compact, UTF-8, no floats."""
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def build_artifact(
    requirements: PaymentRequirements,
    payment_payload: PaymentPayload,
    tx_hash: str,
    payer: str,
    payment_method: str,
    agent_id: int | None,
    request: dict[str, Any],
    response: dict[str, Any],
    feedback: dict[str, Any],
) -> FeedbackArtifact:
    """Assemble the canonical feedback artifact. agentSignature starts as None."""
    response_with_sig = dict(response)
    response_with_sig.setdefault("agentSignature", None)
    return FeedbackArtifact(
        version=ARTIFACT_VERSION,
        settlement={
            "txHash": tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash,
            "chainId": requirements.network,
            "scheme": requirements.scheme,
            "paymentMethod": payment_method,
            # Critical: bind agentId into what the agent signs (via settlement in the
            # interaction core), since one owner EOA may control multiple agentIds.
            "agentId": agent_id,
            "asset": to_checksum_address(requirements.asset),
            "payer": to_checksum_address(payer),
            "payTo": to_checksum_address(requirements.pay_to),
            "amount": requirements.amount,
            "paymentPayload": payment_payload.model_dump(mode="json"),
            "paymentRequirements": requirements.model_dump(mode="json"),
        },
        interaction={"request": request, "response": response_with_sig},
        feedback=feedback,
    )


def _interaction_core(artifact: dict[str, Any]) -> dict[str, Any]:
    # The agent attests to the full interaction: the settlement, the request it
    # answered, and the response it produced (digests only). `agentSignature` is
    # excluded so the agent never signs over its own signature. The server builds
    # this at the HTTP layer once the response digest is known; the client embeds
    # the identical request/response, so both sides compute the same preimage.
    response_core = {
        k: v
        for k, v in artifact["interaction"]["response"].items()
        if k != "agentSignature"
    }
    return {
        "version": artifact["version"],
        "settlement": artifact["settlement"],
        "request": artifact["interaction"]["request"],
        "response": response_core,
    }


def compute_interaction_hash(artifact: dict[str, Any]) -> bytes:
    """keccak256 over the canonical {version, settlement, request, response} core.

    This is what the agent signs (response excludes its own agentSignature).
    """
    return keccak(canonical_bytes(_interaction_core(artifact)))


def compute_feedback_hash(artifact: dict[str, Any]) -> bytes:
    """keccak256 over the canonical full artifact (on-chain commitment)."""
    return keccak(canonical_bytes(artifact))


def receipt_digest(chain_id: int, ticket_id: int, interaction_hash: bytes) -> bytes:
    """Digest the agent signs to attest to the interaction.

    Phase 4.4: anchors to the ticket id (not the settlement tx hash). The
    ticketId is the canonical identifier in the new model — one per paid
    call, consumed atomically on feedback — and is recoverable from
    PAYMENT-RESPONSE without a tx-hash → ticketId index.
    """
    return keccak(
        RECEIPT_PREFIX
        + chain_id.to_bytes(32, "big")
        + int(ticket_id).to_bytes(32, "big")
        + interaction_hash
    )


def sign_interaction_receipt(
    signer: Any, chain_id: int, ticket_id: int, interaction_hash: bytes
) -> InteractionReceipt:
    """Sign the interaction digest with the agent owner key (personal_sign)."""
    digest = receipt_digest(chain_id, ticket_id, interaction_hash)
    signed = signer.sign_message(encode_defunct(digest))
    sig = signed.signature if hasattr(signed, "signature") else signed
    return InteractionReceipt(
        ticket_id=int(ticket_id),
        interaction_hash=interaction_hash,
        chain_id=chain_id,
        signature=bytes(sig),
    )


def verify_interaction_receipt(receipt: InteractionReceipt, expected_owner: str) -> bool:
    """Recover the receipt signer and compare to the expected agent owner."""
    digest = receipt_digest(receipt.chain_id, receipt.ticket_id, receipt.interaction_hash)
    try:
        recovered = Account.recover_message(encode_defunct(digest), signature=receipt.signature)
    except Exception:
        return False
    return to_checksum_address(recovered) == to_checksum_address(expected_owner)
