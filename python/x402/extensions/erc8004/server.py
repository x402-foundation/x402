"""Resource Server Extension for ERC-8004 feedback."""

from __future__ import annotations

import logging
from typing import Any

from x402.mechanisms.evm.utils import get_evm_chain_id
from x402.schemas.extensions import ResourceServerExtension
from x402.schemas.hooks import (
    ServerPaymentRequiredContext,
    SettleResultContext,
)
from x402.schemas.payments import PaymentRequirements

from .artifact import body_digest, sign_interaction_attestation
from .schema import declare_erc8004_extension
from .types import EXTENSION_KEY, ERC8004Config, InteractionAttestation

logger = logging.getLogger("x402.erc8004.server")

ATTESTATION_HEADER = "X-X402-Interaction-Attestation"


def create_erc8004_resource_server_extension(
    config: ERC8004Config,
) -> ResourceServerExtension:
    """Create ERC-8004 server extension.

    Declares ``agentId`` in the 402 response and surfaces ``ticketId`` in
    PAYMENT-RESPONSE after settle. Post-handler, signs an InteractionAttestation
    when possible (best-effort — never blocks the paid response).
    """
    agent_id = config.agent_id
    if agent_id is None:
        raise ValueError("agent_id is required in ERC8004Config for server extension")

    wrapper_address = config.wrapper_address

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

        def enrich_settlement_response(
            self, declaration: Any, context: SettleResultContext
        ) -> dict[str, Any] | None:
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


def create_interaction_attestation(
    signer: Any,
    *,
    wrapper_address: str,
    requirements: PaymentRequirements,
    ticket_id: int,
    method: str,
    url: str,
    request_body: bytes,
    response_body: bytes,
    response_status: int,
) -> InteractionAttestation:
    """Sign an InteractionAttestation after the handler runs (HTTP layer)."""
    chain_id = get_evm_chain_id(str(requirements.network))
    req_digest = body_digest(request_body)
    resp_digest = body_digest(response_body)

    return sign_interaction_attestation(
        signer,
        wrapper_address=wrapper_address,
        ticket_id=int(ticket_id),
        chain_id=chain_id,
        method=method,
        url=url,
        request_body_digest=req_digest,
        response_body_digest=resp_digest,
        response_status=response_status,
    )


def attach_interaction_attestation_header(
    headers: dict[str, str],
    attestation: InteractionAttestation | None,
) -> dict[str, str]:
    """Attach X-X402-Interaction-Attestation when signing succeeded."""
    if attestation is None:
        return headers
    import json

    out = dict(headers)
    out[ATTESTATION_HEADER] = json.dumps(attestation.to_dict(), separators=(",", ":"))
    return out


def try_create_interaction_attestation(
    signer: Any,
    **kwargs: Any,
) -> InteractionAttestation | None:
    """Best-effort attestation — log and return None on signing failure."""
    try:
        return create_interaction_attestation(signer, **kwargs)
    except Exception as e:
        logger.warning("erc8004 attestation signing failed: %s", e, exc_info=True)
        return None
