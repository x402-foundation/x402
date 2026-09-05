# Exact Payment Scheme for Hedera HTS FT and native HBAR token (`exact`)

This document specifies the `exact` payment scheme for the x402 protocol on Hedera.

This scheme facilitates payments of a specific amount of a Hedera HTS fungible token (FT) or the native HBAR token on the Hedera network.

## Scheme Name

`exact`

## Asset Transfer Methods

The `exact` scheme on Hedera executes a transfer where the Facilitator pays the network fee, but the
Client controls the exact flow of funds. This is implemented via one of two asset transfer methods,
depending on who controls the payer's funds:

| AssetTransferMethod | Mechanism | Payer universe | Recommendation |
| --- | --- | --- | --- |
| **1. `cryptoTransfer`** (default) | Client signs a `TransferTransaction`; facilitator co-signs as fee payer | Accounts whose key controls the funds | **Recommended** for key-controlled accounts (simplest, no contract) |
| **2. `transferExecutor`** | Client supplies an authorization for a contract implementing `ITransferExecutor`; facilitator calls `executeTransfer` as fee payer | Funds held by a contract, or spendable only through a contract holding a HIP-336 allowance (smart accounts, multisig / vault contracts, delegation and spend-policy contracts) | **Contract account option** |

If no `assetTransferMethod` is specified in `PaymentRequirements.extra`, clients and facilitators
MUST behave as `cryptoTransfer`. Payment payloads that use a non-default transfer method MUST echo
the selected `assetTransferMethod` in `accepted.extra`. A facilitator MUST reject a value it does not
implement (`invalid_exact_hedera_unsupported_asset_transfer_method`) and MUST NOT fall back to
another method.

In all cases, the Facilitator cannot modify the amount or destination. It serves only as the
transaction broadcaster and fee sponsor.

The sections from `Protocol Flow` through `Facilitator Verification Rules` below define the default
`cryptoTransfer` method (rule 1, "MUST be a `TransferTransaction` directly", applies to that method
only). The `transferExecutor` method is defined in its own section.

Facilitators SHOULD advertise the methods they implement per network in `/supported`:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "hedera:testnet",
      "extra": {
        "feePayer": "0.0.9000",
        "assetTransferMethods": ["cryptoTransfer", "transferExecutor"]
      }
    }
  ]
}
```

## Protocol Flow

The protocol flow for `exact` on Hedera is client-driven.

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a payment required signal containing `PaymentRequired`. Critically, the `extra` field in the requirements contains a **feePayer**, which is the Hedera account ID (`0.0.xxxx`) of the identity that will pay the network fees for the transaction. This is typically the facilitator.
3. **Client** creates a transaction of type `TransferTransaction` that transfers the specified `asset` from the client to the resource server’s `payTo` account for the specified `amount`, and sets the `transactionId.accountId` to `PaymentRequirements.extra.feePayer`.
4. **Client** signs the transaction with their wallet. This results in a **partially signed** transaction (the fee payer’s signature is still missing).
5. **Client** serializes the partially signed transaction and encodes it as a Base64 string.
6. **Client** sends a new request to the resource server with the `PaymentPayload` containing the Base64‑encoded partially signed transaction.
7. **Resource Server** receives the request and forwards the `PaymentPayload` and `PaymentRequirements` to a **Facilitator Server** `/verify` endpoint.
8. **Facilitator** decodes and deserializes the proposed transaction.
9. **Facilitator** inspects the transaction to ensure it is valid and only contains the expected payment transfer.
10. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
11. **Resource Server**, upon successful verification, forwards the payload to the facilitator’s `/settle` endpoint.
12. **Facilitator Server** adds its signature as the `feePayer` and submits the now fully signed transaction to the Hedera network.
13. Upon successful on‑chain settlement, the **Facilitator Server** responds with a `SettlementResponse` to the **Resource Server**.
14. **Resource Server** grants the **Client** access to the resource in its response.

## `PaymentRequirements` for `exact`

In addition to the standard x402 `PaymentRequirements` fields, the `exact` scheme on Hedera requires the following inside the `extra` field:

```json
{
  "scheme": "exact",
  "network": "hedera:mainnet",
  "amount": "1000",
  "asset": "0.0.0",
  "payTo": "0.0.1234",
  "maxTimeoutSeconds": 180,
  "extra": {
    "feePayer": "0.0.1235"
  }
}
```

- `asset`: The Hedera entity ID of the HTS fungible token. For HBAR, use `"0.0.0"`.
- `amount`: The amount to be transferred. For HBAR (`asset` `"0.0.0"`), the amount MUST be expressed in **tinybars** (1 HBAR = 10⁸ tinybars). For HTS fungible tokens, the amount is in the token’s smallest unit (as defined by the token’s decimals).
- `payTo`: The Hedera account ID of the resource server receiving the funds.
- `extra.feePayer`: The Hedera account ID that will pay the transaction fees. This is typically the facilitator’s account; this account must also sign the transaction as the fee payer.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains:

```json
{
  "transaction": "AAAAAAAAAAAAA...AAAAAAAAAAAAA="
}
```

The `transaction` field contains the Base64‑encoded, serialized, **partially signed** versioned Hedera transaction (e.g. `TransferTransaction`), signed by the client but **not yet** signed by the fee payer.

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "hedera:mainnet",
    "amount": "1000",
    "asset": "0.0.0",
    "payTo": "0.0.1234",
    "maxTimeoutSeconds": 180,
    "extra": {
      "feePayer": "0.0.1235"
    }
  },
  "payload": {
    "transaction": "AAAAAAAAAAAAA...AAAAAAAAAAAAA="
  }
}
```

## `SettlementResponse`

The `SettlementResponse` for the `exact` scheme on Hedera:

```json
{
  "success": true,
  "transactionId": "0.0.1235@1700000000.000000000",
  "network": "hedera:mainnet",
  "payer": "0.0.1235"
}
```

- `transactionId`: The Hedera transaction ID of the submitted transaction.
- `payer`: The Hedera account ID of the fee payer that sponsored the transaction.

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`‑scheme Hedera payment MUST enforce all of the following checks before sponsoring and signing the transaction.

### 1. Transaction layout

- The decompiled transaction MUST be a `TransferTransaction` **directly**. It MUST NOT be wrapped in a `ScheduleCreateTransaction` or any other transaction type.
- The transaction MUST:
  1. Have `transactionId.accountId == extra.feePayer` from the `PaymentRequirements`. This ensures the facilitator’s account is the fee payer at the network level.
  2. Contain **only** transfer operations (HBAR or HTS FT transfers) necessary to implement the requested payment. No additional transfers or non‑transfer operations are allowed.
  3. Have the net sum of all HBAR transfers equal zero.
  4. Have the net sum of all transfers for the specified `asset` equal zero.

### 2. Fee payer safety

- The configured `feePayer` (`PaymentRequirements.extra.feePayer`) MUST:
  - NOT appear as a **negative** entry in any HBAR transfer list.
  - NOT appear as a **negative** entry in the token transfer list for the specified `asset`.
- The `feePayer` MAY appear as a positive entry (i.e., receive value), for example when collecting fees or custom fee distributions, but it MUST NOT be the net sender of funds in the payment transaction; it only sponsors network fees via `transactionId.accountId`.

### 3. Network and asset correctness

- The `network` field in `PaymentRequirements` MUST be a valid Hedera CAIP-2 network identifier corresponding to the Hedera network on which the transaction will be submitted (e.g. `hedera:mainnet`, `hedera:testnet`).
- The `asset` in `PaymentRequirements` MUST be:
  - Either `"0.0.0"` to indicate HBAR, **or**
  - A valid fungible token ID for an HTS fungible token.
- All token transfers in the transaction MUST be for the single `asset` specified in `PaymentRequirements.asset`. No other token IDs may appear.

### 4. Transfer intent and destination

- The transaction MUST transfer value from the client’s account(s) to the `payTo` account specified in `PaymentRequirements.payTo`.
- For HBAR payments:
  - The net HBAR amount credited to `payTo` MUST equal `PaymentRequirements.amount` (after normalizing units if necessary).
- For HTS FT payments:
  - The net token amount credited to `payTo` for `asset` MUST equal `PaymentRequirements.amount`.

### 5. Amount exactness

- The `amount` transferred to `payTo` for the given `asset` MUST equal `PaymentRequirements.amount` **exactly**.
- No additional positive net transfers to any other party (besides `payTo`) may exist for the specified `asset`.
- The facilitator MUST reject any transaction where:
  - The net amount to `payTo` is not exactly equal to `PaymentRequirements.amount`, or
  - The client is sending more than `PaymentRequirements.amount` in total for the specified `asset`.

### 6. Payer signature, general validity, and replay protection

- The facilitator MUST verify that the inferred payer actually signed the frozen transaction body before sponsoring it. The facilitator fetches the payer's onchain account key (e.g. via a consensus-node `AccountInfoQuery`) and checks that the transaction carries a valid signature satisfying that key, including KeyList/threshold accounts. A transaction signed with the wrong key, or left unsigned, MUST be rejected (reason `invalid_exact_hedera_payload_signature_invalid`). Without this check a payload that fails at settlement with `INVALID_SIGNATURE` would otherwise pass verification.
- The transaction MUST:
  - Not have been previously submitted/observed (implementations SHOULD perform idempotency / replay checks where possible).
- The facilitator SHOULD pre‑check the transaction to ensure:
  - The client has sufficient balance of the `asset` to cover the transfer.
  - The transaction is expected to succeed on chain (no obvious `INSUFFICIENT_BALANCE`, invalid token association, or similar failures).

These checks are security‑critical to ensure the fee payer cannot be tricked into transferring their own funds or sponsoring unintended actions. Implementations MAY introduce stricter limits (e.g., additional policy around max fee, max amount, or allowed token lists) but MUST NOT relax the above constraints.

### Account aliases and auto-account creation

When the resource server’s `payTo` is specified as an **account alias** (e.g. an EVM address or public key alias) rather than an existing account ID, a transfer of HBAR to that alias can trigger **auto-account creation** on Hedera. In that case, the facilitator effectively funds the creation of the new account (the first transfer to the alias creates the account and credits it). A malicious or poorly configured resource server could use this to have facilitators pay for account creation on its behalf.

This specification does **not** require facilitators to forbid such transfers. Facilitators MAY handle this in whatever way they see fit: for example, they MAY require that `payTo` resolve to an existing account and reject transactions that would trigger auto-account creation, or they MAY allow it and accept the cost. Implementations SHOULD document their policy and, if they allow transfers to aliases, consider the associated cost and abuse potential.

## AssetTransferMethod: `transferExecutor`

This asset transfer method lets a Client whose funds are controlled by a smart contract pay an
`exact` quote. It is particularly suited for contract accounts (smart accounts, multisig, treasury
and vault contracts) and for accounts that have delegated spending to a contract through a HIP-336
allowance (delegation, session-key, spend-policy, subscription and agent-wallet contracts). Such
payers cannot sign a `TransferTransaction` for the funds in question: the contract's logic moves
them, and the transaction that triggers it is a `ContractExecuteTransaction`.

The mechanism it relies on is native to Hedera:

- HIP-336 lets an account grant an HBAR or HTS allowance to **a contract**, and HIP-376 exposes
  `transferFrom` on the HTS ERC-20 facade, where the amount is deducted from **the caller's**
  allowance, the caller being the contract.
- A contract that holds funds itself moves them through the HTS system contract
  (`cryptoTransfer`, `transferToken`) or a native value transfer.
- Transfers initiated by a contract appear in the **child records** of the
  `ContractExecuteTransaction`, so their outcome is observable from consensus.

The shape follows the EVM `erc7710` method: the Client declares which contract acts for it and
supplies an opaque authorization; the Facilitator constructs the transfer call itself, so the asset,
recipient and amount in the call are always the Facilitator's own values, never the Client's.

What this method changes relative to `cryptoTransfer`:

- **Payer universe.** Any account whose funds are held by, or spendable through, a contract on the
  same network. The payer's account key never signs a Hedera transaction.
- **Authorization carrier.** The Client's authorization travels as opaque bytes in whatever form the
  executor contract defines (an EIP-712 signed intent, a session-key signature, an on-chain multisig
  approval id, a standing policy). The facilitator never interprets it.
- **Who moves funds.** The executor contract, not the payer and not the facilitator. The facilitator
  only signs the wrapping `ContractExecuteTransaction` and pays its fee.
- **Verification model.** Simulation before settlement and consensus-record verification after,
  instead of transfer-list inspection and payer-signature checks.
- **Replay protection.** Enforced by the executor contract (nonces, validity windows), not by
  Hedera transaction ids.
- **`extra.feePayer` is not used.** The Client builds no Hedera transaction, so it does not need the
  fee payer's identity. The facilitator submits from an account selected from its own configuration.
  Executors that want submitter binding MAY check `msg.sender` against a value the Client places in
  `authorization`; that is executor-specific and out of scope here.

The Client chooses the executor. No trusted list of executor implementations is required for
correctness: the fixed interface, the simulation and the settlement proof are the verification
mechanism. Resource servers and facilitators MAY restrict which executors they accept as local
policy.

### Executor interface

An executor MUST implement:

```solidity
interface ITransferExecutor {
    /// Moves exactly `amount` of `asset` from `from` to `to` if, and only if,
    /// `authorization` permits it. MUST revert otherwise. Any returned data is ignored.
    /// `asset == address(0)` denotes HBAR; otherwise the HTS token's EVM address.
    function executeTransfer(
        address from,
        address asset,
        address to,
        uint256 amount,
        bytes calldata authorization
    ) external;
}
```

Requirements on an executor:

- It MUST bind `authorization` to `from`, `asset`, `to` and `amount` (or to values that imply them),
  so a facilitator cannot reuse an authorization for a different transfer, and MUST revert on any
  mismatch. Whether an authorization is single-use or multi-use is the executor's choice.
- It MUST signal failure by reverting. Returned data is ignored, so returning `false` is not a
  failure signal: a `SUCCESS` receipt with no transfer is a failed settlement (Phase 4).
- It MUST NOT depend on `msg.value` and MUST NOT debit any account other than `from`.
- Funds move either from the executor's own balance, where `from` is the executor's account, or via
  a HIP-336 allowance from `from` to the executor. The account debited MUST be `from`; settlement
  rule 3 fails any other debit.

`executeTransfer` is the only function a facilitator calls. Everything else about the executor
(how authorizations are created, policies, key management) is opaque to x402.

The interface name is NOT normative: conformance is by function signature, whose selector is
`0xea8f19fd`, which does not encode return types, so a contract that returns data still conforms.
The interface is deliberately protocol-agnostic, so a contract that already exposes it for other
callers needs no x402-specific surface.

### Prerequisites

1. **Executor contract.** A contract implementing `ITransferExecutor` deployed on `network`.
2. **Funding path.** Either `payer` is the executor's own account and holds the funds, or `payer`
   has granted the executor a HIP-336 allowance for `asset` covering `amount`.
3. **Association.** For HTS assets, `payTo` MUST be associated with `asset` or hold a free
   auto-association slot.
4. **Addressability.** `payer`, `payTo` and `executor` MUST resolve to EVM addresses. Facilitators
   resolve Hedera ids through the mirror node and MUST use an account's alias address where one
   exists; the long-zero form of an alias-bearing account does not resolve in HTS calls.
5. **Client authorization.** The Client is able to produce an `authorization` the executor accepts
   for this exact transfer.
6. **No custom fees on `asset`.** A fixed or fractional custom fee credits fee collectors and makes
   the credit to `payTo` differ from the debit to `payer`, which `exact` cannot express. The
   facilitator MUST read the token's fee schedule at verification and reject with
   `invalid_exact_hedera_custom_fee_asset`.

### Phase 1: Obtaining an authorization

How the Client obtains the authorization is outside the scope of x402. Examples:

- signing an EIP-712 intent that the executor verifies on chain;
- a session key or delegated key permitted by the executor's policy;
- a multisig or governance proposal already approved on chain, referenced by id;
- a pre-configured spend policy the executor enforces.

Where the authorization embeds an expiry, Clients SHOULD bound it by `maxTimeoutSeconds` so the
on-chain window and the resource server's willingness to wait cannot drift apart.

### Phase 2: `PAYMENT-SIGNATURE` Header Payload

`PaymentRequirements` for `transferExecutor`:

```json
{
  "scheme": "exact",
  "network": "hedera:testnet",
  "amount": "100000000",
  "asset": "0.0.0",
  "payTo": "0.0.4001",
  "maxTimeoutSeconds": 120,
  "extra": {
    "assetTransferMethod": "transferExecutor"
  }
}
```

**`extra` field definitions specific to `transferExecutor`:**

- `extra.assetTransferMethod` (required): MUST be `"transferExecutor"`.
- `extra.feePayer` (optional): ignored by this method. Resource servers that serve both methods
  from one `accepts[]` entry MAY leave it in place for `cryptoTransfer` clients.

The `payload` field must contain:

- `payer`: Hedera account id (`0.0.x`) whose funds are debited, passed as `from`. MUST be the
  account the settlement record shows debited, so a vault holding the funds itself is named here.
- `executor`: Hedera contract id (`0.0.x`) of the `ITransferExecutor` acting for the payer.
- `authorization`: `0x`-prefixed hex, opaque bytes the executor validates.

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "hedera:testnet",
    "amount": "100000000",
    "asset": "0.0.0",
    "payTo": "0.0.4001",
    "maxTimeoutSeconds": 120,
    "extra": {
      "assetTransferMethod": "transferExecutor"
    }
  },
  "payload": {
    "payer": "0.0.5001",
    "executor": "0.0.7000",
    "authorization": "0x0f2c9d1a..."
  }
}
```

Nothing else crosses the wire: no serialized Hedera transaction, no fee-payer signature, no
transfer calldata.

### Phase 3: Verification Logic

Unlike `cryptoTransfer`, `transferExecutor` verification is performed entirely through simulation.
The `authorization` is opaque to the facilitator but verifiable by simulating the intended call.

Simulation covers whatever conditions the executor imposes; an enumerated set of state reads cannot,
because the executor MAY impose any condition. A facilitator that understands a specific
authorization format MUST define a separate `assetTransferMethod` for it: within `transferExecutor`
that knowledge MAY narrow what is accepted (executor allowlist, caps) but MUST NOT replace the
simulation.

The facilitator:

1. **Validates shape.** `extra.assetTransferMethod == "transferExecutor"`; `payload.payer` and
   `payload.executor` are well-formed Hedera ids; `payload.authorization` is `0x`-prefixed hex.
   Network and asset rules of `cryptoTransfer` (rule 3) apply unchanged. Reject with
   `invalid_payload` / `invalid_payment_requirements`. An HTS `asset` with any custom fee is
   rejected with `invalid_exact_hedera_custom_fee_asset` (Prerequisite 6).
2. **Checks method support.** It implements `transferExecutor` on `network`; otherwise
   `invalid_exact_hedera_unsupported_asset_transfer_method`.
3. **Resolves addresses.** `payer` and `payTo` to EVM addresses (Prerequisite 4), rejecting with
   `address_resolution_failed` when either cannot be resolved; `asset` to `address(0)` for
   `"0.0.0"`, else the token's long-zero address. `executor` stays a Hedera contract id: contracts
   are addressable by their long-zero form, so no lookup is needed.
4. **Constructs** the call
   `executeTransfer(from = payer, asset, to = payTo, amount, authorization)`. The facilitator MUST
   build these arguments from `PaymentRequirements` and `payload.payer` only; it MUST NOT accept a
   client-supplied calldata blob.
5. **Simulates** that call against `executor` from the account it will submit from, with the gas
   limit it will use at settlement, to verify:
   - the authorization is valid and permits exactly this transfer;
   - the payer has sufficient balance / allowance;
   - the transaction will succeed when executed.
   It MUST reject on revert (`simulation_reverted`). It SHOULD also bound gas: submitting with an
   explicit gas limit is required by Security Consideration 4, and a facilitator that can measure
   simulated usage SHOULD reject an unexpectedly high figure (`simulation_gas_exceeded`), which may
   indicate an executor designed to drain the fee payer. Where only a ceiling is enforced, an
   over-budget call surfaces as a revert. The simulation channel MUST execute state-changing calls,
   including calls into the HTS system contract; a read-only channel reports reverts that settlement
   would not produce.

If the simulation succeeds, the payment is considered valid. A passing simulation MUST NOT be
reported as settlement and MUST NOT cause the resource server to release the resource; state can
change between `/verify` and `/settle`, and the settlement proof (Phase 4) is the only evidence of
payment.

The facilitator SHOULD read state that gates the call (nonces, allowances) from a consensus or
mirror node rather than a JSON-RPC relay, which may serve slightly stale state, and SHOULD reject a
payload identical to one it already has in flight, keyed on the hash of
`(network, executor, payer, authorization)`. It MUST NOT reject one because an identical payload
settled earlier: an authorization MAY be multi-use, and a standing policy presents the same bytes on
every payment. On-chain replay protection is the executor's responsibility.

Facilitators MAY introduce stricter limits (executor allowlists, max amount, allowed assets, gas
caps) but MUST NOT relax the above constraints.

### Phase 4: Settlement Logic

1. The facilitator builds a `ContractExecuteTransaction` with `contractId = executor`,
   `functionParameters = executeTransfer(from, asset, to, amount, authorization)` exactly as
   simulated, a gas limit under its own policy and `transactionId.accountId` set to an account from
   its own configuration; signs it as fee payer; submits it. The facilitator MUST only ever sign
   this wrapping transaction.
2. After consensus the facilitator MUST fetch the transaction record **including child records**
   (transfers made by a contract appear in child records, not in the parent) and merge their transfer
   lists: the HBAR list when `asset == "0.0.0"`, otherwise the token transfer list for `asset`.
3. The facilitator MUST report `success: false` unless all hold on the merged lists:
   - the net credit to `payTo` in `asset` equals `amount` exactly;
   - the positive net changes in `asset` other than `payTo`'s sum to the record's `transactionFee`.
     Unlike `cryptoTransfer`, this runs on a consensus record, which always credits the node, fee
     collection and staking accounts; for HBAR those credits share the payment's list. An HTS token
     list carries no fee distribution, so there `payTo` MUST be the only credit;
   - the only debited accounts are `payer` (by `amount` in `asset`) and the fee payer (by the
     transaction fee in HBAR). Any third debited account MUST fail the settlement, so a hostile
     executor cannot touch an account nobody expected. When `payer` is the fee payer, the single HBAR
     debit MUST equal `amount + transactionFee` and the facilitator reports the two parts separately
     using the record's `transactionFee`.
4. A transaction that reaches consensus with a `SUCCESS` receipt but whose record does not satisfy
   rule 3 is a **failed settlement**. Settlement success MUST reflect actual on-chain effects, not
   the receipt status and not simulation.
5. If the transaction broadcasts successfully but its record cannot be obtained (node or mirror
   error, timeout), the facilitator MAY return `settlement_pending` with `success: false` and the
   transaction id in `transaction`, so the caller can reconcile on chain before retrying.

`SettlementResponse` (core v2 shape, `transaction` carries the Hedera transaction id):

```json
{
  "success": true,
  "transaction": "0.0.9000@1755500000.000000000",
  "network": "hedera:testnet",
  "payer": "0.0.5001",
  "extensions": {
    "settlementProof": {
      "payeeCredit": "100000000",
      "payerDebit": "-100000000",
      "feePayerDebit": "-5321000",
      "transactionFee": "5321000"
    }
  }
}
```

- `payer`: the account debited `amount`.
- `extensions.settlementProof` (OPTIONAL): the figures the facilitator asserted, so a
  resource server can log or re-check them. Amounts in the asset's smallest unit and signed as the
  record reports them, so debits are negative; `transactionFee` in tinybars, always positive because
  it names a cost rather than a transfer. The transaction id is already in `transaction` and is not
  repeated here.

### Error codes

`invalidReason` / `errorReason` are stable tokens. Standard v2 codes (`insufficient_funds`,
`invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `invalid_network`,
`invalid_x402_version`, `unexpected_verify_error`, `unexpected_settle_error`, `settlement_pending`)
apply as usual. Method-specific values:

| Code | Meaning |
| --- | --- |
| `invalid_exact_hedera_asset_transfer_method` | `extra.assetTransferMethod` is not a value this mechanism defines |
| `invalid_exact_hedera_unsupported_asset_transfer_method` | the method is defined but this facilitator does not implement it on `network` |
| `invalid_exact_hedera_payload_transfer_executor` | `payload` is absent or not an object |
| `invalid_exact_hedera_payload_payer` | `payload.payer` missing or not a Hedera account id |
| `invalid_exact_hedera_payload_executor` | `payload.executor` missing or not a Hedera contract id |
| `invalid_exact_hedera_payload_authorization` | `payload.authorization` not `0x`-prefixed hex |
| `invalid_exact_hedera_custom_fee_asset` | `asset` has a custom fee schedule, so `exact` cannot hold (Prerequisite 6) |
| `address_resolution_failed` | `payer` or `payTo` could not be resolved to an EVM address |
| `simulation_reverted` | `executeTransfer` reverted in simulation |
| `simulation_gas_exceeded` | OPTIONAL; simulated gas above the facilitator's bound |
| `settlement_status_not_success` | the record's status is not `SUCCESS` |
| `settlement_payee_credit_mismatch` | the record shows a net credit to `payTo` that is not `amount` |
| `settlement_payer_debit_mismatch` | the payer's net debit is not the expected figure |
| `settlement_fee_payer_debit_mismatch` | the fee payer's net debit is not the transaction fee |
| `settlement_unexpected_debit` | an account other than `payer` and the fee payer lost funds |
| `settlement_proof_failed` | the proof failed for a reason with no more specific code |

A resource server that refuses a payment on its own policy, for example an executor outside a local
allowlist, reports it in the 402 body's `error` field (`executor_not_allowed`), which is its own
vocabulary and distinct from the facilitator's `invalidReason`.

### Security Considerations

1. **Fee payer safety.** The executor spends from `from` (allowance or own balance), never from the
   sender of the wrapping transaction, so the fee payer's balances and allowances are never
   referenced by the call it signs, and the gas limit (Consideration 4) bounds the fee. Settlement
   rule 3 makes any other debit a failed settlement, but only after consensus, when the fee is
   already spent.
2. **Authorization scope.** The facilitator constructs `from`, `asset`, `to` and `amount` itself
   and cannot resize or redirect the payment; the executor decides only whether the authorization
   permits that exact transfer. The executor is responsible for bounding what an authorization may
   spend (caps, recipient restrictions); the facilitator will not.
3. **Race condition between verify and settle.** A Client (or a concurrent payment) may invalidate the
   authorization, consume a nonce or drain the balance between simulation and execution, causing the
   facilitator to pay gas for a failed call. Mitigations: re-simulate immediately before submission,
   per-payer and per-executor rate limits, reputation signals, restricting which resource servers may
   request settlement.
4. **Malicious executor gas consumption.** An executor may behave differently at execution than at
   simulation or attempt to consume excessive gas. Facilitators MUST set an explicit gas limit, SHOULD
   reject unexpectedly high simulated gas, and MAY allowlist executors, as MAY resource servers.
5. **Post-settlement verification (TOCTOU).** Simulation proves a call *would* succeed, not that it
   *did*. The record-based proof in Phase 4 is mandatory precisely because a receipt of `SUCCESS` is
   compatible with no funds moving.
6. **Replay.** On chain: the executor's nonce and validity window, the only authoritative defence.
   Off chain: the facilitator's in-flight guard on the authorization hash, which does not block a
   multi-use authorization (Phase 3). Resource servers SHOULD refuse to serve twice for one
   `transaction`.
7. **Settlement atomicity.** One transaction moves the funds; a revert rolls everything back. Soft
   failure (no revert, no transfer) is detected by record, never by receipt.
8. **Account aliases.** The alias / auto-account-creation policy of `cryptoTransfer` applies to
   `payTo` credits produced by the executor.

Security invariants, in the style of the SVM spec. A rule that reads a consensus record can only
report a violation that already happened, so prevention and detection are listed separately:

| ID | Invariant | Prevented by | Detected by |
| --- | --- | --- | --- |
| I1 | Fee payer is never debited beyond the network fee | Executor spends from `from`, never from the wrapping transaction's sender; the fee payer grants it no allowance; explicit gas limit (Considerations 1 and 4) | Settlement rule 3 |
| I2 | `payTo` is credited exactly `amount` of `asset` | Facilitator-built call (verification rule 4); assets with custom fees rejected at verification (Prerequisite 6) | Settlement rule 3 |
| I3 | Only `payer` is debited `amount` | Facilitator-built call; executor MUST NOT debit any account other than `from` | Settlement rule 3 |
| I4 | Settlement success equals on-chain effect | n/a; this invariant is the detection itself | Settlement rules 2 to 4 |
| I5 | Simulation is a viability and cost check, not the security boundary | n/a; a statement of the model, see Phase 3 | n/a |
| I6 | The facilitator cannot resize or redirect the payment | Verification rule 4 | Settlement rule 3 |

### Comparison to `cryptoTransfer`

| | `cryptoTransfer` | `transferExecutor` |
| --- | --- | --- |
| Payer signs | The Hedera transaction | Nothing on chain; authorization is opaque bytes |
| Funds move via | Transfer list | Executor contract (allowance or own balance) |
| Who fixes asset / recipient / amount | Client, checked by facilitator | Facilitator, in the call it builds |
| Facilitator verifies | Transfer list + payer signature | Simulation + consensus-record proof |
| Replay protection | Hedera transaction id | Executor contract |
| `extra.feePayer` | Required | Not used |
| Executor choice | n/a | Client; resource server / facilitator MAY allowlist |
| Fee payer exposure | Fee only (rule 2) | Fee only (settlement rule 3) |
| Payer universe | Key-controlled accounts | Contract-controlled funds |

## Implementer Notes

- Client SDKs SHOULD expose a hook on the signer that produces `{ executor, authorization }` from
  `PaymentRequirements`, so the mechanism package stays free of any executor internals.
- Facilitators SHOULD simulate with the same gas limit they will submit with, and read state that
  gates the call from a consensus or mirror node.
- Executor authors SHOULD enforce expiry before consuming any nonce so an expired authorization
  leaves the payer able to re-sign, and SHOULD emit an event carrying `(from, asset, to, amount)` for
  off-chain reconciliation.
- Existing contracts with their own entry points can adopt this method with a thin
  `executeTransfer` adapter that decodes `authorization`, checks it against the supplied arguments
  and delegates to the existing logic.

## Annex: Reference executors

`transferExecutor` does not define a canonical executor. Any `ITransferExecutor` works. Known
implementations:

- **Hedera Agentic Accounts `PaymentRouter`**: an owner grants the contract a HIP-336 allowance and
  signs a policy (agent key, recipient allowlist, per-asset caps); an agent signs a per-payment
  EIP-712 intent (`asset, source, destination, value, intentNonce, validAfter, validBefore, context`)
  with `validBefore` derived from `maxTimeoutSeconds`. `authorization` is
  `abi.encode(signedConfig, signedIntent, merkleProof)`; `executeTransfer` checks
  `intent.source == from`, `intent.asset == asset`, `intent.destination == to`,
  `intent.value == amount`, then runs the router's policy checks and transfer, reverting on any
  failure. HBAR is exercised end to end; HTS by contract and unit tests.
- Other natural fits: a multisig or vault contract executing an already-approved transfer by id; a
  subscription contract releasing a due payment; a session-key wallet.
