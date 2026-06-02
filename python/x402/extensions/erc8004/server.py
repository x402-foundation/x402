"""Resource Server Extension for ERC-8004 feedback."""

from __future__ import annotations

from typing import Any

from x402.schemas.extensions import ResourceServerExtension
from x402.schemas.hooks import (
    ServerPaymentRequiredContext,
    SettleResultContext,
    SkipHandlerDirective,
    SkipHandlerResult,
    VerifyResultContext,
)
from x402.schemas.payments import PaymentPayload, PaymentRequirements

from .artifact import build_artifact, compute_interaction_hash, sign_interaction_receipt
from .facilitator import extract_ticket_bind
from .schema import declare_erc8004_extension
from .types import ERC8004Config, EXTENSION_KEY, InteractionReceipt


def create_erc8004_resource_server_extension(
    config: ERC8004Config,
    *,
    require_ticket_bind: bool = False,
) -> ResourceServerExtension:
    """Create ERC-8004 server extension.

    Declares ``agentId`` in the 402 response. Forwards the ticket id minted at
    settle time into ``PAYMENT-RESPONSE.extensions.erc8004.ticketId`` so the
    client can recover the ticket without re-parsing the settlement receipt.

    Args:
        config: ERC-8004 configuration (must include ``agent_id``).
        require_ticket_bind: When True, the after-verify hook rejects payment
            payloads that do not carry the ticket-bind fields
            (``requestHash``, ``interactionHash``, ``endpoint``, ``agentId``).
            Defaults to False to remain compatible with the gateway-less
            baseline; flip on once clients populate the bind (Phase 4).

    Note on the mint gate: in x402 v2 the resource handler runs *before*
    settlement, so the actual mint-failure → no-handler invariant is enforced
    by the facilitator extension (it returns ``success=False`` when the
    TicketMinted log is missing). The optional ``require_ticket_bind`` hook
    here is a pre-handler defence: if the client did not bind a ticket, we
    short-circuit instead of running the handler for a payment that cannot
    produce a ticket downstream.
    """
    agent_id = config.agent_id
    if agent_id is None:
        raise ValueError("agent_id is required in ERC8004Config for server extension")

    class ERC8004ResourceServerExtension:
        @property
        def key(self) -> str:
            return EXTENSION_KEY

        def enrich_declaration(self, declaration: Any, transport_context: Any) -> Any:
            return declaration

        def enrich_payment_required_response(
            self, declaration: Any, context: ServerPaymentRequiredContext
        ) -> dict[str, Any] | None:
            return declare_erc8004_extension(agent_id)

        def after_verify(
            self, context: VerifyResultContext
        ) -> SkipHandlerResult | None:
            """Optionally skip the handler when ticket bind is missing.

            Active only when ``require_ticket_bind`` was set at construction.
            """
            if not require_ticket_bind:
                return None
            payload = context.payment_payload
            if not isinstance(payload, PaymentPayload):
                # V1 payloads cannot carry the bind; defer to caller policy.
                return None
            if extract_ticket_bind(payload) is None:
                # Refuse to run the paid handler when there's no bind — the
                # client wouldn't be able to obtain a usable ticket anyway.
                return SkipHandlerResult(
                    response=SkipHandlerDirective(
                        content_type="application/json",
                        body={"error": "erc8004_ticket_bind_required"},
                    )
                )
            return None

        def enrich_settlement_response(
            self, declaration: Any, context: SettleResultContext
        ) -> dict[str, Any] | None:
            """Surface ticketId in PAYMENT-RESPONSE.extensions.erc8004.

            The interaction receipt covers the response, which isn't in the
            settle context. The HTTP layer produces it via
            ``create_interaction_receipt`` once response digests exist.
            """
            settle_response = context.result
            settle_ext = getattr(settle_response, "extensions", None) or {}
            erc8004_data = settle_ext.get(EXTENSION_KEY)
            if not isinstance(erc8004_data, dict):
                return None
            ticket_id = erc8004_data.get("ticketId")
            if ticket_id is None:
                return None
            return {"ticketId": str(ticket_id)}

    return ERC8004ResourceServerExtension()


def create_interaction_receipt(
    signer: Any,
    *,
    agent_id: int,
    requirements: PaymentRequirements,
    payment_payload: PaymentPayload,
    tx_hash: str,
    payer: str,
    request: dict[str, Any],
    response: dict[str, Any],
    payment_method: str | None = None,
    ticket_id: int | None = None,
) -> InteractionReceipt:
    """Sign an InteractionReceipt over {version, settlement, request, response}.

    Call this at the HTTP layer, after the resource handler runs, once the
    response digests are known. ``request``/``response`` carry digests (not raw
    bodies). The returned receipt is meant for the ``X-X402-Interaction-Receipt``
    response header; the client embeds it at ``interaction.response.agentSignature``.

    The signer must be the agent owner key (``IdentityRegistry.ownerOf(agentId)``).

    ``ticket_id`` is accepted for forward compatibility with Phase 4's receipt
    digest migration (which signs over ticketId instead of tx_hash). For now
    the digest still uses tx_hash — the ticket id is stored on the receipt as
    metadata so callers can attach it to artifact.interaction without changing
    the on-chain receipt verifier.
    """
    pm = payment_method or _payment_method(requirements)
    artifact = build_artifact(
        requirements=requirements,
        payment_payload=payment_payload,
        tx_hash=tx_hash,
        payer=payer,
        payment_method=pm,
        agent_id=agent_id,
        request=request,
        response=response,
        feedback={},
    )
    interaction_hash = compute_interaction_hash(artifact.to_dict())
    chain_id = int(requirements.network.split(":")[1])
    tx_bytes = bytes.fromhex(tx_hash.removeprefix("0x"))
    receipt = sign_interaction_receipt(signer, chain_id, tx_bytes, interaction_hash)
    if ticket_id is not None:
        # Stash the ticket id on the receipt object so the HTTP layer can
        # include it in the artifact without an extra round-trip. Phase 4
        # will move the signed digest itself to (chainId, ticketId,
        # interactionHash); until then keep ticket_id as a parallel field.
        object.__setattr__(receipt, "ticket_id", int(ticket_id))
    return receipt


def _payment_method(requirements: Any) -> str:
    """Best-effort scheme tag for the artifact (informational only)."""
    extra = getattr(requirements, "extra", {}) or {}
    # x402 EVM mechanisms use `assetTransferMethod` ("eip3009", "permit2", ...).
    return extra.get("assetTransferMethod") or extra.get("paymentMethod") or requirements.scheme
