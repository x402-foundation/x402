# Batch-Settlement Client (Go)

Sequential batch-settlement payment client. Opens a payment channel on the first request (deposit) and pays subsequent requests with off-chain vouchers that update the cumulative claimable amount.

## Run

```bash
cp .env-example .env
# fill in EVM_PRIVATE_KEY (and optionally EVM_VOUCHER_SIGNER_PRIVATE_KEY, STORAGE_DIR)

go run .
```

The companion server is in `examples/go/servers/batch-settlement` and the facilitator is in `examples/go/facilitator/batch-settlement`.

## Voucher Signer Delegation

By default, vouchers are signed by the same key as the payer (`EVM_PRIVATE_KEY`). Set `EVM_VOUCHER_SIGNER_PRIVATE_KEY` to delegate voucher signing to a dedicated EOA — its address is committed into the channel as the `payerAuthorizer`.

Use this when:

- The payer key should only sign deposit authorizations.
- The payer is a smart wallet (EIP-1271). Delegating to an EOA voucher signer lets the facilitator verify vouchers with ECDSA recovery instead of an onchain `isValidSignature` call.

## Deposit policy

The default per-request deposit is `payment amount × DEPOSIT_MULTIPLIER` (default `5`). For app-specific deposit decisions (caps, dynamic adjustments, opting out), pass a `DepositStrategy` callback to `BatchSettlementEvmSchemeOptions`:

```go
cfg := &batchedclient.BatchSettlementEvmSchemeOptions{
    DepositMultiplier: 5,
    DepositStrategy: func(_ context.Context, c batchedclient.DepositStrategyContext) (batchedclient.DepositStrategyResult, error) {
        // Cap deposits at 1_000_000 base units.
        capped, _ := new(big.Int).SetString("1000000", 10)
        proposed, _ := new(big.Int).SetString(c.DepositAmount, 10)
        if proposed.Cmp(capped) > 0 {
            return batchedclient.DepositStrategyResult{Amount: capped.String()}, nil
        }
        return batchedclient.DepositStrategyResult{}, nil // use computed
    },
}
```

## Environment

| Variable                              | Required | Description |
|---------------------------------------|----------|-------------|
| `EVM_PRIVATE_KEY`                     | yes      | Payer private key (0x-prefixed hex) |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY`      | no       | Dedicated voucher-signing EOA (committed as `payerAuthorizer`) |
| `EVM_RPC_URL`                         | no       | RPC endpoint used for cold-start onchain recovery (default `https://sepolia.base.org`) |
| `RESOURCE_SERVER_URL`                 | no       | Server base URL (default `http://localhost:4021`) |
| `ENDPOINT_PATH`                       | no       | Path on the server (default `/weather`) |
| `CHANNEL_SALT`                        | no       | 32-byte hex salt; change to open a fresh channel (default `0x00…00`) |
| `DEPOSIT_MULTIPLIER`                  | no       | Per-request deposit is payment amount × this multiplier (must be integer ≥ 3; default `5`) |
| `STORAGE_DIR`                         | no       | If set, persists session state under `${STORAGE_DIR}/client/` |
| `NUMBER_OF_REQUESTS`                  | no       | How many paid requests to issue (default `3`) |
| `REFUND_AFTER_REQUESTS`               | no       | If `"true"`, request a cooperative refund after the request loop completes |
| `REFUND_AMOUNT`                       | no       | Partial refund amount in base units; empty drains the remaining channel balance |
