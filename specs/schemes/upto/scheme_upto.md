# Scheme: `upto`

## Summary

`upto` is a scheme that authorizes a transfer of up to a **maximum amount** of funds from a client to a resource server. The actual amount charged is determined at settlement time based on resource consumption during the request.

This scheme is ideal for usage-based pricing models where the final cost is not known until after the resource has been consumed.

## Example Use Cases

- Paying for LLM token generation (charge per token generated)
- Bandwidth or data transfer metering (charge per byte transferred in a single request)
- Dynamic compute pricing (charge based on actual resources consumed)

## Core Properties (MUST)

The `upto` scheme MUST enforce the following properties across ALL network implementations:

### 1. Single-Use Authorization

Each authorization MUST be settled at most once. After settlement (regardless of amount), the authorization is consumed and cannot be reused.

- Rationale: Provides a clear audit trail, simpler mental model, and matches x402's request-response pattern.
- Implementation: On EVM, Permit2's nonce mechanism enforces this. Other networks MUST implement equivalent replay protection.

### 2. Time-Bound Authorization

Each authorization MUST have explicit validity time constraints:

- **Start time** (`validAfter`): Authorization is not valid before this timestamp
- **End time** (`deadline`): Authorization expires after this timestamp

- Rationale: Limits exposure window for unused authorizations and ensures timely settlement.
- Implementation: On EVM, Permit2's `deadline` and witness `validAfter` enforce this. Other networks MUST implement equivalent time bounds.

### 3. Recipient Binding

The authorization MUST cryptographically bind the recipient address. The server/facilitator cannot redirect funds to a different address than what the client signed.

- Rationale: Prevents malicious facilitators from stealing funds.
- Implementation: On EVM, the Permit2 witness pattern binds `witness.to`. Other networks MUST implement equivalent recipient binding.

### 4. Maximum Amount Enforcement

The settled amount MUST be less than or equal to the authorized maximum.

- The settled `amount` MUST be `<=` the authorized maximum
- The settled `amount` MAY be `0` (no charge if no usage occurred)

### 5. Phase-Dependent `amount` Semantics in `PaymentRequirements`

In the x402 protocol, the verify and settle requests share the same `PaymentPayload` and `PaymentRequirements` types. In the `upto` scheme, the `amount` field of `PaymentRequirements` is **phase-dependent** for server-to-facilitator communication:

- At **verification** time, `amount` represents the **maximum** amount the client authorizes.
- At **settlement** time, `amount` represents the **actual amount to settle**, which MUST be less than or equal to the previously authorized maximum.

The actual settled amount is communicated by the resource server to the facilitator via the `amount` field in the settlement-time `PaymentRequirements`. This allows the resource server to determine the final charge based on actual resource consumption (e.g., tokens generated, bytes transferred) and communicate it to the facilitator without requiring additional fields or a separate settlement type.

- Rationale: Reusing the existing `PaymentRequirements` type for both phases keeps the protocol simple and avoids introducing settlement-specific message types. The `amount` field naturally maps to "how much" in both contexts — "how much is authorized" at verification time and "how much to charge" at settlement time.
- Implementation: The resource server MUST set the `amount` field in the `PaymentRequirements` passed to the facilitator's settle endpoint to the desired settlement amount. The facilitator MUST verify that this amount does not exceed the authorized maximum from the client's signed authorization.

## Out of Scope

The following patterns are NOT supported by `upto` and would require different schemes:

- **Multi-settlement / streaming**: Settling the same authorization multiple times (e.g., pay-per-chunk streaming)
- **Recurring payments**: Automatic periodic charges without new authorizations
- **Open-ended allowances**: Authorizations without time bounds or single-use constraints

## Network-Specific Implementation

Network-specific rules and implementation details are defined in the per-network scheme documents:

- EVM chains: See [`scheme_upto_evm.md`](./scheme_upto_evm.md)
