# ERC-8004 Feedback Extension (v2)

x402 v2 extension that turns paid HTTP calls into ticket-gated, on-chain feedback for ERC-8004 agents.

## How it works

1. **Pay.** Client signs x402 payment only (no ticket bind). Facilitator routes settle through `X402AgentReputation.settleAndMintTicket{,EIP3009,Permit2}`. Ticket fields are plain payment data: `payer`, `agentId`, `agentAddress`, `token`, `amount`, `consumed`.
2. **Serve.** Agent runs handler, then best-effort signs EIP-712 `InteractionAttestation` → `X-X402-Interaction-Attestation` header (never blocks the 200).
3. **Feedback.** Payer calls `giveFeedbackWithTicket` (Path A) or signs `FeedbackIntent` for relayer submission (Path B). Ticket sets `consumed=true` atomically with feedback.
4. **Verify.** Aggregators run `verify_feedback` → `FULL` / `CLIENT_ONLY` / `DISPUTED` / `REJECTED`.

Direct feedback on upstream `ReputationRegistry.giveFeedback` remains available separately — the wrapper does not disable it.

## Activation

| Side | Requirement |
|------|-------------|
| Resource server | `create_erc8004_resource_server_extension(config)` with `agent_id` |
| Client | Optional for pay; echoes `agentId` from 402 into payment payload |
| Facilitator | `ERC8004TicketFacilitatorExtension(wrappers={network: wrapper_addr})` |

Settle routing guards: extension registered + wrapper address configured + `agentId` in `payload.extensions.erc8004`.

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
    agent_id=42,
    requirements=requirements,
    payment_payload=payment_payload,
    ticket_id=int(settle_result.extensions["erc8004"]["ticketId"]),
    tx_hash=settle_result.transaction,
    payer=settle_result.payer,
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
    ERC8004ClientExtension,
    ERCFeedbackClient,
    ERC8004Config,
    FeedbackParams,
    body_digest,
    build_artifact,
    compute_feedback_hash,
)

client.register_extension(ERC8004ClientExtension())

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
