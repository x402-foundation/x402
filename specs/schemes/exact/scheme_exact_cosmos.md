# Scheme: `exact` on `Cosmos`

## Summary

The `exact` scheme on Cosmos SDK chains transfers a specific amount of a
bank denom from the payer to the resource server with a `cosmos.bank.v1beta1.MsgSend`.
As on Sui, the payer forms and signs a complete transaction. The
facilitator can't change it, so funds can only go to `PaymentRequirements.payTo`.
The facilitator checks the transaction and broadcasts it, and holds no key.

It applies to any chain built on the Cosmos SDK (v0.47 or later), whatever
account key type the chain accepts (secp256k1, ed25519, eth_secp256k1,
ML-DSA, ...). The asset can be the chain's native denom or a token that
arrived over IBC (`ibc/<hash>`), such as USDC from Noble.

## Network

`network` is the CAIP-2 identifier in the `cosmos` namespace:
`cosmos:<chain-id>`, e.g. `cosmos:cosmoshub-4`, `cosmos:osmosis-1`,
`cosmos:aether-testnet-1`.

## PaymentRequirements

- `asset`: a bank denom (`uatom`, `ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4`).
- `amount`: an integer in that denom's base units.
- `payTo`: a bech32 account address on the chain.
- `extra` (optional): `symbol` and `decimals` for display. A facilitator's
  `/supported` kind may state `feeDenom` and `feePayer: "payer"`.

```json
{
  "scheme": "exact",
  "network": "cosmos:aether-testnet-1",
  "amount": "250000",
  "asset": "uaeth",
  "payTo": "aether1e6r6g8mat6aqax9l29wwmrfhp52hjzrpwevqqq9tcj0lm8egdhjs9q44xl",
  "maxTimeoutSeconds": 60,
  "extra": { "symbol": "AETH", "decimals": 6 }
}
```

## Protocol Sequencing

1. The client requests the resource and receives a payment required response with `PaymentRequirements`.
2. The client looks up its account number and next sequence (`cosmos.auth.v1beta1.Query/AccountInfo`).
3. The client builds and signs (`SIGN_MODE_DIRECT`) a transaction with one
   `MsgSend` of exactly `amount` of `asset` to `payTo`, paying its own fee.
4. The client sends the request again with the `PaymentPayload`.
5. The resource server sends it to the facilitator to verify (or straight to settle).
6. The facilitator verifies it (below).
7. The resource server requests settlement: the facilitator broadcasts the transaction and waits
   for it to be included in a block.
8. Once settlement succeeds, the resource server returns the response with the `SettlementResponse`.

The resource server may do the work before or after settling, as on Sui,
but it returns the response only after settlement succeeds. This document
is transport-agnostic: how each message travels is defined by the
transport specs.

## PaymentPayload `payload` Field

- `transaction`: the signed transaction, a protobuf `cosmos.tx.v1beta1.TxRaw`, base64 encoded.

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/weather", "mimeType": "application/json" },
  "accepted": {
    "scheme": "exact",
    "network": "cosmos:aether-testnet-1",
    "amount": "250000",
    "asset": "uaeth",
    "payTo": "aether1e6r6g8mat6aqax9l29wwmrfhp52hjzrpwevqqq9tcj0lm8egdhjs9q44xl",
    "maxTimeoutSeconds": 60,
    "extra": {}
  },
  "payload": { "transaction": "CpMBCpABChwvY29zbW9zLmJhbmsudjFiZXRhMS5Nc2dTZW5k..." }
}
```

The signature is inside `TxRaw.signatures`, so `payload` has no separate field for it.

## Verification

The facilitator refuses the payment, with the reason in brackets, unless all of these hold:

1. `x402Version` is 2, the scheme is `exact`, and `network` is this facilitator's chain
   (`invalid_x402_version`, `unsupported_scheme`, `invalid_network`).
2. `paymentPayload.accepted` has the same `amount`, `asset` and `payTo` as
   the server's `paymentRequirements`
   (`invalid_exact_cosmos_payload_accepted_mismatch`).
3. `payload.transaction` decodes as a `TxRaw` the chain's own decoder
   accepts, no larger than a set limit (16 KiB is enough for a single
   send) (`invalid_payload`, `invalid_exact_cosmos_payload_transaction`).
4. The body holds exactly one message and no extension options. The message
   is a `MsgSend` to `payTo` whose `amount` is exactly `amount` of `asset`
   and nothing else (`..._message`, `..._recipient_mismatch`, `..._amount_mismatch`).
5. There is exactly one signer, in `SIGN_MODE_DIRECT`. Its public key is a
   type the chain accepts, and its address is the message's `from_address`
   (`..._signer`).
6. The fee has no `granter`, and its `payer` is empty or the signer (`..._fee`).
7. `timeout_height`, if set, is above the latest block (`..._expired`).
8. The signer info's sequence is at least the account's current sequence
   (`..._sequence`), so a transaction already included is refused. A later
   sequence is allowed for a payer whose earlier transactions wait in the
   mempool: the simulation in step 10 runs on the node's check state,
   which counts them, and refuses a real gap.
9. The signature verifies over
   `SignDoc{body_bytes, auth_info_bytes, chain_id, account_number}`, using
   the account number from the chain (`..._signature`). The facilitator
   must check this itself, because a node skips signature verification
   when it simulates.
10. Simulation (`cosmos.tx.v1beta1.Service/Simulate`) succeeds. A failure
    for balance is `insufficient_funds`.
11. The gas the simulation used is no more than the transaction's gas
    limit (`..._gas`). Simulation runs without a gas limit. A transaction
    short of gas would be included, charge its fee and transfer nothing.

The fee amount is the payer's concern. A node refuses a fee below its
minimum gas price at broadcast, which is reported as `..._fee`.

## Settlement

The facilitator verifies again and then broadcasts the transaction
(`BroadcastTx`, sync mode). A non-zero `CheckTx` code is a failure. It
then polls `GetTx` by hash until the transaction is in a block, or until
`maxTimeoutSeconds` passes, which gives `invalid_transaction_state`.
Success requires the transaction's code to be 0. `transaction` in the
`SettleResponse` is the uppercase hex SHA-256 of the `TxRaw` bytes, the
hash the chain indexes it by.

A facilitator should settle a given transaction at most once, so one
payment can't be used for two responses. The chain's sequence check
enforces this once the transaction is included, but a facilitator should
also deduplicate payments in flight.

## Appendix

### Sponsored fees

The payer pays the fee in this version. A chain with `x/feegrant` allows
sponsorship: the facilitator's `/supported` kind could name a fee granter
in `extra.feeGranter`, and the client would set `fee.granter` to it.
Verification would then allow that granter. Left for a later version.

### Relation to `upto`

The `x/authz` `SendAuthorization` (a capped, expiring allowance that
another account can draw on, limited to an allow list of recipients) maps
naturally onto `upto`. It is a separate spec.

### Reference implementation

A facilitator, client and resource server for this scheme run on the Aether
testnet (`cosmos:aether-testnet-1`), whose accounts use ML-DSA-44 keys:

- Facilitator (Go): [`x402/`](https://github.com/whoyoujoshin/aether/tree/main/x402) and [`cmd/facilitator`](https://github.com/whoyoujoshin/aether/tree/main/cmd/facilitator), public at `https://explorer.157-245-252-221.sslip.io/facilitator`
- Client (TypeScript, an `@x402/core` scheme): [`ExactAetherScheme`](https://github.com/whoyoujoshin/aether/blob/main/clients/ts/src/x402.ts) in `aether-chain-client/x402`
- Resource server (Go): [`paywall/`](https://github.com/whoyoujoshin/aether/tree/main/paywall) and [`cmd/paywall`](https://github.com/whoyoujoshin/aether/tree/main/cmd/paywall)
