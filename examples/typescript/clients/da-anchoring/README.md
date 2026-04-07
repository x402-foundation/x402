# x402 + Decision Anchor Payment Anchoring

Example client demonstrating how to anchor x402 payment decisions externally using [Decision Anchor](https://api.decision-anchor.com). Creates append-only proof of payment authorization scope before x402 execution.

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import DecisionAnchor from "decision-anchor-sdk";

// Anchor the decision BEFORE payment
const dd = await da.dd.create({ ... });

// Execute x402 payment
const response = await fetchWithPayment(url);

// Confirm the anchor AFTER payment
await da.dd.confirm(dd.dd_id);
```

## What This Demonstrates

On-chain records show who paid whom how much — but not **why** an agent authorized a payment, or what decision scope was in effect. Internal logs are self-testimony: the agent claims it decided the spend was necessary, but that claim is unfalsifiable after the fact.

This example wraps x402 payments with DA Decision Declarations:

1. **Before payment** — creates a DD that records the authorization scope externally
2. **x402 payment** — executes USDC payment via `@x402/fetch`
3. **After payment** — confirms the DD, anchoring the completion timestamp

The DD is external (not in the agent's own logs), append-only (cannot be retroactively modified), and created at the moment of decision (not reconstructed later).

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A running x402 server (see [express server example](../../servers/express))
- A DA agent auth token (register at https://api.decision-anchor.com — see [SDK docs](https://github.com/zse4321/decision-anchor-sdk))
- Valid EVM private key with USDC on Base

## Setup

1. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd clients/da-anchoring
```

2. Create a `.env` file with your credentials:

```bash
EVM_PRIVATE_KEY=0x...        # Ethereum private key for x402 payments
DA_AUTH_TOKEN=da_tk_...      # Decision Anchor auth token
TARGET_API_URL=http://localhost:4021/weather  # x402-protected endpoint
DA_BASE_URL=https://api.decision-anchor.com  # Optional, defaults to production
```

3. Run the example:

```bash
pnpm start
```

## Expected Output

```
=== x402 Payment with DA Anchoring ===

1. Creating Decision Declaration (pre-payment anchor)...
   DD ID: dd_abc123...
   Anchored at: 2026-04-07T12:00:00.000Z
   Integrity hash: sha256:...

2. Executing x402 payment...
   Status: 200
   Response: { ... }

3. Confirming Decision Declaration (post-payment anchor)...
   Status: confirmed
   Confirmed at: 2026-04-07T12:00:01.000Z

=== Done ===
```

## Related

- [fetch client example](../fetch/) — basic x402 payment without anchoring
- [Decision Anchor SDK](https://github.com/zse4321/decision-anchor-sdk) — DA client library
- [x402.org](https://x402.org) — x402 protocol specification
