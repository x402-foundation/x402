# ERC-8004 Feedback Extension

x402 v2 extension that turns paid HTTP calls into ticket-gated, on-chain feedback for ERC-8004 agents.

## How it works (ticket flow)

1. **Pay.** Client pays via the normal x402 flow. The facilitator routes the settle
   call through `TicketMinter.settleAndMintTicket{,EIP3009,Permit2}` so the token
   transfer and a `Ticket` mint land in **one transaction**. The `ticketId`
   surfaces on `PAYMENT-RESPONSE.extensions.erc8004.ticketId` (or is recoverable
   from the `TicketMinted` log).
2. **Bind.** Before signing the payment, the client computes a `TicketBind`
   (`requestHash`, `interactionHash`, `endpoint`, `agentId`) and echoes it into
   `PaymentPayload.extensions.erc8004` — both client and facilitator hash the
   same canonical preimage, so the ticket is cryptographically pinned to that
   specific request → response pair.
3. **Feedback.** The payer calls `ReputationRegistryV3.giveFeedbackWithTicket`
   (Path A, direct) — or signs an EIP-712 `FeedbackIntent` that a relayer
   submits via `giveFeedbackWithTicketFor` (Path B, sponsored — payer pays no
   gas). The ticket transitions `MINTED → CONSUMED` atomically with the
   feedback record. The registry forbids self-feedback (`payer != agent owner`)
   and dedups on `(agentId, payer, feedbackHash)`.
4. **Agent receipt (optional).** The server can sign an `InteractionReceipt`
   over `keccak256(prefix ‖ chainId ‖ ticketId ‖ interactionHash)` and return
   it in `X-X402-Interaction-Receipt`. Embedded in the artifact at
   `interaction.response.agentSignature`, it commits the agent to *what it
   served*.

`ReputationRegistry.giveFeedback` (the gateway-less path) is on-chain disabled in
`ReputationRegistryV3` (`LegacyGiveFeedbackDisabled`). The bind is mandatory:
enabling the extension on the server unconditionally requires the client to
echo the bind, otherwise the paid handler is skipped before money moves.

## Activation contract — who must opt in

| Side | Must do | Without it |
|------|---------|------------|
| Resource server | `server.register_extension(create_erc8004_resource_server_extension(config))` | 402 never advertises `erc8004` |
| Client | `client.register_extension(ERC8004ClientExtension(bind))` (or `ext.set_ticket_bind(bind)`) | `payload.extensions.erc8004` empty → server skips handler, facilitator falls through to plain transfer |
| Facilitator | `facilitator.register_extension(ERC8004TicketFacilitatorExtension(minters={...}))` | `ExactEvmScheme.settle` falls through → no ticket minted |

Inside `ExactEvmScheme.settle()` the routing branch (Phase 3.4) checks all three guards. Any miss → standard transfer/proxy path runs; non-erc8004 traffic is untouched.

## Installation

```bash
pip install x402[evm]
```

## Server usage

```python
from x402 import x402ResourceServer
from x402.extensions.erc8004 import (
    create_erc8004_resource_server_extension,
    create_interaction_receipt,
    ERC8004Config,
)
from eth_account import Account

config = ERC8004Config(
    network="eip155:1",
    reputation_registry="0x...ReputationRegistryV3...",
    identity_registry="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    rpc_url="https://...",
    agent_id=42,
)
server = x402ResourceServer(facilitator_client)
server.register_extension(create_erc8004_resource_server_extension(config))

# After the handler runs and settlement completes, sign an interaction receipt
# anchored to the ticketId and return it in a header.
agent_owner = Account.from_key("0x...")  # == IdentityRegistry.ownerOf(agentId)
ticket_id = int(settle_result.extensions["erc8004"]["ticketId"])
receipt = create_interaction_receipt(
    agent_owner,
    agent_id=42,
    requirements=requirements,
    payment_payload=payment_payload,
    ticket_id=ticket_id,
    tx_hash=settle_result.transaction,
    payer=settle_result.payer,
    request={"method": "GET", "url": url, "headerDigest": h_req, "bodyDigest": b_req},
    response={"status": 200, "headerDigest": h_resp, "bodyDigest": b_resp},
)
response.headers["X-X402-Interaction-Receipt"] = json.dumps(receipt.to_dict())
```

## Client usage

```python
from x402.extensions.erc8004 import (
    ERC8004ClientExtension,
    ERCFeedbackClient,
    ERC8004Config,
    FeedbackParams,
    compute_ticket_bind,
)

config = ERC8004Config(
    network="eip155:1",
    reputation_registry="0x...ReputationRegistryV3...",
    identity_registry="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    rpc_url="https://...",
)
ext = ERC8004ClientExtension()
client.register_extension(ext)

# Before each paid request: compute the bind, hand it to the extension.
request_digests = {"method": "GET", "url": url, "headerDigest": "0x..", "bodyDigest": "0x.."}
bind = compute_ticket_bind(
    requirements=requirements,
    payment_payload=payment_payload,
    agent_id=42,
    endpoint="https://agent.example/r",
    request_digests=request_digests,
    payer=signer.address,
    payment_method="eip3009",   # or "permit2", "erc20"
)
ext.set_ticket_bind(bind)
# ... send request — extension echoes bind into payload.extensions.erc8004

# Recover ticketId from PAYMENT-RESPONSE (or parse the receipt log as a fallback).
feedback_client = ERCFeedbackClient(config, signer)
ticket_id = int(payment_response.extensions["erc8004"]["ticketId"])
# or: ticket_id = feedback_client.ticket_id_from_receipt(settlement_tx_hash)

params = FeedbackParams(
    agent_id=42, value=95, tag1="x402", tag2="weather",
    endpoint="https://agent.example/r",
    feedback_uri="ipfs://...",
    feedback_hash=feedback_hash,
)

# Path A — direct (payer pays gas):
feedback_client.submit_feedback_with_ticket(ticket_id, params)

# Path B — sponsored (relayer pays gas):
nonce, deadline = 1, int(time.time()) + 3600
domain, types, message = feedback_client.build_feedback_intent(ticket_id, params, nonce, deadline)
signed = Account.sign_typed_data(
    signer.key,
    domain_data=domain,
    message_types={k: v for k, v in types.items() if k != "EIP712Domain"},
    message_data=message,
)
relayer_client = ERCFeedbackClient(config, relayer_signer)
relayer_client.submit_feedback_sponsored(
    payer=signer.address, ticket_id=ticket_id, params=params,
    nonce=nonce, deadline=deadline, signature=signed.signature,
)
```

## Facilitator usage

```python
from x402 import x402Facilitator
from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme
from x402.extensions.erc8004 import ERC8004TicketFacilitatorExtension

facilitator = x402Facilitator()
facilitator.register(
    ["eip155:1"],
    ExactEvmFacilitatorScheme(signer=fac_signer),
)
facilitator.register_extension(ERC8004TicketFacilitatorExtension(
    minters={"eip155:1": "0x...TicketMinter..."},
))
# settle() now routes through TicketMinter whenever the payload carries a bind.
```

## Verification (aggregators)

```python
from x402.extensions.erc8004 import verify_feedback, dedup_feedback, TrustTier

tier = verify_feedback(w3, config.identity_registry, artifact_bytes, feedback_hash, artifact_dict)
# TrustTier.FULL / CLIENT_ONLY / DISPUTED / REJECTED
```

## Hashes

| Field | Definition |
|-------|------------|
| `requestHash` | `keccak256(canonical_json(requestDigests))` |
| `interactionHash` | `keccak256(canonical_json({version, settlement*, request, response}))` — settlement omits txHash at bind time, response excludes `agentSignature` |
| `feedbackHash` | `keccak256(canonical_json(fullArtifact))` at feedback time |
| Agent receipt | `personal_sign(keccak256("x402-erc8004-receipt" ‖ chainId ‖ ticketId ‖ interactionHash))` |

See [`specs/extensions/erc8004_ticket.md`](../../../../specs/extensions/erc8004_ticket.md) for the full design and [`x402-erc8004-ticket-flow.html`](./x402-erc8004-ticket-flow.html) for the flow diagram.

## Demo

`examples/python/clients/erc8004/run_ticket_demo.py` runs the full flow against a mainnet fork using real USDC + DAI and the canonical ERC-8004 IdentityRegistry. See [`examples/python/clients/erc8004/README.md`](../../../../examples/python/clients/erc8004/README.md).
