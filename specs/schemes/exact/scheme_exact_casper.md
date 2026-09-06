# Scheme: `exact` on `Casper`

## Summary

In the `exact` scheme on Casper, the Client authorizes a single fixed-amount CEP-18 transfer off-chain with their key; the Facilitator relays that authorization on-chain and pays the gas. The Client's signature commits to the recipient, amount, and timing — the Facilitator cannot alter them.

The on-chain mechanism is the `transfer_with_authorization` entry point defined by [CEP-3009](https://github.com/casper-network/ceps/blob/master/text/3009-transfer-with-authorization.md), Casper's adaptation of EIP-3009 for CEP-18 tokens. The authorization is an EIP-712 typed message carrying the recipient, amount, validity window, and a 32-byte nonce; the token contract recomputes the digest, verifies the signature, enforces the window and nonce uniqueness, and performs the transfer.

**Version Support:** This specification supports x402 v2 protocol only.

## `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `authorization`: The parameters required to reconstruct the signed authorization message.
- `publicKey`: The payer's public key, with a leading 1-byte tag identifying the key algorithm.
- `signature`: The signature over the authorization, with a leading 1-byte tag matching `publicKey`.

**Example `PaymentPayload`:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "http://api.example.com/weather?city=San%20Francisco"
  },
  "accepted": {
    "scheme": "exact",
    "network": "casper:casper-test",
    "asset": "17be3c3dc67ddf193b8f64bfc2421826407470f88b3dab68184ebffebdd57f59",
    "amount": "7500000000",
    "payTo": "007a9f9948cb7b258d18f3c5e85780372971b5b40096e724c9e596c284a01445fa",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "Casper X402 Token",
      "version": "1"
    }
  },
  "payload": {
    "authorization": {
      "from": "0076d080b4e769f0b29c77fc6472d6e425710840c2f46a4506e5544d2ce34f43a3",
      "to": "007a9f9948cb7b258d18f3c5e85780372971b5b40096e724c9e596c284a01445fa",
      "value": "7500000000",
      "validAfter": "1782725469",
      "validBefore": "1782729069",
      "nonce": "6505daf8ee30b4bf90db8e4ef3849ea869945ba0638853f6194704e8c9001115"
    },
    "publicKey": "020376e4f8766e4f33bcc6e20b331b5163f363dc0106063b052ad38afe08637bd867",
    "signature": "02e6e2ce5ff0721c4f52166ccf6f31a517335faa534913c0b8ed4ac91149d56a423931d804ad6246f27aa3bfe2a9ff14efa0fedf7e650dc5a951992e53d959c475"
  }
}
```

### `accepted` field definitions

- `network`: CAIP-2 network identifier. This spec defines behavior for `casper:casper` (Mainnet) and `casper:casper-test` (Testnet); implementations MAY support additional `casper:*` identifiers.
- `asset`: 32-byte hex contract package hash of the token (no prefix). This is the `contract_package_hash` used in the CEP-3009 EIP-712 domain separator.
- `payTo`: 33-byte hex address of the recipient (1-byte type tag + 32-byte hash; see [Address Format](#address-format)).
- `amount`: Exact amount in atomic units, as a decimal string.
- `extra.name` (required): CEP-18 token `name`, used as the `name` field of the CEP-3009 EIP-712 domain separator.
- `extra.version` (required): Domain `version`, used in the CEP-3009 EIP-712 domain separator.

### `payload.authorization` field definitions

- `from`: 33-byte hex address of the payer. MUST be the `Address` derived from `publicKey` (which, for an externally-owned account, is the `AccountHash` with the `0x00` type tag).
- `to`: 33-byte hex address of the recipient. MUST equal `accepted.payTo`.
- `value`: Decimal string. MUST equal `accepted.amount`.
- `validAfter`: Unix timestamp (seconds). The authorization is valid only when `now > validAfter` (strict).
- `validBefore`: Unix timestamp (seconds). The authorization is valid only when `now < validBefore` (strict).
- `nonce`: 32-byte hex unique nonce to prevent replay, per CEP-3009.

### `payload` field definitions

- `publicKey`: Casper public key with a 1-byte algorithm tag (`0x01` = ed25519, `0x02` = secp256k1).
- `signature`: Signature over the CEP-3009 EIP-712 digest of the authorization, with the same 1-byte algorithm tag as `publicKey`.

## Verification

A facilitator verifying an `exact` scheme payment on Casper MUST reject any payload that fails any rule below. General x402 v2 validation, including `PaymentPayload` structure and selected `PaymentRequirements` consistency, is defined by the core x402 specification. In this section, `PaymentRequirements` means the selected requirement supplied to the facilitator alongside the `PaymentPayload`.

1. **Verify** the `signature` is valid under `publicKey` over the CEP-3009 `TransferWithAuthorization` EIP-712 digest, and that `publicKey` derives `authorization.from`.
   - For `secp256k1` signatures (`publicKey`/`signature` tag `0x02`), the facilitator MUST additionally verify the signature is in canonical low-s form (`s <= n/2`) and MUST reject non-canonical (high-s) signatures.
2. **Verify** the client (`authorization.from`) has sufficient balance of `PaymentRequirements.asset`.
3. **Verify** the authorization parameters meet the `PaymentRequirements`:
   - `authorization.to` MUST equal `PaymentRequirements.payTo`.
   - `authorization.value` MUST equal `PaymentRequirements.amount`.
   - Current chain time MUST satisfy `validAfter < now < validBefore` (strict bounds, per CEP-3009).
   - `validBefore` MUST be equal to or later than `now + PaymentRequirements.maxTimeoutSeconds`.
   - `nonce` MUST NOT have previously been consumed or canceled for `from` on this token contract (CEP-3009 `authorization_state`).
4. **Verify** the token contract identified by `PaymentRequirements.asset` exists on `PaymentRequirements.network` and supports the CEP-3009 `transfer_with_authorization` entry point.
5. **Simulate (optional)** the `transfer_with_authorization` call on the token contract via Casper's `speculative_exec` RPC to ensure success. Facilitators MAY skip this step and rely on the targeted state checks above (balance, `authorization_state`, current chain time).

## Settlement

Settlement is performed by the facilitator submitting a Casper transaction that invokes the CEP-3009 `transfer_with_authorization` entry point on the token contract identified by `PaymentRequirements.asset`, with the runtime arguments defined by CEP-3009: `from`, `to`, `value`, `valid_after`, `valid_before`, `nonce`, `public_key`, `signature`. The facilitator signs and pays for the transaction; the entry point is relayer-agnostic — the caller does not need to be the payer or the recipient.

The token contract recomputes the CEP-3009 EIP-712 digest, verifies the signature, enforces the validity window and nonce uniqueness, records `(from, nonce)` as used, and transfers `value` from `from` to `to`.

The facilitator MUST perform full verification again during settlement and MUST NOT assume that a prior `/verify` result is still valid. The facilitator MUST wait for the submitted Casper transaction to be included and executed successfully on chain before returning `success: true`. If execution fails, the facilitator MUST return `success: false` with an `errorReason` and an empty `transaction` value.

## `SettlementResponse`

The `SettlementResponse` returned to the client for the `exact` scheme in Casper is:

```json
{
  "success": true,
  "payer": "0076d080b4e769f0b29c77fc6472d6e425710840c2f46a4506e5544d2ce34f43a3",
  "transaction": "2d94dd38f00afd64cb3fb4004b7571055e4dc0e1ff65fe708d7e0d2388f16a8d",
  "network": "casper:casper-test"
}
```

- `success`: Boolean indicating the settlement outcome.
- `payer`: 33-byte hex address of the payer (`authorization.from`).
- `transaction`: 32-byte hex Casper transaction hash.
- `network`: CAIP-2 network identifier.

On failure (`success: false`), the response additionally contains:

- `errorReason`: A short, human-readable string describing why settlement failed.

## Appendix

### Signature Schemes

Casper supports both `ed25519` and `secp256k1` keys at the protocol level. To preserve the algorithm of the signing key, both `publicKey` and `signature` carry a leading 1-byte tag:

- `0x01` — `ed25519`
- `0x02` — `secp256k1`

Implementations MUST select the verification algorithm based on this tag and MUST reject payloads where the `publicKey` and `signature` tags disagree.

For `secp256k1` (`0x02`) signatures, the facilitator MUST reject non-canonical (high-s) signatures — i.e. `s` MUST satisfy `s <= n/2` where `n` is the secp256k1 curve order (SEC1 §4.1.4, EIP-2).

### Address Format

`accepted.payTo`, `authorization.from`, and `authorization.to` use the 33-byte `Address` encoding — a 1-byte type tag followed by a 32-byte hash:

- `0x00` — `AccountHash` (externally-owned account; the blake2b hash of the account's `PublicKey`).
- `0x01` — contract package `Hash`.

Implementations MUST use the full 33-byte form in hex (66 hex characters).

### Asset Identifier

The `asset` field is the 32-byte hex `contract_package_hash` of the CEP-18 token, as used in the CEP-3009 EIP-712 domain separator. No `0x` or `hash-` prefix is used.

### External References

- [CEP-3009: Transfer with Authorization](https://github.com/casper-network/ceps/blob/master/text/3009-transfer-with-authorization.md) — the on-chain entry point, EIP-712 typed data, error codes, and nonce-storage layout this scheme depends on.
- [CEP-18: Casper Fungible Token Standard](https://github.com/casper-network/ceps/blob/master/text/0018-token-standard.md) — the underlying token interface CEP-3009 extends.
- [Casper EIP-712 toolkit](https://github.com/casper-ecosystem/casper-eip-712) — reference implementation of EIP-712 for Casper.
- [CAIP-2 for Casper](https://github.com/ChainAgnostic/namespaces/blob/main/casper/caip2.md) — network identifier format.
- [Casper `speculative_exec` JSON-RPC](https://docs.casper.network/developers/json-rpc/json-rpc-transactional#speculative_exec_txn) — optional simulation endpoint used in verification step 5.
