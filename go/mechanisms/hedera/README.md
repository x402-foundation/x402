# Hedera Mechanisms

Payment mechanism implementations for **Hedera** networks (CAIP-2 `hedera:mainnet` / `hedera:testnet`).

## Exact Payment Scheme

Fixed-amount payments using partially signed `TransferTransaction`s for **HBAR** (`0.0.0`, tinybars) or **HTS** fungible tokens (e.g. Circle USDC).

The facilitator is the **fee payer**: the client builds a transfer with `transactionId` owned by the facilitator account, signs as the debiting payer, and the facilitator co-signs and submits.

### Export Paths

#### Clients

```
github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/client
```

```go
signer, err := hedera.NewPrivateKeyClientSigner(accountID, privateKey, "hedera:testnet")
client := hederaclient.NewExactHederaScheme(signer)
```

#### Servers

```
github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/server
```

```go
server := hederaserver.NewExactHederaScheme()
// Copies feePayer from facilitator /supported into payment requirements.
```

#### Facilitators

```
github.com/x402-foundation/x402/go/v2/mechanisms/hedera/exact/facilitator
```

```go
facSigner, err := hedera.NewPrivateKeyFacilitatorSigner(hedera.SignerConfig{
	Operators: []hedera.OperatorCredentials{{
		AccountID:  "0.0.xxxx",
		PrivateKey: "0x...", // ECDSA hex preferred
	}},
})
scheme := hederafacil.NewExactHederaScheme(facSigner)
```

## Important implementation notes

1. **ECDSA key parsing** — 32-byte hex keys are treated as ECDSA secp256k1 (not ED25519). Prefer `0x`-prefixed ECDSA hex for EVM-compatible Hedera accounts.

2. **BodyBytes-preserving submit** — JS/TS clients encode AccountIDs with explicit shard/realm fields. The Go SDK `Execute` path remarsals bodies and invalidates those signatures. The default facilitator signer co-signs and submits at the protobuf/gRPC layer without remarsaling `BodyBytes`.

3. **Alias policy** — default `reject` (payTo must be an existing `0.0.x` entity id). Use `WithAliasPolicy("allow")` to relax.

4. **Mirror-backed verify** — `VerifyPayerSignature` and `PreflightTransfer` use the Mirror Node REST API (no operator-funded consensus queries).

5. **Settlement cache / HA** — the default `SettlementCache` is process-local with `SettlementTTL` expiry. Multi-replica facilitators must inject a shared `SettlementTracker` (or run a single settler); otherwise the same transaction ID can be settled twice.

6. **Asset transfer methods** — only `cryptoTransfer` (the default) is implemented. Requirements with `extra.assetTransferMethod` set to `transferExecutor` are rejected with `invalid_exact_hedera_unsupported_asset_transfer_method`, and unknown values with `invalid_exact_hedera_asset_transfer_method`.

7. **Pending settlements** — when submission or the receipt lookup fails without a definitive status, `Settle` returns `settlement_pending` with the transaction id; a retry of the same payload looks up the consensus result instead of resubmitting: first on the Mirror Node, which keeps it after consensus nodes drop receipts (about 3 minutes), then via a receipt query. The default store is process-local; multi-replica facilitators should share one via `SetPendingSettlementStore`.

## Testnet setup

1. Create ECDSA testnet accounts for the client, resource server (`payTo`), and facilitator (fee payer) in the [Hedera Portal](https://portal.hedera.com/) and fund them with testnet HBAR from the [Hedera faucet](https://portal.hedera.com/faucet).
2. For HTS payments (e.g. testnet USDC `0.0.429274`), associate the token with both the payer and `payTo` accounts, or give them free auto-association slots. Verification fails with `invalid_exact_hedera_payload_preflight_failed` otherwise.
3. HBAR payments (`asset` `0.0.0`) need no association; amounts are in tinybars.

## Supported networks

- `hedera:mainnet` — USDC `0.0.456858`
- `hedera:testnet` — USDC `0.0.429274`

Use `hedera:*` when registering with the facilitator.
