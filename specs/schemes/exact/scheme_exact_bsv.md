# Scheme: `exact` on `BSV`

## Versions supported

- ❌ `v1` - not supported.
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/) identifiers:
- `bsv:mainnet` — BSV mainnet
- `bsv:testnet` — BSV testnet

## Summary

The x402 `exact` scheme on BSV uses native Bitcoin transactions where the client constructs and signs a payment transaction and the server settles via [ARC](https://docs.bsvblockchain.org/important-concepts/details/spv/broadcasting) (the BSV transaction processor). BSV's UTXO model provides single-spend guarantees at the network layer — each transaction can only be accepted once, eliminating the need for application-level duplicate settlement mitigation.

BSV transaction fees are negligible (1–50 satoshis), so fee sponsorship is not required for micropayments. However, a fee delegation model exists for zero-preload clients (see [Fee Delegation](#fee-delegation-optional)).

## Protocol Flow

The protocol flow for `exact` on BSV is client-driven with server-side settlement:

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a `402 Payment Required` status and `PAYMENT-REQUIRED` header containing `PaymentRequired`. The `extra` field contains a `partialTx` — a pre-built transaction template with the payment output and an OP_RETURN request binding output.
3. **Client** extends the partial transaction by adding funding inputs (and optionally a change output). If the client does not support `extra.partialTx`, it constructs a transaction from scratch using `payTo` and `amount`.
4. **Client** signs the transaction with their wallet.
5. **Client** sends a new request to the resource server with the `PaymentPayload` in the `PAYMENT-SIGNATURE` header containing the hex-encoded raw transaction.
6. **Resource Server** validates the transaction: verifies the payment output (amount and payee), verifies the OP_RETURN request binding (if present), and broadcasts the transaction to ARC.
7. **ARC** validates the transaction against the BSV network (mempool acceptance, double-spend check) and returns a status.
8. Upon ARC acceptance (`SEEN_ON_NETWORK`), the **Resource Server** grants the **Client** access to the resource and includes a `PAYMENT-RESPONSE` header with the `SettlementResponse`.

> **Note:** The Resource Server broadcasts the transaction directly to ARC, not via a separate facilitator. ARC serves as both the transaction processor and the settlement oracle. No facilitator service is required.

## `PaymentRequirements` for `exact`

In addition to the standard x402 `PaymentRequirements` fields (see [x402-specification-v2.md](../../x402-specification-v2.md#5-types)), the `exact` scheme on BSV includes the following inside the `extra` field:

```json
{
  "scheme": "exact",
  "network": "bsv:mainnet",
  "amount": "100",
  "asset": "BSV",
  "payTo": "76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac",
  "maxTimeoutSeconds": 60,
  "extra": {
    "partialTx": "AQAAAA...base64-encoded-partial-transaction..."
  }
}
```

- `asset`: `"BSV"` — native currency. BSV does not use token contracts; all payments are in the native satoshi unit.
- `amount`: Payment amount in satoshis (atomic unit). String-encoded per the v2 spec.
- `payTo`: The payee's locking script in hex. For standard P2PKH addresses this is `76a914<20-byte-pubkey-hash>88ac`. BSV uses locking scripts rather than address strings to avoid ambiguity between address formats.
- `extra.partialTx` (optional): Base64-encoded partial transaction template containing:
  - Output 0: Payment output (`amount` satoshis to `payTo` locking script)
  - Output 1: OP_RETURN with SHA-256 request binding hash (`OP_FALSE OP_RETURN <SHA256(method + path + query)>`)

The `partialTx` is a progressive enhancement for BSV-aware clients. Basic x402 v2 clients MAY ignore it and construct a transaction from scratch using `payTo` and `amount`. The `payTo` and `amount` fields are always sufficient on their own.

Full `PaymentRequired` object:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "bsv:mainnet",
      "amount": "100",
      "asset": "BSV",
      "payTo": "76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac",
      "maxTimeoutSeconds": 60,
      "extra": {
        "partialTx": "AQAAAA..."
      }
    }
  ],
  "extensions": {}
}
```

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains:

```json
{
  "rawtx": "0100000001...hex-encoded-raw-transaction...",
  "txid": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
}
```

- `rawtx`: The fully signed BSV transaction in hex encoding.
- `txid`: The double-SHA256 transaction ID. This is redundant (derivable from `rawtx`) but included for logging and receipt purposes without requiring transaction deserialisation.

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "bsv:mainnet",
    "amount": "100",
    "asset": "BSV",
    "payTo": "76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac",
    "maxTimeoutSeconds": 60,
    "extra": {
      "partialTx": "AQAAAA..."
    }
  },
  "payload": {
    "rawtx": "0100000001...",
    "txid": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
  },
  "extensions": {}
}
```

## `SettlementResponse`

The `SettlementResponse` for the exact scheme on BSV:

```json
{
  "success": true,
  "transaction": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  "network": "bsv:mainnet"
}
```

The `payer` field is omitted as BSV transactions do not have a single recoverable payer address (inputs may come from multiple sources).

## Verification Rules (MUST)

A server verifying an `exact`-scheme BSV payment MUST enforce all of the following checks:

1. **Payment output**
   - The transaction MUST contain an output whose locking script exactly matches `payTo`.
   - That output's satoshi value MUST be greater than or equal to `amount`.

2. **Request binding** (configurable)
   - If the server issued a `partialTx` with an OP_RETURN binding output, the submitted transaction SHOULD contain a matching OP_RETURN output with the same SHA-256 hash.
   - Servers MAY operate in **strict mode** (MUST reject transactions without a matching OP_RETURN) or **permissive mode** (MUST accept transactions without the binding, for basic client compatibility).

3. **ARC broadcast**
   - The server MUST broadcast the raw transaction to ARC using the `X-WaitFor: SEEN_ON_NETWORK` header (or an equivalent configured status level).
   - ARC acceptance (HTTP 200) confirms the transaction is valid and has propagated to the network.
   - ARC rejection MUST be relayed to the client.

4. **Amount**
   - The payment output amount MUST be greater than or equal to `PaymentRequirements.amount`.

## Settlement

Settlement is performed by the Resource Server broadcasting the raw transaction directly to ARC (the BSV transaction processor):

1. Server decodes the hex-encoded `rawtx` from the `payload` field.
2. Server submits the raw transaction to ARC via its broadcast API with the `X-WaitFor` header set to the desired acceptance level (default: `SEEN_ON_NETWORK`).
3. ARC validates the transaction against BSV consensus rules and mempool policy.
4. On ARC HTTP 200: settlement is complete. The transaction has been accepted by the network.
5. On ARC error: the server relays the ARC error response to the client.

No separate facilitator, simulation step, or signature verification is required. ARC provides transaction validation, double-spend detection, and network propagation as a single atomic operation.

See the [ARC API documentation](https://docs.bsvblockchain.org/important-concepts/details/spv/broadcasting) for broadcast endpoint details.

## Facilitator

The BSV `exact` scheme does **not** require a facilitator service. The Resource Server interacts directly with ARC for both verification and settlement in a single broadcast step. This is possible because:

- BSV transaction validation is deterministic and performed by ARC on broadcast.
- There is no gas estimation, signature simulation, or pre-flight verification needed.
- UTXO single-spend is enforced by network consensus, not application logic.

Implementations MAY still use a facilitator if they wish to separate settlement from the resource server, but this is not required or recommended for typical deployments.

## Duplicate Settlement Mitigation

BSV's UTXO model provides built-in duplicate settlement protection. Each transaction input references a specific unspent output (UTXO) which can only be spent once — this is enforced by network consensus, not application logic. ARC rejects transactions that attempt to spend already-spent outputs.

No additional deduplication cache, nonce tracking, or in-memory state is required. This is a fundamental advantage of the UTXO model over account-based chains.

## Fee Delegation (Optional)

BSV transaction fees are negligible for micropayments (typically 1–50 satoshis). Most clients can fund their own fees. However, for zero-preload clients, an optional fee delegation model exists:

1. **Client** constructs a partial transaction (payment output only, no fee inputs) and signs with `SIGHASH_ALL | ANYONECANPAY | FORKID` (`0xC1`). This commits to all outputs but allows additional inputs to be appended.
2. **Client** submits the partial transaction to a **Delegator** service.
3. **Delegator** appends fee-covering inputs, signs only its own inputs, and returns the completed transaction.
4. **Client** submits the completed transaction to the Resource Server as normal.

The Delegator never signs the payment output or the client's inputs — only its own fee inputs. The Resource Server has no knowledge of or dependency on the Delegator; it treats fee-delegated and self-funded transactions identically.

> **Note:** Fee delegation is not required for the x402 flow to function. It is a convenience for clients that do not hold BSV.

## Implementer Notes

- **No facilitator required.** Unlike EVM and Solana schemes, the BSV scheme does not require a separate facilitator service. The Resource Server broadcasts directly to ARC, which serves as both the transaction processor and the settlement oracle.
- **No gas estimation.** BSV fees are a simple function of transaction size (satoshis per byte), not computational complexity. Fee estimation is trivial and deterministic.
- **Header size.** A typical BSV micropayment transaction (1–2 inputs, 2 outputs) is approximately 200–400 bytes. Hex-encoded in the `payload.rawtx` field, this is 400–800 characters — well within HTTP header size limits.
- **OP_RETURN binding.** The request binding hash in the OP_RETURN output uses `OP_FALSE OP_RETURN <32-byte SHA-256>`. The `OP_FALSE` prefix makes the output provably unspendable per BSV consensus rules.
- **`payTo` format.** BSV uses raw locking script hex rather than address strings. This avoids ambiguity between legacy address formats (1..., 3...) and ensures the server can verify outputs by direct script comparison.

## Appendix

### BSV Network Identifiers

| Network | CAIP-2 Identifier |
|---------|-------------------|
| BSV Mainnet | `bsv:mainnet` |
| BSV Testnet | `bsv:testnet` |

### ARC Transaction Statuses

| Status | Meaning |
|--------|---------|
| `SEEN_ON_NETWORK` | Transaction has propagated to multiple nodes (recommended default) |
| `ACCEPTED_BY_NETWORK` | Transaction accepted by at least one node (faster, slightly less certainty) |
| `MINED` | Transaction included in a block (strongest guarantee, ~10 minute latency) |

### References

- [ARC Transaction Processor](https://docs.bsvblockchain.org/important-concepts/details/spv/broadcasting)
- [BSV Wiki](https://wiki.bitcoinsv.io/)
- [x402-rack Reference Implementation](https://github.com/sgbett/x402-rack)
