# Scheme: `exact` on Thru

## Summary

The `exact` scheme on Thru transfers an exact amount of a token-program asset from a payer's derived token account to a merchant's derived token account. The payer signs one canonical Thru transaction and pays its native transaction fee. The facilitator verifies the transaction and chain state, submits the same bytes, and waits for execution.

This specification supports x402 v2 only.

## Supported Networks

This draft uses `thru:<chain-id>` identifiers and defines Thru Alphanet as `thru:1`.

`thru` is a provisional CAIP namespace in this draft. Standardization or registration of the namespace is an open review item; it MUST be resolved before the mechanism is described as production interoperable.

## Payment Requirements

```json
{
  "scheme": "exact",
  "network": "thru:1",
  "amount": "100000",
  "asset": "ta...mint",
  "payTo": "ta...merchant",
  "maxTimeoutSeconds": 300,
  "extra": {
    "tokenProgram": "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq",
    "maxExpirySlots": 100
  }
}
```

- `amount` is the exact token quantity in atomic units as a decimal string.
- `asset` is the token mint account address.
- `payTo` is the merchant wallet address, not its token-account address.
- The payer token account is derived from `(payer, asset, zero seed)` with the standard token program.
- The recipient token account is derived from `(payTo, asset, zero seed)` with the standard token program.
- `maxTimeoutSeconds` MUST be a positive integer.
- `extra.tokenProgram` identifies the standard token program.
- `extra.maxExpirySlots` is the facilitator's maximum accepted transaction validity window.

### Timeout Mapping

This draft sets `estimatedSlotSeconds = 2` for Alphanet and maps:

```text
timeoutSlots = max(1, ceil(maxTimeoutSeconds / estimatedSlotSeconds))
expiryAfter <= min(timeoutSlots, extra.maxExpirySlots)
```

The constant is a protocol interoperability value rather than a claim that every slot completes in exactly two seconds. Reviewers SHOULD confirm it with Thru before standardization.

## Payment Payload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "thru:1",
    "amount": "100000",
    "asset": "ta...mint",
    "payTo": "ta...merchant",
    "maxTimeoutSeconds": 300,
    "extra": {
      "tokenProgram": "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq",
      "maxExpirySlots": 100
    }
  },
  "payload": {
    "transaction": "base64-canonical-signed-thru-wire-transaction"
  }
}
```

`payload.transaction` is canonical base64 of the complete Thru wire transaction, including its trailing 64-byte fee-payer signature.

## Transaction Construction

The client MUST build one transaction with:

- `feePayer`: payer's Ed25519 public-key address.
- `program`: `extra.tokenProgram`.
- `chainId`: numeric suffix of the selected network.
- `nonce`: current fee-payer account nonce.
- `startSlot`: current finalized slot.
- `expiryAfter`: bounded by the timeout mapping above.
- `readWriteAccounts`: exactly the derived payer and recipient token accounts, in canonical sorted order.
- `readOnlyAccounts`: empty.
- `instructionData`: exactly one standard token `transfer` instruction.

The transfer ABI is:

```text
[variant=2:u8][sourceAccountIndex:u16 LE][destinationAccountIndex:u16 LE][amount:u64 LE]
```

No additional instruction or account is permitted.

## Signature

The unsigned wire body is every transaction byte before the trailing signature. The client computes:

```text
M = ASCII("tn_txn_sign_v1__") || SHA-256(unsignedWireBody)
signature = PureEd25519.sign(feePayerPrivateKey, M)
signedTransaction = unsignedWireBody || signature
```

The 16-byte domain separator and SHA-256 construction are defined by Thru's RFC-8032 transaction-signing API. A client MAY use an external HSM, MPC service, or Cloudflare-controlled signer, provided it signs the exact 48-byte `M` with standard Ed25519.

## Facilitator Verification

A facilitator MUST fail closed unless every check succeeds.

### Envelope and Requirements

1. `x402Version` is `2`.
2. Both selected and required schemes are `exact`.
3. Network is a supported `thru:*` identifier.
4. Selected `scheme`, `network`, `asset`, `payTo`, and `amount` exactly match the supplied requirements.
5. `amount` is positive and fits the token transfer's unsigned 64-bit amount.
6. `maxTimeoutSeconds` and `maxExpirySlots` are valid positive integers.

### Wire and Signature

1. Base64 is canonical.
2. Wire decoding is strict, consumes every byte, and does not accept trailing bytes.
3. The fee-payer signature exists and passes Thru's strict/canonical Ed25519 verification.
4. The facilitator MUST verify the signature before returning `payer`.

### Transaction Intent

1. `chainId` matches the numeric network reference.
2. `program` matches `extra.tokenProgram`.
3. There are exactly two writable accounts and no read-only accounts.
4. Instruction data is exactly the 13-byte standard token transfer ABI.
5. Source is the derived token account for `(feePayer, asset)`.
6. Destination is the derived token account for `(payTo, asset)`.
7. Transfer amount exactly equals the required amount.
8. `expiryAfter` does not exceed either timeout bound.

### Replay, Expiry, and Chain State

All state reads SHOULD use finalized state.

1. Current finalized slot is within `[startSlot, startSlot + expiryAfter]`.
2. Transaction nonce exactly equals the current fee-payer account nonce.
3. Fee payer has enough native balance for the transaction fee.
4. Source and destination token accounts exist.
5. Source owner is the fee payer and destination owner is `payTo`.
6. Both accounts have mint `asset`.
7. Neither account is frozen.
8. Source token balance is at least `amount`.

If any required RPC read fails or cannot be interpreted safely, verification MUST fail.

## Settlement

1. Re-run all verification checks immediately before submission.
2. Atomically reserve a settlement-cache entry keyed by the exact signed transaction bytes.
3. Submit the unchanged signed transaction with Thru `SendAndTrackTxn`.
4. Wait for an execution result; receipt or mempool acceptance is insufficient.
5. Return success only when both VM error and user error code are zero.
6. Return the Thru transaction signature, network, and cryptographically verified payer.

Thru's on-chain nonce prevents a transaction from executing twice. A facilitator still MUST deduplicate concurrent settlement calls so one payment cannot unlock multiple resources while the first submission is in flight. A multi-isolate environment such as Cloudflare Workers SHOULD place this cache in a Durable Object or equivalent strongly consistent store.

## Settlement Response

```json
{
  "success": true,
  "transaction": "ts...signature",
  "network": "thru:1",
  "payer": "ta...payer"
}
```

On failure, `transaction` is empty. `payer` MUST be omitted unless the signature was independently verified.

## Security Considerations

- The standard token program address and chain identifier MUST come from trusted network configuration, not only from client input.
- A browser signing session is not required. Headless agents SHOULD use a narrowly scoped external Ed25519 signer and transaction-intent policy.
- The signer policy SHOULD allow only one token transfer, a configured mint/recipient set, bounded amounts, the selected chain, bounded expiry, and bounded transaction fees/resources.
- Dollar-form prices require a configured token mint and decimals. Alphanet faucet funds are native test tokens; an application-specific test mint MUST NOT be represented as official USDC.
- Alphanet identifiers, assets, and behavior are non-production and may reset or change.

## References

- [x402 v2 specification](../../x402-specification-v2.md)
- [Exact scheme](./scheme_exact.md)
- [Thru transaction format](https://thru.org/docs/spec/core/transactions/)
- [Thru web SDK](https://thru.org/docs/sdks/web-packages/sdk/)
- [Thru token program](https://thru.org/docs/core-programs/token-program/)
- [Thru signing sessions](https://thru.org/docs/wallet/signing-sessions/)
