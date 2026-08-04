# ERC-8004 Feedback Extension (v2)

x402 v2 extension that turns paid HTTP calls into ticket-gated, on-chain feedback for ERC-8004 agents.

## How it works

1. **Pay.** Client signs x402 payment only (no ticket bind, no agentId echo). The server stamps its `agentId` into the settle-time requirements; the facilitator routes settle through `X402AgentReputation.settleAndMintTicket{EIP3009,Permit2}` (permissionless — gated by the signed authorization) and the wrapper binds the minted `agentId` to the paid address (`ownerOf(agentId) == payTo`). Ticket fields are plain payment data: `payer`, `agentId`, `agentAddress`, `token`, `amount`, `consumed`.
2. **Serve.** Agent runs handler, then best-effort signs EIP-712 `InteractionAttestation` → `X-X402-Interaction-Attestation` header (never blocks the 200).
3. **Feedback.** Payer delegates its EOA to the `FeedbackGateway` (EIP-7702) — self-paid (`submitFeedback`) or sponsored via a signed `FeedbackIntent` (`submitFeedbackFor`). The gateway, running as the client, calls `X402AgentReputation.consumeTicket` (ticket `consumed=true`) and forwards `giveFeedback` to the **canonical** `ReputationRegistry`, authored by the client.
4. **Verify.** Aggregators run `verify_feedback` → `FULL` / `CLIENT_ONLY` / `DISPUTED` / `REJECTED`.

Feedback is stored on the canonical ERC-8004 `ReputationRegistry`; the wrapper only mints/consumes the payment-backed ticket. Disputes use the canonical registry's own `revokeFeedback` (client) / `appendResponse` (agent).

## Activation

| Side | Requirement |
|------|-------------|
| Resource server | `create_erc8004_resource_server_extension(config)` with `agent_id`; stamp `agentId` into the settle-time requirements via `set_requirements_agent_id(requirements, agent_id)` |
| Client | Nothing erc8004-specific for pay — `agentId` is server-sourced, never echoed |
| Facilitator | `ERC8004TicketFacilitatorExtension(wrappers={network: wrapper_addr})` |

Settle routing guards: extension registered + wrapper address configured + `agentId` in `requirements.extra` (server-set at settle, never client-supplied). The wrapper additionally binds the minted `agentId` to the paid address on-chain (`ownerOf(agentId) == payTo`).

## Server usage

```python
from x402.extensions.erc8004 import (
    create_erc8004_resource_server_extension,
    create_interaction_attestation,
    attach_interaction_attestation_header,
    ATTESTATION_HEADER,
    ERC8004Config,
)

config = ERC8004Config(
    network="eip155:8453",
    wrapper_address="0x...X402AgentReputation...",
    reputation_registry="0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    identity_registry="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    rpc_url="https://...",
    agent_id=42,
)
server.register_extension(create_erc8004_resource_server_extension(config))

# After handler (best-effort):
att = create_interaction_attestation(
    agent_owner,
    wrapper_address=config.wrapper_address,
    requirements=requirements,
    ticket_id=int(settle_result.extensions["erc8004"]["ticketId"]),
    method="GET",
    url=url,
    request_body=request_body_bytes,
    response_body=response_body_bytes,
    response_status=200,
)
response.headers = attach_interaction_attestation_header(dict(response.headers), att)
```

## Client usage

```python
from x402.extensions.erc8004 import (
    ERCFeedbackClient,
    ERC8004Config,
    FeedbackParams,
    body_digest,
    build_artifact,
    compute_feedback_hash,
)

# No client extension to register: agentId is server-sourced at settle, not echoed.
# The client just pays normally and reads ticketId from PAYMENT-RESPONSE.
feedback_client = ERCFeedbackClient(config, signer)
ticket_id = int(payment_response.extensions["erc8004"]["ticketId"])

params = FeedbackParams(
    agent_id=42, value=95, tag1="x402",
    endpoint="https://agent.example/r",
    feedback_hash=feedback_hash,
)
feedback_client.submit_feedback_with_ticket(ticket_id, params)
```

## Facilitator usage

```python
facilitator.register_extension(ERC8004TicketFacilitatorExtension(
    wrappers={"eip155:8453": "0x...X402AgentReputation..."},
))
```

## Verification

```python
tier = verify_feedback(
    w3, config.identity_registry, artifact_bytes, feedback_hash, artifact_dict,
    wrapper_address=config.wrapper_address,
)
```

## References

- Spec: [`specs/extensions/erc8004_ticket_v2.md`](../../../../specs/extensions/erc8004_ticket_v2.md)
- Flow diagram: [`x402-erc8004-ticket-flow.html`](./x402-erc8004-ticket-flow.html)
- Demo: [`examples/python/clients/erc8004/run_x402_client.py`](../../../../examples/python/clients/erc8004/run_x402_client.py)
