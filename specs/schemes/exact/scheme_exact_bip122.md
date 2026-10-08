# Scheme: `exact` on Bitcoin (`bip122`)

## Summary

This specification defines native on-chain Bitcoin payments for x402 v2 `exact`. The payer's wallet signs and broadcasts the payment, then the client presents its transaction outputs as proof. The resource server checks the payment against its issued requirements and records it as used before executing the requested operation.

The resource server MAY perform settlement locally or delegate it to a facilitator. A separate facilitator service is not required. The payer funds the mining fee. The method supports one payment output or several outputs whose values add up to the requested amount.

The method belongs to the client-submitted family and uses `upfront`. The simplest configuration accepts one confirmed output. Multiple outputs and zero-confirmation acceptance are independent capabilities, enabled only by the issued requirements and the settlement implementation's advertised limits.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are normative requirements.

## Scheme and Networks

Networks use the CAIP-2 `bip122` namespace. The reference is the first 32
hexadecimal characters of the network's genesis block hash.

| Network | Identifier | Witness prefix | P2PKH version | P2SH version |
| --- | --- | --- | --- | --- |
| Bitcoin mainnet | `bip122:000000000019d6689c085ae165831e93` | `bc` | `0x00` | `0x05` |
| Bitcoin testnet4 | `bip122:00000000da84f2bafbbc53dee25a72ae` | `tb` | `0x6f` | `0xc4` |
| Bitcoin regtest, for local testing | `bip122:0f9188f13cb7b2c71f2a335e3a4fc328` | `bcrt` | `0x6f` | `0xc4` |

Implementations MUST check the configured backend's full genesis hash against the selected network and use Bitcoin-validating chain evidence. Genesis alone cannot distinguish Bitcoin from forks sharing its history. Address encoding alone does not identify a chain. Support for one network MUST NOT imply support for every `bip122` network.

`asset` MUST be `"BTC"`.

## Asset Transfer Method and Payment Flow

`onchain` is the only supported asset transfer method and the default for this mechanism. An omitted `extra.assetTransferMethod` MUST resolve to `"onchain"`; any explicit value MUST be `"onchain"`. Servers SHOULD include the selector explicitly. Default resolution does not permit changing an issued requirement when constructing `accepted`.

`upfront` is the only supported flow. Every requirement MUST set `extra.paymentFlow` to `"upfront"`. The order is settlement, resource execution, response. Settlement validates an already-submitted payment and records its consumption; it does not submit a transaction.

Bitcoin permits signing without broadcasting, but some exchange withdrawal interfaces, custodial wallets and wallet tools expose only a send operation. A client using such an interface cannot obtain a signed but unsubmitted payment. This method supports such interfaces when the client can establish the net recipient amount and obtain the transaction references. It does not require a wallet to export signed transaction bytes, use a particular input script or obtain a facilitator's signature.

The protocol sequence is:

1. The client requests a resource.
2. The resource server issues a `PaymentRequired` containing immutable requirements, a private payment identifier and a fresh recipient address bound to the operation.
3. The client validates and saves the requirements, then instructs its wallet to sign and broadcast one or more transactions paying that address.
4. The client repeats the operation with a v2 `PaymentPayload`. Its proof identifies the payment outputs by `txid` and `vout`.
5. The resource server authenticates the original requirements and operation. It performs settlement locally or passes the payload and authoritative requirements to its chosen facilitator.
6. Settlement checks the complete output set against one consistent chain view, including mempool evidence when accepting unconfirmed payments. If the amount or confirmation policy is unmet, it consumes nothing and returns the relevant error.
7. Once every check passes, settlement atomically records all outputs and the payment identifier as consumed. Exactly one call receives a successful `SettleResponse`.
8. The resource server executes the bound operation and returns its result through the selected transport. Retries recover the existing operation under the rules below.

The normal `upfront` flow omits a separate verify call. Settlement performs all validation. An implementation MAY expose read-only verification, but verification MUST NOT reserve or consume a payment, broadcast a transaction or authorise resource execution.

These steps apply to any x402 transport. Message encoding and delivery follow the selected [v2 transport specification](../../transports-v2).

## Amounts

The wire `amount` uses satoshis. One BTC is 100,000,000 satoshis.

`amount` MUST be a positive canonical decimal string without a sign, fraction, exponent, separator, unit suffix or leading zero. Its maximum is `2100000000000000`. The payment outputs MUST total exactly `amount` satoshis. Implementations MUST use integer arithmetic without floating-point conversion. Mining fees are additional; they MUST NOT be deducted from the required output total.

Examples:

| Meaning | Wire `amount` |
| --- | ---: |
| 1 satoshi | `"1"` |
| 10,000 satoshis | `"10000"` |
| 1 bitcoin | `"100000000"` |

User-facing SDKs MUST use explicit atomic `AssetAmount` pricing by default, for example `{ "asset": "BTC", "amount": "10000" }`. They MAY support qualified inputs such as `"10000 sats"`. A bare application price such as `"1"` or `1` MUST NOT silently mean one satoshi; fiat or other convenience prices require a registered conversion parser. This restriction concerns application pricing inputs, not the canonical integer string in `PaymentRequirements.amount`.

The `bip122` and `lnbtc` namespaces identify separate mechanisms. Implementations MUST dispatch on the complete network identifier and MUST NOT copy a numeric BTC amount between them without an explicit unit conversion. The Lightning mechanism uses millisatoshis under `lnbtc`; its method defaults do not apply here.

The issued BTC amount is fixed. Exchange-rate movement MUST NOT change the requirements for an existing payment. A top-up completes the original amount; this method defines no transfer of partial credit into a replacement quote after expiry.

## `PaymentRequirements`

This decoded `PaymentRequired` example requests 10,000 satoshis. Its address is a BIP-173 test vector with a publicly known private key and MUST NOT receive funds. The identifier and timestamps are illustrative.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/report",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "bip122:000000000019d6689c085ae165831e93",
      "amount": "10000",
      "asset": "BTC",
      "payTo": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      "maxTimeoutSeconds": 7200,
      "extra": {
        "assetTransferMethod": "onchain",
        "paymentFlow": "upfront",
        "paymentId": "7b9e81c023d46fa598e6d304ca1f7260ef083cb519ad47e26f953a80d642c1bb",
        "issuedAt": 1790000000,
        "expiresAt": 1790007200,
        "recoveryUntil": 1790093600,
        "minConfirmations": 1,
        "maxPaymentOutputs": 8,
        "latePaymentPolicy": "no-automatic-refund"
      }
    }
  ]
}
```

The shared fields follow the [x402 v2 specification](../../x402-specification-v2.md).

The `extra` fields are:

| Field | Required | Meaning |
| --- | --- | --- |
| `extra.assetTransferMethod` | No | If present, MUST be `"onchain"`; defaults to `"onchain"`. Servers SHOULD include it explicitly. |
| `extra.paymentFlow` | Yes | MUST be `"upfront"`. |
| `extra.paymentId` | Yes | 32 cryptographically random bytes encoded as 64 lowercase hexadecimal characters. |
| `extra.issuedAt` | Yes | Non-negative JSON integer, Unix time in seconds. |
| `extra.expiresAt` | Yes | JSON integer greater than `issuedAt`, exclusive deadline for first successful settlement. |
| `extra.recoveryUntil` | Yes | JSON integer at least `expiresAt`, inclusive minimum deadline for recovery of an existing settlement. |
| `extra.minConfirmations` | Yes | Non-negative JSON integer chosen by the resource server; `0` explicitly permits mempool acceptance. |
| `extra.maxPaymentOutputs` | Yes | Positive JSON integer limiting the number of outputs in one proof; `1` requires a single output. |
| `extra.latePaymentPolicy` | Yes | `"no-automatic-refund"`; see [Deadline Policy and Retention](#deadline-policy-and-retention). |
| `extra.issuanceToken` | No | Opaque string authenticating stateless issuance; clients preserve it unchanged. |

`maxTimeoutSeconds` MUST be a positive JSON integer equal to `expiresAt - issuedAt`.

`payTo` MUST be a canonically encoded P2PKH, P2SH, P2WPKH, P2WSH or P2TR address on the selected network, issued exclusively for this operation. Witness addresses use lowercase.

JSON number fields MUST be safe integers. The server MUST choose confirmation and output-count limits supported by its settlement implementation. No default confirmation depth is inferred from a missing field. Before issuing requirements, the server SHOULD check that the requested amount can be paid under the intended node's output and dust policies.

Legacy addresses MUST pass Base58Check with the network's version byte and a 20-byte payload. Witness version 0 MUST use Bech32 and a 20-byte or 32-byte program; version 1 MUST use Bech32m and a 32-byte program. Other witness versions and lengths are unsupported. Witness addresses MUST use the selected network's prefix and canonical lowercase encoding, with valid checksum and padding.

## Request Binding

The resource server MUST authenticate the complete issued requirements and the operation they authorise, keyed by `paymentId`. It MAY store them or authenticate them through `issuanceToken`. A token MUST protect every requirement except itself, and the operation binding, against alteration. The binding MUST cover the resource, its action, every input affecting execution or price, and any application identity on which access depends.

Key rotation MUST preserve authentication of unexpired requirements and recovery of committed payments through `recoveryUntil`. Retained verification keys or durable authenticated issuance records MAY provide this continuity.

On each paid retry, the server MUST restore or authenticate the original issuance and compare every requirement field with `accepted`. Object member order is immaterial. Unknown identifiers, changed requirements and changed operations MUST be rejected. A retry MUST NOT generate a new address, identifier or deadline for an existing payment.

`paymentId` is a bearer capability for the bound operation. Clients and servers MUST keep it confidential, use an authenticated confidential transport, and exclude it from public logs and on-chain data. Public transaction identifiers and recipient addresses MUST NOT suffice to retrieve or resume an operation. A delegated facilitator receives this bearer capability. Where execution or its result is sensitive, applications SHOULD require client authentication independent of `paymentId` and bind that identity to the operation. Other applications MAY require it.

The recipient script MUST be unique to the issued payment and MUST never be reassigned, including after expiry. Address generation MAY use a local wallet, public descriptor or service. Requirements MUST NOT be shared between clients or cached for reuse. Discovery services MAY publish prices and capabilities; clients MUST obtain fresh requirements before paying.

A delegated facilitator MUST authenticate the resource server and its acceptance domain. The server supplies authoritative requirements after checking the operation binding; the client's `accepted` alone is insufficient. No advance facilitator registration of invoices or disclosure of wallet descriptors is required.

Servers SHOULD rate-limit issuance and transaction lookups. Address allocation MUST survive restart and backup restoration without reuse. A durable allocation counter can avoid storing every unpaid challenge, but wallet recovery must cover the allocated range instead of relying only on a default gap limit.

## `PaymentPayload`

The client MUST copy the selected requirements into `accepted` and use `x402Version: 2`. The method-specific `payload` MUST contain exactly one field, `outputs`, which is a non-empty array of payment output references.

| Field | Type | Requirements |
| --- | --- | --- |
| `outputs[].txid` | `string` | Non-witness transaction identifier, 64 lowercase hexadecimal characters in Bitcoin's displayed byte order. |
| `outputs[].vout` | `number` | Zero-based output index; non-negative safe JSON integer; first settlement requires it to be within the referenced transaction's output count. |

Each reference MUST contain exactly `txid` and `vout`. References MUST be unique and ordered lexicographically by `txid`, then numerically by `vout`. The array length MUST NOT exceed `maxPaymentOutputs`. Duplicate references MUST be rejected before summing values. A single payment uses a one-element array. Recovery requires this bounded shape but uses the stored commitment; funding checks on the presented outputs apply only to a first settlement.

A method-specific payload has this shape; these identifiers are placeholders, not transaction test vectors:

```json
{
  "outputs": [
    {
      "txid": "1111111111111111111111111111111111111111111111111111111111111111",
      "vout": 0
    },
    {
      "txid": "2222222222222222222222222222222222222222222222222222222222222222",
      "vout": 1
    }
  ]
}
```

For a first settlement, every listed output MUST pay the script decoded from `payTo`. Their integer values MUST sum to exactly `amount` satoshis. Outputs may come from one transaction or several transactions. Transactions MAY contain change and other payments. Bitcoin-valid input scripts and signature hash types are not restricted by this method. Transaction validation is supplied by the validating backend; a `txid` alone is not a self-verifying proof.

For a first settlement, amount acceptance concerns the listed outputs. The method MUST NOT use the address's current balance or cumulative receipts to decide whether a proof is exact. Unlisted transfers grant no additional resource or credit and MUST NOT invalidate an otherwise valid proof. Listing outputs whose sum is below or above the requirement fails first settlement without consuming any output. This method provides no automatic refund for excess or incomplete payments.

## Optional Capabilities

All configurations use the same `outputs` array and validation rules. An implementation MAY support only one output with positive confirmation depth. The server MUST advertise and issue only configurations its settlement implementation supports.

### Multiple Payment Outputs

`maxPaymentOutputs: 1` requires one output. Larger values permit split payments and top-ups, including outputs from different transactions. Every selected output must meet the advertised confirmation policy. Settlement claims the complete exact set atomically; a partial set creates no credit or execution entitlement. The multi-transaction receipt rule is defined under [Settlement Response](#settlement-response).

Clients SHOULD check that both each planned output and any remaining top-up can meet the intended node's relay and dust policies. A shortfall below those policies may be impossible to complete with another standard output. An output exceeding the entire quote cannot belong to an exact proof. If the wallet can replace an unconfirmed payment, it MAY correct the recipient amount before acceptance. Confirmed mistakes may require a separate merchant remedy; the method cannot promise an exact top-up or refund for every shortfall.

### Zero Confirmations

The merchant MAY explicitly choose `minConfirmations: 0` when its settlement implementation advertises that capability. A transaction may then satisfy the policy through current acceptance in the validating node's mempool or through active-chain inclusion. Mempool transactions in one proof MUST coexist in the same validated view, including their ancestors. A client's broadcast claim or an old callback is insufficient evidence. The merchant owns replacement, eviction and double-spend risk; zero-confirmation acceptance does not establish irreversible payment.

## Client Payment Construction

Payment can complete even if the resource subsequently fails. The client MUST approve the payment order, mining fees, confirmation policy and expiry disposition before broadcasting.

Before initiating a payment or top-up, the client MUST establish the amount the recipient will receive after mining fees and withdrawal deductions. The planned proof, including selected existing outputs and planned top-ups, MUST be capable of satisfying the exact amount and output-count rules. If a send-only interface cannot establish a conforming recipient amount or provide the transaction references, the client MUST NOT initiate payment through it. A fee-deducting withdrawal can leave a shortfall too small for a standard top-up; this method cannot repair such a payment automatically.

Clients MUST save the requirements before broadcasting and persist transaction references as payments are sent. On a lost broadcast result they MUST reconcile through their wallet or backend before sending more funds. On retry they MUST preserve the original requirements and account for existing payments. An error, missing callback or fresh payment-required response MUST NOT automatically trigger another full payment.

After an ambiguous settlement response, the client SHOULD retry its existing proof before sending a top-up or replacement. An already-settled response confirms the existing purchase; it is never an instruction to fund it again.

Clients MAY replace unaccepted transactions or add payments under the advertised output limit. Before the first settlement, every revised set undergoes all payment checks again. Conflicting alternatives cannot both count toward the total. Clients SHOULD use bounded backoff and the selected transport's retry guidance.

Clients SHOULD submit and reconcile their proof promptly within the payment window. They MUST NOT assume that background monitoring will commit a payment before expiry. A merchant's monitoring service does not extend the deadline.

## Settlement Validation

Settlement MUST perform these checks in order:

1. Validate the immutable envelope and field encodings, resolved method, explicit flow, and proof shape against the originally issued output-count bound. Authenticate issuance and the operation, and require exact `accepted` matching. Do not apply current capability limits at this step.
2. If a committed claim exists for this issuer, payment identifier, original requirements and operation, follow [Recovery](#recovery). The presented output set may differ; it MUST NOT replace the stored claim or cause additional outputs to be consumed.
3. For a first settlement, require currently supported scheme, network and policies and authoritative time strictly before `expiresAt`. `issuedAt` is issuance metadata, not a not-before condition. A request after expiry MUST NOT become a new success, even if its payment already confirmed. Servers SHOULD preserve support for issued requirements until they expire.
4. Resolve each distinct transaction through a Bitcoin-validating node or trusted provider. Verify its canonical `txid`, every selected index, recipient script and output value. The complete set must satisfy the amount rule.
5. Establish the acceptance evidence for every selected transaction using the consistent-view rules below. Independently cached observations that could describe conflicting transactions or ancestors at different times MUST NOT be combined.
6. Recheck the deadline and all claim conflicts during the atomic commitment described below. Implementations MUST bound the age of their acceptance evidence and refresh it before commitment if processing or lock waits make it stale. If a fresh consistent view cannot be established, return without consuming any output.

For confirmed transactions, confirmations equal `tipHeight - inclusionHeight + 1`. The inclusion block MUST be an ancestor of the observed active-chain tip. Every selected transaction MUST reach the advertised `minConfirmations`.

### Consistent Evidence

A consistent view establishes that every selected transaction could coexist at one observation point in the configured validating backend. Confirmed evidence MUST identify an active-chain tip and each transaction's inclusion block. Mempool evidence MUST establish current validated membership in the configured node. When a proof spans multiple transactions, that evidence MUST identify a common mempool state and its associated chain state. A locally assigned `viewId` or a sequence of unrelated REST responses does not establish this property.

For confirmed payments, an implementation MAY use the following procedure. Read the tip hash, obtain the transactions and their inclusion blocks, verify every inclusion block is an ancestor of that tip, then read the tip hash again. It MUST discard the view if the tip changed or any ancestry check fails. An indexer MAY instead supply a snapshot identifier with equivalent consistency guarantees.

When all selected outputs belong to one unconfirmed transaction, a fresh observation of its membership in one validating node's mempool MAY establish the view. The observation MUST establish current validated membership, including the node's validation of unconfirmed ancestors. Bitcoin Core's `getmempoolentry` is one such observation. Transaction data MAY be obtained separately if its canonical `txid` is checked. A raw transaction lookup, an unconfirmed status flag or a cached callback alone is insufficient without equivalent documented membership guarantees. The evidence-age limit below still applies.

For proofs spanning more than one distinct transaction and containing an unconfirmed transaction, a single pass over one node's individual transaction endpoints is insufficient. This includes a proof combining confirmed transactions with one unconfirmed transaction. An implementation MAY use a backend snapshot that covers the chain and mempool. Alternatively, it MAY bracket its reads with the active tip hash and a mempool version that changes on additions and removals, such as Bitcoin Core's `mempool_sequence`. Both markers MUST remain unchanged, every selected unconfirmed transaction must be in that mempool, and confirmed inclusion must satisfy the ancestry check. A node restart, reconnection without continuity, or an intervening marker change invalidates the view. Nodes with different mempools MUST NOT be combined.

Implementations MUST configure a finite maximum evidence age, measured with a monotonic elapsed-time source. At commitment, evidence older than that limit must be refreshed and revalidated. Backend consistency contracts and the configured age limit MUST be documented and tested. These checks establish a recent observation; they cannot prevent a subsequent replacement or reorganisation.

Absence of opt-in RBF signalling MUST NOT be treated as proof that a transaction cannot be replaced. Before consumption, clients MAY present a replacement proof set satisfying the original requirements. After consumption, replacement, eviction or reorganisation MUST NOT reopen the invoice or authorise another execution.

Payment checks MUST inspect transaction history and outputs. They MUST NOT require a recipient output to remain unspent: the merchant may already have spent a valid payment. Implementations MUST NOT infer an authenticated payer or refund destination from transaction inputs.

A Bitcoin Core backend needs access to the relevant transaction history, for example through `txindex` with retained block data, a wallet watching the issued scripts, or an indexer. `gettxout` alone cannot establish receipt once an output has been spent. An arbitrary confirmed `txid` is not generally available from an unindexed node unless the verifier also knows its block and that block's data is available.

A provider or node outage, stale evidence, or inability to establish a consistent view MUST NOT produce settlement success. Callbacks and polling are implementation choices; either must supply the evidence required above.

## Settlement and Replay Protection

### Consumption and Duplicate Delivery

Each output's canonical payment key is:

```text
<CAIP-2 network>/<txid>:<vout>
```

`vout` uses decimal digits without leading zeroes, except `0`. The canonical proof set is the ordered list of these keys.

In one atomic transaction, settlement MUST ensure that every payment key and `(issuer, paymentId)` is unconsumed, then record them together with the full requirements, canonical proof set and settlement result. Any conflict MUST leave the entire set unconsumed by that attempt. A partial insert is forbidden. A different valid set paying the same invoice can never create another grant.

The claim store belongs to the authenticated merchant acceptance domain. All resource endpoints, workers and delegated providers accepting that merchant's issued requirements MUST share it or an equivalent single authority. Untrusted tenants MUST NOT be able to reserve or consume another merchant's keys merely by supplying fabricated requirements. The canonical wire key remains network and outpoint; tenant isolation is a storage-authority boundary.

Exactly one settle call obtains `success: true` for a payment identifier. A repeated claim returns failure. A matching authenticated owner retry returns `invalid_exact_bip122_already_settled` and the original transaction reference and network, including when its submitted output set has changed. Other claims on consumed outputs return `duplicate_settlement`.

If a proof otherwise satisfies its issued requirements, a conflicting claim for another issuance indicates recipient-script reuse or inconsistent issuance or claim state. Implementations SHOULD investigate that conflict. Ordinary authenticated retries recover the existing operation.

### Settlement from Monitoring

The resource server MAY initiate settlement from its payment monitor without waiting for another client request. It MUST use the authenticated original issuance and bound operation, construct a conforming output proof, and perform the same validation and atomic commitment before `expiresAt`. It MUST create or restore the durable operation record before doing so. A callback or a record that funds were observed is insufficient on its own.

For monitor-triggered settlement, the resource server MUST retain or independently reconstruct and authenticate the original requirements and bound operation for the observed recipient script. A token held only by the client is insufficient. An external monitoring provider need not receive the operation context. If several exact output sets qualify, settlement MAY select any one that satisfies the requirements; the commitment records the selected set.

The monitor records payment acceptance. Execution follows the bound operation's normal authorisation and recovery rules. A later client request recovers this existing commitment, even if the monitor selected a different qualifying output set. Monitoring and client-triggered settlement MUST share the same claim authority, so a race creates only one commitment. Monitoring is optional and does not require advance invoice registration with an external facilitator.

### Recovery

Before settlement, the resource server MUST create or restore its durable execution record for the operation. On first success, or an authenticated `invalid_exact_bip122_already_settled` result for its existing commitment, it atomically attaches that settlement to the same operation. Exactly one worker may obtain a new execution entitlement. Repeated requests retrieve or resume that operation.

Recovery of an existing settlement MUST be available through `recoveryUntil`, including after `expiresAt`. It uses the stored commitment and MUST NOT depend on current confirmations, backend availability or current advertised capabilities. The issuer, payment identifier, original requirements and operation MUST match, and normal application authentication and authorisation MUST still pass. The submitted proof must pass the bounded syntax checks, but its outputs need not match the committed set. Recovery MUST return the original reference and [payment-set extension](#settlement-response), retain the original set and consume no additional output. No other failure code authorises execution.

An altered proof on recovery grants no credit for new outputs and does not show that they were accepted. The stored original set remains the receipt authority.

Handlers with external side effects require application idempotency. This method limits a payment to one operation; it cannot guarantee exactly-once effects across independent systems. A lost result or failed handler does not authorise a second purchase or create an automatic refund.

Settlement storage outages MUST fail closed. Switching a monitoring provider does not change consumption authority. Changing settlement providers requires preserving that authority and its durable records. Blockchain history cannot reconstruct whether a resource was already granted.

Restoration from a backup that may omit a committed claim or execution entitlement MUST be treated as a settlement-storage outage for affected operations. Settlement and execution for those operations MUST remain blocked until authoritative state is recovered. An empty or incomplete restored store MUST NOT be treated as evidence that a payment is unused.

### Pending Payments, Top-ups and Replacements

These payment checks apply before the first commitment. Authenticated recovery of an existing commitment takes precedence.

When a known transaction has not reached the required depth, settlement MUST return `success: false` with `errorReason: "settlement_pending"`. It MUST NOT consume any output or permit resource execution. A proof containing one confirmed output and one pending output remains pending as a whole.

If a transaction cannot be observed, return `invalid_exact_bip122_payment_not_observed`. Its identifier alone does not prove broadcast. If the observed output total is short, return `invalid_exact_bip122_underpaid`. The client MAY add a top-up and present a new complete proof set against the same requirements before expiry. Overpayment in the presented set returns `invalid_exact_bip122_overpaid`.

Pending and failed attempts MUST NOT permanently bind an invoice to one transaction or proof set. Temporary locks MUST be released before returning. Crash leases MUST expire, with fencing that prevents an old worker committing after ownership has changed. None of these states consumes part of a payment.

One settle call MUST have a bounded duration independent of the payment deadline. No additional polling or callback endpoint is required by this method.

### Deadline Policy and Retention

`expiresAt` is the exclusive deadline for the first durable settlement commitment. It equals `issuedAt + maxTimeoutSeconds`. Payment observed or broadcast before expiry does not establish an entitlement to complete afterward. The commitment MUST recheck authoritative time. Client assertions and block timestamps cannot prove that an unrecorded settlement occurred before the deadline.

The server chooses a window suitable for its confirmation policy. The client MUST apply its own minimum remaining-window and fee policy before each payment or top-up. Fee estimates and average block intervals do not guarantee timely inclusion. Settlement may fail after funds have arrived, including during an outage.

`latePaymentPolicy: "no-automatic-refund"` declares that an unconsumed payment at expiry has no automatic resource entitlement or refund under this method. Requirements expiry does not expire a Bitcoin transaction, revoke signatures or prevent a late payment. A fiat quote and any wider checkout policy must be mapped to these deadlines explicitly.

Consumption records MUST remain until the requirements can no longer authorise a first claim and all in-flight workers using them have terminated or been fenced. Grant and recovery records MUST remain through `recoveryUntil` and while the operation is still executing. Implementations MAY retain them longer. After pruning, expired requirements MUST still fail; a node lookup MUST NOT recreate a missing grant.

The issuer and settlement workers MUST use an agreed authoritative source of Unix time for issuance and deadline decisions. The claim authority MUST prevent decreasing time readings or restored state from making an expired requirement eligible again, including across workers and restarts. If it cannot establish that property, it MUST fail closed. No comparison against `issuedAt` is required at settlement, and no implicit clock-skew grace extends `expiresAt`. Tests MUST cover equality at expiry and rollback after an expiry decision. Address-allocation history or equivalent never-reuse protection must outlive the proof's acceptance window. Its expiry does not permit assigning the script to another invoice.

A refund requires a separately authenticated return destination and a new transaction authorised by the merchant. It is outside this payment proof. The payer MUST NOT assume a return path exists.

## Settlement Response

Settlement uses the core `SettleResponse`. For a committed payment, `transaction` MUST contain the first `txid` in the canonical committed output set. Set digests and concatenated identifiers are invalid.

On first success and authenticated `invalid_exact_bip122_already_settled` recovery, the response MUST include `extensions["bip122-payment-set"]`, including for a single output or settlement from monitoring. It MUST return the stored committed set, even when the retry presents different outputs. Other settlement failures MUST omit this extension.

`bip122-payment-set` is mandatory response metadata for this method and requires no separate negotiation. Servers MUST NOT include it in `PaymentRequired.extensions`, and clients MUST NOT include it in `PaymentPayload.extensions`. Clients implementing this method MUST process a conforming extension on success or authenticated recovery without prior advertisement in `PaymentRequired`.

The extension's `info` MUST contain exactly `version: 1` and `outputs`. The outputs follow the encoding, uniqueness, ordering and original output-count bound in [`PaymentPayload`](#paymentpayload). Its `schema` MUST describe `info` as shown below; ordering and the issued bound require additional checks.

```json
{
  "success": true,
  "transaction": "1111111111111111111111111111111111111111111111111111111111111111",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "extensions": {
    "bip122-payment-set": {
      "info": {
        "version": 1,
        "outputs": [
          { "txid": "1111111111111111111111111111111111111111111111111111111111111111", "vout": 0 },
          { "txid": "2222222222222222222222222222222222222222222222222222222222222222", "vout": 1 }
        ]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["version", "outputs"],
        "additionalProperties": false,
        "properties": {
          "version": { "type": "integer", "const": 1 },
          "outputs": {
            "type": "array",
            "minItems": 1,
            "uniqueItems": true,
            "items": {
              "type": "object",
              "required": ["txid", "vout"],
              "additionalProperties": false,
              "properties": {
                "txid": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
                "vout": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 }
              }
            }
          }
        }
      }
    }
  }
}
```

The transaction identifiers are illustrative. `payer` is omitted because input addresses do not establish one authenticated payer.

Clients MUST preserve the returned set with the original requirements and check that the response `network` matches `accepted.network`. The extension records payment acceptance under the issued policy; it does not attest service delivery or irreversible confirmation.

The resource server MUST deliver this extension to the authorised client through the selected transport on first success and authenticated recovery. Access follows the request-binding and recovery rules, including availability through `recoveryUntil`. No separate receipt endpoint is required.

Pending responses MUST carry a transaction known to the backend: the first observed `txid` in canonical proof order, together with `network`. If none is observed, use the not-observed error with an empty `transaction`. Reconciliation MUST inspect the entire proof set. Same-owner recovery returns the original successful reference. Other failures MAY include a known transaction reference and MUST NOT imply acceptance.

## Error Vocabulary

| `errorReason` | Meaning |
| --- | --- |
| `invalid_payload` | Malformed, duplicate, unsorted or over-limit output references |
| `invalid_exact_bip122_asset_transfer_method` | An explicit method selector is not `onchain` |
| `invalid_exact_bip122_payment_flow` | Missing flow or a value other than `upfront` |
| `invalid_payment_requirements` | Unknown issuance, altered terms or operation, unsupported policy, or invalid units or time fields |
| `invalid_exact_bip122_payment_not_observed` | A referenced transaction cannot currently be observed; reconcile before paying again |
| `invalid_exact_bip122_recipient` | A listed output does not pay the issued script |
| `invalid_exact_bip122_underpaid` | The selected outputs total less than the requested amount |
| `invalid_exact_bip122_overpaid` | The selected outputs total more than the requested amount |
| `invalid_exact_bip122_payment_expired` | The completion deadline passed without a settlement commitment |
| `invalid_exact_bip122_already_settled` | An authenticated retry for the same committed requirements and operation; returns the original `bip122-payment-set` extension and grants recovery only |
| `duplicate_settlement` | A selected output was consumed by another claim within the acceptance domain |
| `settlement_pending` | An observed payment has not met the confirmation policy; no outputs consumed |
| `invalid_transaction_state` | The set cannot coexist in a consistent validated chain and mempool view |

Core errors apply to unsupported versions, schemes and networks and to infrastructure failures. Unsupported network identifiers use `invalid_network`. An altered `accepted.network` fails the original-requirements comparison with `invalid_payment_requirements`.

Unavailable or incompletely restored issuance state is an infrastructure failure. It MUST NOT be reported as definitive unknown issuance under `invalid_payment_requirements`. An authoritative unknown-issuance result still does not establish that no payment was sent and MUST NOT prompt automatic repayment.

Verify failures use `isValid: false` and `invalidReason`; settle failures use `success: false` and `errorReason`. An optional read-only verifier MUST NOT return or create a settlement commitment.

## Security Considerations

### Payment Capabilities and Request Binding

A public transaction proves neither who may use a resource nor what operation was purchased. Confidential payment capabilities and authoritative issuance provide that binding. A fresh address alone does not prevent duplicate execution of the same operation.

### Confirmation Risk

Zero-confirmation acceptance exposes the merchant to replacement, eviction and double-spend. Confirmations reduce reorganisation risk without eliminating it. The merchant's chosen threshold applies to every payment in a combined proof. A provider supplies evidence and may be trusted for that evidence; it does not remove these Bitcoin risks.

An unconfirmed transaction with legacy inputs may be malleated so that its payment confirms under a different `txid`. The committed outpoints then record what was accepted; those identifiers may never appear on chain. SegWit reduces this form of malleability but does not prevent deliberate replacement or failure of an unconfirmed ancestor. Reconciliation to a later transaction MUST preserve the original commitment and MUST NOT create another grant. Recipient script and amount alone do not identify a unique output. A merchant requiring a receipt backed by active-chain inclusion SHOULD advertise a positive confirmation depth.

### Output Accounting

A spent payment output remains evidence of receipt. Unsolicited transfers and unrelated outputs must not change the amount being claimed. Duplicate references, conflicting transactions and mixed stale observations must never increase the counted value.

### Payment Before Service

Payment before service exposes the payer to failure, expiry and a dishonest merchant. A resource-server or provider outage can delay acceptance even though the payer independently broadcasts. Local verification removes a separate provider dependency; it does not guarantee service delivery.

## Implementation Requirements

An `exact` implementation MUST select the mechanism using the complete network identifier, resolve its method default, and reject unsupported methods before payment construction. A `bip122` handler MUST NOT accept an `lnbtc` requirement. Registering handlers MUST NOT make method selection depend on registration order.

Supported networks MUST be advertised explicitly. In the existing `/supported` schema, the presence of `extra.onchain` in a matching v2 `exact` kind advertises this method. That object MUST contain `minSupportedConfirmations`, `maxSupportedConfirmations` and `maxPaymentOutputs` as safe JSON integers. The range MUST satisfy `0 <= minSupportedConfirmations <= maxSupportedConfirmations`, and `maxPaymentOutputs` MUST be positive. Each issued `minConfirmations` and output-count bound must fall within those capabilities. This method requires no signing key; an implementation supporting only this method can return `signers: {}`. No new top-level core response fields are introduced.

A facilitator implementing this method MUST include `bip122-payment-set` in the top-level `SupportedResponse.extensions` array.

The BIP-122 handler and any facilitator selection logic MUST check the resolved method and its advertised capabilities before issuing requirements or constructing payment. A provider advertising Lightning support under `lnbtc` does not thereby advertise native Bitcoin support.

An implementation MUST bound payload parsing and backend work before resolving transactions. It SHOULD query each distinct transaction once per consistent observation, even when several outputs refer to it. Core transport size limits still apply to the complete encoded envelope.

## Test Vectors

The witness addresses below are the published BIP-173 and BIP-350 vectors. The signed transaction is a regtest fixture built from published test keys. Never send funds to any address in this section.

### Recipient Script Decoding

Each mainnet `payTo` MUST decode to the script shown.

| Type | `payTo` | `scriptPubKey` |
| --- | --- | --- |
| P2PKH | `1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2` | `76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac` |
| P2SH | `3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy` | `a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87` |
| P2WPKH | `bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4` | `0014751e76e8199196d454941c45d1b3a323f1433bd6` |
| P2WSH | `bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3` | `00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262` |
| P2TR | `bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0` | `512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798` |

On testnet4 the same programs use prefix `tb` and version bytes `0x6f` and `0xc4`; regtest uses `bcrt`. `tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx` decodes to `0014751e76e8199196d454941c45d1b3a323f1433bd6` under the testnet4 identifier.

Requirements carrying these `payTo` values MUST fail with `invalid_payment_requirements`:

| `payTo` | Network | Reason |
| --- | --- | --- |
| `BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4` | mainnet | Uppercase; valid Bech32, but this method requires canonical lowercase |
| `tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx` | mainnet | Testnet prefix under the mainnet identifier |
| `bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd` | mainnet | Witness version 1 with a Bech32 checksum; BIP-350 lists it as invalid |
| `bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh` | mainnet | Witness version 0 with a Bech32m checksum; BIP-350 lists it as invalid |
| `bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y` | mainnet | Valid BIP-350 address with a 40-byte version 1 program; this method requires 32 bytes |
| `bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs` | mainnet | Valid BIP-350 address with witness version 2; unsupported by this method |
| `1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2` | testnet4 | Mainnet P2PKH version byte under the testnet4 identifier |

### Payment Proof

A regtest requirement with `amount: "10000"` and `payTo` `bcrt1qnjg0jd8228aq7egyzacy8cys3knf9xvr3v5hfj` is paid by this signed transaction:

```text
020000000001010ece4256be027cb3aa07988baf86d6e0b63f3953f701ac3a04d54d9c781516f60000000000fdffffff0210270000000000001600149c90f934ea51fa0f6504177043e0908da6929983a85b010000000000160014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2024830450221009bd718fa00b2b6ca6ee349865f7740e88b6f36ad74f7f75cf4c4cc9a12b2444302203c68527332f4456e74187407350e4019b24eff3004624214030272d7e92bd34201210330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c00000000
```

Its non-witness `txid` is `7b3d66c6888fb70dc15bb4cf7396831844adee226adccf70a309352bbb5550b8`, its size is 223 bytes, and output `0` pays 10000 satoshis to `00149c90f934ea51fa0f6504177043e0908da6929983`. Output `1` is change. The conforming payload and canonical payment key are:

```json
{
  "outputs": [
    {
      "txid": "7b3d66c6888fb70dc15bb4cf7396831844adee226adccf70a309352bbb5550b8",
      "vout": 0
    }
  ]
}
```

```text
bip122:0f9188f13cb7b2c71f2a335e3a4fc328/7b3d66c6888fb70dc15bb4cf7396831844adee226adccf70a309352bbb5550b8:0
```

Once the transaction reaches the advertised confirmation depth, settlement consumes that key together with the payment identifier.

## References

- [x402 v2](../../x402-specification-v2.md)
- [`exact` client-submitted family](scheme_exact.md#client-submitted-payment-proof)
- [Bitcoin Lightning mechanism](scheme_exact_lnbtc.md)
- [CAIP-2 namespace for BIP-122](https://namespaces.chainagnostic.org/bip122/caip2)
- [Bitcoin network parameters](https://github.com/bitcoin/bitcoin/blob/v30.0/src/kernel/chainparams.cpp)
- [BIP-173: Bech32 addresses](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki)
- [BIP-350: Bech32m addresses](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki)
- [BIP-141: Segregated Witness](https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki)
- [Bitcoin Core 28.0: full RBF by default](https://bitcoincore.org/en/releases/28.0/)
- [Bitcoin Core mempool membership](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getmempoolentry/)
- [Bitcoin Core mempool sequence](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getrawmempool/)
