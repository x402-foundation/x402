"""Client-side helpers for binding an x402 paid request to an ERC-8004 ticket.

The TicketMinter stores two hashes per ticket — `requestHash` and
`interactionHash` — that pin the on-chain ticket to a specific request /
response pair. Both sides (client + facilitator) must compute them the same
way, so this module is the single source of truth for the canonicalisation
contract.

- `requestHash`     = keccak(canonical_json(request_digests))
- `interactionHash` = keccak over the canonical interaction core
                      ({version, settlement, request, response}) with
                      settlement.txHash omitted at bind time

When the client signs its payment payload, it computes both hashes ahead of
the settle tx (so neither the settle tx hash nor the response body are known
yet). The facilitator forwards them into `TicketMinter.settleAndMintTicket*`,
the resource server later signs a receipt whose interaction_hash matches.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from eth_utils import keccak

from x402.schemas.payments import PaymentPayload, PaymentRequirements

from .artifact import canonical_bytes
from .types import ARTIFACT_VERSION


@dataclass(frozen=True)
class TicketBind:
    """The 4-tuple a client must publish into `payment_payload.extensions.erc8004`.

    Mirrors `facilitator.TicketBind` but kept locally to avoid pulling the
    facilitator-side import chain into clients.
    """

    agent_id: int
    request_hash: bytes
    interaction_hash: bytes
    endpoint: str

    def to_extension_info(self) -> dict[str, Any]:
        """Render as the JSON shape echoed into PaymentPayload.extensions.erc8004.info."""
        return {
            "agentId": self.agent_id,
            "requestHash": "0x" + self.request_hash.hex(),
            "interactionHash": "0x" + self.interaction_hash.hex(),
            "endpoint": self.endpoint,
        }


def compute_request_hash(request_digests: dict[str, Any]) -> bytes:
    """keccak256 over the canonical JSON of request digests.

    ``request_digests`` is the same shape passed to ``build_artifact``'s
    ``request`` argument: a small dict of HTTP method, URL, header/body
    digests. We don't constrain the keys here — whatever the agent and client
    agree on. The hash binds the ticket to that exact request.
    """
    return keccak(canonical_bytes(request_digests))


def compute_ticket_bind(
    *,
    requirements: PaymentRequirements,
    payment_payload: PaymentPayload,
    agent_id: int,
    endpoint: str,
    request_digests: dict[str, Any],
    payer: str,
    payment_method: str,
    response_digests: dict[str, Any] | None = None,
) -> TicketBind:
    """Compute (requestHash, interactionHash) for the ticket bind.

    ``response_digests`` is optional: at the moment the client signs the
    payment payload, the response body isn't known yet. The interaction hash
    therefore covers a *placeholder* response (empty dict by default) — the
    same placeholder both sides must agree on. The interaction receipt signed
    by the agent at HTTP time uses the same shape, so the two preimages match
    exactly.

    The settlement section omits ``txHash`` at bind time (it doesn't exist
    yet) — both sides reconstruct the same preimage.
    """
    request_hash = compute_request_hash(request_digests)

    settlement = {
        "chainId": requirements.network,
        "scheme": requirements.scheme,
        "paymentMethod": payment_method,
        "agentId": agent_id,
        "asset": requirements.asset,
        "payer": payer,
        "payTo": requirements.pay_to,
        "amount": requirements.amount,
        "paymentPayload": payment_payload.model_dump(mode="json"),
        "paymentRequirements": requirements.model_dump(mode="json"),
    }

    response = dict(response_digests) if response_digests else {}
    response.pop("agentSignature", None)  # never include the receipt over itself

    core = {
        "version": ARTIFACT_VERSION,
        "settlement": settlement,
        "request": request_digests,
        "response": response,
    }
    interaction_hash = keccak(canonical_bytes(core))

    return TicketBind(
        agent_id=agent_id,
        request_hash=request_hash,
        interaction_hash=interaction_hash,
        endpoint=endpoint,
    )


def echo_ticket_bind_in_payment_payload(
    payment_payload: PaymentPayload, bind: TicketBind
) -> PaymentPayload:
    """Merge the TicketBind into PaymentPayload.extensions.erc8004.info.

    Idempotent: if an erc8004 extension entry already exists (e.g. from the
    server's agentId declaration), this preserves the schema field and only
    updates / adds the info keys.
    """
    from .schema import erc8004_schema
    from .types import EXTENSION_KEY

    extensions = dict(payment_payload.extensions or {})
    existing = extensions.get(EXTENSION_KEY, {})
    if isinstance(existing, dict):
        existing_info = existing.get("info") or {}
        schema = existing.get("schema", erc8004_schema)
    else:
        existing_info = getattr(existing, "info", {}) or {}
        schema = getattr(existing, "schema", erc8004_schema)

    info = {**dict(existing_info), **bind.to_extension_info()}
    extensions[EXTENSION_KEY] = {"info": info, "schema": schema}
    payment_payload.extensions = extensions
    return payment_payload
