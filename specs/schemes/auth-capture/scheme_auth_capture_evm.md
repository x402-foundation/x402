# Scheme: `auth-capture` on `EVM`

## Summary

This is the EVM binding of [`auth-capture`](./scheme_auth_capture.md). It specifies the contracts, wire fields, signatures, and facilitator logic that realize the scheme on EVM chains.

The binding builds on the [base/commerce-payments](https://github.com/base/commerce-payments) contract stack. Two CREATE2 deployments are specified, selected by OPTIONAL `extra.authCaptureEscrow` as [Commerce-payments deployments](#commerce-payments-deployments) sets out. The default is the v1.1 set.

- `AuthCaptureEscrow` — the escrow singleton. It holds funds, enforces the expiry ordering, moves value on every operation, and gates each of them on `msg.sender == paymentInfo.operator`. Its address is the same on every supported chain for a given deployment.
- **Token collectors** — one canonical contract per funding path in that deployment, each turning an authorization into a token pull:
  - `EIP3009_TOKEN_COLLECTOR_ADDRESS` — collects from the payer via ERC-3009 `receiveWithAuthorization` (USDC, EURC, and other EIP-3009 tokens).
  - `PERMIT2_TOKEN_COLLECTOR_ADDRESS` — collects from the payer via Uniswap Permit2 `permitTransferFrom` (any ERC-20).
  - `OPERATOR_REFUND_COLLECTOR_ADDRESS` — collects refund liquidity from `paymentInfo.operator`.

The client produces exactly one signature: an ERC-3009 or Permit2 authorization naming a collector as the recipient. Which later operations the facilitator also relays depends on `extra.operatorType`. Facilitator-relayed `charge`, `capture`, `void`, and `refund` each require an EIP-712 signature from the receiver authorizer; `authorize` does not — the client's token authorization is sufficient.

## Operator types

`extra.operatorType` names the kind of `extra.captureAuthorizer`. That address is committed onchain as `PaymentInfo.operator`.

Two kinds are specified: `"delegated"`, where the facilitator is the operator, and `"custom"`, where a custom smart contract is. A third value, `"policy"`, is RESERVED for the contract operators in [Future operator type: `policy`](#future-operator-type-policy); `extra.policy` is defined and bound into the payment's identity already, so that adding that type later changes no field and no derivation.

The kinds are choices about who submits which calls. They are defined in terms of the escrow's own functions, referred to below as the **escrow ABI**. The **collect** operations are `authorize` and `charge` — whichever `extra.paymentFlow` selects for the client's payload. The **lifecycle** operations are `capture`, `void`, and `refund`. The signatures below are the v1.1 escrow. When `extra.authCaptureEscrow` is the v1.0 escrow, `charge` and `capture` take `uint16 feeBps` in place of `uint256 feeAmount`; `authorize`, `void`, and `refund` are identical across both. A `"custom"` operator MUST expose the collect ABI of the escrow it forwards to.


| Operation   | Signature                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `authorize` | `authorize(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)`                                      |
| `charge`    | `charge(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData, uint256 feeAmount, address feeReceiver)` |
| `capture`   | `capture(PaymentInfo paymentInfo, uint256 amount, uint256 feeAmount, address feeReceiver)`                                             |
| `void`      | `void(PaymentInfo paymentInfo)`                                                                                                        |
| `refund`    | `refund(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)`                                         |


### `"delegated"` — facilitator is the operator

The facilitator is itself the operator and calls the escrow directly with the escrow ABI. `extra.captureAuthorizer` is an address the facilitator controls and submits from. It MAY be an EOA or a smart-contract account (for example an ERC-4337 account that is `msg.sender` via a user operation).

When `extra.receiverAuthorizer` is a non-zero address, the facilitator relays collect and lifecycle operations. What the server gives up is enforcement: nothing onchain requires an authorizer signature, checks it against the one the server holds, or stops a capture the server never asked for, so the facilitator's own verification is the only gate. A server choosing `"delegated"` with a receiver authorizer is trusting the facilitator to relay exactly what the client payload and its own authorizer signed, and nothing else. That trust is bounded by the escrow's client-side guarantees — the client-signed maximum, the fee bounds, and `reclaim` after the capture deadline — but within those bounds it is trust, not proof.

When `extra.receiverAuthorizer` is absent or the zero address, `"delegated"` is authorize-only: the facilitator may relay `authorize`, but MUST reject `charge` and `payload.type` of `"capture"`, `"void"`, or `"refund"`. Later lifecycle operations run out of band under the operator's own rules (for example a self-facilitating server that submits capture from the same smart-contract account through its own API).

### `"custom"` — collect-only relay, lifecycle out of band

`extra.captureAuthorizer` is a contract that is `PaymentInfo.operator`. It MUST expose the escrow ABI's collect entry points (`authorize` and `charge`) as permissionless — any caller, including the facilitator, MAY invoke them — and each MUST forward to the escrow. The facilitator relays only that collect call; it has no other way onto the operator, so an access-controlled collect entry point makes the kind unusable.

`"custom"` is identified by its entry in the facilitator's operator allowlist and by exposing those collect wrappers, not by the mere presence of bytecode. A smart-contract account the facilitator submits from is `"delegated"`, even though it has deployed code.

For the client, the payment ends where the protocol ends: it signs once, the collect settles, and it has paid. Everything after that is between the server and the operator — merchant, arbiter, payer, or any other party the operator's policy allows calls the operator or its periphery directly, with whatever ABI and authentication that operator defines, typically through the operator's own SDK. The facilitator is not involved in or aware of that call path.

Because lifecycle is out of band, the operator MAY impose additional rules — time locks, freeze windows, role-gated capture or void, arbitration, streaming release, or a surface that does not match `capture`/`void`/`refund` — without changing the escrow, the facilitator, or the scheme. Those rules are neither relayed nor validated by the facilitator.

### Validation before relaying

At verification time the facilitator branches on `extra.operatorType` and applies the rules of the branch it lands in:

- **`"custom"`** — `extra.captureAuthorizer` exposes the permissionless collect wrappers and is admitted by the facilitator's operator allowlist (see [`/supported`](#supported)), otherwise `invalid_auth_capture_evm_operator_type_mismatch` or `invalid_auth_capture_evm_operator_not_admitted`. `extra.policy` is absent or the zero address. The payload is a collect settle (`authorize` or `charge` per `extra.paymentFlow`), never a lifecycle payload.
- **`"policy"`** — the appendix's rules apply, in [Future operator type: `policy`](#future-operator-type-policy). A facilitator that does not implement that type MUST reject it with `invalid_auth_capture_evm_unsupported_operator_type` rather than treat it as one of the other two.
- **default** — the value MUST be `"delegated"` or absent, otherwise `invalid_auth_capture_evm_unsupported_operator_type`. `extra.captureAuthorizer` MUST be an address the facilitator controls and submits from, otherwise `invalid_auth_capture_evm_operator_not_admitted`. That lookup against its own submitters is the whole test: the facilitator calls the escrow directly here, so an address it does not control is refused whether or not it is somebody else's operator contract. `extra.policy` is absent or the zero address. Without a non-zero `receiverAuthorizer` the payload is a collect settle, not a lifecycle payload.

### Operator fields per type

`extra.captureAuthorizer` is the payment's **authority** — the only address the escrow accepts as `msg.sender` — and `extra.receiverAuthorizer` is its **consent**, the EIP-712 signer of the operations the client did not authorize. Three `extra` fields carry the operator model, and only these three differ by type; absent is read as the zero address throughout.


| `extra` field        | `"delegated"`                                                                                                                                              | `"custom"`                                                                                                                          | `"policy"`                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `captureAuthorizer`  | REQUIRED — an address the facilitator controls and submits from                                                                                            | REQUIRED — the operator contract                                                                                                    | REQUIRED — the operator contract                                                        |
| `receiverAuthorizer` | OPTIONAL for `authorize`; REQUIRED and non-zero for `charge` and relayed lifecycle, with the facilitator the only thing that checks the signature | OPTIONAL for `authorize`; REQUIRED and non-zero for `charge`, whose signature the facilitator checks before relaying | REQUIRED, non-zero — the operator verifies its signature onchain                        |
| `policy`             | UNUSED — MUST be absent or zero                                                                                                                            | UNUSED — MUST be absent or zero                                                                                                     | OPTIONAL — zero selects the signature-only operator, non-zero names the policy contract |


Every other `extra` field means the same thing in all three, as its [`extra` entry](#extra-fields) gives it.

## PaymentRequirements

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "auth-capture",
      "network": "eip155:8453",
      "amount": "1000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xReceiverAddress",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2",
        "authCaptureEscrow": "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c",
        "captureAuthorizer": "0xOperatorAddress",
        "operatorType": "custom",
        "receiverAuthorizer": "0xReceiverAuthorizerAddress",
        "policy": "0x0000000000000000000000000000000000000000",
        "paymentFlow": "escrow",
        "captureDeadline": 1740758554,
        "refundDeadline": 1741276954,
        "minFeeBps": 100,
        "maxFeeBps": 100,
        "feeRecipient": "0xFeeRecipientAddress",
        "assetTransferMethod": "eip3009"
      }
    }
  ]
}
```

### `extra` fields


| Field                 | Required | Type                           | Description                                                                                                                                                                                                                                                                    |
| --------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                | Yes      | `string`                       | EIP-712 token-domain name (e.g. `"USDC"`). Used for ERC-3009 signing only.                                                                                                                                                                                                     |
| `version`             | Yes      | `string`                       | EIP-712 token-domain version (e.g. `"2"`). Not the commerce-payments deployment.                                                                                                                                                                                               |
| `authCaptureEscrow`   | No       | `address`                      | Canonical `AuthCaptureEscrow` this payment is collected into. Selects the [commerce-payments deployment](#commerce-payments-deployments): the v1.1 escrow (default when omitted) or the v1.0 escrow. New servers SHOULD write the v1.1 address out. Any other value is `invalid_auth_capture_evm_extra`. The matching collectors are not carried on `extra`. |
| `captureAuthorizer`   | Yes      | `address`                      | The operator, committed onchain as `PaymentInfo.operator`.                                                                                                                                                                                                                     |
| `receiverAuthorizer`  | Per type | `address`                      | Signer of every `authorizerSignature` on facilitator-relayed `charge` and lifecycle settles, required as [Operator fields per type](#operator-fields-per-type) gives it. MUST be non-zero for every `charge` and every relayed `capture` / `void` / `refund`. Non-zero turns [salt binding](#payment-identity) on. MAY equal `captureAuthorizer`. |
| `policy`              | Per type | `address`                      | Policy contract governing the payment, permitted as [Operator fields per type](#operator-fields-per-type) gives it. A non-zero value turns [salt binding](#payment-identity) on alongside `receiverAuthorizer`. See [Future operator type: `policy`](#future-operator-type-policy). |
| `captureDeadline`     | Yes      | `uint48`                       | Absolute Unix seconds; capture must occur before this. Onchain `authorizationExpiry`.                                                                                                                                                                                          |
| `refundDeadline`      | Yes      | `uint48`                       | Absolute Unix seconds; refunds are allowed until this. Onchain `refundExpiry`.                                                                                                                                                                                                 |
| `feeRecipient`        | Yes      | `address`                      | Fee recipient, onchain `feeReceiver`.                                                                                                                                                                                                                                          |
| `minFeeBps`           | Yes      | `uint16`                       | Fee floor in basis points; `0` for none. Onchain `PaymentInfo.minFeeBps` in both deployments. The submitted `charge` / `capture` fee is not this field: v1.1 submits `feeAmount`, v1.0 submits `feeBps`. |
| `maxFeeBps`           | Yes      | `uint16`                       | Fee ceiling in basis points. Onchain `PaymentInfo.maxFeeBps` in both deployments.                                                                                                                      |
| `paymentFlow`         | No       | `"escrow"` \| `"authorization"` | Which lifecycle applies, and with it whether the client's payload settles as `authorize` or `charge`. Default `"escrow"`. New servers SHOULD write `"escrow"` out. A server that captures automatically after its own `authorize` is still `"escrow"`; `"authorization"` means the client's payload itself settles as a terminal `charge`. |
| `captureMode`         | No       | `"sync"` \| `"deferred"`       | Escrow-only resource-server choice for when the post-resource finalize runs. Default `"sync"`: the after-handler `/settle` relays `capture` or `void`. `"deferred"` skips that settle so the server captures later from durable state. MUST NOT be set when `paymentFlow` is `"authorization"`, and MUST be `"deferred"` on a collect-only route — `operatorType: "custom"`, or `"delegated"` with a zero `receiverAuthorizer` — per [Sync and async finalize](#sync-and-async-finalize). |
| `operatorType`        | No       | `"delegated"` \| `"custom"`    | Kind of `extra.captureAuthorizer`: an address the facilitator controls and submits from (`"delegated"`, EOA or smart-contract account) or a contract with permissionless collect and an out-of-band lifecycle surface (`"custom"`). Default `"delegated"`. `"policy"` is reserved for the appendix's future type. |
| `assetTransferMethod` | No       | `"eip3009"` \| `"permit2"`     | Which canonical token collector the client authorizes. Default `"eip3009"`. A server MAY list several `accepts[]` entries differing only here, so clients can pick the method matching their token approvals. The collector address is not carried on `extra`; it is the collector of the [resolved deployment](#commerce-payments-deployments) for the chosen method. |


Where a description above names an onchain field, that is the `AuthCaptureEscrow` struct field the value becomes; the [PaymentInfo struct](#paymentinfo-struct) appendix gives the full derivation.

## Commerce-payments deployments

`AUTH_CAPTURE_ESCROW_ADDRESS`, `EIP3009_TOKEN_COLLECTOR_ADDRESS`, `PERMIT2_TOKEN_COLLECTOR_ADDRESS`, and `OPERATOR_REFUND_COLLECTOR_ADDRESS` name one canonical CREATE2 set. Two sets are specified. OPTIONAL `extra.authCaptureEscrow` selects between them; the collector addresses are never on `extra`.

Treat an omitted `extra.authCaptureEscrow` as the v1.1 escrow. A facilitator MUST reject any other address with `invalid_auth_capture_evm_extra`. New servers SHOULD write the v1.1 address out. A server that still collects into the v1.0 escrow MUST publish that v1.0 address so a client that defaults to v1.1 does not sign a nonce and collector for the wrong set.


| Constant                            | v1.1 (default)                                 | v1.0                                               |
| ----------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `AUTH_CAPTURE_ESCROW_ADDRESS`       | `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c`   | `0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff`       |
| `EIP3009_TOKEN_COLLECTOR_ADDRESS`   | `0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88`   | `0x0E3dF9510de65469C4518D7843919c0b8C7A7757`       |
| `PERMIT2_TOKEN_COLLECTOR_ADDRESS`   | `0xD69831Aed5bfe262067ec4c751f4F830EcdD446e`   | `0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26`       |
| `OPERATOR_REFUND_COLLECTOR_ADDRESS` | `0x7a03443724d14798c4AB4622F1DAAcA761Fea486`   | `0x934907bffd0901b6A21e398B9C53A4A38F02fa5d`       |


The client's `signatureNonce` commits to the resolved escrow, and `authorization.to` / `permit2Authorization.spender` MUST be the matching collector. `PaymentInfo` is the same struct in both deployments, including `minFeeBps` / `maxFeeBps`. What differs is the submitted fee on `charge` and `capture`: v1.1 takes an absolute `feeAmount` in atomic units; v1.0 takes `feeBps`. See [Fee system](#fee-system). `PERMIT2_ADDRESS` is the canonical [Uniswap Permit2 contract](https://docs.uniswap.org/contracts/v4/deployments) in both cases.

## Client payment payload

The client signs one token authorization and sends it with a fresh random 32-byte value. From that plus the payment requirements, the facilitator reconstructs the whole `PaymentInfo` with no stored state of its own, field by field as the [PaymentInfo struct](#paymentinfo-struct) appendix sets out. Whether the payload settles as an `authorize` or a `charge` follows from `extra.paymentFlow`, so the client names no operation of its own.

The collect payload always carries `salt`, which is `PaymentInfo.salt`. It is **unbound** when `receiverAuthorizer` and `policy` are both absent or zero, and **bound** when either is non-zero, in which case it **adds** `saltNonce`, the client's random contribution to the commitment in `salt`. See [Payment identity](#payment-identity).

`salt` and `saltNonce` are 0x-prefixed 32-byte hex strings on the wire, zero-padded to their full width, and are the `uint256` those 32 bytes denote wherever the scheme hashes or encodes them. The same spelling applies to `paymentInfo.salt` on a [lifecycle payload](#lifecycle-payloads). Pinning one spelling matters because the value is also a database key for async servers: `"0x1"` and `"0x00…01"` are one `uint256` but two distinct strings.

### EIP-3009 (default)

Unbound (scheme v1.0 wire):

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/resource", "method": "GET" },
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "authorization": {
      "from": "0xPayerAddress",
      "to": "0xEIP3009TokenCollectorAddress",
      "value": "1000000",
      "validAfter": "0",
      "validBefore": "1740675754",
      "nonce": "0xf374...3480"
    },
    "signature": "0x2d6a...571c",
    "salt": "0x0000000000000000000000000000000000000000000000000000000000000abc"
  }
}
```

Bound — same envelope, `salt` is the commitment and `saltNonce` is added beside it:

```json
{
  "payload": {
    "authorization": { "...": "..." },
    "signature": "0x2d6a...571c",
    "salt": "0x1f0e...9c3a",
    "saltNonce": "0x0000000000000000000000000000000000000000000000000000000000000abc"
  }
}
```


| Payload field               | Derived from                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `authorization.from`        | Client's own address                                                                                 |
| `authorization.to`          | `EIP3009_TOKEN_COLLECTOR_ADDRESS` of the [resolved deployment](#commerce-payments-deployments) |
| `authorization.value`       | `requirements.amount`                                                                                |
| `authorization.validAfter`  | `0` — the token collector hardcodes the lower bound                                                  |
| `authorization.validBefore` | `now + requirements.maxTimeoutSeconds`, which is also `PaymentInfo.preApprovalExpiry`                |
| `authorization.nonce`       | The payment's `signatureNonce`, see [Payment identity](#payment-identity)                            |
| `salt`                      | Always. `PaymentInfo.salt`: the client's random 32 bytes when unbound, or the keccak commitment when bound |
| `saltNonce`                 | Bound only, **added**. Fresh 32 random bytes, one of the values hashed into that commitment; see [Payment identity](#payment-identity) |
| EIP-712 domain              | `{ name, version }` from `extra`; `chainId` from `network`; `verifyingContract = requirements.asset` |


### Permit2

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/resource", "method": "GET" },
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "permit2Authorization": {
      "from": "0xPayerAddress",
      "permitted": {
        "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "1000000"
      },
      "spender": "0xPermit2TokenCollectorAddress",
      "nonce": "110210486920734568342928534950928740912034856789012345678901234567890123456789",
      "deadline": "1740675754"
    },
    "signature": "0x2d6a...571c",
    "salt": "0x0000000000000000000000000000000000000000000000000000000000000abc"
  }
}
```


| Payload field                           | Derived from                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `permit2Authorization.from`             | Client's own address                                                                     |
| `permit2Authorization.permitted.token`  | `requirements.asset`                                                                     |
| `permit2Authorization.permitted.amount` | `requirements.amount`                                                                    |
| `permit2Authorization.spender`          | `PERMIT2_TOKEN_COLLECTOR_ADDRESS` of the [resolved deployment](#commerce-payments-deployments) |
| `permit2Authorization.nonce`            | The payment's `signatureNonce` as a `uint256`, see [Payment identity](#payment-identity) |
| `permit2Authorization.deadline`         | `now + requirements.maxTimeoutSeconds`, which is also `PaymentInfo.preApprovalExpiry`    |
| `salt` / `saltNonce`                    | `salt` always (`PaymentInfo.salt`); `saltNonce` added when bound, as for EIP-3009        |
| EIP-712 domain                          | Canonical Permit2 contract; `chainId` from `network`                                     |


No witness struct is needed: the receiver is bound through the deterministic nonce.

### Payment identity

Treat absent `receiverAuthorizer` and `policy` as the zero address. `payload.salt` is always `PaymentInfo.salt`. When the bind is on, `payload.saltNonce` is **added** as the client's contribution to it:

```
# unbound — both addresses zero
payload.salt = PaymentInfo.salt                    # client's random 32 bytes
# no saltNonce

# bound — receiverAuthorizer and/or policy non-zero
payload.saltNonce                                  # client's random 32 bytes
payload.salt = PaymentInfo.salt
             = uint256(keccak256(abi.encode(SALT_BINDING_TYPEHASH, receiverAuthorizer, policy, saltNonce)))

SALT_BINDING_TYPEHASH = keccak256("x402AuthCaptureSaltBinding(address receiverAuthorizer,address policy,uint256 saltNonce)")
```

Unbound is the v1.0 collect path: the wire `salt` is the onchain salt. Bound is a commitment to the two addresses that govern facilitator-relayed `charge` and lifecycle. The keccak is one-way — `PaymentInfo.salt` does not contain those addresses — so the payload **adds** `saltNonce` beside `salt`, never in place of it. Reopening the commitment means recomputing the hash over all four encoded words, taking the addresses from `extra` and the nonce from `payload.saltNonce`, and requiring the result to equal `payload.salt`, and, for `"policy"`, passing `saltNonce` into the operator ABI. Reconstructing `PaymentInfo` from `payload.salt` matches the signature nonce; this extra check is what proves the embedding, so a collected bound payment cannot be re-pointed at a different authorizer or policy. Async servers MUST persist `saltNonce` with `paymentInfo` whenever the bind is on; `paymentInfo` alone is not enough to re-check the bind or to call the policy operator.

`SALT_BINDING_TYPEHASH` is a domain tag, and it is REQUIRED. Without it the commitment would be an untagged three-word keccak, the same shape as the `signatureNonce` encoding below, and nothing would establish that a value produced as one can never be read as the other. It also names the derivation, so the four encoded words — the typehash, both addresses, and the nonce — are the whole preimage and there is no shorter one. Encode them as four left-padded 32-byte words with `abi.encode`, never `abi.encodePacked`.

Two hashes derive from the struct, and they are not interchangeable:

```
payerAgnosticHash = keccak256(abi.encode(PAYMENT_INFO_TYPEHASH, paymentInfo with payer = address(0)))
signatureNonce    = keccak256(abi.encode(chainId, AUTH_CAPTURE_ESCROW_ADDRESS, payerAgnosticHash))

paymentInfoHash   = AuthCaptureEscrow.getHash(paymentInfo)
```

`AUTH_CAPTURE_ESCROW_ADDRESS` here is the [resolved deployment](#commerce-payments-deployments)'s escrow. `signatureNonce` is the nonce inside the client's token authorization, computed with `payer` zeroed and every other field holding the value it will have onchain. `paymentInfoHash` is the escrow's canonical payment identifier, computed over the real payer; it keys the escrow's `paymentState` and appears in every authorizer signature. Both commit to the chain id and the escrow address, so neither crosses chains or deployments.

The client's random 32 bytes (`payload.salt` when unbound, `payload.saltNonce` when bound) are what keep `signatureNonce` fresh: two payers signing concurrently, or one payer buying the same resource twice, produce distinct nonces with no collision risk.

### Smart-wallet signatures

A payer MAY be a contract account, so a facilitator MUST verify all three signature forms rather than ECDSA alone: a 65-byte ECDSA signature recovered against the payload's `from`, an ERC-1271 signature checked with `isValidSignature` on a deployed wallet, and an EIP-6492 envelope for a wallet that does not exist yet. An EIP-6492 signature carries the wallet's deployment bytecode: the facilitator extracts the inner signature to verify it, and the `ERC6492SignatureHandler` inside the token collector deploys the wallet during settlement.

A facilitator MUST submit `collectorData` with the wrapper intact. The token collector runs `ERC6492SignatureHandler` over those bytes, executes the preparation call through the neutral Multicall3 sender, and only then passes the inner signature to the token or Permit2; unwrapping first would drop the deployment. The bytes stay untrusted and payer-controlled, so a custom operator MUST forward them unchanged.

A counterfactual payer — EIP-6492 envelope, no code at the payer address yet — has no `isValidSignature` to call, so a facilitator MUST defer the signature check to the collect simulation, where the collector deploys the wallet before the token validates. An unknown preparation target can burn arbitrary gas in the facilitator's transaction, so it MUST allowlist the targets it accepts, at verify as well as settle, and reject the rest with `invalid_auth_capture_evm_erc6492_factory_not_allowed`. An empty allowlist admits none.

### Completing the payload for settlement

- `authorize` **MUST collect the full** `requirements.amount`. The server adds no amount and no `authorizerSignature`: the client's token authorization is the consent for this settle. Collecting less is destructive rather than thrifty — that authorization is single-use, so a smaller collection consumes it and permanently caps the payment below the ceiling the client agreed to.
- `charge` **requires a non-zero** `receiverAuthorizer` and **may name any** `amount` greater than zero and at most `requirements.amount`, carried alongside the submitted fee and `feeReceiver` the escrow requires whenever funds are distributed, plus an `authorizerSignature` over that exact charge. Charging less than the maximum is safe because charge is terminal: the difference simply never leaves the payer.

The charge case is the only one where the server adds fields to the client's payload. It leaves the client's own fields untouched and appends four, and the payload is always bound, because a receiver authorizer is what turns the bind on. The submitted fee field follows the [resolved deployment](#commerce-payments-deployments): `feeAmount` (atomic units, same spelling as `amount`) on v1.1, `feeBps` (`uint16`) on v1.0. A mixed group — `feeBps` on v1.1 extra, or `feeAmount` on v1.0 extra — is `invalid_auth_capture_evm_payload_format`. The default submitted fee on v1.1 is `feeAmount = amount * extra.minFeeBps / 10000`.

```json
{
  "payload": {
    "authorization": { "...": "..." },
    "signature": "0x2d6a...571c",
    "salt": "0x1f0e...9c3a",
    "saltNonce": "0x0000000000000000000000000000000000000000000000000000000000000abc",
    "amount": "750000",
    "feeAmount": "7500",
    "feeReceiver": "0xFeeRecipientAddress",
    "authorizerSignature": "0x9b1c...44ef"
  }
}
```


| Added field           | Type      | Description                                                                          |
| --------------------- | --------- | ------------------------------------------------------------------------------------ |
| `amount`              | `uint256` | The amount to charge, greater than zero and at most `requirements.amount`.           |
| `feeAmount`           | `uint256` | Fee submitted with the call on v1.1, per [Fee system](#fee-system). On a v1.0 extra pin this field is `feeBps` (`uint16`) instead. |
| `feeReceiver`         | `address` | Fee recipient submitted with the call, per [Fee system](#fee-system).                |
| `authorizerSignature` | `bytes`   | EIP-712 `Charge` signature by `extra.receiverAuthorizer` over exactly these values.  |


All four are absent on `authorize`, where the client's payload settles as it arrived.

Under `escrow` the choice of amount is postponed rather than lost: `capture` and `refund` each name their own amount and each may repeat, bounded by the hold and by the amount already captured. Holding the full ceiling is therefore costless — `capture` takes only what is owed and `void` returns the rest — while a hold set too low can never be raised.

## Authorizer signatures

`authorizerSignature` is an EIP-712 signature by `extra.receiverAuthorizer` over the parameters of the operation being requested. Both ECDSA and ERC-1271 signatures are valid, so the authorizer MAY itself be a contract. It is required on every facilitator-relayed `charge`, whatever the amount, and on lifecycle settles for `"delegated"` (and `"policy"`). It is never required on `authorize`.

The server chooses that authorizer: an address it owns — an EOA, or a contract so the signing key can rotate — or an address the facilitator advertises in [`/supported`](#supported), delegating authorization to it. Delegation applies wherever a payload carries `authorizerSignature`, `charge` and lifecycle alike: the server omits the field, and the facilitator produces the signature after authenticating the request out of band, rejecting it with `invalid_auth_capture_evm_unauthenticated_authorizer_request` when it cannot. The signature is then the facilitator's own and no longer evidence of the server's intent, so that authentication is what has to supply the evidence instead.

### Domain

Every operator type shares one domain, with the capture authorizer as `verifyingContract`:

```
{ name: "x402 Auth Capture Operator", version: "1", chainId, verifyingContract: extra.captureAuthorizer }
```

`verifyingContract` is the operator rather than one address for the whole scheme because a contract that verifies an EIP-712 signature binds its own address into the domain it checks against: an operator that does verify these digests onchain has its domain fixed by where it is deployed, and two such operators cannot share one. Neither `"delegated"` nor `"custom"` has an onchain verifier for facilitator-relayed calls, but both follow the same rule anyway, so that one formula covers every type and a signature is bound to its operator by the domain as well as by `paymentInfoHash`.

### Types

The two repeatable lifecycle operations carry the single-use element [`auth-capture`](./scheme_auth_capture.md#core-properties) requires by binding both escrow balances the authorizer expects to find. `Charge` and `Capture` include the submitted fee as the onchain argument: `uint256 feeAmount` on v1.1, `uint16 feeBps` on a v1.0 extra pin.


| Operation | Signed type (v1.1)                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `charge`  | `Charge(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash,uint256 feeAmount,address feeReceiver)`                    |
| `void`    | `Void(bytes32 paymentInfoHash)`                                                                                                                            |
| `capture` | `Capture(bytes32 paymentInfoHash,uint256 amount,uint256 feeAmount,address feeReceiver,uint256 expectedCapturableAmount,uint256 expectedRefundableAmount)`  |
| `refund`  | `Refund(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,uint256 expectedCapturableAmount,uint256 expectedRefundableAmount)`                  |


On a v1.0 extra pin, `Charge` and `Capture` use `uint16 feeBps` in place of `uint256 feeAmount`; `Void` and `Refund` are unchanged. The authorizer MUST sign the fee field that the escrow call will take. Converting `feeBps` to `feeAmount` at encode time on v1.1 is invalid: the digest would not cover the value that executes.


`collectorDataHash` is `keccak256(collectorData)`. `Refund` carries no funding address, because the escrow ABI has no such parameter: refund liquidity comes from `paymentInfo.operator` itself, as [Refund funding](#refund-funding) sets out.

Replay across payments is impossible for any type, since `paymentInfoHash` commits to every `PaymentInfo` field — the operator, and when bound the authorizer and the policy among them.

### Single-use enforcement

Before relaying a `capture` or `refund`, the facilitator reads `AuthCaptureEscrow.paymentState(paymentInfoHash)` and MUST reject the request unless both signed expectations match what it finds: `capturableAmount == expectedCapturableAmount` and `refundableAmount == expectedRefundableAmount`.

Binding both balances is required because `refundableAmount` alone is not monotonic: a capture after a refund can restore a refundable level an earlier refund signature was signed against. The pair `(capturableAmount, refundableAmount)` cannot recur once either balance has moved — after a refund, `capturable + refundable` falls and never recovers — so each signature is single-use. Partial and repeated captures each get their own signature against the snapshot they expect. No nonce is kept anywhere: the payment's own state is the replay key.

For `operatorType: "delegated"` this check runs only at the facilitator, so onchain state can still change between the check and inclusion, making the guarantee best-effort. Repeating it onchain is one of the things the appendix's `"policy"` type buys.

## Sync and async finalize

Whether the post-resource finalize runs during the paid request or afterwards is a resource-server choice. This binding publishes that choice as OPTIONAL `extra.captureMode` (`"sync"` default, or `"deferred"`) so a route can carry it through to settle time. The field is meaningful only under `paymentFlow: "escrow"` and MUST NOT appear on an `"authorization"` route.

- **Sync.** The in-request `/settle` after the resource runs is a `capture`, a partial `capture` with `void` of the remaining balance, or a `void`. No durable payment state is required.
- **Async.** That second in-request settle does not call the facilitator or broadcast a transaction. The server instead commits enough payment info into durable storage to author lifecycle settles later — at least `paymentInfo`, and when the bind is on the client `saltNonce`.

A later facilitator-relayed `refund` always requires durable state, including after a sync finalize. Both patterns are open to the types that relay lifecycle: `"delegated"` with a non-zero `receiverAuthorizer`, and the appendix's `"policy"` type.

The collect-only cases — `"custom"`, and `"delegated"` with no receiver authorizer — are async only, since lifecycle always runs out of band against the stored payment. A resource server MUST NOT publish `captureMode: "sync"` on one of those routes, and because `"sync"` is the default it MUST write `"deferred"` out rather than leave the field off. A route that gets this wrong strands the payment: the collect escrows the payer's funds, the after-handler `capture` or `void` is refused with `invalid_auth_capture_evm_lifecycle_not_relayed` since the facilitator relays no lifecycle for these types, and the hold then sits until the payer calls `reclaim` after the capture deadline.

## Lifecycle payloads

`capture`, `void`, and `refund` have no client payload to build on, so the resource server authors them outright and passes them to `POST /settle` with `payload.type` naming the operation. `payload.type` appears only on these three; nothing else in the scheme carries it. Each payload gives the payment as the exact `paymentInfo` struct the onchain call takes, rather than leaving the facilitator to reconstruct it.

They apply only where the facilitator relays lifecycle: `operatorType: "delegated"` with a non-zero `receiverAuthorizer`, and the appendix's `"policy"` type. The collect-only cases run lifecycle out of band and MUST NOT submit these payloads to the facilitator.

Two fields share the name `feeReceiver` without being the same thing: `paymentInfo.feeReceiver` is the recipient the client committed to, and `payload.feeReceiver` is the one submitted with the call. See [Fee system](#fee-system) for when they may differ.

Lifecycle payloads are bind-on: they carry `saltNonce` next to `paymentInfo.salt` (the commitment) so the facilitator can reopen the embedding.

### `capture`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "capture",
    "paymentInfo": {
      "operator": "0xOperatorAddress",
      "payer": "0xPayerAddress",
      "receiver": "0xReceiverAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxAmount": "1000000",
      "preApprovalExpiry": 1740675754,
      "authorizationExpiry": 1740758554,
      "refundExpiry": 1741276954,
      "minFeeBps": 100,
      "maxFeeBps": 100,
      "feeReceiver": "0xFeeRecipientAddress",
      "salt": "0x1f0e...9c3a"
    },
    "saltNonce": "0x0000000000000000000000000000000000000000000000000000000000000abc",
    "amount": "750000",
    "feeAmount": "7500",
    "feeReceiver": "0xFeeRecipientAddress",
    "expectedCapturableAmount": "1000000",
    "expectedRefundableAmount": "0",
    "authorizerSignature": "0x9b1c...44ef",
    "voidAuthorizerSignature": "0x7a2d...18c0"
  }
}
```

`expectedCapturableAmount` and `expectedRefundableAmount` are REQUIRED.

`voidAuthorizerSignature` is OPTIONAL and present only for a sync partial close-out: when set, this single `/settle` performs `capture` and then `void` on the remaining hold. It is the `Void` digest for the same `paymentInfoHash`, verified like a standalone `void`. The capture leg uses the same single-use balance check as a capture-only settle; the following `void` needs no replay key of its own. Omit it for a capture-only settle (full capture, or a partial that leaves the hold for later).

### `void`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "void",
    "paymentInfo": { "...": "..." },
    "saltNonce": "0x0000000000000000000000000000000000000000000000000000000000000abc",
    "authorizerSignature": "0x9b1c...44ef"
  }
}
```

### `refund`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "refund",
    "paymentInfo": { "...": "..." },
    "saltNonce": "0x0000000000000000000000000000000000000000000000000000000000000abc",
    "amount": "250000",
    "expectedCapturableAmount": "250000",
    "expectedRefundableAmount": "750000",
    "authorizerSignature": "0x9b1c...44ef"
  }
}
```

`expectedCapturableAmount` and `expectedRefundableAmount` are REQUIRED. The token collector is always `OPERATOR_REFUND_COLLECTOR_ADDRESS`, so it is not carried on the wire.

## Verification

### Client payment payload

The operation is `authorize` or `charge` according to `extra.paymentFlow`, which defaults to `"escrow"` when omitted. A resource server first sends the client-authored payload to `/verify`; for `charge`, that initial payload omits the four server-authored completion fields. Before `/settle`, the server adds all four fields from [Completing the payload for settlement](#completing-the-payload-for-settlement). A facilitator MUST accept the raw form at `/verify`, but MUST require the completed form at `/settle`. It performs these checks in order:

1. **Shape guard**: the payload matches the EIP-3009 or Permit2 shape above, with `signature` and `salt` always present, and `saltNonce` present if and only if the bind is on. A completed `charge` carries `amount`, the deployment's fee field (`feeAmount` on v1.1, `feeBps` on a v1.0 extra pin), `feeReceiver`, and `authorizerSignature` together — the last omitted only when the authorizer is delegated to the facilitator — while the raw `/verify` form and every `authorize` carry none of the four. Any partial group is invalid, a mixed fee field for the resolved deployment is invalid, and `/settle` rejects a `charge` that still has none. A server that nonce-probes for v1.0 clients is the one exception to the `saltNonce` rule, accepting a bound payment whose `saltNonce` is absent under [Compatibility with v1.0](#compatibility-with-v10).
2. **Scheme match**: `requirements.scheme` and `payload.accepted.scheme` are both `auth-capture`.
3. **Network match**: `payload.accepted.network === requirements.network`, in `eip155:<chainId>` form.
4. **Extra validation**: `requirements.extra` carries `captureAuthorizer`, `captureDeadline`, `refundDeadline`, `feeRecipient`, `minFeeBps`, `maxFeeBps`, `name`, and `version`; `extra.authCaptureEscrow` is absent or one of the two canonical escrow addresses in [Commerce-payments deployments](#commerce-payments-deployments); resolved `paymentFlow` is one of the two defined values, and the fee fields satisfy [Fee system](#fee-system).
5. **Operator**: `extra.operatorType`, `extra.policy`, and `extra.receiverAuthorizer` pass the validation in [Operator types](#validation-before-relaying).
6. **Method routing**: `extra.assetTransferMethod` (default `"eip3009"`) matches the payload shape.
7. **Deadline ordering**: `refundDeadline >= captureDeadline`, `now + maxTimeoutSeconds <= captureDeadline` so the whole window a client may sign for fits inside the hold, `captureDeadline > now + 6s` (the 6s figure is a floor; implementations MAY use a larger skew), and `validBefore` (EIP-3009) or `deadline` (Permit2) `<= captureDeadline`.
8. **Time window**: `validBefore` / `deadline` `> now + 6s` (floor, as in step 7), and `validAfter <= now` (EIP-3009 only).
9. **Collector match**: `authorization.to === EIP3009_TOKEN_COLLECTOR_ADDRESS`, or `permit2Authorization.spender === PERMIT2_TOKEN_COLLECTOR_ADDRESS`, using the collectors of the [resolved deployment](#commerce-payments-deployments). Do not read a collector from `extra`.
10. **Token match**: `permitted.token === requirements.asset` (Permit2 only; EIP-3009 binds the token through its signing domain).
11. **Client signature**: verify the signature over the `ReceiveWithAuthorization` or `PermitTransferFrom` digest against the `from` address the payload names, which is the payer. ECDSA, ERC-1271, and EIP-6492 signatures are all valid and a facilitator MUST accept all three, as [Smart-wallet signatures](#smart-wallet-signatures) sets out. For a counterfactual payer this check moves to the simulation in step 15; the allowlist gate on the preparation target replaces it here.
12. **Amount and fee**: `authorization.value` or `permitted.amount` equals `requirements.amount`; `authorize` settles that full amount. A completed `charge` requires `0 < payload.amount <= requirements.amount`, and its submitted fee (`feeAmount` on v1.1, `feeBps` on a v1.0 extra pin) and `feeReceiver` satisfy [Fee system](#fee-system). For raw `/verify`, use `requirements.amount` and the default fee terms as provisional simulation inputs.
13. **Nonce match**: reconstruct `PaymentInfo` from `extra`, `payload.salt` as `PaymentInfo.salt`, the payer, and the requirements; recompute `signatureNonce` and assert it equals the nonce on the wire. When bound, also require `payload.salt == uint256(keccak256(abi.encode(SALT_BINDING_TYPEHASH, receiverAuthorizer, policy, saltNonce)))`. This transitively enforces equality on every field encoded in `PaymentInfo` — receiver, token, deadlines, fee bounds, fee recipient, operator, and when bound the receiver authorizer and policy — so none of them needs a check of its own.
14. **Authorizer signature** (completed `charge` only): the `Charge` signature recovers to the required non-zero `extra.receiverAuthorizer`, whatever the amount, or the facilitator produces it under the delegation rule in [Authorizer signatures](#authorizer-signatures). Skip for `authorize` and the raw `/verify` form; `/settle` cannot use that raw form.
15. **Simulate** the settlement call and require success. Raw charge verification simulates the provisional full-amount charge from step 12; settlement re-verification simulates the exact authorizer-signed charge it will submit.

Step 15 is materially heavier on RPC for `operatorType: "custom"` than for `"delegated"`, which simulates a single escrow call: the custom outcome assertions in [`/supported`](#supported) need the operator's token store and the pre- and post-call state around the relay.

### Lifecycle payloads

Lifecycle payloads apply only to `operatorType: "delegated"` with a non-zero `receiverAuthorizer`. For `operatorType: "custom"`, and for `"delegated"` without a receiver authorizer, the facilitator MUST reject the request with `invalid_auth_capture_evm_lifecycle_not_relayed` without further checks.

`capture` and `void` additionally require `paymentFlow: "escrow"`. The `"authorization"` flow settles the client's payload as a terminal `charge` and places no hold, so there is nothing to capture or release, and a payload naming either MUST be rejected with `invalid_auth_capture_evm_payload_type`. `refund` applies to both flows.

For an admitted lifecycle payload, the facilitator repeats the scheme, network, extra, and operator checks (2 through 5 above), and then:

1. **Operator match**: `payload.paymentInfo.operator === extra.captureAuthorizer`.
2. **Salt binding**: `payload.paymentInfo.salt === uint256(keccak256(abi.encode(SALT_BINDING_TYPEHASH, extra.receiverAuthorizer, extra.policy, payload.saltNonce)))`. There is no client signature here to enforce this transitively, so it is an explicit check.
3. **Requirements match**: every remaining `paymentInfo` field equals what `extra` and the top-level requirements dictate.
4. **Authorizer signature**: the operation's signature recovers to `extra.receiverAuthorizer`, or the facilitator produces it under the delegation rule in [Authorizer signatures](#authorizer-signatures).
5. `voidAuthorizerSignature` (capture only): if present, it MUST recover to `extra.receiverAuthorizer` over the `Void` digest, and it falls under the same delegation rule as step 4. It MUST NOT appear on `void` or `refund` payloads.
6. **Operation preconditions**, read from `AuthCaptureEscrow.paymentState(paymentInfoHash)` and `paymentInfo`:

   | Operation | Preconditions                                                                                                                                          |
   | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `capture` | `now < authorizationExpiry`; `0 < amount <= capturableAmount`; fee parameters per [Fee system](#fee-system); the single-use balance check              |
   | `void`    | `capturableAmount > 0`                                                                                                                                 |
   | `refund`  | `now < refundExpiry`; `0 < amount <= refundableAmount`; the single-use balance check; refund liquidity available per [Refund funding](#refund-funding) |

   When `voidAuthorizerSignature` is present, apply the `capture` row to `payload.amount`, and require `amount < capturableAmount` so a hold remains for `void` (a full capture omits the field). Simulation covers both legs.

7. **Simulate** the settlement call and require success.

`reclaim` is out of scope for the facilitator: the escrow restricts it to `paymentInfo.payer`, so it can only be called by the client and needs no operator ABI. Out-of-band lifecycle is likewise out of scope, submitted straight to the operator.

## Settlement

1. **Re-verify** the payload, requiring the completed charge form and catching anything that expired or was consumed since verification.
2. **Resolve the target**: the resolved `AUTH_CAPTURE_ESCROW_ADDRESS` for `operatorType: "delegated"`, `extra.captureAuthorizer` for `"custom"`.
3. **Encode the call** for the operation, which is `payload.type` on a lifecycle payload and `extra.paymentFlow`'s implied `authorize` or `charge` on a client payload. For `authorize` and `charge`, resolve the collector from `extra.assetTransferMethod` and the [resolved deployment](#commerce-payments-deployments), and set `collectorData` to the raw ERC-3009 signature or the ABI-encoded Permit2 signature; `authorize` passes `requirements.amount`, and `charge` passes the authorizer-signed payload's `amount`, submitted fee (`feeAmount` on v1.1, `feeBps` on a v1.0 extra pin), and `feeReceiver` with no conversion between the two. For `refund`, the collector is `OPERATOR_REFUND_COLLECTOR_ADDRESS` with empty `collectorData`.
4. **Capture-and-void**: when `payload.type` is `"capture"` and `voidAuthorizerSignature` is present, drive both legs from this single `/settle`: encode `capture` as above, then `void` with that signature. Submit them in one transaction when the target allows — any batched path the facilitator controls for `"delegated"` — and otherwise as two transactions still under this one request. If a race empties the hold between capture and void, skip `void` and treat the settle as capture-only success.
5. **Submit**, wait up to 60 s for the receipt, and confirm the transaction succeeded onchain.
6. **Return** the transaction hash, network, payer, and the amount settled (the captured amount; void releases the rest without changing that figure).

## Refund funding

Facilitator-relayed refunds use `OperatorRefundCollector`, which pulls the refunded tokens from `paymentInfo.operator`. What that implies differs per type:

- `"delegated"` — the operator is an address the facilitator submits from, which would make the facilitator a source of value. A facilitator MUST reject `type: "refund"` for a `"delegated"` operator unless it has an explicit out-of-band funding agreement with the receiver, and MUST authorize the request against that agreement rather than against the authorizer signature, which here amounts to the receiver approving a spend of someone else's money.
- `"custom"` — the facilitator does not relay refunds. How a `"custom"` operator sources refund liquidity is that operator's business, settled out of band.

## `/supported`

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "auth-capture",
      "network": "eip155:8453",
      "extra": {
        "captureAuthorizer": "0xFacilitatorSubmitterAddress",
        "receiverAuthorizer": "0xFacilitatorAuthorizerAddress",
        "feeRecipient": "0xFeeRecipientAddress",
        "minFeeBps": 100,
        "maxFeeBps": 100,
        "operators": [
          { "address": "*", "operatorType": "custom" }
        ]
      }
    }
  ],
  "extensions": [],
  "signers": { "eip155:*": ["0xFacilitatorSignerAddress"] }
}
```

- `signers` is the authoritative set of addresses the facilitator submits transactions from. A smart-contract account the facilitator submits from MAY appear here. It is not where a server reads `extra.captureAuthorizer`: `signers` is response-level and family-keyed, while submitter sets are not in general uniform across the chains a facilitator serves.
- `extra.captureAuthorizer` is the address the facilitator commits to submitting from on this network. It is REQUIRED unless `extra.operators` is non-empty, which is the relay-only case where the facilitator never acts as operator itself: a kind without it admits nothing but `operatorType: "delegated"`, and a server has no other source for the submitter address, so a kind carrying neither is malformed. A server using that kind for `operatorType: "delegated"` copies it verbatim into its payment requirements. A facilitator that advertises a `captureAuthorizer` MUST submit `"delegated"` calls from it. A facilitator MAY vary which submitter it advertises between `/supported` responses to spread load across its keys. Because the address is committed onchain as `PaymentInfo.operator` and is the only address the escrow accepts for that payment's `capture`, `void`, and `refund`, a facilitator MUST remain able to submit from an address it has advertised until every payment that used it has passed its `refundDeadline`. Retiring a submitter earlier strands outstanding holds: nothing can capture or void them, and the payer recovers the funds only by calling `reclaim` after the capture deadline. A facilitator that rotates submitters and also relays `type: "refund"` for `"delegated"` MUST fund and approve **every** address in the rotation, since `OperatorRefundCollector` pulls with `safeTransferFrom(token, PaymentInfo.operator, tokenStore, amount)`.
- `extra.receiverAuthorizer` is OPTIONAL: an address the facilitator will sign with on a server's behalf, which a server MAY adopt in place of an authorizer it owns under [Authorizer signatures](#authorizer-signatures). A facilitator MUST NOT advertise one unless it can authenticate those requests out of band, for example with SIWX, a JWT, or an API credential bound at payment creation. A payment commits to both addresses — `receiverAuthorizer` through the salt, `captureAuthorizer` as `PaymentInfo.operator` — so one that delegates both is captive to this facilitator until its `refundDeadline`, and a server changing facilitators SHOULD let outstanding payments finalize first.
- `extra.feeRecipient`, `extra.minFeeBps`, and `extra.maxFeeBps` are OPTIONAL facilitator fee terms. A server using that supported kind MUST copy all three verbatim into its payment requirements. Equal bounds fix the fee and are what a facilitator SHOULD advertise; unequal bounds ask the server to grant free choice up to `maxFeeBps`, since nothing onchain holds the facilitator to a narrower value. Omission means the facilitator claims no fee, and a `"delegated"` server publishes zero bounds per [Fee system](#fee-system).
- `extra.operators` is an OPTIONAL allowlist of the contract operators the facilitator will relay for, each entry pairing an address with the type it is admitted as. Omitted or `[]` admits no contract operator at all, leaving only `operatorType: "delegated"` with the facilitator's own submitter. `"address": "*"` admits every contract of that type; the wildcard MUST be written out, and an empty list MUST NOT be read as one. A facilitator MAY advertise the wildcard, but it is not recommended: admission then extends to contract code the facilitator has never reviewed, bounded only by the requirements below.

A facilitator that offers `"custom"` is relaying into contract code and MUST:

1. **Cap the gas.** The simulated and submitted calls MUST use a gas limit chosen by the facilitator, so an operator cannot drain its gas budget.
2. **Assert the outcome, not the absence of a revert.** Before relaying, the facilitator MUST simulate the exact call and confirm that the canonical escrow of the [resolved deployment](#commerce-payments-deployments) emitted the expected `PaymentAuthorized` or `PaymentCharged` event with the expected payment hash and arguments (`feeAmount` on v1.1 `PaymentCharged`, `feeBps` on v1.0), that `paymentState` made the exact intended before-to-after transition, and that the net token movements match the operation. A successful top-level operator call alone is insufficient. No token movement may originate from a facilitator-controlled address.

The simulation RPC MUST expose nested-call logs and enough pre- and post-call state to establish those conditions, whether through state diffs or stateful follow-up reads. A facilitator without access to those capabilities MUST NOT advertise or accept `"custom"`. After the transaction is confirmed, the facilitator MUST apply the same outcome checks to the actual receipt and resulting onchain state before reporting settlement success; a successful receipt status alone is insufficient.

Admission is by address, not by code: an operator behind a proxy can change implementation after it is admitted. A facilitator SHOULD prefer immutable operators, and MUST apply the assertions above on every relay rather than resting on a review.

## Error Codes

The scheme uses the standard x402 error codes plus the following. Every reason this binding defines is namespaced `invalid_auth_capture_evm_*`; standard reasons it also returns, such as `invalid_network`, keep their canonical names.

### Verification errors


| Error Code                                                   | Description                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_auth_capture_evm_payload_format`                    | Payload matches neither the EIP-3009 nor the Permit2 shape, omits `salt`, omits `saltNonce` when bound (unless probing), carries it unbound, or carries the wrong fee field for the resolved deployment (`feeBps` on v1.1 extra, or `feeAmount` on a v1.0 extra pin). |
| `invalid_auth_capture_evm_payload_type`                      | A lifecycle payload's `payload.type` is missing or is not `"capture"`, `"void"`, or `"refund"`.                                                      |
| `invalid_auth_capture_evm_void_authorizer_signature`         | `voidAuthorizerSignature` is present on a non-capture payload, or does not recover to `extra.receiverAuthorizer` over the `Void` digest.             |
| `invalid_auth_capture_evm_void_remainder_full_capture`       | `voidAuthorizerSignature` is present but `amount` equals the full `capturableAmount`, leaving nothing to void.                                       |
| `invalid_auth_capture_evm_unsupported_payment_flow`          | Resolved `paymentFlow` is neither `"escrow"` nor `"authorization"`, or `extra` carries the removed `autoCapture: true`.                              |
| `invalid_auth_capture_evm_scheme`                            | Scheme is not `auth-capture`.                                                                                                                        |
| `invalid_auth_capture_evm_network_mismatch`                  | Payload network does not match requirements.                                                                                                         |
| `invalid_network`                                            | Network format is not `eip155:<chainId>`.                                                                                                            |
| `invalid_auth_capture_evm_extra`                             | Extra is missing required fields, `authCaptureEscrow` is not a canonical escrow address, or its fee fields violate [Fee system](#fee-system).       |
| `invalid_auth_capture_evm_missing_receiver_authorizer`       | `extra.receiverAuthorizer` is absent or zero for a `charge` or facilitator-relayed lifecycle settle.                                                |
| `invalid_auth_capture_evm_unsupported_operator_type`         | `extra.operatorType` is an unknown value, or a type the facilitator does not implement.                                                              |
| `invalid_auth_capture_evm_policy`                            | `extra.policy` does not fit the declared operator type: non-zero where the zero address is required, or not a policy contract where one is expected. |
| `invalid_auth_capture_evm_lifecycle_not_relayed`             | A lifecycle payload (`capture`, `void`, or `refund`) was submitted for `operatorType: "custom"`, or for `"delegated"` without a receiver authorizer. |
| `invalid_auth_capture_evm_operator_type_mismatch`            | `extra.captureAuthorizer` does not expose the collect wrappers `"custom"` / `"policy"` requires.                                                     |
| `invalid_auth_capture_evm_operator_not_admitted`             | The operator is not on the facilitator's allowlist, or `"delegated"` names an address it does not control and submit from.                           |
| `invalid_auth_capture_evm_operator_mismatch`                 | `paymentInfo.operator` does not match `extra.captureAuthorizer`.                                                                                     |
| `invalid_auth_capture_evm_salt_binding_mismatch`             | Bound `paymentInfo.salt` is not the salt derived from `receiverAuthorizer`, `policy`, and `saltNonce`.                                            |
| `invalid_auth_capture_evm_authorizer_signature`              | The authorizer signature does not recover to `extra.receiverAuthorizer`.                                                                             |
| `invalid_auth_capture_evm_unauthenticated_authorizer_request` | The authorizer is delegated to the facilitator and the `charge` or lifecycle request carries no out-of-band authentication.                         |
| `invalid_auth_capture_evm_unexpected_payment_state`          | Observed `capturableAmount` or `refundableAmount` differs from the signed expectation.                                                               |
| `invalid_auth_capture_evm_refund_funding_unavailable`        | No refund liquidity path exists for the declared operator type.                                                                                      |
| `invalid_auth_capture_evm_unsupported_asset_transfer_method` | `assetTransferMethod` is neither `"eip3009"` nor `"permit2"`.                                                                                        |
| `invalid_auth_capture_evm_payload_method_mismatch`           | Payload shape does not match `assetTransferMethod`.                                                                                                  |
| `invalid_auth_capture_evm_capture_deadline_expired`          | `captureDeadline <= now + 6s` (floor), or a capture was attempted after it.                                                                          |
| `invalid_auth_capture_evm_refund_deadline_expired`           | A refund was attempted at or after `refundDeadline`.                                                                                                 |
| `invalid_auth_capture_evm_deadline_ordering`                 | Deadlines violate `now + maxTimeoutSeconds <= captureDeadline <= refundDeadline`.                                                                    |
| `invalid_auth_capture_evm_authorization_expired`             | EIP-3009 `validBefore` or Permit2 `deadline` is `<= now + 6s` (floor).                                                                               |
| `invalid_auth_capture_evm_authorization_not_yet_valid`       | EIP-3009 `validAfter > now`.                                                                                                                         |
| `invalid_auth_capture_evm_signature`                         | Client signature verification failed.                                                                                                                |
| `invalid_auth_capture_evm_erc6492_factory_not_allowed`       | The payer is counterfactual and its EIP-6492 preparation target is not on the facilitator's allowlist.                                               |
| `invalid_auth_capture_evm_amount_mismatch`                   | Authorization value does not match `requirements.amount`.                                                                                            |
| `invalid_auth_capture_evm_token_collector_mismatch`          | `to` or `spender` is not the expected collector for the method.                                                                                      |
| `invalid_auth_capture_evm_token_mismatch`                    | Permit2 `permitted.token` does not match `requirements.asset`.                                                                                       |
| `invalid_auth_capture_evm_nonce_mismatch`                    | Wire nonce does not match the recomputed `signatureNonce`.                                                                                           |
| `invalid_auth_capture_evm_insufficient_balance`              | Payer balance is below the required amount.                                                                                                          |
| `invalid_auth_capture_evm_simulation_failed`                 | Simulation reverted with an unmapped error.                                                                                                          |


### Typed simulation reverts

When simulation reverts with a custom error declared in the call's ABI, the facilitator decodes it and surfaces a stable reason instead of the opaque `invalid_auth_capture_evm_simulation_failed` fallback.

`AuthCaptureEscrow` errors:


| Custom error                    | `invalidReason`                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `AfterPreApprovalExpiry`        | `invalid_auth_capture_evm_authorization_expired`                                        |
| `InvalidExpiries`               | `invalid_auth_capture_evm_deadline_ordering`                                            |
| `ExceedsMaxAmount`              | `invalid_auth_capture_evm_amount_mismatch`                                              |
| `PaymentAlreadyCollected`       | `invalid_auth_capture_evm_payment_already_collected`                                    |
| `TokenCollectionFailed`         | `invalid_auth_capture_evm_token_collection_failed`                                      |
| `InvalidCollectorForOperation`  | `invalid_auth_capture_evm_collector`                                                    |
| `InvalidSender`                 | `invalid_auth_capture_evm_operator_mismatch`                                            |
| `ZeroAmount` / `AmountOverflow` | `invalid_auth_capture_evm_amount_mismatch` / `invalid_auth_capture_evm_amount_overflow` |
| `FeeBpsOverflow`                | `invalid_auth_capture_evm_fee_bps`                                                      |
| `InvalidFeeBpsRange`            | `invalid_auth_capture_evm_fee_bps_range`                                                |
| `FeeBpsOutOfRange`              | `invalid_auth_capture_evm_fee_bps_out_of_range`                                         |
| `FeeAmountOutOfRange`           | `invalid_auth_capture_evm_fee_bps_out_of_range`                                         |
| `ZeroFeeReceiver`               | `invalid_auth_capture_evm_zero_fee_receiver`                                            |
| `InvalidFeeReceiver`            | `invalid_auth_capture_evm_fee_receiver`                                                 |
| `AfterAuthorizationExpiry`      | `invalid_auth_capture_evm_capture_deadline_expired`                                     |
| `InsufficientAuthorization`     | `invalid_auth_capture_evm_insufficient_authorization`                                   |
| `ZeroAuthorization`             | `invalid_auth_capture_evm_zero_authorization`                                           |
| `AfterRefundExpiry`             | `invalid_auth_capture_evm_refund_deadline_expired`                                      |
| `RefundExceedsCapture`          | `invalid_auth_capture_evm_refund_exceeds_capture`                                       |


### Settlement errors


| Error Code                                      | Description                                      |
| ----------------------------------------------- | ------------------------------------------------ |
| `invalid_auth_capture_evm_verification_failed`  | Re-verification before settlement failed.        |
| `invalid_auth_capture_evm_transaction_reverted` | Onchain transaction reverted after confirmation. |


## Appendix

### PaymentInfo struct

The struct keeps its canonical Solidity names rather than the names the same values carry on the wire, so that its EIP-712 typehash matches the `AuthCaptureEscrow` contract byte-for-byte. Every field, and where the facilitator gets it:

```solidity
struct PaymentInfo {
    address operator;            // = extra.captureAuthorizer
    address payer;               // = the payload's `from`, verified against the client's signature
    address receiver;            // = requirements.payTo
    address token;               // = requirements.asset
    uint120 maxAmount;           // = requirements.amount
    uint48  preApprovalExpiry;   // = now + requirements.maxTimeoutSeconds, chosen client-side
    uint48  authorizationExpiry; // = extra.captureDeadline
    uint48  refundExpiry;        // = extra.refundDeadline
    uint16  minFeeBps;           // = extra.minFeeBps
    uint16  maxFeeBps;           // = extra.maxFeeBps
    address feeReceiver;         // = extra.feeRecipient
    uint256 salt;                // = payload.salt. Unbound: client's random bytes. Bound: keccak256(SALT_BINDING_TYPEHASH, receiverAuthorizer, policy, saltNonce)
}
```

### Expiry ordering

The escrow enforces `preApprovalExpiry <= authorizationExpiry <= refundExpiry`, and each expiry gates a different operation:


| Expiry                | Enforced at                | Effect                               |
| --------------------- | -------------------------- | ------------------------------------ |
| `preApprovalExpiry`   | `authorize()` / `charge()` | Blocks collecting the client's funds |
| `authorizationExpiry` | `capture()`                | Blocks capture; enables `reclaim()`  |
| `refundExpiry`        | `refund()`                 | Blocks refunds                       |


### Fee system

`PaymentInfo.minFeeBps` and `PaymentInfo.maxFeeBps` are the client-signed bounds in both deployments, each in the range 0–10,000. They stay in basis points so each `charge` or `capture` scales its own `amount`: 100 bps of 750000 is not 100 bps of 1000000. `authorize` has no fee argument.

The submitted fee on `charge` and `capture` is the onchain argument, and that is what the authorizer signs:

- **v1.1 (default).** The call takes `uint256 feeAmount` in atomic units. The escrow requires `amount * minFeeBps / 10000 <= feeAmount <= amount * maxFeeBps / 10000`. Integer division is the escrow's. The default submitted value is `amount * minFeeBps / 10000`.
- **v1.0 extra pin.** The call takes `uint16 feeBps`. The escrow requires `minFeeBps <= feeBps <= maxFeeBps` and computes `feeAmount = amount * feeBps / 10000` itself.

In both cases the remainder after the fee goes to the receiver. If `PaymentInfo.feeReceiver` is non-zero, the submitted `feeReceiver` must equal it; if it is `address(0)`, any non-zero address is accepted. A zero `feeReceiver` with a non-zero submitted fee (`feeAmount` or `feeBps`) reverts.

Those are the guarantee. Who holds the submitter to a narrower value differs per operator type:

- `"delegated"` — the escrow's range and a non-zero `feeReceiver` are the only limits. An `authorizerSignature` over the submitted fee tells a conformant facilitator what to submit, but nothing onchain reads that signature, so the server's exposure is `maxFeeBps` whether the bind is on or off. This is the trust bound [`"delegated"`](#delegated--facilitator-is-the-operator) already states for every operation.
- `"custom"` — the operator contract is the enforcement point, so the submitter's discretion is whatever that operator leaves unchecked, within the escrow's range.
- `"policy"` — the operator verifies the authorizer's digest onchain, so the signed fee and `feeReceiver` are what executes. That binds every submitter. It binds the authorizer's own choice only where the server holds the authorizer key, or where the policy constrains the fee through the fee and `feeReceiver` its hooks receive.

A server therefore MUST read its own published bounds, not any signature, as what it has agreed to:

- **No agreed fee.** `minFeeBps == maxFeeBps == 0`, which is required unless the server has agreed fee terms with the party that ends up choosing the value: the facilitator under `"delegated"`, the operator under `"custom"`. Nothing can then be taken from any payment. The submitted fee MUST be `0`.
- **Agreed fixed fee.** `minFeeBps == maxFeeBps` at the agreed value with a non-zero `feeRecipient`, which servers SHOULD prefer: the escrow admits exactly one fee to exactly one address, so the outcome needs no trust. On v1.1 the submitted `feeAmount` MUST be `amount * that value / 10000` and the submitted `feeReceiver` MUST be `extra.feeRecipient`. On a v1.0 extra pin the submitted `feeBps` MUST be that value. For `"delegated"` these are the facilitator's `/supported` fee terms copied verbatim; for `"custom"` they come from the server's agreement with the operator.
- **Agreed range.** `minFeeBps < maxFeeBps` is permitted only where the server has agreed that range with the same party, and it grants that party free choice inside it. Publishing a range is granting the discretion, not reserving it.
- **Zero fee receiver.** A zero `PaymentInfo.feeReceiver` lets the submitter name any non-zero recipient, so under `"delegated"` and `"custom"` it MUST come with `minFeeBps == maxFeeBps == 0`. A zero fee on the submitted call is not sufficient, since the submitter can send another value within the signed range. Under `"policy"` the authorizer's signature over `feeReceiver` is verified onchain, which supplies the missing constraint.

### Compatibility with v1.0

This section is the x402 scheme v1.0 collect path (unbound salt, `autoCapture`), not the commerce-payments contract deployment. For the latter see [Commerce-payments deployments](#commerce-payments-deployments) and the paragraph below.

The unbound collect path is byte-identical to scheme v1.0: `extra.captureAuthorizer`, payload `salt`, `PaymentInfo.salt = payload.salt`. Clients MUST ignore unrecognized `extra` keys. New servers that omit `receiverAuthorizer` and `policy` remain payable by scheme-v1.0 clients that still target the same commerce deployment. New clients that treat omitted `receiverAuthorizer` / `policy` as unbound remain able to pay scheme-v1.0 servers on that deployment.

v1.0's `extra.autoCapture` is removed, and `paymentFlow` is the only flow selector. `autoCapture: false` agrees with the default and needs no handling, but a facilitator that receives `autoCapture: true` MUST reject with `invalid_auth_capture_evm_unsupported_payment_flow` rather than fall through to `"escrow"`, because settling a hold where the server asked for a terminal `charge` is a different onchain outcome and no later error would report it.

Turning the bind on (non-zero `receiverAuthorizer` or `policy`) changes `signatureNonce` and requires `saltNonce` beside `salt`. A scheme-v1.0 client then emits only `salt` (the random value, not the hash), so verification fails with `invalid_auth_capture_evm_payload_format` or `invalid_auth_capture_evm_nonce_mismatch` unless the server probes.

A server that turns the bind on while still serving scheme-v1.0 clients MAY nonce-probe: if `saltNonce` is absent, treat `payload.salt` as the nonce, recompute `signatureNonce` for the raw value and for the commitment over it, and accept whichever matches. It MUST persist the matching `uint256` (and the nonce, if any) for the life of the payment so later `capture` / `void` / `refund` reuse that salt and do not re-hash. A probed scheme-v1.0 payment is unbound onchain even though extra advertised an authorizer — the authorizer is then an HTTP check only. Pin `receiverAuthorizer` and `policy` per (`captureAuthorizer`, chain) and never rotate them mid-flight.

A scheme-v1.0 client also ignores `extra.authCaptureEscrow` and signs the collectors and escrow it was built with (the v1.0 set). It cannot pay a server that collects into the v1.1 escrow: `signatureNonce` and `authorization.to` / `permit2Authorization.spender` will not match. A new client pays a v1.0 commerce deployment if and only if `extra.authCaptureEscrow` is that v1.0 escrow; omitted extra selects v1.1. Charge and capture payloads on that pin keep `feeBps`; the v1.1 wire uses `feeAmount`.


### Future operator type: `policy`

`"delegated"` and `"custom"` sit at opposite ends of a trade-off. `"delegated"` with a receiver authorizer relays the whole lifecycle but rests on trusting the facilitator; `"custom"` needs no trust in the facilitator, but everything past collect also leaves the protocol. A third type, `operatorType: "policy"`, is a planned addition that closes the gap, and it buys two things:

1. **Trustless relay.** The operator contract, not the facilitator, is what gates the escrow. It checks the payment's binding, verifies the receiver authorizer's EIP-712 signature onchain for `charge` and lifecycle, and compares the signed balances against `paymentState` before calling the escrow. That is also what makes the signed fee and `feeReceiver` enforceable rather than advisory, so a range may be published without granting the submitter discretion over it (see [Fee system](#fee-system)). The facilitator's HTTP checks stop being the thing that protects the server: a request the facilitator would refuse also reverts when anyone else submits it directly, and a request the facilitator relays cannot deviate from what the authorizer signed.
2. **Capture and void stay in the protocol.** They remain ordinary relayed `/settle` calls even when a contract enforces conditions on them, so the server keeps the gasless, RPC-free path it has under `"delegated"` without the trust. The conditions come from a separate policy contract consulted through read-only hooks, which is what makes relaying into unreviewed policy code safe for the facilitator.

Everything this type needs on the wire already exists: `extra.operatorType: "policy"`, `extra.policy` naming the policy contract, and `PaymentInfo.salt` committing to it. Because the salt commits to the policy, the client's own signature commits to it too — a payer knows which rules govern its money before it pays, and a collected payment cannot be re-pointed at a different policy afterwards. `extra.policy` MAY be the zero address here, which selects the signature-only operator of step 1 below; `receiverAuthorizer` MUST be non-zero, so the bind is on. No payload, digest, or `extra` field changes. As with `"delegated"`, `authorize` needs no authorizer signature — only the salt-binding trailing parameters.

That authorizer MAY be delegated to the facilitator here as anywhere else, and `extra.policy` is what decides the cost. With the zero address of step 1 the operator only re-checks a signature the facilitator itself produced, which buys `"delegated"`'s trust at the price of a contract call. With a policy attached the conditions bind the authorizer too, so a server that holds no key still keeps an enforced envelope `"delegated"` has no way to offer.

#### Operator ABI

The operator implements the escrow ABI with trailing parameters appended. The facilitator relays collect and lifecycle operations the same way, targeting `extra.captureAuthorizer` in both cases.


| Operation   | Trailing parameters added to the escrow ABI                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `authorize` | `address authorizer, address policy, uint256 saltNonce`                                                       |
| `charge`    | `address authorizer, address policy, uint256 saltNonce, bytes authorizerSignature`                            |
| `void`      | `address authorizer, address policy, uint256 saltNonce, bytes authorizerSignature`                            |
| `capture`   | `address authorizer, address policy, uint256 saltNonce, ExpectedBalances expected, bytes authorizerSignature` |


`ExpectedBalances` is `(uint256 capturableAmount, uint256 refundableAmount)` — the balances the authorizer expects in `paymentState` when the call executes. The EIP-712 digests name those members `expectedCapturableAmount` and `expectedRefundableAmount`.

A `"custom"` / `"policy"` mixup on a collect call needs no separate check, because it fails closed: the misdeclared type encodes a selector the target does not implement, so simulation reverts before any gas is spent.

#### Step 1: the operator as a signature wrapper

At its simplest the operator adds nothing but the checks the facilitator was trusted to run, moved onchain. `capture` is the operation where all of them appear at once:

```solidity
function capture(
    IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
    uint256 amount,
    uint256 feeAmount,
    address feeReceiver,
    address authorizer,
    address policy,
    uint256 saltNonce,
    ExpectedBalances calldata expected,
    bytes calldata authorizerSignature
) external nonReentrant {
    // operator == address(this), authorizer != 0, policy == 0,
    // and salt == keccak256(SALT_BINDING_TYPEHASH, authorizer, policy, saltNonce)
    bytes32 paymentInfoHash = _checkBinding(paymentInfo, authorizer, policy, saltNonce);
    _checkSignature(
        authorizer, getCaptureDigest(paymentInfoHash, amount, feeAmount, feeReceiver, expected), authorizerSignature
    );
    _checkExpectedBalances(paymentInfoHash, expected);

    ESCROW.capture(paymentInfo, amount, feeAmount, feeReceiver);
}
```

The salt check is what ties `authorizer` to this payment: an attacker cannot pass an authorizer of its own choosing, because `paymentInfo.salt` was fixed by the client's signature. `_checkExpectedBalances` reads `paymentState` and reverts unless both balances equal the signed pair — the same [single-use rule](#single-use-enforcement), now enforced atomically with the call rather than best-effort ahead of it. The operator is permissionless by design: anyone may submit, and without a fresh authorizer signature nothing happens.

#### Step 2: read-only policy hooks

What the wrapper cannot express is *when* an operation is allowed — a cooldown before capture, a window in which void is still possible, a role that must sign off. Encoding any of that in the operator would mean a new operator contract per rule, each needing its own review and its own allowlist entry at every facilitator.

Instead the rule lives in a separate contract, named by `extra.policy` and consulted through `ICaptureAuthorizer`, whose predicates are `view` and return a boolean:

```solidity
    bytes32 paymentInfoHash = _checkBinding(paymentInfo, authorizer, policy, saltNonce);
    _checkSignature(
        authorizer, getCaptureDigest(paymentInfoHash, amount, feeAmount, feeReceiver, expected), authorizerSignature
    );
    if (!ICaptureAuthorizer(policy).authorizeCapture(paymentInfo, amount, feeAmount, feeReceiver, "")) {
        revert AuthorizationDenied();
    }
    _checkExpectedBalances(paymentInfoHash, expected);

    ESCROW.capture(paymentInfo, amount, feeAmount, feeReceiver);
```

This is a separate deployment with the same call ABI and a stricter binding: `_checkBinding` here requires `policy` to be non-zero and to advertise `ICaptureAuthorizer` through ERC-165, so a plain address cannot be passed off as a policy, while the step 1 operator requires `policy` to be zero.

The hooks are read-only, and that is the point for the facilitator. A `view` predicate cannot move value, cannot re-enter the escrow, and cannot leave state behind; it can only say yes or no, with gas its sole cost. The operator's own checks are unconditional and run regardless of what the policy answers — the policy is consulted *in addition to* the signature and balance checks, never instead of them. That ordering is mandatory rather than stylistic: a policy that only gates *when* an operation is permissible would otherwise let a third party force a capture the moment the window opens, or force a void and deprive the server of the payment.

One mutating hook is defined for policies that must record state when the hold is placed: `ICaptureLifecycle.onAuthorize(PaymentInfo)`, invoked only on `authorize`, only after the escrow call has succeeded, and only when the policy advertises the interface through ERC-165.

#### Step 3: an example policy

A policy is small. This one admits the `escrow` flow only and holds capture back until a cooldown past the pre-approval expiry has elapsed, giving the payer a guaranteed window in which the hold is untouchable and `void` is still the only outcome the server can force:

```solidity
contract DelayedCapturePolicy is ICaptureAuthorizer, ERC165 {
    uint48 public immutable COOLDOWN;

    constructor(
        uint48 cooldown
    ) {
        COOLDOWN = cooldown;
    }

    function authorizeCapture(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256,
        uint256,
        address,
        bytes calldata
    ) external view returns (bool) {
        return block.timestamp >= uint256(paymentInfo.preApprovalExpiry) + COOLDOWN;
    }

    // authorizeCharge returns false — a charge would settle instantly, defeating the delay.
    // authorizeAuthorization and authorizeVoid return true.

    function supportsInterface(
        bytes4 interfaceId
    ) public view override returns (bool) {
        return interfaceId == type(ICaptureAuthorizer).interfaceId || super.supportsInterface(interfaceId);
    }
}
```

Because the policy address is in the salt, this promise is verifiable by the payer at signing time and immutable afterwards. The same shape covers freeze windows, role-gated capture or void, arbitration hooks, and oracle-conditioned release — each a small `view` contract rather than a new operator.

#### Facilitator validation and errors

Validation follows the `"custom"` rules — `extra.captureAuthorizer` exposes the collect wrappers and is admitted by the facilitator's allowlist — with two changes: `capture` and `void` payloads are relayed rather than rejected, and `extra.policy`, when non-zero, MUST have deployed code and advertise `ICaptureAuthorizer` through ERC-165. A `refund` payload is rejected with `invalid_auth_capture_evm_refund_funding_unavailable`, since the operator exposes no refund entry point. Admission works the same way, with an extra `/supported` entry:

```json
{ "address": "0xOperatorAddress", "operatorType": "policy" }
```

The operator declares typed errors that a facilitator decodes from a reverted simulation:


| Custom error                      | `invalidReason`                                        |
| --------------------------------- | ------------------------------------------------------ |
| `WrongOperator`                   | `invalid_auth_capture_evm_operator_mismatch`           |
| `SaltMismatch`                    | `invalid_auth_capture_evm_salt_binding_mismatch`       |
| `ZeroAuthorizer`                  | `invalid_auth_capture_evm_missing_receiver_authorizer` |
| `InvalidSignature`                | `invalid_auth_capture_evm_authorizer_signature`        |
| `UnexpectedPaymentState`          | `invalid_auth_capture_evm_unexpected_payment_state`    |
| `InvalidPolicy` / `NonZeroPolicy` | `invalid_auth_capture_evm_policy`                      |
| `AuthorizationDenied`             | `invalid_auth_capture_evm_policy_denied`               |


### Contract addresses

The two canonical CREATE2 sets, and how `extra.authCaptureEscrow` selects between them, are in [Commerce-payments deployments](#commerce-payments-deployments). `PERMIT2_ADDRESS` is the canonical [Uniswap Permit2 contract](https://docs.uniswap.org/contracts/v4/deployments).

No operator or policy address is canonical, and none is named above. `extra.captureAuthorizer` and `extra.policy` are per-deployment values with no protocol-level meaning: a facilitator MUST NOT treat either as trusted because its bytecode matches one of the shapes sketched here, and admission goes through the [`/supported`](#supported) rules in every case. The Solidity in the appendix illustrates a future addition rather than audited or deployed code, and anyone building on it is responsible for reviewing, auditing, and deploying their own.

## Version History


| Version | Date       | Changes                                                                                         | Authors   |
| ------- | ---------- | ----------------------------------------------------------------------------------------------- | --------- |
| v1.1    | 2026-08-26 | Payment flow lifecycles, operator types and commerce-payments v1.1 | @phdargen |
| v1.0    | 2026-05-13 | Initial draft                                                                                   | @A1igator |


