# Batch-Settlement Facilitator Example

Express.js facilitator for the **batch-settlement** EVM scheme on Base Sepolia. It exposes standard x402 facilitator endpoints and submits the batch-settlement contract calls.

See the [scheme specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) and the [scheme README](../../../../typescript/packages/mechanisms/evm/src/batch-settlement/README.md) for protocol details.

## Two Signer Roles

This example can use separate keys for relaying transactions and authorizing receiver actions:

| Env var                               | Role                                                                       | Onchain effect                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `EVM_PRIVATE_KEY`                     | **Relayer** — submits transactions                                         | Pays gas for `deposit` / `claimWithSignature` / `settle` / `refundWithSignature`                 |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | **Receiver authorizer** — signs `ClaimBatch` and `Refund` EIP-712 messages | Address is committed into the channel identity for any server that delegates to this facilitator |

If `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` is omitted, the relayer key is reused for both roles. In production, keep them separate so the receiver-authorizer key (which controls how much gets claimed) can be rotated independently of the gas-paying hot wallet.

> The receiver-authorizer address is advertised under `kinds[].extra.receiverAuthorizer` in `GET /supported`. **Servers that delegate authorization to this facilitator bind that address into their channel config** — rotating the authorizer key requires opening new channels, so treat this address as long-lived.

## Prerequisites

- Node.js v20+, pnpm v10
- Base Sepolia ETH on the **relayer** address (gas)
- Optional: a separate funded address for the **authorizer** (no gas required if relayer is separate)

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY (and optionally EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY, EVM_RPC_URL, PORT)

cd ../../
pnpm install && pnpm build
cd facilitator/batch-settlement

pnpm dev
```

The facilitator listens on `http://localhost:4022` by default (`PORT` env var to override). Env keys match `examples/go/facilitator/batch-settlement/.env-example` (TS uses `.env-local`; Go uses `.env-example`, per each ecosystem's convention).

## API Surface

Standard x402 facilitator endpoints: `POST /verify`, `POST /settle`, `GET /supported`. The `/settle` endpoint dispatches on `payload.type`:

| Payload type | Triggered by                  | Contract call / effect                          |
| ------------ | ----------------------------- | ----------------------------------------------- |
| `deposit`    | First request or top-up       | Funds the channel via EIP-3009 or Permit2       |
| `claim`      | Server batches voucher claims | Calls `claimWithSignature` (no transfer)        |
| `settle`     | Server sweeps unsettled funds | Calls `settle` to transfer claimed funds        |
| `refund`     | Cooperative refund            | Calls `refundWithSignature` for unclaimed funds |

`/verify` and `/settle` always return the onchain channel snapshot (`balance`, `totalClaimed`, `withdrawRequestedAt`, `refundNonce`) in the `extra` field — the resource server mirrors these into its session state.

`GET /supported` advertises the receiver authorizer address:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "eip155:84532",
      "extra": { "receiverAuthorizer": "0x..." }
    }
  ],
  "signers": { "eip155:*": ["0x..."] }
}
```
