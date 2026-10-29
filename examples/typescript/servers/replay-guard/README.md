# Replay Guard Server Example

Express.js server that runs a paid handler at most once per payment authorization.

The middleware verifies a payment, runs the handler, then settles. Verification does not consume the authorization; settlement does. So one signed payment sent several times at once passes verification every time, and the handler runs for each copy. The facilitator settles only one, and the other copies get a 402, so no one receives a free response. But every side effect in the handler (a model call, a queued job, an onchain transaction) happens once per copy. See [#1169](https://github.com/x402-foundation/x402/issues/1169) for the wider verify-to-settle race.

This example closes the duplicate-copy case with an `onAfterVerify` hook (abridged from [`index.ts`](./index.ts)):

```typescript
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .onAfterVerify(async ({ paymentPayload, requirements, result }) => {
    if (!result.isValid) return;
    const claim = claimOf(paymentPayload, requirements);
    if (!claim) return;
    const claimedUntil = claims.get(claim.key);
    if (claimedUntil !== undefined && Date.now() < claimedUntil) {
      return { abort: true, reason: "payment_replayed", message: "..." };
    }
    claims.set(claim.key, claim.expiresAt + CLOCK_SKEW_MS);
  });
```

The claim key identifies the authorization rather than the header bytes, so a re-encoded copy still matches. A claim lasts until the authorization itself expires:

| Payload | Key | Kept until |
| --- | --- | --- |
| EIP-3009 (`authorization`) | network, asset, `from`, `nonce` (the token contract accepts each nonce from a signer once) | `validBefore` |
| Permit2 (`permit2Authorization`) | network, `from`, `nonce` as an integer (Permit2 nonces are per owner, across tokens; `"1"`, `"01"` and `"0x1"` sign the same value) | `deadline` |

The signer chooses that expiry, and verification does not cap it at `maxTimeoutSeconds`, so a fixed TTL could release a claim while the authorization can still settle.

Claims are made only after the facilitator reports the payment valid, so an invalid payment never takes a claim.

This complements the [`payment-identifier`](../payment-identifier/) example rather than replacing it. That example caches a response after settlement under an ID the client chooses, which serves retries. Copies that arrive before the first one settles are not cached yet, and a client can omit the ID.

## Prerequisites

- Node.js v22+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v11.1.1+ (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM address for receiving payments (Base Sepolia)

## Setup

1. Copy `.env-local` to `.env` and fill in:

- `EVM_ADDRESS` - Ethereum address to receive payments
- `FACILITATOR_URL` - Facilitator endpoint URL

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/replay-guard
```

3. Run the server:

```bash
pnpm dev
```

Pay `GET http://localhost:4021/report` with any client example, then send the same `PAYMENT-SIGNATURE` header again. The second request returns 402 with `payment_replayed`, and the handler log shows one run.

## Production Considerations

- **Shared store.** The in-memory `Map` is atomic within one process. With several instances, claim with an atomic insert in a shared store: Redis `SET key 1 NX PXAT <expiry ms>`, or a unique index.
- **Expiry.** Keep each claim until the authorization's own `validBefore` or `deadline`, plus a margin for clock skew. If you need a bounded store, reject authorizations whose expiry is further out than you are willing to retain instead of evicting their claims early.
- **Store outages.** Decide what happens when a claim cannot be written. Failing closed keeps the guarantee: catch the store error and return an `abort` (for example `reason: "claim_unavailable"`), so the handler does not run. Failing open keeps the route available but gives up duplicate-execution protection while the store is down; the facilitator still refuses a second settlement, but the handler can run for every copy. Fail closed for handlers that are expensive or not idempotent. A hook that throws is logged and skipped by the resource server, which fails open, so don't rely on throwing to refuse.
- **Retries.** `payment_replayed` means the authorization was presented before, not that the earlier attempt failed. If the client lost the first response, the handler may have run and the payment may have settled, so signing a new authorization can pay twice. Establish the outcome of the original request first: keep its result, and match it to a confirmed settlement, or confirm the authorization was cancelled or has expired. For EIP-3009, `authorizationState(from, nonce)` on the token contract helps but is not enough on its own: `true` means used or cancelled, not that this request succeeded, and `false` does not rule out a pending settlement transaction. Pair this guard with [`payment-identifier`](../payment-identifier/) if clients need the stored result of a settled payment returned to them. Sign a new authorization only when the earlier attempt is known to have failed.
- **Other schemes.** Key on whatever the scheme makes single-use. For `exact` on Solana, hash the transaction message rather than the whole transaction: the fee payer's signature slot is outside the payer's signature.
