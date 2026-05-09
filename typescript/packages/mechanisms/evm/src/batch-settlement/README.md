# Batch-Settlement EVM Scheme (`@x402/evm/batch-settlement`)

The **batch-settlement** scheme enables high-throughput, low-cost EVM payments via **stateless unidirectional payment channels**. Clients deposit funds into an onchain escrow once, then sign off-chain **cumulative vouchers** per request. Servers verify vouchers with a fast signature check and claim them onchain in batches.

A single claim transaction can cover many channels at once, and claimed funds are swept to the receiver in a separate `settle` step. The scheme also supports **dynamic pricing**: the client authorizes a max per-request and the server charges only what was actually used.

See the [scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) for full protocol details.

## Import Paths

| Role | Import |
|------|--------|
| Client | `@x402/evm/batch-settlement/client` |
| Server | `@x402/evm/batch-settlement/server` |
| Facilitator | `@x402/evm/batch-settlement/facilitator` |

## Client Usage

Register `BatchSettlementEvmScheme` with an `x402Client`. The client handles deposits, voucher signing, channel-state recovery, and corrective 402 resync.

```typescript
import { x402Client } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const scheme = new BatchSettlementEvmScheme(signer, {
  depositPolicy: { depositMultiplier: 5 },
});

const client = new x402Client();
client.register("eip155:*", scheme);
```

### Deposit Policy

Controls how much the client deposits when the channel needs funding or top-up:

| Field | Description |
|-------|-------------|
| `depositMultiplier` | Per-request `amount × multiplier` is deposited (default 5, minimum 3) |

Use `depositStrategy` for app-specific deposit decisions. The strategy can:

- Return `undefined` to use the SDK default deposit amount.
- Return `false` to skip this deposit attempt.
- Return a base-unit string or bigint to choose a custom amount. The amount must cover the next voucher.

```typescript
const maxDeposit = 1_000_000n;

const scheme = new BatchSettlementEvmScheme(signer, {
  depositPolicy: { depositMultiplier: 5 },
  depositStrategy: ({ depositAmount }) => {
    const amount = BigInt(depositAmount);
    return amount > maxDeposit ? maxDeposit : undefined;
  },
});
```

### Voucher Signer Delegation

By default, vouchers are signed by the same key as the payer. For better performance — especially when the payer is a **smart wallet** (EIP-1271) — delegate voucher signing to a dedicated EOA. The scheme commits this address as the channel's `payerAuthorizer`, so the facilitator can verify vouchers via fast ECDSA recovery instead of an onchain `isValidSignature` RPC.

```typescript
const voucherSigner = toClientEvmSigner(privateKeyToAccount(VOUCHER_KEY));
const scheme = new BatchSettlementEvmScheme(signer, { voucherSigner });
```

### Cooperative Refund

Trigger a cooperative refund request:

```typescript
// Full refund: refunds the remaining channel balance.
const settle = await scheme.refund("https://api.example.com/any-protected-route");

// Partial refund:
await scheme.refund(url, { amount: "1000000" });
```

The server claims any outstanding vouchers and then executes `refundWithSignature` to return `balance - totalClaimed` or `amount` to the payer.

### Persistence

By default, channel state is stored in memory. For long-lived clients, use `FileClientChannelStorage`:

```typescript
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client";

const scheme = new BatchSettlementEvmScheme(signer, {
  storage: new FileClientChannelStorage({ directory: "./channels" }),
});
```

If state is lost, the client recovers from onchain `channels(channelId)` plus corrective 402s — see the spec's *Recovery After State Loss* section.

## Server Usage

Register the scheme with an `x402ResourceServer` and pair it with a `ChannelManager` to handle batched claims, settlements, and refunds.

```typescript
import { x402ResourceServer } from "@x402/core/server";
import {
  BatchSettlementEvmScheme,
  FileChannelStorage,
  RedisChannelStorage,
} from "@x402/evm/batch-settlement/server";

const scheme = new BatchSettlementEvmScheme(receiverAddress, {
  receiverAuthorizerSigner,        // optional: self-managed authorizer (recommended)
  withdrawDelay: 900,              // 15 min – 30 days
  storage: new FileChannelStorage({ directory: "./channels" }),
});

const server = new x402ResourceServer(facilitatorClient).register("eip155:84532", scheme);

const manager = scheme.createChannelManager(facilitatorClient, "eip155:84532");
manager.start({
  claimIntervalSecs: 60,
  settleIntervalSecs: 300,
  refundIntervalSecs: 3600,
  selectClaimChannels: channels => channels,
  selectRefundChannels: channels =>
    channels.filter(channel => Date.now() - channel.lastRequestTimestamp >= 3_600_000),
});
```

For serverless deployments or multi-instance servers, use Redis/Valkey-backed storage so channel updates survive cold starts and are atomic across processes:

```typescript
const scheme = new BatchSettlementEvmScheme(receiverAddress, {
  storage: new RedisChannelStorage({ client: redisClient }),
});
```

Use the same `selectClaimChannels` policy with one-shot cron jobs when you need to claim a specific channel subset:

```typescript
const selectedChannelIds = new Set(["0x..."]);

await manager.claimAndSettle({
  maxClaimsPerBatch: 100,
  selectClaimChannels: channels =>
    channels.filter(channel => selectedChannelIds.has(channel.channelId.toLowerCase())),
});
```

### Receiver Authorizer

The `receiverAuthorizer` signs `ClaimBatch` and `Refund` EIP-712 messages and is committed into the channel's identity at deposit time:

- **Self-managed** (recommended): pass a `receiverAuthorizerSigner` (an EOA you control). Channels survive facilitator changes — any facilitator can relay your signed claims and refunds.
- **Facilitator-delegated**: omit `receiverAuthorizerSigner`. The scheme picks up `extra.receiverAuthorizer` advertised by the facilitator's `/supported`. Switching facilitators requires opening **new channels**, so claim and refund existing channels first with.

### Pricing

Set the route `price` to the per-request maximum. To bill less than the max, override at handler time:

```typescript
import { setSettlementOverrides } from "@x402/express";

app.get("/api/generate", (req, res) => {
  const actualUsage = computeCost();
  setSettlementOverrides(res, { amount: String(actualUsage) });
  res.json({ result: "..." });
});
```

`amount` accepts raw atomic units, percentages (`"50%"`), or dollar prices (`"$0.001"`).

## Facilitator Usage

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";

const facilitator = new x402Facilitator().register(
  "eip155:84532",
  new BatchSettlementEvmScheme(evmSigner, authorizerSigner),
);
```

The `authorizerSigner` produces the EIP-712 signatures advertised in `/supported.kinds[].extra.receiverAuthorizer`. Servers may delegate to it (see above) or supply their own. The `evmSigner` (the wallet account) submits transactions for `deposit`, `claimWithSignature`, `settle`, and `refundWithSignature` — anyone can submit a valid claim/refund tx, but only the configured signer here will be used by this facilitator.

## Supported Networks

| Network | CAIP-2 ID |
|---------|-----------|
| Base Mainnet | `eip155:8453` |
| Base Sepolia | `eip155:84532` |

Requires the x402 batch-settlement contract deployed on the target network.

## Asset Transfer Methods

Deposits use one of two onchain transfer methods, controlled by `extra.assetTransferMethod`:

| Method | Description |
|--------|-------------|
| `eip3009` | `receiveWithAuthorization` — for tokens that support EIP-3009 (e.g. USDC). Default. |
| `permit2` | Universal fallback for any ERC-20 via Uniswap Permit2. |

Deposits are sponsored by the facilitator (gasless for the client).

## Examples

- [Server example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/batch-settlement)
- [Client example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/clients/batch-settlement)
- [Facilitator example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/facilitator/batch-settlement)
- [Streaming server (SSE, mid-stream voucher renewal)](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/batch-settlement-streaming)

## See Also

- [Exact EVM Scheme](../exact/README.md) — fixed-price, no escrow
- [Upto EVM Scheme](../upto/README.md) — usage-based, single-shot
- [Batch-Settlement EVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md)
