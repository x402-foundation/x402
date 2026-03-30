# Scheme: `exact` on `Algorand`

## Summary

The `exact` scheme on Algorand uses the Algorand Standard Asset (ASA), native assets (no contract required) of the Algorand protocol, to authorize a transfer of a specific amount from the payor to the resource server. The approach results in the facilitator having no ability to direct funds anywhere but the address specified by the resource server in `paymentRequirements`.

> **x402 v2:** `PaymentRequirements` use the field name **`amount`** (atomic units). Do not use the v1 name `maxAmountRequired` in specifications or v2 payloads for this scheme.

## Sequence of operations

```mermaid
  sequenceDiagram
    participant C as Client
    participant R as Resource Server
    participant F as Facilitator
    participant A as Algorand

    C->>R: Request Resource
    R-->>C: 402 Payment Required + paymentRequirements
    C->>C: Construct paymentGroup of transactions
    C->>C: Sign relevant transactions in paymentGroup
    C->>R: Resend request with PAYMENT-SIGNATURE header
    R->>F: Verify paymentGroup
    alt valid
      F-->>F: Check/Sign feePayer transaction
      F-->>A: Simulate paymentGroup
      A-->>F: Simulation result
      alt simulation success
        F-->>R: Payment verified
        R->>F: Request settlement
        F-->>A: Submit paymentGroup
        A-->>F: Transaction result
        alt success - Instant Finality
          F-->>R: Settlement successful
          R-->>C: 200 OK + Resource
        else
          F-->>R: Settlement failed
          R-->>C: 402 Payment Required (invalid payment)
        end
      else simulation fail
        F-->>R: Payment invalid
        R-->>C: 402 Payment Required (invalid payment)
      end


    else invalid
      R-->>C: 402 Payment Required (invalid payment)
    end
```

## `paymentRequirements` for Payment Required Response

In the `exact` scheme on Algorand, the `paymentRequirements` record **MAY** include a `feePayer` field inside the `extra` element. This informs the client they **MAY** construct a transaction that includes a 0 Algo payment transaction, from the `feePayer`, with a `fee` value that's enough to cover the cost of their transaction(s). This transaction would be included in the same atomic group as the expected asset transfer transaction, and will be signed by the `Facilitator` after verifying the transaction group and before settling to the network.

Additionally the `paymentRequirements.asset` field **MUST** be a string representing an ASA ID (64-bit unsigned integer) instead of an `ERC20` contract address. This **MUST** be validated by the resource server to ensure the `asset` field is valid when using the Algorand scheme.

### `paymentRequirements.extra` specification:

```json5
  {
    // Optional Algorand address that will pay the transaction fees.
    feePayer?: string;
  }
```

Full `paymentRequirements` Example:

```json
{
  "scheme": "exact",
  "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "amount": "5000000",
  "payTo": "RESOURCESERVERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALTSRPAE",
  "maxTimeoutSeconds": 60,
  "asset": "31566704",
  "extra": {
    "feePayer": "FACILITATORADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQCXBZE",
  }
}
```

## `PAYMENT-SIGNATURE` Header Payload

The `payload` field of the `PAYMENT-SIGNATURE` header **MUST** contain `paymentGroup` as a field. It represents an atomic group of transactions as an array. Transaction groups are natively supported by the Algorand protocol (no contract required), enabling the execution of several transactions (even with different authorizers) processed atomically (no partial execution is allowed, either all the transactions in the group succeed or the entire group is rejected).

A group can contain several different types of transactions, such as `pay` (transfer of ALGO native protocol asset) and `axfer` (transfer of generic ASA), and others (for further details on supported transaction types, refer to the [Algorand transactions documentation](https://dev.algorand.co/concepts/transactions/reference/).

As part of the payload there **MUST** also be a `paymentIndex` field which identifies the transaction in the group that will pay the resource server. The group may perform several operations to facilitate the payment, such as swaps or asset transfers, but only one transaction in the group will actually transfer the funds to the resource server.

> In a single standalone transaction, the `paymentIndex` **MUST** be set to 0.

Multiple signers can be in the group, and fees can be pooled together or assigned to a specific signer, meaning they can be delegated to a specific account to pay the fees for the group. A group can include a maximum of:

- 16 _top-level transactions_, authorized either with a single signature (`Ed25519`), a `k-of-n` threshold multi-signature, or a logic signature;
- 256 _inner transactions_, authorized by an application (smart contract).

Example of a USDC asset transfer with an abstracted fee (i.e paid by the facilitator):

```json
{
  "paymentIndex": 1, // 0th index of the transaction in the group that will pay the resource server
  "paymentGroup": [
    "gaN0eG6Jo2ZlZc0H0KJmds4DLgNro2dlbqxtYWlubmV0LXYxLjCiZ2jEIMBhxNj8Hb3e0tdgS+RWjj9tBBmHrDe95LYgtas5JIrfo2dycMQgfy1Szr+lgvgTJsviMY2KnHSsXqyfCJ1UOCE+2Tf3vS+ibHbOAy4HU6NyY3bEICgEhaJgm6IBjiSUgAAAAAAAAAAAAAAAAAAAAAAAAAAAo3NuZMQgKASFomCbogGOJJSAAAAAAAAAAAAAAAAAAAAAAAAAAACkdHlwZaNwYXk=",
    "gqNzaWfEQP3J1DI6GLSfK0nLZftvSyVMJuFOE48xPlnZpNdEJWbGbcxsD5aASwza4TjbwhgEF0dXOv8E3W/f22vkEzfFywWjdHhuiaRhYW10zgBMS0CkYXJjdsQgiSTqRESRI1JEAxxJKQAAAAAAAAAAAAAAAAAAAAAAAACiZnbOAy4Da6JnaMQgwGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit+jZ3JwxCB/LVLOv6WC+BMmy+IxjYqcdKxerJ8InVQ4IT7ZN/e9L6Jsds4DLgdTo3NuZMQgEtBGzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACkdHlwZaVheGZlcqR4YWlkzgHhq3A="
  ]
}
```

### Full `PAYMENT-SIGNATURE` header example:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "resource": { 
    "url": "https://example.net/signup",
    "description": "$5 registration payment",
    "mimeType": "text/html"
  },
  "accepted": {
    "scheme": "exact",
    "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "amount": "5000000",
    "payTo": "RESOURCESERVERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALTSRPAE",
    "maxTimeoutSeconds": 60,
    "asset": "31566704",
    "extra": {
      "feePayer": "FACILITATORADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQCXBZE",
    }
  },
  "extensions": {},
  "outputSchema": null,
  "payload": {
    "paymentIndex": 1,
    "paymentGroup": [
      "gaN0eG6Jo2ZlZc0H0KJmds4DLgNro2dlbqxtYWlubmV0LXYxLjCiZ2jEIMBhxNj8Hb3e0tdgS+RWjj9tBBmHrDe95LYgtas5JIrfo2dycMQgfy1Szr+lgvgTJsviMY2KnHSsXqyfCJ1UOCE+2Tf3vS+ibHbOAy4HU6NyY3bEICgEhaJgm6IBjiSUgAAAAAAAAAAAAAAAAAAAAAAAAAAAo3NuZMQgKASFomCbogGOJJSAAAAAAAAAAAAAAAAAAAAAAAAAAACkdHlwZaNwYXk=",
      "gqNzaWfEQP3J1DI6GLSfK0nLZftvSyVMJuFOE48xPlnZpNdEJWbGbcxsD5aASwza4TjbwhgEF0dXOv8E3W/f22vkEzfFywWjdHhuiaRhYW10zgBMS0CkYXJjdsQgiSTqRESRI1JEAxxJKQAAAAAAAAAAAAAAAAAAAAAAAACiZnbOAy4Da6JnaMQgwGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit+jZ3JwxCB/LVLOv6WC+BMmy+IxjYqcdKxerJ8InVQ4IT7ZN/e9L6Jsds4DLgdTo3NuZMQgEtBGzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACkdHlwZaVheGZlcqR4YWlkzgHhq3A="
    ]
  }
}
```

## `PAYMENT-RESPONSE` Header

Upon a successful settlement, the `PAYMENT-RESPONSE` **MUST** return the transaction ID of the `paymentGroup[paymentIndex]` transaction. This identifies the specific asset transfer transaction to the `payTo` address for the `amount` specified in `PaymentRequirements`, and can be used to identify the transaction on the network.

Should the settlement fail, the transaction ID **SHOULD** be returned, but since failed transactions are not committed to the network, it might not be visible on the chain.

### Full `PAYMENT-RESPONSE` header example:
```json
{
  "success": true,
  "errorReason": null,
  "payer": "<payer>",
  "transaction": "NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA",
  "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="
}
```

## Verification

Steps to verify a payment for the `exact` scheme on Algorand. Implementations **SHOULD** perform **cross-validation** (subsection **1**) before relying on payment-line and fee-payer checks, so invalid protocol metadata fails fast with a structured error.

### 1. Cross-validation (protocol metadata)

Before relying on decoded transaction fields:

1. **`x402Version`** — The `PAYMENT-SIGNATURE` header **MUST** include an `x402Version` compatible with the facilitator and resource server (typically `2` for v2 flows).
2. **`scheme`** — **MUST** be `exact` for this scheme.
3. **`network`** — The `network` carried in the payment payload (e.g. inside the `PAYMENT-SIGNATURE` header) **MUST** match the `network` in `PaymentRequirements` for this request (same CAIP-2 string, e.g. `algorand:<genesis-hash>`).
4. **Consistency** — Any `accepted` / `resource` fields present in the header **MUST** be consistent with what the resource server previously returned in the 402 `accepts` list (same `scheme`, `network`, `asset`, `amount`, `payTo` as selected for payment).

### 2. Transaction group structure

5. Check the `paymentGroup` contains **16 or fewer** top-level transactions (Algorand atomic-group limit).
6. Decode all transactions from the `paymentGroup` (base64 → msgpack).

### 3. Genesis hash (network binding)

7. For **every** decoded transaction in the group, the transaction’s **genesis hash** (`gh` in the decoded txn) **MUST** equal the genesis hash encoded in `PaymentRequirements.network` for CAIP-2 identifiers of the form `algorand:<base64-genesis-hash>`. This binds the group to the intended Algorand network and prevents cross-network replay.

### 4. Payment transaction (index `paymentIndex`)

8. Locate the `paymentGroup[paymentIndex]` transaction (the payment line to the resource server).
9. **Asset amount** — For an `axfer` (ASA transfer), `aamt` **MUST** exactly equal the `amount` field from `PaymentRequirements` (same string interpreted in the asset’s base units). For native ALGO `pay` transfers, the transferred amount **MUST** match `PaymentRequirements.amount` under the same rules.
10. **Receiver** — `arcv` / receiver **MUST** match `payTo` from `PaymentRequirements`.
11. **Asset** — For `axfer`, the asset ID (`xaid`) **MUST** match `PaymentRequirements.asset` (ASA ID as a string). Implementations **MUST** reject transfers where the on-chain asset does not match the required asset.

### 5. Facilitator fee-payer transactions

12. Locate all transactions where `snd` (sender) is the facilitator’s Algorand address (fee-payer role).
    1. Check the `type` is `pay`.
    2. Check the following fields are omitted: `close`, `rekey`, `amt` (zero-ALGO self-transfer pattern for fee pooling as used in gasless flows).
    3. Check the `fee` is within a reasonable upper bound (policy-defined) so the facilitator cannot be drained by excessive fees.
    4. Sign the transaction if the facilitator is expected to co-sign.

### 6. Simulation

13. Evaluate the payment group against an Algorand node’s **`simulate`** endpoint to ensure the transactions would succeed.

### Machine-readable errors

Facilitators **SHOULD** return structured verify/settle responses using stable `invalidReason` / `errorReason` strings (and optional `invalidMessage` / `errorMessage` detail). The reference `@x402/avm` facilitator defines a fixed vocabulary in [`VerifyErrorReason`](../../../typescript/packages/mechanisms/avm/src/exact/facilitator/scheme.ts) (for example genesis hash mismatch, amount/receiver/asset mismatch, simulation failure). Implementations **MAY** adopt the same strings or extend them, but **SHOULD** keep reasons stable for client handling.

## Settlement

Once the group is validated by the resource server, settlement can occur by the facilitator submitting the verified transaction group to the Algorand network through the `v2/transactions` endpoint against any valid Algorand node.

In Algorand there are no long-range reorgs comparable to probabilistic-finality chains; once a transaction is included in a block it is final for practical purposes. Implementations **SHOULD** still confirm the transaction ID is **committed** (e.g. returned from `v2/transactions` or observed via `pending` → `confirmed`) before reporting settlement success to the resource server, so clients never see success for a dropped or never-broadcast group.

## Additional Considerations

### Assets

In order for the resource server to receive payment on a particular Asset, it **MUST** be opted-in to that asset. In Algorand, accounts explicitly enable receiving a particular asset, otherwise an asset transfer to that account will be rejected. So as part of the resource server's setup, it **SHOULD** ensure it has opted-in to the asset ID specified in the `paymentRequirements.asset`.

### Multiple Payments

The facilitator may want to account for multiple payments and `feePayer` transactions in a single group. If the client knows what they're paying for and constructs multiple payments in one group, there could be up to 16 payments to the resource server, or 8 gasless payments.

### Signature Scheme

Each _top-level transaction_ in the `paymentGroup` **MUST** be signed individually by each of the owners of the sender addresses in the group.

In Algorand, signatures of _top-level transactions_ are based either on:

- A `Ed25519` single signature scheme (`sig`);
- A `k-of-n` threshold [multi-signature](https://dev.algorand.co/concepts/transactions/signing/#multisignatures) (`msig`);
- A [Logic Signature](https://dev.algorand.co/concepts/smart-contracts/logic-sigs/), verified by the Algorand Virtual Machine (`lsig`);

### Algorand Addresses and Public Key relationship

In Algorand, addresses are 58-character base32-encoded representations of either:

- SHA512_256 of the Logic Signatures program bytecode + `Program` as a prefix.
- Public keys, with a sha512_256 checksum (last 4 bytes) appended as a suffix. This encoding ensures that addresses can be derived directly from public keys without requiring a pre-existing signature for operations like `ecRecover` to verify signatures.

Example of encoding Algorand addresses:

```ts
	encodeAddress(publicKey: Buffer): string {
		const keyHash: string = sha512_256.create().update(publicKey).hex()

		// last 4 bytes of the hash
		const checksum: string = keyHash.slice(-8)

		return base32.encode(Encoder.ConcatArrays(publicKey, Buffer.from(checksum, "hex"))).slice(0, 58)
	}
```

### Encoding

Algorand uses [**msgpack**](https://www.npmjs.com/package/algorand-msgpack) to encode the transactions. Each element in the `paymentGroup` array can be base64-decoded, then msgpack-decoded, to reveal the transaction contents. Or using `goal` you can do the following:

```json
% cat payload.json | jq -r '.paymentGroup[]' | base64 -d | goal clerk inspect -
-[0]
{
  "txn": {
    "fee": 2000,
    "fv": 53347179,
    "gen": "mainnet-v1.0",
    "gh": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "grp": "fy1Szr+lgvgTJsviMY2KnHSsXqyfCJ1UOCE+2Tf3vS8=",
    "lv": 53348179,
    "rcv": "FACILITATORADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQCXBZE",
    "snd": "FACILITATORADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQCXBZE",
    "type": "pay"
  }
}

-[1]
{
  "sig": "/cnUMjoYtJ8rSctl+29LJUwm4U4TjzE+Wdmk10QlZsZtzGwPloBLDNrhONvCGAQXR1c6/wTdb9/ba+QTN8XLBQ==",
  "txn": {
    "aamt": 5000000,
    "arcv": "RESOURCESERVERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALTSRPAE",
    "fv": 53347179,
    "gh": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "grp": "fy1Szr+lgvgTJsviMY2KnHSsXqyfCJ1UOCE+2Tf3vS8=",
    "lv": 53348179,
    "snd": "CLIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHFUPIRI",
    "type": "axfer",
    "xaid": 31566704
  }
}
```

## Appendix

### Gasless Transactions/Sponsored Fees

`Facilitator`s who offer "gasless" transactions, may refuse to sign their `feePayer` transaction, if they consider it's been constructed maliciously. These malicious checks may be off-loaded to a logic signature, where the `facilitator` instead provides their signature of the TxID as an argument.
