# Extension: `onchain-actions`

## Summary

The `onchain-actions` extension enables **noncustodial onchain execution** through x402. Servers prepare and return executable transaction data that the **client executes onchain**. The client pays for transaction preparation, not execution. The server never touches user funds.

This standardizes the response format so any x402-compatible client can parse, verify, simulate and execute onchain actions from any compliant server, without bespoke integrations. Example use cases include token swaps, cross-chain bridges, portfolio rebalancing, LP management, multisend or dust cleanup.

---

## `PaymentRequired`

Server advertises `onchain-actions` support in the `extensions` object.
The `info` field describes server capabilities. The `schema` field validates the full `info` structure (server-provided fields plus client-appended fields).

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/swap",
    "description": "Token swap preparation service",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "5000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "extensions": {
    "onchain-actions": {
      "info": {
        "version": "1",
        "supportedNetworks": ["eip155:8453", "eip155:42161"]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "version": {
            "type": "string",
            "description": "Extension schema version."
          },
          "supportedNetworks": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,64}$"
            },
            "description": "CAIP-2 networks the server can return transaction data for."
          },
          "executor": {
            "type": "string",
            "description": "Address that will execute the returned transactions. Appended by client. Format depends on the CAIP-2 namespace of `executionNetwork`: `eip155:*` requires a 0x-prefixed 20-byte hex address (EIP-55 checksum recommended); `solana:*` requires a base58-encoded 32-byte public key.",
            "oneOf": [
              { "pattern": "^0x[a-fA-F0-9]{40}$" },
              { "pattern": "^[1-9A-HJ-NP-Za-km-z]{32,44}$" }
            ]
          },
          "executionNetwork": {
            "type": "string",
            "description": "CAIP-2 network where the client intends to execute. Appended by client. Defaults to the payment network if omitted. MUST be a member of `supportedNetworks`.",
            "pattern": "^[a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,64}$"
          }
        },
        "required": ["version", "supportedNetworks"]
      }
    }
  }
}
```

### Info Fields


| Field               | Type       | Required | Description                                        |
| ------------------- | ---------- | -------- | -------------------------------------------------- |
| `version`           | `string`   | Yes      | Extension schema version                           |
| `supportedNetworks` | `string[]` | Yes      | CAIP-2 networks the server can return transaction data for |


---

## Schema Validation

The `schema` field contains a JSON Schema (Draft 2020-12) that validates the structure of `info`. It covers both server-provided fields (`version`, `supportedNetworks`) and client-appended fields (`executor`, `executionNetwork`). Only server-provided fields are in `required`; the client MUST append `executor` (and optionally `executionNetwork`) per the extension spec. Facilitators **may** validate `info` against `schema` before processing.

---

## `PaymentPayload`

The client echoes the server's `info` and appends `executor` (required) and optionally `executionNetwork`. If `executionNetwork` is omitted, it defaults to the `network` in `accepted`.

```json
"extensions": {
  "onchain-actions": {
    "info": {
      "version": "1",
      "supportedNetworks": ["eip155:8453", "eip155:42161"],
      "executor": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "executionNetwork": "eip155:42161"
    }
  }
}
```

When `executionNetwork` differs from the payment `network`, the server prepares transaction data for the specified execution chain while payment settles on the payment chain. Servers MUST list all supported execution networks in `supportedNetworks`.

---

## Response Body

The server returns prepared transaction data in the **resource response body**. The `mimeType` in the `PaymentRequired` resource MUST be `application/json`. The response body MUST include `extensions["onchain-actions"]`. Servers MAY include additional top-level fields alongside `extensions`.

```json
{
  "extensions": {
    "onchain-actions": {
      "version": "1",
      "transactions": [
        {
          "network": "eip155:8453",
          "type": "approval",
          "description": "Approve 100 USDC for Uniswap Router",
          "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "data": "0x095ea7b3000000000000000000000000...",
          "value": "0",
          "decodedFunctionData": {
            "abi": [{"type": "function", "name": "approve", "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}], "outputs": [{"name": "", "type": "bool"}], "stateMutability": "nonpayable"}],
            "functionName": "approve",
            "args": ["0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", "100000000"]
          }
        },
        {
          "network": "eip155:8453",
          "type": "swap",
          "description": "Swap 100 USDC for ~0.038 ETH via Uniswap V3 (0.5% slippage)",
          "validUntil": 1740672300,
          "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
          "data": "0x3593564c000000000000000000000000...",
          "value": "0",
          "decodedFunctionData": {
            "abi": [{"type": "function", "name": "execute", "inputs": [{"name": "commands", "type": "bytes"}, {"name": "inputs", "type": "bytes[]"}, {"name": "deadline", "type": "uint256"}], "outputs": [], "stateMutability": "payable"}],
            "functionName": "execute",
            "args": ["0x0b00", ["0x..."], "1740672300"]
          }
        }
      ]
    }
  }
}
```

### `onchain-actions` Fields


| Field          | Type     | Required | Description                                              |
| -------------- | -------- | -------- | -------------------------------------------------------- |
| `version`      | `string` | Yes      | Extension schema version. MUST equal the `info.version` advertised by the server in the corresponding `PaymentRequired` response. |
| `transactions` | `array`  | Yes      | Ordered array of Transaction objects to execute sequentially |

---

## Transaction Types

Each transaction has common fields and chain-specific fields. The `network` field (CAIP-2) determines which chain-specific fields apply. Clients use the CAIP-2 namespace prefix (e.g., `eip155`, `solana`) to select the correct parser.

### Common Fields

All transactions share these fields regardless of chain.


| Field         | Type     | Required | Description                                                                                                                      |
| ------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `network`     | `string` | No       | CAIP-2 network identifier (e.g., `"eip155:8453"`, `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`). When omitted, defaults to the negotiated `executionNetwork` from `PaymentPayload`. MUST be a member of the server's advertised `supportedNetworks` when present. |
| `type`        | `string` | Yes      | Transaction category (see Type Values below)                                                                                     |
| `description` | `string` | Yes      | Human-readable summary, intended **for UI display only**. MUST be a non-empty string of printable text (Unicode categories L, N, P, S, Zs; no control characters in category Cc), with a maximum length of 280 characters. Clients MUST treat `description` as informational only and MUST NOT use it to make any normative decision (routing, signing, allowlisting). Clients SHOULD truncate or sanitize before display and MAY reject transactions whose `description` violates these constraints. |
| `validUntil`  | `number` | No       | Unix timestamp after which this transaction is stale. If absent, the transaction does not expire. SHOULD reflect the earliest internal deadline (swap deadline, bridge timeout, oracle staleness). |


### EVM Fields (`eip155:*`)

Additional fields for transactions on EVM chains.


| Field      | Type     | Required | Description                                                                                         |
| ---------- | -------- | -------- | --------------------------------------------------------------------------------------------------- |
| `to`       | `string` | Yes      | 20-byte `0x`-prefixed hex address                                                                   |
| `data`     | `string` | Yes      | ABI-encoded transaction data as `0x`-prefixed hex                                                   |
| `value`    | `string` | Yes      | Native token value in wei as decimal string. Use `"0"` for non-payable calls.                       |
| `decodedFunctionData`  | `object` | Yes      | Decoded contract call data: `abi` (ABI items array), `functionName`, and `args` (positional array matching the function signature) |


### SVM Fields (`solana:*`)

Additional fields for transactions on SVM chains.


| Field          | Type    | Required | Description                                                                                                                |
| -------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `instructions` | `array` | Yes      | Ordered array of instruction objects, each with `programId` (base58), `data` (base64), and `keys` (array of account metas) |


#### SVM Instruction Object


| Field       | Type     | Required | Description                                                                                           |
| ----------- | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `programId` | `string` | Yes      | Base58-encoded program address                                                                        |
| `data`      | `string` | Yes      | Base64-encoded instruction data                                                                       |
| `keys`      | `array`  | Yes      | Array of account metas, each with `pubkey` (base58), `isSigner` (boolean), and `isWritable` (boolean) |


#### SVM Account Meta


| Field        | Type      | Required | Description                  |
| ------------ | --------- | -------- | ---------------------------- |
| `pubkey`     | `string`  | Yes      | Base58-encoded account key   |
| `isSigner`   | `boolean` | Yes      | Whether the account signs    |
| `isWritable` | `boolean` | Yes      | Whether the account is mutable |


### Type Values


| Type           | Description                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------- |
| `approval`     | Token approval. Amount MUST be bounded; verify spender matches the next transaction's `to`. |
| `swap`         | Token swap via DEX router.                                                                  |
| `transfer`     | Token or native transfer.                                                                   |
| `bridge`       | Cross-chain bridge deposit.                                                                 |
| `deposit`      | Deposit assets into a liquidity pool, vault or lending protocol.                            |
| `withdraw`     | Withdraw assets from a liquidity pool, vault or lending protocol.                           |

Servers MAY use additional type values but SHOULD prefer standard types. 

---

## Response Format Enforcement

Servers must produce the correct response format and clients must validate it.


## Error Handling

When the server cannot prepare valid transaction data, it MUST NOT call `/settle` and MUST respond with an error. Because no settlement occurs, the client is not charged.


| Error Code                      | Description                               |
| ------------------------------- | ----------------------------------------- |
| `simulation_failed`             | Server-side simulation failed             |
| `unsupported_action`            | Action type not supported                 |
| `unsupported_execution_network` | Requested execution network not supported |
| `executor_invalid`              | Executor address invalid or unusable      |
| `preparation_failed`            | Internal error building transaction data  |

---

## EVM Conventions

On EVM chains (`eip155:*`), the following conventions apply to `TransactionEVM` objects.

### Approval Hygiene

Servers SHOULD set approval amounts to the exact value needed for the subsequent operation. Unlimited approvals (`type(uint256).max`) are forbidden. Clients MUST reject any approval where the amount in `decodedFunctionData.args` is unreasonably large relative to the operation, and SHOULD verify the approved address matches the `to` of a subsequent transaction.

### Decoded Verification

Clients MUST verify that calling `encodeFunctionData(decodedFunctionData)` (using viem or equivalent) reproduces the `data` value. If there is a mismatch, the client MUST NOT execute.

---

## Client Security Recommendations

The server is **untrusted**. Clients MUST NOT execute returned transactions on the basis of server-provided metadata or `description` alone — `description` is normatively informational only (see Common Fields). Independent verification is required and the decision to execute any transaction lies ultimately with the client.

The checks below are organized as MUST (required for spec compliance), SHOULD (strongly recommended for production clients) and MAY (additional defenses for high-value or autonomous flows).

### Required (MUST)

- **Schema conformance**: Validate the response body against the `onchain-actions` schema and reject malformed transactions.
- **Calldata integrity**: Verify decoded data round-trips to the raw payload. On EVM, `encodeFunctionData(decodedFunctionData)` MUST equal `data`. On SVM, the decoded instructions MUST re-encode to the same raw bytes. Reject on any mismatch.
- **Approval bounds**: Reject unlimited or unreasonably large approvals. Verify the approved `spender` matches the `to` of the subsequent transaction that consumes the allowance.
- **Network consistency**: Confirm each transaction's `network` matches the negotiated `executionNetwork` from `PaymentPayload`.
- **Executor consistency**: Confirm the signer/caller of every transaction is the `executor` from `PaymentPayload`. For SVM, verify required signer accounts.
- **Expiry**: Reject any transaction whose `validUntil` is in the past at execution time, allowing for reasonable clock skew.

### Recommended (SHOULD)

- **Spending limits**: Enforce per-call, per-session, and per-period caps on token outflows and native value. Block when predicted outflows exceed the configured budget.
- **Local simulation**: Simulate the full transaction batch before signing (e.g. by using `eth_simulateV1` on EVM). Inspect predicted asset changes, balance deltas and emitted events.
- **Address allowlist**: Maintain an allowlist of known router, bridge, vault, and pool addresses per chain; warn or block unknown `to` addresses. For transfers, confirm the recipient (in `decodedFunctionData.args` or as `to`) is the executor or a user-designated address, not an arbitrary third party.
- **User confirmation**: For non-automated flows, present decoded `description`, decoded args, and predicted asset changes for explicit user approval before signing.

### Optional (MAY)

- **Full simulation with asset traces**: Use a third-party simulation service or a self-hosted fork to produce detailed asset-change diffs, call traces, event logs and dollar-value impact summaries before execution.
- **LLM / model-based review**: Submit decoded calldata, destination contract source or bytecode, and the stated intent to an LLM or analysis pipeline to detect anomalous patterns, hidden behaviors or mismatches with the requested action.
- **Bytecode and source verification**: Pin known-good bytecode hashes (and proxy implementation addresses) for trusted contracts; reject deviations.
- **Reputation lookups**: Query allow/deny lists (chain-specific scam databases, blocklists, sanctions lists) for destination, spender and recipient addresses.
- **MEV protection**: Submit via private mempools or MEV-protected RPCs (e.g., MEV-Share, Flashbots Protect) for sensitive flows.
---

## Version History


| Version | Date       | Changes       | Author    |
| ------- | ---------- | ------------- | --------- |
| v1.0    | 2026-05-25 | Initial draft | @phdargen |


