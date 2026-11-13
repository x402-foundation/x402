# Scheme: `exact` on `Neo`

## Summary

The [`exact`](./scheme_exact.md) scheme on Neo uses a signed [Neo transaction](https://docs.neo.org/docs/n3/foundation/Transactions.html) containing one canonical [NEP-17](https://github.com/neo-project/proposals/blob/master/nep-17.mediawiki) `transfer` call. The payer signs the complete unsigned transaction before the protected resource is executed. The payment payload carries its unsigned serialization and collected signatures in the [`ContractParametersContext`](https://github.com/neo-project/proposals/blob/master/nep-21.mediawiki#types) structure defined by NEP-21, subject to the additional restrictions in this specification. A facilitator verifies the payload, completes the fee-payer entry in `items` when sponsorship is used, constructs the witnesses, and broadcasts the resulting transaction.

This specification supports two fee modes:

- **Payer-paid:** the payer is the transaction's only signer and pays the system and network fees.
- **Facilitator-sponsored:** the facilitator is the first transaction signer and pays the fees, while the payer remains the only account authorized to transfer the payment asset.

Both modes use the `signedTransaction` asset transfer method and the `upfront` payment flow (`settle` → resource → response). Settlement is durably completed before the protected resource executes. This specification supports [x402 version 2](../../x402-specification-v2.md) only.

## Scope and Terminology

### Networks and compatibility

This document applies to any blockchain in the `neo` CAIP-2 namespace that implements the Neo N3 protocol behavior required by this specification. This includes public and independently operated compatible networks.

The [Neo CAIP-2 namespace profile](https://github.com/ChainAgnostic/namespaces/blob/main/neo/caip2.md) identifies each network as `neo:<network-magic>`. The reference is the canonical unsigned decimal representation of the network's `uint32` Network Magic. Implementations MUST obtain the target network's Network Magic from a trusted source and verify that it equals the reference in `PaymentRequirements.network`. The standard Neo [`getversion`](https://docs.neo.org/docs/n3/reference/rpc/getversion.html) operation is one way to obtain it.

The following well-known identifiers are informative examples:

| Network | [CAIP-2](https://standards.chainagnostic.org/CAIPs/caip-2) identifier |
| --- | --- |
| Neo N3 MainNet | `neo:860833102` |
| Neo N3 TestNet T5 | `neo:894710606` |
| NeoFS MainNet | `neo:91414437` |
| NeoFS TestNet | `neo:735783775` |

A network is compatible with this scheme only if it implements the Neo transaction, NeoVM, signer and witness, NEP-17, and fee semantics required by [Neo Transaction](#neo-transaction) and [Signing and Witnesses](#signing-and-witnesses), and can provide the authoritative protocol settings and chain state needed for transaction construction and settlement. Use of a `neo` CAIP-2 identifier alone does not establish compatibility with this scheme or support by any facilitator.

Whenever this specification refers to the target network's `addressversion`, `msperblock`, or `maxvaliduntilblockincrement`, it means the authoritative protocol setting for the selected network. Implementations MUST obtain and verify these settings through trusted protocol configuration or a trusted node interface. The corresponding fields returned by `getversion` are the standard Neo RPC representation. If multiple sources are used, their values MUST agree.

### Terminology and supported mechanism

- The **payer** is the account from which the NEP-17 payment asset is transferred.
- The **fee payer** is the first transaction signer and pays `SystemFee + NetworkFee`. It is the payer in payer-paid mode and the facilitator account in sponsored mode.
- The Neo transaction **sender** is the first signer. It is therefore not the payer in sponsored mode.
- A **preflight** is a non-persisting execution used to predict the signed transaction's current execution result before broadcast.
- A **logical fulfillment** is one protected resource operation funded by a successful settlement.

The only asset transfer method defined here is `signedTransaction`, and its only payment flow is `upfront`. Every Neo `PaymentRequirements` MUST explicitly select both values. Implementations MUST reject any other asset transfer method or payment flow.

Any deployed contract that correctly implements NEP-17 MAY be used as the payment asset. Examples use the native GAS contract. The recipient MAY be a standard account or a deployed contract.

## Protocol Flow

1. A resource server offers one or more Neo `PaymentRequirements` entries.
2. The client selects an entry, constructs the required transaction, obtains the payer signatures, and submits a `PaymentPayload` containing the resulting `ContractParametersContext`.
3. The resource server passes the selected requirements and payload to the facilitator's `settle` operation. The `upfront` flow does not call `verify`.
4. The facilitator validates the payment and performs one preflight. In sponsored mode it then adds only its own signatures to the fee-payer context entry.
5. The facilitator constructs the witnesses, broadcasts the transaction, and returns success only after observing a persisted `HALT` execution with the required NEP-17 `Transfer` notification.
6. The resource server atomically consumes `(network, transactionHash)` before executing the protected operation, as defined in [Resource Fulfillment and Retries](#resource-fulfillment-and-retries).

Facilitators require trusted access to the network information and operations specified in [Networks and compatibility](#networks-and-compatibility) and [Settlement](#settlement) for validation, preflight execution, broadcast, and settlement confirmation. Clients MAY use a Neo node interface to construct the transaction; resource servers perform network-dependent settlement through the facilitator.

The client MUST NOT broadcast the transaction directly. Even in payer-paid mode, it submits the signed `ContractParametersContext` only through the x402 request; the facilitator is the sole broadcaster in this flow.

## Capability Advertisement and Payment Requirements

### Facilitator `SupportedKind`

A facilitator MUST advertise exactly one `SupportedKind` for each concrete network it supports for this scheme. `SupportedKind.network` MUST contain a concrete CAIP-2 identifier and MUST NOT use a wildcard.

A Neo `SupportedKind` MUST contain an `extra` object whose `assetTransferMethod` is exactly `"signedTransaction"`. Omission of `extra`, omission of `assetTransferMethod`, or any other value does not advertise support for this mechanism.

The presence of `extra.feePayerVerificationScript` in that kind advertises an additional capability:

- absent: the facilitator supports payer-paid mode only;
- present: the facilitator supports both payer-paid and sponsored modes, using the advertised script for sponsored payments.

A facilitator that advertises sponsored capability MUST also accept payer-paid payments on the same network.

The advertised `feePayerVerificationScript` uses the same format and derivation rules as the field of that name in [`PaymentRequirements.extra`](#paymentrequirements).

When `feePayerVerificationScript` is advertised, consumers MUST compute its fee-payer account and address under [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures) and verify that the derived address appears in the matching `SupportedResponse.signers` entry. An exact CAIP-2 key or a matching family pattern such as `neo:*` MAY be used. An advertisement that fails this check MUST be rejected.

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "neo:894710606",
      "extra": {
        "assetTransferMethod": "signedTransaction",
        "feePayerVerificationScript": "DCEDPOXX4lthqMpa+30XnFphsw+b/bhbllIFAkDyuQwKOvlBVuezJw=="
      }
    }
  ],
  "extensions": [],
  "signers": {
    "neo:*": ["NZDH4xUF8s82AJhg6swoH9tvmHG71FEzrS"]
  }
}
```

### `PaymentRequirements`

Neo uses the standard x402 [`PaymentRequirements`](../../x402-specification-v2.md) fields with the following meanings.

| Field | Required | Neo definition |
| --- | --- | --- |
| `scheme` | yes | MUST be `"exact"`. |
| `network` | yes | MUST be a concrete CAIP-2 identifier valid under the [Neo CAIP-2 namespace profile](https://github.com/ChainAgnostic/namespaces/blob/main/neo/caip2.md) and supported by the selected facilitator. |
| `asset` | yes | NEP-17 contract script hash in canonical lowercase `0x` plus 40 hexadecimal digits. |
| `amount` | yes | Positive decimal integer string in the asset's atomic units. |
| `payTo` | yes | [Base58Check Neo address](https://docs.neo.org/docs/n3/foundation/Wallets.html#address) encoded with the target network's `addressversion`. |
| `maxTimeoutSeconds` | yes | Positive integer used to bound `ValidUntilBlock`. |
| `extra.assetTransferMethod` | yes | MUST be `"signedTransaction"`. |
| `extra.paymentFlow` | yes | MUST be `"upfront"`. |
| `extra.transferData` | no | Optional application-defined string passed unchanged as the NEP-17 `data` argument. When omitted, that argument is Neo VM `null`. |
| `extra.feePayerVerificationScript` | no | Canonical Base64 standard-account verification script that offers facilitator-sponsored mode. |

`amount` MUST match `^[1-9][0-9]*$` and be representable as a Neo VM integer. Clients that display a human-readable amount MUST obtain token decimals from the asset contract rather than trusting additional server-provided metadata.

When present, `transferData` MUST be a JSON string containing a valid sequence of Unicode scalar values whose UTF-8 encoding is between 1 and 255 bytes inclusive. Its exact Unicode value is part of the payment requirements. Implementations MUST NOT trim it or apply Unicode normalization, case conversion, or any other transformation before UTF-8 encoding it. JSON `null`, an empty string, and strings whose UTF-8 encoding exceeds 255 bytes are invalid. Resource servers MAY use it for public application data such as an order number, invoice reference, or receipt reference, but this scheme assigns it no uniqueness or idempotency semantics.

`feePayerVerificationScript` contains only the verification script bytes, not a serialized `Witness`, address, public-key array, or script hash. It MUST use canonical Base64 and decode to either a standard Neo single-signature script or a standard Neo m-of-n multisignature script as defined in [Standard accounts](#standard-accounts).

### Fee-mode selection and requirement construction

A resource server creates one `PaymentRequired.accepts` entry for a matching kind. It MUST explicitly set `assetTransferMethod` to `"signedTransaction"` and `paymentFlow` to `"upfront"`.

The resource server MAY omit `feePayerVerificationScript` and offer payer-paid mode only, whether or not the matching kind advertises sponsorship. To offer sponsored mode, it MUST copy the matching kind's `feePayerVerificationScript` byte-for-byte into `PaymentRequirements.extra`. It MUST NOT place that field in a requirement when the kind omits it or use a different script.

Payer-paid mode is available for every valid requirement. Sponsored mode is available only when `feePayerVerificationScript` is present. The fee-payer account value and target-network address are derived from that script under [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures). For a multisignature account, the script also determines its threshold and public keys. The client selects one of the [fee-mode signer layouts](#fee-mode-signer-layouts) allowed by the requirement.

If a facilitator rotates its advertised script, resource servers MUST use the current value in new requirements. A facilitator MAY retain the corresponding key material and accept a retired script carried by an earlier requirement for a bounded grace period so that already signed payloads can still settle.

### `PaymentRequirements` example

This example includes `transferData` to exercise its non-null encoding. Omitting that field is also valid and selects the `PUSHNULL` form defined in [Canonical NEP-17 payment script](#canonical-nep-17-payment-script).

```json
{
  "scheme": "exact",
  "network": "neo:894710606",
  "amount": "10000000",
  "asset": "0xd2a4cff31913016155e38e474a2c06d08be276cf",
  "payTo": "NaSxHhUMrJkVGaJyC98fnccjNXoGEGPps5",
  "maxTimeoutSeconds": 60,
  "extra": {
    "assetTransferMethod": "signedTransaction",
    "paymentFlow": "upfront",
    "transferData": "4f8c2e31-6d78-4a5b-9c01-2e3f4a5b6c7d",
    "feePayerVerificationScript": "DCEDPOXX4lthqMpa+30XnFphsw+b/bhbllIFAkDyuQwKOvlBVuezJw=="
  }
}
```

## `PaymentPayload`

### Restricted `ContractParametersContext` structure

The scheme-specific `payload` is a [`ContractParametersContext`](https://github.com/neo-project/proposals/blob/master/nep-21.mediawiki#types) object with the restrictions defined in this section:

```json
{
  "type": "Neo.Network.P2P.Payloads.Transaction",
  "hash": "<transaction-hash>",
  "data": "<base64-encoded unsigned Neo transaction>",
  "items": {
    "<signer-script-hash>": {
      "script": "<base64 verification script>",
      "parameters": [
        {
          "type": "Signature",
          "value": "<base64 signature>"
        }
      ],
      "signatures": {
        "<compressed-public-key>": "<base64 signature>"
      }
    }
  },
  "network": 894710606
}
```

The `ContractParametersContext` fields have these meanings:

| Field | Definition |
| --- | --- |
| `type` | MUST be exactly `"Neo.Network.P2P.Payloads.Transaction"`. |
| `hash` | Canonical transaction hash string derived from the decoded `data` bytes as defined in [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures). |
| `data` | Canonical Base64 encoding of exactly the unsigned Neo transaction serialization. It excludes the witness count and all witnesses. |
| `items` | Object containing exactly one entry for every transaction signer, keyed by that signer's canonical lowercase UInt160 string. No other entry is permitted. |
| `network` | JSON number in the `uint32` range equal to the Network Magic encoded by `PaymentPayload.accepted.network`. |

The `payload` object MUST contain exactly these five fields. Each entry in `items` MUST contain exactly `script`, `parameters`, and `signatures`. JSON property order is not significant, and implementations MUST NOT compare or hash the JSON serialization as bytes.

### Items and signature material

Each entry in `items` is restricted as follows:

- `script` is the canonical Base64 encoding of the signer's standard verification script.
- `parameters` contains exactly the signature parameter slots required by that script: one `Signature` argument for a single-signature account and `m` `Signature` arguments for an m-of-n multisignature account.
- A populated parameter has exactly `{ "type": "Signature", "value": "<base64-signature>" }`. An unpopulated parameter has exactly `{ "type": "Signature" }`; it MUST omit `value` rather than encode null or an empty string.
- `signatures` maps canonical lowercase compressed secp256r1 public keys, encoded as 66 hexadecimal characters without `0x`, to Base64-encoded 64-byte Neo signatures.
- Every signature-map key MUST be a distinct public key contained in the verification script. No unknown public key or duplicate signature is permitted.

For a complete entry, `signatures` MUST contain exactly the signatures needed by the verification script and every parameter MUST be populated. In a single-signature entry, the only parameter value MUST equal the only signature-map value. In a multisignature entry, order the `m` selected signatures by the positions of their corresponding public keys in the verification script. The `parameters` array MUST contain those signature values in reverse order, from the highest selected public-key position to the lowest. A facilitator MUST reject an entry in which the parameter values and signature map do not have this exact relationship. JSON property order within `signatures` has no significance.

For the incomplete fee-payer entry used in sponsored mode, `signatures` MUST be empty and every signature parameter MUST omit `value`. No other entry may be incomplete.

### Canonical encoding and requirements binding

All Base64 values MUST use the canonical [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648) representation:

- the value MUST contain only `A-Z`, `a-z`, `0-9`, `+`, `/`, and any required trailing `=` padding;
- whitespace, the URL-safe characters `-` and `_`, and all other characters are prohibited;
- the total length MUST be a multiple of four characters;
- padding MUST be absent when the underlying byte length is divisible by three, MUST be one trailing `=` when the remainder is two, and MUST be two trailing `==` characters when the remainder is one; `=` MUST NOT appear elsewhere; and
- unused bits in the final non-padding character MUST be zero.

These Base64 rules apply to `data`, every `script`, every populated parameter value, and every signature-map value.

`data` MUST decode to the exact canonical unsigned serialization `U` of one transaction in the target network's Neo transaction format. It MUST NOT contain a witness count, witnesses, trailing bytes, or non-canonical variable-length encodings. `hash` MUST equal lowercase `0x` followed by the hexadecimal encoding of `reverse(SHA-256(U))`.

The signer list in `data` MUST conform to exactly one of the [fee-mode signer layouts](#fee-mode-signer-layouts). For the sponsored layout, `PaymentRequirements.extra.feePayerVerificationScript` MUST be present, and its decoded bytes MUST exactly equal the `script` in the first signer's `items` entry.

`PaymentPayload.accepted` MUST match the selected `PaymentRequirements` supplied to the facilitator for `scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, and every scheme-defined `extra` field.

## Neo Transaction

### Unsigned transaction fields

Both fee modes use the standard Neo N3-compatible transaction format required by [Networks and compatibility](#networks-and-compatibility) and MUST satisfy all of the following:

- `Version` MUST be `0`.
- `Nonce` MUST be a `uint32`; clients SHOULD choose it randomly.
- `Attributes` MUST be empty.
- `SystemFee`, `NetworkFee`, and `ValidUntilBlock` MUST be finalized before the payer signs.
- `Script` MUST be the [canonical NEP-17 payment script](#canonical-nep-17-payment-script).
- Signer accounts MUST be unique.
- No unsigned transaction field MAY be changed after the payer signs.

The `data` field of `ContractParametersContext` contains these unsigned transaction fields but no witnesses. Neo treats the first signer as the transaction sender, and that account pays `SystemFee + NetworkFee`. The transaction hash and signing message exclude the witnesses but cryptographically commit to every unsigned field listed above.

### Fee-mode signer layouts

The transaction signer list determines the fee mode and MUST conform to exactly one of the following layouts. Every account value in the tables is the 20-byte value derived from the named verification script under [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures).

#### Payer-paid mode

The payer MUST be the transaction's only signer:

| Index | Account | Scope |
| --- | --- | --- |
| 0 | account value derived from the payer verification script | `CalledByEntry` |

The payer is the transaction sender and pays all transaction fees.

#### Facilitator-sponsored mode

The fee payer and payer MUST be different accounts. The transaction MUST contain exactly two signers in this order:

| Index | Account | Scope |
| --- | --- | --- |
| 0 | account value derived from `PaymentRequirements.extra.feePayerVerificationScript` | `None` |
| 1 | account value derived from the payer verification script | `CalledByEntry` |

The first signer pays the fees. `WitnessScope.None` prevents its witness from authorizing contract activity. The payer's `CalledByEntry` scope authorizes the directly invoked NEP-17 asset contract, without granting the recipient callback global use of the payer witness.

### Canonical NEP-17 payment script

`Transaction.Script` MUST be [NeoVM bytecode](https://docs.neo.org/docs/n3/reference/opcodes.html) containing exactly the opcode and operand sequence specified in the following table. The opcode mnemonics and position labels are used only to describe the bytecode; they are not text contained in `Transaction.Script`.

Position 1 pushes the NEP-17 `data` argument. Position 2 pushes, as a Neo VM integer, the positive integer represented by `PaymentRequirements.amount`. Exactly one alternative MUST be selected at each of positions 1 and 2. All other positions are fixed.

| Position | Opcode | Serialized operand bytes | Rule |
| --- | --- | --- | --- |
| 1a | `PUSHNULL` | none | Required when `PaymentRequirements.extra.transferData` is absent. Pushes Neo VM `null`. |
| 1b | `PUSHDATA1` | one-byte length followed by the exact UTF-8 bytes | Required when `PaymentRequirements.extra.transferData` is present. The length byte is from `0x01` through `0xff` and equals the value's UTF-8 byte length. |
| 2a | `PUSH1` through `PUSH16` | none | When the parsed `PaymentRequirements.amount` is from 1 through 16, use the opcode that pushes that integer (`PUSH1` for 1 through `PUSH16` for 16). |
| 2b | `PUSHINT8`, `PUSHINT16`, `PUSHINT32`, `PUSHINT64`, `PUSHINT128`, or `PUSHINT256` | signed little-endian integer of the width named by the opcode | For every other parsed `PaymentRequirements.amount`, use the smallest listed width that represents that integer. An amount that cannot be represented by `PUSHINT256` is invalid. |
| 3 | `PUSHDATA1` | `14`, followed by the 20-byte little-endian UInt160 decoded from `PaymentRequirements.payTo` | Pushes `payTo`. |
| 4 | `PUSHDATA1` | `14`, followed by the payer signer's 20-byte account value | Pushes `payer`. |
| 5 | `PUSH4` | none | Pushes the transfer argument count. |
| 6 | `PACK` | none | Packs the four transfer arguments. |
| 7 | `PUSH15` | none | Pushes `0x0f`, the numeric value of `CallFlags.All`. |
| 8 | `PUSHDATA1` | `08 74 72 61 6e 73 66 65 72` | Pushes the exact, case-sensitive UTF-8 method name `transfer`. |
| 9 | `PUSHDATA1` | `14`, followed by the 20-byte little-endian UInt160 parsed from `PaymentRequirements.asset` | Pushes the asset contract hash. |
| 10 | `SYSCALL` | `62 7d 5b 52` | Calls `System.Contract.Call`. |
| 11 | `ASSERT` | none | Requires the NEP-17 call to return true. |

The four transfer arguments are pushed in reverse order. `PUSH4` and `PACK` therefore produce the array `[payer, payTo, amount, data]`. `data` is Neo VM `null` when `transferData` is absent and is the exact UTF-8 byte string defined in [`PaymentRequirements`](#paymentrequirements) when it is present. `PUSH15` supplies the numeric value `0x0f` for [`CallFlags.All`](https://docs.neo.org/docs/n3/reference/scapi/framework/services/CallFlags.html). [`System.Contract.Call`](https://docs.neo.org/docs/n3/reference/scapi/interop.html) receives, in order, the asset contract hash, the exact method name, the call flags, and the argument array. `ASSERT` MUST immediately follow the call and MUST be the final instruction, so a NEP-17 contract returning `false` causes the transaction to enter the `FAULT` state.

These instruction and operand requirements define the only accepted byte encoding. The facilitator MUST compare `Transaction.Script` byte-for-byte with the script required by this section. Semantically equivalent alternative encodings are not accepted. There MUST be no leading or trailing instructions, other contract calls, extra transfers, or separate memo instructions.

### Transaction lifetime

The timeout calculation uses the target network's `msperblock` and `maxvaliduntilblockincrement` protocol settings. For a requirement, calculate:

```text
baseTimeoutBlocks = min(
  maxvaliduntilblockincrement,
  max(1, ceil(maxTimeoutSeconds * 1000 / msperblock))
)
```

The client MUST choose a `ValidUntilBlock` satisfying:

```text
clientHeight < ValidUntilBlock
ValidUntilBlock <= clientHeight + baseTimeoutBlocks
```

`clientHeight` is the highest persisted block index observed by the client. The standard Neo [`getblockcount`](https://docs.neo.org/docs/n3/reference/rpc/getblockcount.html) result minus one is one way to obtain it.

During settlement, let `facilitatorHeight` be the highest persisted block index observed through the facilitator's trusted node interface. The facilitator MUST require:

```text
facilitatorHeight < ValidUntilBlock
ValidUntilBlock <= facilitatorHeight + min(
  maxvaliduntilblockincrement,
  baseTimeoutBlocks + 2
)
```

The two-block allowance applies only to the facilitator's acceptance bound and accommodates a client height up to two blocks ahead when permitted by the network's `maxvaliduntilblockincrement`; it never extends that protocol limit. The facilitator MUST also require enough remaining time for immediate broadcast and MAY apply a stricter local minimum remaining-block policy.

### Fees and balances

The facilitator MUST use the single fresh preflight execution required by [Preflight execution and payment outcome](#preflight-execution-and-payment-outcome) to evaluate both the payment outcome and `SystemFee`; its gas consumption is the required minimum `SystemFee`. The facilitator MUST also determine the minimum `NetworkFee` for the final witness sizes. The standard Neo [`calculatenetworkfee`](https://docs.neo.org/docs/n3/reference/rpc/calculatenetworkfee.html) operation or an equivalent local calculation can produce that result.

For payer-paid mode:

- `SystemFee` MUST be at least the preflight gas consumption; and
- `NetworkFee` MUST be at least the calculated network fee.

The payer MAY intentionally include a larger fee because it bears that cost.

For facilitator-sponsored mode:

- `SystemFee` MUST equal the preflight gas consumption;
- `NetworkFee` MUST equal the calculated minimum for the final transaction; and
- `SystemFee + NetworkFee` MUST NOT exceed the facilitator's local sponsorship cap.

When calculating the sponsored network fee, an implementation MAY temporarily complete a copy of the fee-payer entry in `items` with same-length placeholder signatures and construct its witnesses. It MUST account for the exact final single-signature or m-signature invocation length and MUST NOT change the `ContractParametersContext` object submitted by the client. A compatible Neo RPC can calculate the same fee from the resulting placeholder-witness transaction.

The actual first signer MUST hold enough GAS for `SystemFee + NetworkFee`. The payer MUST hold at least `amount` of the selected NEP-17 asset. If the payer also pays fees and the asset is GAS, its GAS balance MUST cover `amount + SystemFee + NetworkFee`. In sponsored mode the payer needs only the transfer amount, even when the asset is GAS, while the facilitator account covers the fees.

## Signing and Witnesses

### Hashes, addresses, and transaction signatures

The following byte-level definitions apply throughout this specification. `||` denotes byte concatenation, `reverse` reverses the order of all bytes in its argument, and `uint32_le` encodes a `uint32` as four bytes in little-endian order.

Let `U` be the exact canonical unsigned transaction byte sequence carried in `PaymentPayload.payload.data`, after Base64 decoding. Define the 32-byte transaction digest:

```text
H = SHA-256(U)
```

The canonical Neo transaction hash string is lowercase `0x` followed by the hexadecimal encoding of `reverse(H)`. The raw 32 bytes serialized in Neo data structures are `H`, not the reversed display form. Network Magic and witnesses are not inputs to `H`.

For a standard-account verification script whose exact bytes are `V`, define its 20-byte account value:

```text
A = RIPEMD-160(SHA-256(V))
```

`A` is the byte sequence serialized in `Signer.Account`. Its canonical Neo UInt160 string is lowercase `0x` followed by the hexadecimal encoding of `reverse(A)`. Its target-network address is the Base58 encoding of `P || C`, where:

```text
P = addressversion || A
C = first4(SHA-256(SHA-256(P)))
```

`addressversion` is the target network's single address-version byte, and `first4` selects the first four bytes. Base58 uses the alphabet `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`; each leading zero byte in `P || C` is represented by a leading `1` character.

Let `N` be the `uint32` Network Magic represented by `PaymentRequirements.network`. The exact 36-byte transaction signing message is:

```text
M = uint32_le(N) || H
```

Every payer or facilitator transaction signature MUST be an ECDSA signature over `SHA-256(M)` using secp256r1. Its serialized form MUST be exactly 64 bytes: the 32-byte unsigned big-endian `r` value followed by the 32-byte unsigned big-endian `s` value, with each value left-padded with zero bytes when necessary. DER encoding is not permitted.

Because neither `H` nor `M` includes witnesses or the `ContractParametersContext` JSON object, completing an entry in `items` and constructing witnesses does not change the transaction hash or invalidate an existing signature. Because `M` includes `N`, a signature valid for one Network Magic MUST NOT validate for another.

### Standard accounts

This version supports [standard Neo single-signature and m-of-n multisignature accounts](https://docs.neo.org/docs/n3/foundation/Wallets.html#address) only. Custom verification contracts are outside the scope of this specification.

#### Verification scripts

A standard single-signature verification script MUST be exactly 40 bytes and contain these two NeoVM instructions:

| Position | Opcode | Serialized operand bytes | Rule |
| --- | --- | --- | --- |
| 1 | `PUSHDATA1` | `21`, followed by one 33-byte compressed public key | The key MUST decode to a finite point on secp256r1 and start with `0x02` or `0x03`. |
| 2 | `SYSCALL` | `56 e7 b3 27` | Calls [`System.Crypto.CheckSig`](https://docs.neo.org/docs/n3/reference/scapi/interop.html). |

A standard m-of-n multisignature verification script accepted by this specification MUST satisfy `1 <= m <= n <= 16`. It MUST contain `n` distinct compressed secp256r1 public keys that satisfy the same point-encoding requirements as the single-signature key. The keys MUST be ordered by ascending affine x coordinate and then by ascending affine y coordinate, treating both coordinates as unsigned integers.

The threshold `m` and key count `n` MUST each be encoded by the corresponding single-byte `PUSH1` through `PUSH16` opcode (`0x11` through `0x20`). For a value `v`, the opcode byte is `0x10 + v`; no operand bytes follow it.

The multisignature verification script MUST contain exactly this instruction sequence:

| Position | Opcode | Serialized operand bytes | Rule |
| --- | --- | --- | --- |
| 1 | the integer-push opcode required for `m` | as specified above | Pushes the signature threshold. |
| 2 through `n + 1` | `PUSHDATA1` | `21`, followed by one 33-byte compressed public key | Pushes all `n` keys in the required order, one instruction per key. |
| `n + 2` | the integer-push opcode required for `n` | as specified above | Pushes the public-key count. |
| `n + 3` | `SYSCALL` | `9e d0 dc 3a` | Calls [`System.Crypto.CheckMultisig`](https://docs.neo.org/docs/n3/reference/scapi/interop.html). |

A verification script is standard under this specification only when its complete byte sequence has one of the two forms above. Alternate integer encodings, duplicate or incorrectly ordered keys, additional instructions, and trailing bytes are not accepted.

#### Invocation scripts

Each transaction signature MUST have the 64-byte `r || s` form and validate against the signing message defined in [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures). Each signature in an invocation script MUST be encoded as one `PUSHDATA1` instruction whose operand is the length byte `0x40` followed by the 64 signature bytes. A standard single-signature invocation script MUST contain exactly one such instruction. A standard multisignature invocation script MUST contain exactly `m` such instructions, with the signatures ordered according to their corresponding public keys in the verification script so that `System.Crypto.CheckMultisig` succeeds. No other instruction or byte is permitted in either invocation script form.

For verification-script bytes `V`, the signer account and displayed address MUST equal the account value and target-network address derived from `V` under [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures).

### `ContractParametersContext` entries and witness construction

The client and facilitator use `ContractParametersContext.items` to collect signatures without changing the unsigned transaction in `data`. Property order within `items` does not determine witness order; the signer order in the unsigned transaction does.

After every signer entry is complete, `items` contains the data required to construct exactly one witness for each transaction signer. For signer position `i`:

1. the source entry is the `items` entry whose key is the canonical lowercase UInt160 representation of `Signers[i].Account`;
2. `VerificationScript` is the exact byte sequence obtained by Base64-decoding that entry's `script`; and
3. `InvocationScript` is the standard single-signature or multisignature invocation script defined in [Standard accounts](#standard-accounts), using the signatures in that entry.

For a single-signature entry, `InvocationScript` contains its only signature. For a multisignature entry, it contains the `m` selected signatures from lowest to highest corresponding public-key position in the verification script. This is the reverse of the entry's required `parameters` order. Each signature uses the exact `PUSHDATA1 0x40` encoding defined in [Invocation scripts](#invocation-scripts).

`Witnesses[i]` MUST be that constructed witness. The witness count MUST equal the signer count, and no witness may be added, omitted, or reordered. Before broadcast, the facilitator MUST verify every witness against the unsigned transaction and selected Network Magic. The entries in `items`, including their parameter arrays and signature maps, are signing-coordination data; only the constructed witnesses are included in the final consensus transaction serialization.

### Payer-paid context and witness

For the payer-paid signer layout, the client-supplied `ContractParametersContext.items` object MUST contain exactly one entry with this state:

| Signer index | Decoded entry `script` | Client-supplied entry state |
| --- | --- | --- |
| 0 | payer standard verification script | complete payer signature or multisignature data |

Because that entry is already complete, witness construction produces exactly one final witness:

| Witness index | `InvocationScript` | `VerificationScript` |
| --- | --- | --- |
| 0 | standard payer single-signature or multisignature invocation script | payer standard verification script |

### Facilitator-sponsored context and witnesses

For the facilitator-sponsored signer layout, the client-supplied `ContractParametersContext.items` object MUST contain exactly two entries with these states:

| Signer index | Decoded entry `script` | Client-supplied entry state |
| --- | --- | --- |
| 0 | standard fee-payer verification script decoded from `PaymentRequirements.extra.feePayerVerificationScript` | incomplete: every signature parameter omits `value`, and `signatures` is empty |
| 1 | payer standard verification script | complete payer signature or multisignature data |

Settlement completes only the fee-payer entry as defined in [Fee-payer entry completion and witness construction](#fee-payer-entry-completion-and-witness-construction). The completed context produces these final witnesses:

| Witness index | `InvocationScript` | `VerificationScript` |
| --- | --- | --- |
| 0 | standard fee-payer single-signature or multisignature invocation script | standard fee-payer verification script decoded from `PaymentRequirements.extra.feePayerVerificationScript` |
| 1 | standard payer single-signature or multisignature invocation script | payer standard verification script |

## Settlement

In the core `upfront` flow, settlement occurs before the protected resource. The facilitator MUST treat both the requirements and client payload as untrusted. In this section, `PaymentRequirements` means the selected requirements supplied to the facilitator alongside the `PaymentPayload`.

Before signing or broadcasting a new transaction, the facilitator MUST complete the validation specified in this section and reject a payment that fails any check. Checks that depend on chain state MUST use current chain state.

### Envelope and network

1. `x402Version` is `2`, the scheme is `exact`, and `PaymentRequirements.extra` explicitly contains `assetTransferMethod: "signedTransaction"` and `paymentFlow: "upfront"`.
2. `PaymentPayload.accepted` matches `PaymentRequirements` without default resolution, including the presence or absence and exact value of `feePayerVerificationScript`.
3. The network is a canonical `neo:<network-magic>` identifier, satisfies the network compatibility requirements, and has exactly one matching `SupportedKind` in the selected facilitator's `SupportedResponse`.
4. The unsigned transaction signer list conforms to exactly one of the [fee-mode signer layouts](#fee-mode-signer-layouts). For the sponsored layout, `feePayerVerificationScript` MUST be present, the `script` in the first signer's `items` entry MUST exactly match it, and the facilitator MUST recognize it as its currently advertised script or a retired script still accepted during a bounded rotation grace period.
5. The Network Magic obtained from the facilitator's trusted network source equals the CAIP-2 reference.
6. `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, and scheme-specific `extra` fields use their canonical formats.
7. `payTo` decodes with the target network's `addressversion`. It MUST NOT be rejected merely because its script hash belongs to a deployed contract.

### Payload, serialization, and transaction shape

1. `payload` has the exact restricted `ContractParametersContext` structure and field types defined in [`PaymentPayload`](#paymentpayload), and every Base64 or hexadecimal value is canonical.
2. `type` is `"Neo.Network.P2P.Payloads.Transaction"`; `network` equals both the CAIP-2 reference and the Network Magic obtained from the trusted network source; and `hash` equals the canonical transaction hash independently calculated from `data` under [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures).
3. `data` decodes to exactly one canonical unsigned transaction and contains no witness data, trailing bytes, or non-canonical variable-length encodings.
4. `Version` is `0`, `Attributes` is empty, and the unsigned transaction has the exact signer layout for the selected fee mode.
5. Signer accounts are unique and every scope equals the value specified for its position. No custom contracts, groups, witness rules, or global scopes are present.
6. `items` contains exactly one entry for each signer account and no other entry. Property order is ignored; each entry is associated with its signer by the canonical UInt160 key.
7. Every entry's `script` is a canonical standard single-signature or multisignature verification script. The account value and canonical UInt160 string derived from its decoded bytes under [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures) equal the corresponding signer's account and the `items` key, respectively.
8. Every entry has the exact signature-parameter count required by its script. Its parameter values, signature map, public keys, and canonical invocation derived from them are mutually consistent.
9. In sponsored mode, the fee-payer entry is the only incomplete entry: its script exactly equals the decoded `PaymentRequirements.extra.feePayerVerificationScript`, every parameter value is absent, and its signature map is empty. In payer-paid mode, `items` contains exactly one entry: the complete payer entry.
10. The payer entry is complete, and all required payer signatures validate over `SHA-256(uint32_le(N) || SHA-256(U))` for the selected Network Magic `N` and unsigned transaction bytes `U`.
11. `Transaction.Script` byte-for-byte equals the canonical payment bytecode defined in this specification.

### Transaction identity and existing settlement coordination

Look up `(network, transactionHash)` in the settlement cache using the transaction hash established by [Payload, serialization, and transaction shape](#payload-serialization-and-transaction-shape). If a matching record exists, require the same requirements and canonical payload and reconcile that record as an existing settlement.

### Chain state

1. The asset contract exists and its manifest declares `NEP-17` in `supportedstandards`.
2. `ValidUntilBlock` is unexpired and within both the requirement-derived and protocol bounds.
3. The transaction and its signers satisfy current Neo policy rules, including blocked-account checks.

### Preflight execution and payment outcome

The facilitator MUST perform one fresh, non-persisting preflight execution of the exact canonical `Transaction.Script` against current chain state and with the exact ordered transaction signer list. This same execution supplies the gas consumption used for `SystemFee` validation and the notifications used for payment-outcome validation. The signers supplied to the execution environment MUST preserve every signer account and scope from the unsigned transaction; no signer may be added, removed, reordered, or assigned a broader scope. Preflight execution MUST finish in `HALT` state.

The facilitator MUST obtain the preflight VM state, gas consumption, notifications, and any diagnostic information needed for the checks below through a trusted interface that preserves the exact script and ordered signer accounts and scopes. [`invokescript`](https://docs.neo.org/docs/n3/reference/rpc/invokescript.html) can provide these results when supplied with the exact script and ordered signers. Preflight results are predictive; persisted transaction state and the persisted application log remain authoritative for settlement success.

The preflight notifications MUST contain exactly one event satisfying all of the following:

- emitting contract equals `PaymentRequirements.asset`;
- event name is `Transfer`;
- the notification state is an array of exactly three values;
- `state[0]` is a non-null 20-byte value equal to the payer signer's account value;
- `state[1]` is a non-null 20-byte value equal to the internal UInt160 bytes decoded from `payTo`; and
- `state[2]` is the integer represented by `PaymentRequirements.amount`.

RPC encodings may label the two 20-byte values as byte strings or buffers. Implementations MUST compare the decoded bytes, not their Base64 text or displayed UInt160 byte order. The same rules apply to preflight notifications and the persisted application log.

The facilitator MUST reject a preflight result containing any NEP-17 transfer from the payer other than the required payment. In sponsored mode, it MUST also reject any observed NEP-17 transfer from the facilitator's fee-payer account, because that account's witness may authorize only fees.

When `PaymentRequirements.asset` is the target network's [native NEO contract](https://github.com/neo-project/neo/blob/master-n3/src/Neo/SmartContract/Native/NeoToken.cs), the facilitator MUST NOT reject the result solely because it also contains native GAS distribution notifications. Each notification allowed by this exception MUST satisfy all of the following:

- the emitting contract is the target network's native GAS contract;
- the event name is `Transfer` and its state is an array of exactly three values;
- `state[0]` is Neo VM `null`;
- `state[1]` is a non-null 20-byte value equal to either the payer signer's account value or the internal UInt160 bytes decoded from `payTo`; and
- `state[2]` is a positive integer.

Such a notification represents GAS minted by the native contracts, not a transfer from the payer or fee payer. A GAS notification that does not satisfy every condition above receives no exception from the general isolation rules.

Receiver-contract callbacks MAY execute and emit their own events. They do not invalidate the payment unless preflight execution faults or violates a payer/fee-payer isolation rule above. The facilitator MUST fail closed if it cannot inspect the complete preflight result needed for these checks.

### Fee validation and balances

1. System and network fees satisfy the rules for the selected fee mode and, in sponsored mode, the facilitator's local cap.
2. The payer has sufficient asset balance and the first signer has sufficient GAS, including the combined GAS requirement when payer and fee payer are the same account in payer-paid mode.

Validation MUST NOT mutate the client-supplied `ContractParametersContext`. A copy MAY be completed with same-length placeholder signatures solely for network-fee calculation.

### Duplicate transaction check and atomic reservation

1. Ensure that the new settlement has passed all checks from [Envelope and network](#envelope-and-network) through [Fee validation and balances](#fee-validation-and-balances).
2. Determine whether that single transaction hash already exists in the target network's mempool or ledger. [`getrawtransaction`](https://docs.neo.org/docs/n3/reference/rpc/getrawtransaction.html) is the standard Neo RPC operation for this lookup; an equivalent trusted interface MAY be used. If the transaction already exists without a matching settlement record, reject it as already submitted.
3. Atomically check and insert `(network, transactionHash)` in the settlement cache before signing or broadcasting. If another worker wins the insertion race, reconcile the winning record instead of broadcasting independently.
4. Retain the record until `ValidUntilBlock` has passed. A horizontally scaled facilitator MUST use a shared store with equivalent atomic semantics.

The cache record SHOULD commit to the normalized requirements and canonical payload and track whether broadcast occurred and any known transaction outcome. A repeated settlement request MUST be reconciled against that record and the network; it MUST NOT produce an independent broadcast or a conflicting settlement result.

### Fee-payer entry completion and witness construction

Only after validation and duplicate reservation succeed may settlement add facilitator signatures and broadcast the transaction.

In payer-paid mode, the facilitator MUST construct the witnesses from the verified complete payer entry in `items` and attach them to the transaction deserialized from `data`. It MUST NOT add, remove, or replace any client signature.

In sponsored mode, the facilitator MUST:

1. sign the same unsigned transaction with the key or keys represented by the verified fee-payer entry's script;
2. add those signatures to the incomplete fee-payer entry in `items` in a verified copy of the client-supplied `ContractParametersContext`;
3. populate the fee-payer parameters with the selected signatures in descending order of their corresponding public-key positions, as required by [Items and signature material](#items-and-signature-material);
4. require every signer entry in the resulting `items` object to be complete;
5. construct all witnesses in signer order and verify them locally; and
6. verify that `data`, its unsigned serialization, and the transaction hash are unchanged.

For both modes, the facilitator MUST require the constructed witness count to equal the signer count and MUST serialize the final transaction canonically before broadcast. It MUST NOT alter signer order, scopes, verification scripts, attributes, script, nonce, fees, or `ValidUntilBlock`.

### Broadcast and confirmation

The facilitator submits the final serialized transaction through its trusted node interface and waits for it to be persisted. [`sendrawtransaction`](https://docs.neo.org/docs/n3/reference/rpc/sendrawtransaction.html) is the standard Neo RPC operation for submission. It then obtains the persisted execution result and notifications, for example through [`getapplicationlog`](https://docs.neo.org/docs/n3/reference/rpc/getapplicationlog.html), and repeats the final `HALT` and exact `Transfer` checks.

If a broadcast races with another submission and the node reports that the transaction already exists, the facilitator MUST query that single transaction hash through `getrawtransaction` or an equivalent trusted interface and reconcile it with the settlement cache instead of constructing a replacement transaction.

Settlement succeeds only when:

- the transaction is persisted on the required network;
- the application execution state is `HALT`; and
- the persisted notifications satisfy the same exact payment and isolation rules as the preflight result.

If the transaction was broadcast but confirmation or its application log cannot be established, the facilitator MAY return `settlement_pending`. This is non-terminal and MUST include the broadcast transaction hash so the caller can reconcile before retrying.

If a persisted transaction has `FAULT` state or lacks the required transfer outcome, the facilitator MUST return `invalid_transaction_state` and include the known transaction hash.

### `SettleResponse`

When `success` is `true`, `payer`, `transaction`, `network`, and `amount` MUST all be present, and `errorReason` MUST be absent. `payer` is the target-network address derived from the payer verification script under [Hashes, addresses, and transaction signatures](#hashes-addresses-and-transaction-signatures), not Neo's transaction `sender` address, because the sender is the facilitator in sponsored mode. `network` MUST equal `PaymentRequirements.network`, and `amount` MUST equal `PaymentRequirements.amount`.

If no transaction was broadcast and the transaction was not otherwise found in the target network's mempool or ledger, `transaction` MUST be the empty string, even when the unsigned transaction can be deserialized and its hash can be calculated. This includes every failure before submission and a definitive rejection by the node interface that establishes that the transaction was not accepted.

If the transaction was broadcast, may have been broadcast after an indeterminate submission result, or was found in the target network's mempool or ledger, `transaction` MUST contain lowercase `0x` followed by the hexadecimal encoding of `reverse(H)`, where `H = SHA-256(U)` is calculated independently from the canonical unsigned transaction. It MUST NOT be copied from an unverified payload `hash` value.

When `success` is `false`, `errorReason` MUST be present. `network` and `transaction` remain required by the core response schema, including the rules for `transaction` in this section. `payer` and `amount` SHOULD be present whenever they can be derived reliably, but MAY be omitted when failure occurs before that derivation is possible.

```json
{
  "success": true,
  "payer": "NMqq8yB3ybgQ6Wzk7mpKvhte7s4yxyL3L5",
  "transaction": "0x547617532fab4cc38765f1d7fddde29e6c5920bd4af2f7fb357e50555e880505",
  "network": "neo:894710606",
  "amount": "10000000"
}
```

A non-terminal response after broadcast is:

```json
{
  "success": false,
  "errorReason": "settlement_pending",
  "payer": "NMqq8yB3ybgQ6Wzk7mpKvhte7s4yxyL3L5",
  "transaction": "0x547617532fab4cc38765f1d7fddde29e6c5920bd4af2f7fb357e50555e880505",
  "network": "neo:894710606",
  "amount": "10000000"
}
```

## Resource Fulfillment and Retries

Neo rejects an identical transaction after it enters the mempool or ledger, and the facilitator's atomic settlement cache prevents concurrent workers from signing or broadcasting it independently. To recover after a lost or timed-out response, a reconciled request MAY receive the same successful `SettlementResponse` as the original request. This confirms the existing on-chain settlement and does not authorize multiple logical fulfillments.

After settlement succeeds and before executing the protected operation, the resource server MUST atomically consume `(network, transactionHash)` and allow that key to fund at most one logical fulfillment. A retry for the same fulfillment MAY reuse its stored result, but reuse for another fulfillment MUST be rejected. Horizontally scaled servers MUST share this atomic state, and successful consumption records MUST be retained so that the payment cannot later become reusable.

The resource server MUST NOT execute the protected operation when settlement is pending or has failed. Once settlement succeeds, the payment is final even if the protected operation later fails or its response cannot be delivered. Resource servers SHOULD make retry behavior idempotent and define an operational refund or recovery policy appropriate to the resource.

## Security Considerations

### Cross-network replay

The CAIP-2 reference supplies `N` in the signing message `M = uint32_le(N) || H`. Facilitators MUST use that exact value when verifying signatures and MUST verify that the Network Magic obtained from their trusted network source is the same value. The settlement cache key includes the network because the Neo transaction hash itself excludes Network Magic.

### Transaction mutation

The payer signature covers every unsigned transaction field, including signer order, scopes, fees, validity, and payment script. The only permitted completion is adding valid facilitator signatures and their derived parameter values to the incomplete fee-payer entry in `items`. The unsigned `data` and its hash cannot change. Byte-for-byte canonical payment-script validation prevents an attacker from appending additional calls or substituting a semantically similar script with different behavior.

### Fee-payer isolation

The sponsored fee payer has `WitnessScope.None`, is not a payment source, and MUST NOT authorize contract activity or appear as the source of an observed NEP-17 transfer. Exact fee calculation and a local total-fee cap prevent a client from draining the facilitator through inflated fees. A custom fee-payer verification contract is not accepted because its behavior cannot be inferred safely from an advertised address alone.

### Payer witness scope

The payer has `CalledByEntry`, which permits the directly invoked NEP-17 contract to use the `System.Runtime.CheckWitness` interoperable service for the payer without granting global authority. Restricting the transaction to one canonical call, then inspecting preflight and persisted events, limits the signature to the required payment outcome.

### Contract recipients and transfer data

NEP-17 transfers to deployed contracts may invoke `onNEP17Payment`, which receives Neo VM `null` when `transferData` is absent or its exact UTF-8 byte string when present. The recipient therefore cannot be validated as an externally controlled account only. Facilitators MUST rely on exact preflight execution before resource execution and the persisted application log after broadcast. Any callback fault makes the payment invalid.

When present, `transferData` is embedded in the signed transaction script and is public. Resource servers and clients MUST NOT place secrets or sensitive personal information in it. The facilitator validates its exact value but does not interpret its application meaning or treat it as a unique identifier. The transaction hash remains the settlement identity and resource-level atomic consumption key whether or not `transferData` is present.

### RPC trust and incomplete results

Facilitators depend on trusted node interfaces for protocol settings, state, preflight execution, mempool visibility, broadcast, and persisted execution results. For production deployments, they SHOULD use a local, trusted, well-synchronized Neo RPC node under their operational control rather than rely on a public third-party endpoint. Equivalent local node or execution-engine interfaces MAY be used when they provide the same results required by this specification. Facilitators SHOULD fail closed when a security-relevant result is missing, inconsistent, or cannot be decoded. A broadcast followed by an uncertain read is reported as `settlement_pending`, not as success or a safe-to-retry terminal failure.

### Payload consistency

The `ContractParametersContext` JSON representation intentionally repeats information: `hash` commits to `data`, `network` repeats the CAIP-2 reference, keys in `items` repeat signer accounts, and signature values appear in both `parameters` and `signatures`. Facilitators MUST cross-check every representation and MUST NOT choose one conflicting value as authoritative.

### Payload size and resource exhaustion

The [HTTP transport](../../transports-v2/http.md#payment-payload-transmission) carries `PaymentPayload` as Base64-encoded JSON in the `PAYMENT-SIGNATURE` header. The scheme-specific payload is larger than a raw transaction, especially for multisignature accounts. Clients, resource servers, and facilitators SHOULD enforce a decoded-payload size limit consistent with the Neo transaction and multisignature limits they support, and HTTP deployments MUST configure a sufficient but bounded request-header limit.

Implementations SHOULD define local, finite resource limits and reject work that exceeds them. Relevant limits include encoded and decoded payload size, numeric input length, RPC request and response size, RPC and confirmation timeouts, preflight gas and execution time, notification count, concurrent signature checks and preflights, pending settlement records, and aggregate sponsorship exposure. Public facilitators SHOULD also consider rate limits and supported-asset or recipient policies. Cheap structural and size checks SHOULD run before Base64 decoding, transaction parsing, elliptic-curve verification, RPC calls, or VM preflight whenever possible. The appropriate values depend on the deployment and network and are intentionally not fixed by this specification.

## Appendix: Test Vectors

### TestNet T5 fixture

The examples and vectors below use the following fixed TestNet T5 fixture generated and round-tripped with Neo 3.10.0. The fixture is for serialization and signature interoperability; its fixed `ValidUntilBlock` will expire and it is not intended for broadcast.

| Value | Fixture |
| --- | --- |
| Network Magic | `894710606` |
| Address version | `53` |
| Fixture height | `18762412` |
| `maxTimeoutSeconds` | `60` |
| `ValidUntilBlock` | `18762434` |
| GAS asset | `0xd2a4cff31913016155e38e474a2c06d08be276cf` |
| Amount | `10000000` (`0.1` GAS) |
| Optional transfer data | `4f8c2e31-6d78-4a5b-9c01-2e3f4a5b6c7d` |
| Payer | `NMqq8yB3ybgQ6Wzk7mpKvhte7s4yxyL3L5` |
| Payer script hash | `0x02ee2302206e3c50b055357f71d568dc9ade2715` |
| Recipient | `NaSxHhUMrJkVGaJyC98fnccjNXoGEGPps5` |
| Recipient script hash | `0xb6740c17d4c52253d615d2a8e158a54514e86d9f` |
| Facilitator fee payer | `NZDH4xUF8s82AJhg6swoH9tvmHG71FEzrS` |
| `SystemFee` | `215933` (`0.00215933` GAS) |
| Payer-paid `NetworkFee` | `38504` (`0.00038504` GAS) |
| Sponsored `NetworkFee` | `73868` (`0.00073868` GAS) |

### Sponsored `PaymentPayload`

The following complete sponsored-mode example uses the [TestNet T5 fixture](#testnet-t5-fixture). A payer-paid payload uses the same envelope and restricted `ContractParametersContext` structure with the payer-paid signer layout and its single complete payer entry.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather"
  },
  "accepted": {
    "scheme": "exact",
    "network": "neo:894710606",
    "amount": "10000000",
    "asset": "0xd2a4cff31913016155e38e474a2c06d08be276cf",
    "payTo": "NaSxHhUMrJkVGaJyC98fnccjNXoGEGPps5",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "signedTransaction",
      "paymentFlow": "upfront",
      "transferData": "4f8c2e31-6d78-4a5b-9c01-2e3f4a5b6c7d",
      "feePayerVerificationScript": "DCEDPOXX4lthqMpa+30XnFphsw+b/bhbllIFAkDyuQwKOvlBVuezJw=="
    }
  },
  "payload": {
    "type": "Neo.Network.P2P.Payloads.Transaction",
    "hash": "0x547617532fab4cc38765f1d7fddde29e6c5920bd4af2f7fb357e50555e880505",
    "data": "AIBwYFB9SwMAAAAAAIwgAQAAAAAAwkoeAQKR36JjnceS7GrFIoC9oa6Su732eQAVJ96a3GjVcX81VbBQPG4gAiPuAgEAgAwkNGY4YzJlMzEtNmQ3OC00YTViLTljMDEtMmUzZjRhNWI2YzdkAoCWmAAMFJ9t6BRFpVjhqNIV1lMixdQXDHS2DBQVJ96a3GjVcX81VbBQPG4gAiPuAhTAHwwIdHJhbnNmZXIMFM924ovQBixKR47jVWEBExnzz6TSQWJ9W1I5",
    "items": {
      "0x79f6bdbb92aea1bd8022c56aec92c79d63a2df91": {
        "script": "DCEDPOXX4lthqMpa+30XnFphsw+b/bhbllIFAkDyuQwKOvlBVuezJw==",
        "parameters": [
          {
            "type": "Signature"
          }
        ],
        "signatures": {}
      },
      "0x02ee2302206e3c50b055357f71d568dc9ade2715": {
        "script": "DCEDH2TaijjmweVCOnLd1tT8Snd6vlN+XLWqBCVoXNqOBjtBVuezJw==",
        "parameters": [
          {
            "type": "Signature",
            "value": "heWfgjBSYQ/ImrRUnvMoHfulfnpYtV2BJpQVsXsuk/47mbAJsN7nn0SbH7/4wN28afFRmLzSmF1gIDap1Lb/iA=="
          }
        ],
        "signatures": {
          "031f64da8a38e6c1e5423a72ddd6d4fc4a777abe537e5cb5aa0425685cda8e063b": "heWfgjBSYQ/ImrRUnvMoHfulfnpYtV2BJpQVsXsuk/47mbAJsN7nn0SbH7/4wN28afFRmLzSmF1gIDap1Lb/iA=="
        }
      }
    },
    "network": 894710606
  },
  "extensions": {}
}
```

### Canonical payment and account scripts

Canonical payment script:

```text
DCQ0ZjhjMmUzMS02ZDc4LTRhNWItOWMwMS0yZTNmNGE1YjZjN2QCgJaYAAwUn23oFEWlWOGo0hXWUyLF1BcMdLYMFBUn3prcaNVxfzVVsFA8biACI+4CFMAfDAh0cmFuc2ZlcgwUz3bii9AGLEpHjuNVYQETGfPPpNJBYn1bUjk=
```

Payer standard verification script:

```text
DCEDH2TaijjmweVCOnLd1tT8Snd6vlN+XLWqBCVoXNqOBjtBVuezJw==
```

Facilitator standard verification script:

```text
DCEDPOXX4lthqMpa+30XnFphsw+b/bhbllIFAkDyuQwKOvlBVuezJw==
```

### Final transactions and hashes

The payer-paid transaction hash is:

```text
0x2e338d1e83cb7a279d7827e0bf8a95116111422278f041720226fcd884b70c6d
```

The complete payer-paid `ContractParametersContext` produces the following canonical transaction:

```text
AEAwIBB9SwMAAAAAAGiWAAAAAAAAwkoeAQEVJ96a3GjVcX81VbBQPG4gAiPuAgEAgAwkNGY4YzJlMzEtNmQ3OC00YTViLTljMDEtMmUzZjRhNWI2YzdkAoCWmAAMFJ9t6BRFpVjhqNIV1lMixdQXDHS2DBQVJ96a3GjVcX81VbBQPG4gAiPuAhTAHwwIdHJhbnNmZXIMFM924ovQBixKR47jVWEBExnzz6TSQWJ9W1I5AUIMQJJNMs9548HX8fxWPZ05Tgt9ghtQCM+9lBernmN/P6WciUpAT2+cnpmiF3qrU9gyESzzYnzTdJFBZBNqNYUAlgQoDCEDH2TaijjmweVCOnLd1tT8Snd6vlN+XLWqBCVoXNqOBjtBVuezJw==
```

The client-supplied sponsored `ContractParametersContext` in the [`PaymentPayload` example](#sponsored-paymentpayload) is incomplete only at the fee-payer entry in `items`. After the facilitator adds this fixture's fee-payer signature, the completed `ContractParametersContext` produces the following canonical transaction:

```text
AIBwYFB9SwMAAAAAAIwgAQAAAAAAwkoeAQKR36JjnceS7GrFIoC9oa6Su732eQAVJ96a3GjVcX81VbBQPG4gAiPuAgEAgAwkNGY4YzJlMzEtNmQ3OC00YTViLTljMDEtMmUzZjRhNWI2YzdkAoCWmAAMFJ9t6BRFpVjhqNIV1lMixdQXDHS2DBQVJ96a3GjVcX81VbBQPG4gAiPuAhTAHwwIdHJhbnNmZXIMFM924ovQBixKR47jVWEBExnzz6TSQWJ9W1I5AkIMQDYCARcw23I+AYjUXsT5x8SE2/FMWGWzDop6THO6X9UIBHsKMtv1+A6PeYjThuAUi0thIfzmgYAa/w03BZ9YLtgoDCEDPOXX4lthqMpa+30XnFphsw+b/bhbllIFAkDyuQwKOvlBVuezJ0IMQIXln4IwUmEPyJq0VJ7zKB37pX56WLVdgSaUFbF7LpP+O5mwCbDe559Emx+/+MDdvGnxUZi80phdYCA2qdS2/4goDCEDH2TaijjmweVCOnLd1tT8Snd6vlN+XLWqBCVoXNqOBjtBVuezJw==
```

The sponsored transaction hash is:

```text
0x547617532fab4cc38765f1d7fddde29e6c5920bd4af2f7fb357e50555e880505
```

This hash equals the original `hash` in the sponsored `ContractParametersContext`; completing the fee-payer entry and constructing witnesses do not change it.

### Multisignature account vector

An example canonical 2-of-3 standard multisignature verification script and its T5 address are:

```text
EgwhAgIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtDCEDUadYCDOJjqGxg8vXNQpAmQeMbvHB4Y6XDNdoMDXyXn0MIQPWWpOXfKo9GwgYUv9Xp55GXxZgV3MEuurVBd06SFic8xNBntDcOg==
```

```text
NY9VNmP9d5EeSaWTUmRcSSmhRrQbuvUSxg
```

The vectors were parsed and round-tripped using the `ContractParametersContext` representation defined by NEP-21 with Neo 3.10.0. They were checked for canonical unsigned and final transaction serialization, strict Base64 round-trip, correspondence between entries in `items` and signers, address and script-hash derivation, signature validity under T5 Network Magic, signer/witness ordering, single-signature and multisignature script construction, deterministic witness construction, and an unchanged sponsored transaction hash after the fee-payer entry was completed. The system fee was measured from an equivalent successful GAS transfer simulation, and the final transactions' network fees were checked against a T5 Neo RPC at the fixture height. Neo 3.10.0 is identified here only as an interoperability test implementation; conformance is determined by the normative byte and data rules in this document.

## References

- [x402 v2 core specification](../../x402-specification-v2.md)
- [`exact` scheme](./scheme_exact.md)
- [CAIP-2: Blockchain ID Specification](https://standards.chainagnostic.org/CAIPs/caip-2)
- [Neo CAIP-2 namespace profile](https://github.com/ChainAgnostic/namespaces/blob/main/neo/caip2.md)
- [NEP-17: Token Standard](https://github.com/neo-project/proposals/blob/master/nep-17.mediawiki)
- [NEP-21: dAPI for N3](https://github.com/neo-project/proposals/blob/master/nep-21.mediawiki)
- [Neo N3 transactions, witnesses, and signature scopes](https://docs.neo.org/docs/n3/foundation/Transactions.html)
- [Neo N3 standard and multisignature accounts](https://docs.neo.org/docs/n3/foundation/Wallets.html)
- [NeoVM opcodes](https://docs.neo.org/docs/n3/reference/opcodes.html)
- [Neo interoperability services](https://docs.neo.org/docs/n3/reference/scapi/interop.html)
- [Neo N3 `CallFlags`](https://docs.neo.org/docs/n3/reference/scapi/framework/services/CallFlags.html)
- [RFC 4648: Base-N Encodings](https://www.rfc-editor.org/rfc/rfc4648)
- [Neo RPC API](https://docs.neo.org/docs/n3/reference/rpc/api.html)
- [`getversion`](https://docs.neo.org/docs/n3/reference/rpc/getversion.html)
- [`getblockcount`](https://docs.neo.org/docs/n3/reference/rpc/getblockcount.html)
- [`getcontractstate`](https://docs.neo.org/docs/n3/reference/rpc/getcontractstate.html)
- [`invokescript`](https://docs.neo.org/docs/n3/reference/rpc/invokescript.html)
- [`calculatenetworkfee`](https://docs.neo.org/docs/n3/reference/rpc/calculatenetworkfee.html)
- [`sendrawtransaction`](https://docs.neo.org/docs/n3/reference/rpc/sendrawtransaction.html)
- [`getrawtransaction`](https://docs.neo.org/docs/n3/reference/rpc/getrawtransaction.html)
- [`getapplicationlog`](https://docs.neo.org/docs/n3/reference/rpc/getapplicationlog.html)
