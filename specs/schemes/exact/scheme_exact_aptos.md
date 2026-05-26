# Scheme: `exact` on `Aptos`

## Summary

The `exact` scheme on Aptos transfers a specific amount of a stablecoin (such as USDC) from the payer to the resource server using Aptos's fungible asset framework. The approach requires the payer to construct a complete signed transaction ensuring that the facilitator cannot alter the transaction or redirect funds to any address other than the one specified by the resource server in paymentRequirements.

**Version Support:** This specification supports x402 v2 protocol only.

## Protocol Sequencing

The protocol flow for `exact` on Aptos is client-driven. When the facilitator supports sponsorship, it provides `extra.feePayer` in the payment requirements with the address of the account that will pay gas fees. This signals to the client that sponsored (gasless) transactions are available.

1. Client makes a request to a `resource server` and receives a `402 Payment Required` response. The `extra.feePayer` field indicates sponsorship is available and specifies which account will pay gas.
2. Client constructs a fee payer transaction to transfer the fungible asset to the resource server's address. The fee payer address field should be set to the value from `extra.feePayer` provided in the payment requirements.
3. Client signs the transaction (the client's signature covers the transaction payload but not the fee payer address).
4. Client serializes the signed transaction using BCS (Binary Canonical Serialization) and encodes it as Base64.
5. Client resends the request to the `resource server` including the payment in the `PAYMENT-SIGNATURE` header.
6. `resource server` passes the payment payload to the `facilitator` for verification.
7. `facilitator` validates the transaction structure, signature, and payment details.
8. `resource server` does the work to fulfill the request.
9. `resource server` requests settlement from the `facilitator`.
10. `facilitator` ensures the transaction is sponsored (fee payer signature added) and submitted to the `Aptos` network. See [Aptos Sponsored Transactions](https://aptos.dev/build/guides/sponsored-transactions) for details.
11. `facilitator` reports back to the `resource server` the result of the transaction.
12. `resource server` returns the response to the client with the `PAYMENT-RESPONSE` header.

**Security Note:** The sponsorship mechanism does not give the fee payer possession or ability to alter the client's transaction. The client's signature covers the entire transaction payload (recipient, amount, asset). The fee payer can only add its own signature - any attempt to modify the transaction would invalidate the client's signature and cause the transaction to fail.

## Network Format

X402 v2 uses CAIP-2 format for network identifiers:

- **Mainnet:** `aptos:1` (CAIP-2 format using Aptos chain ID 1)
- **Testnet:** `aptos:2` (CAIP-2 format using Aptos chain ID 2)

## `PaymentRequirements` for `exact`

In addition to the standard x402 `PaymentRequirements` fields, the `exact` scheme on Aptos requires the following:

```json
{
  "scheme": "exact",
  "network": "aptos:1",
  "amount": "1000000",
  "asset": "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
  "payTo": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "maxTimeoutSeconds": 60,
  "extra": {
    "feePayer": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
  }
}
```

### Field Descriptions

- `scheme`: Always `"exact"` for this scheme
- `network`: CAIP-2 network identifier - `aptos:1` (mainnet) or `aptos:2` (testnet)
- `amount`: The exact amount to transfer in atomic units (e.g., `"1000000"` = 1 USDC, since USDC has 6 decimals)
- `asset`: The metadata address of the fungible asset (e.g., USDC on Aptos mainnet: `0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b`)
- `payTo`: The recipient address (32-byte hex string with `0x` prefix)
- `maxTimeoutSeconds`: Maximum time in seconds before the payment expires
- `extra.feePayer`: (Optional) The address of the facilitator's fee payer account that will sponsor the transaction. When present, the client can construct a fee payer transaction without including gas payment. When absent, the client must pay their own gas fees.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` must contain the following fields:

- `transaction`: Base64 encoded BCS-serialized signed Aptos transaction

Example `payload`:

```json
{
  "transaction": "AQDy8fLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIC..."
}
```

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
    "network": "aptos:1",
    "amount": "1000000",
    "asset": "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
    "payTo": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "maxTimeoutSeconds": 60,
    "extra": {
      "feePayer": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    }
  },
  "payload": {
    "transaction": "AQDy8fLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vIC..."
  }
}
```

## Verification

Steps to verify a payment for the `exact` scheme:

1. **Extract requirements**: Use `payload.accepted` to get the payment requirements being fulfilled.
2. Verify `x402Version` is `2`.
3. Verify the network matches the agreed upon chain (CAIP-2 format: `aptos:1` or `aptos:2`).
4. Deserialize the BCS-encoded transaction and verify the signature is valid.
5. Verify the transaction has not expired (check expiration timestamp). Note: A buffer time should be considered to account for network propagation delays and processing time.
6. Verify the transaction contains a fungible asset transfer operation (`0x1::primary_fungible_store::transfer` or `0x1::fungible_asset::transfer`).
7. Verify the transfer is for the correct asset (matching `requirements.asset`).
8. Verify the transfer amount matches `requirements.amount`.
9. Verify the transfer recipient matches `requirements.payTo`.
10. Verify the transaction sender has sufficient balance of the `asset` to cover the required amount.
11. Simulate the transaction using the Aptos REST API to ensure it would succeed and has not already been executed/committed to the chain. This also validates the sequence number to prevent replay attacks.

## Settlement

Settlement is performed by sponsoring and submitting the transaction:

1. Facilitator receives the client-signed transaction (deserialized from Base64/BCS).
2. Facilitator verifies the fee payer address field matches the expected fee payer account.
3. Facilitator signs the transaction as the fee payer (this is an additional signature appended to the transaction, not a replacement).
4. The fully-signed transaction (with both client signature and fee payer signature) is submitted to the Aptos network.
5. Transaction hash is returned to the resource server.

The facilitator may act as the fee payer directly, or delegate to a gas station service. See the [Sponsored Transactions](#sponsored-transactions) appendix for implementation options.

Aptos supports [fee payer transactions](https://aptos.dev/build/guides/sponsored-transactions) where a sponsor pays gas fees on behalf of the sender. This is a native Aptos feature that maintains transaction integrity.

The settlement response includes the transaction hash which can be used to track the transaction on-chain.

## `PAYMENT-RESPONSE` Header Payload

The `PAYMENT-RESPONSE` header is base64 encoded and returned to the client from the resource server.

Once decoded, the `PAYMENT-RESPONSE` is a JSON string following the standard `SettlementResponse` schema:

```json
{
  "success": true,
  "transaction": "0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890",
  "network": "aptos:1",
  "payer": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
}
```

### Field Descriptions

- `success`: Boolean indicating whether the payment settlement was successful
- `transaction`: The transaction hash (64 hex characters with `0x` prefix)
- `network`: The CAIP-2 network identifier
- `payer`: The address of the payer's wallet

For Aptos-specific information like the ledger version, clients can query the transaction details using the transaction hash via the [Aptos REST API](https://aptos.dev/build/apis).

## Appendix

### Sponsored Transactions

When `extra.feePayer` is present, the facilitator will pay gas fees on behalf of the client using Aptos's native [fee payer mechanism](https://aptos.dev/build/guides/sponsored-transactions). The `feePayer` value specifies which facilitator account will sponsor the transaction.

**Fee Payer Address:** When constructing a sponsored transaction, the client sets the fee payer address field to the value from `extra.feePayer` provided in the payment requirements. The client's signature remains valid because it covers only the transaction payload, not the fee payer address.

Facilitators can implement sponsorship in two ways:

**Direct Fee Payer:**
The facilitator maintains one or more wallets and signs transactions as the fee payer directly at settlement time. This is the simplest approach. Multiple addresses enable load balancing across accounts.

**Gas Station Service:**
The facilitator operates (or integrates with) a gas station service that handles fee payment. This approach enables additional features:

- Rate limiting per account or globally
- Function allowlists to restrict which operations can be sponsored
- Budget controls and usage tracking
- Abuse prevention policies

Both approaches are transparent to the client - they simply check for `extra.feePayer` and construct their transaction accordingly.

### Non-Sponsored Transactions

If `extra.feePayer` is absent, the client must pay their own gas fees:

1. Client constructs a regular transaction including gas payment from their own account.
2. Client fully signs the transaction.
3. At settlement, the facilitator submits the fully-signed transaction directly to the Aptos network.

This mode may be useful for facilitators that do not wish to sponsor transactions or for testing purposes.

### Transaction Structure

Aptos transactions consist of:

- **Sender**: The account initiating the transaction (the payer in our case)
- **Sequence Number**: Incremental counter for the sender's account
- **Payload**: The operation to execute (fungible asset transfer)
- **Max Gas Amount**: Maximum gas units willing to spend
- **Gas Unit Price**: Price per gas unit
- **Expiration Timestamp**: When the transaction expires
- **Chain ID**: Identifier for the network

For sponsored transactions, an additional **Fee Payer** field is included, designating the account that will pay for gas.

### Fungible Asset Transfer

The payment transaction transfers a fungible asset using Aptos's fungible asset framework. Two common approaches:

**Option 1: `0x1::primary_fungible_store::transfer`** (recommended)

```move
public entry fun transfer<T: key>(
    sender: &signer,
    metadata: Object<T>,
    recipient: address,
    amount: u64,
)
```

Auto-creates primary stores if they don't exist. Simpler and safer for general use.

**Option 2: `0x1::fungible_asset::transfer`**

```move
public entry fun transfer<T: key>(
    sender: &signer,
    from: Object<T>,
    to: Object<T>,
    amount: u64,
)
```

Lower-level transfer between existing stores. More gas efficient when stores already exist.

**Key difference:** `primary_fungible_store::transfer` takes addresses and handles store lookup/creation automatically. `fungible_asset::transfer` takes store objects directly—the caller must resolve store addresses beforehand.

### Signature Schemes

Aptos supports:

- **Ed25519**: Single signature scheme (most common)
- **MultiEd25519**: Multi-signature scheme for accounts requiring multiple signatures
- **SingleKey**: Single signature scheme for accounts with a single key, either Ed25519, Secp256k1, or Secp256r1
- **MultiKey**: Multi-signature scheme for accounts with multiple keys, either Ed25519, Secp256k1, or Secp256r1

The facilitator must verify signatures according to the sender's authentication key and signature scheme.

**Note**: Additional signature schemes (such as Secp256k1 and other types) may need to be supported in future implementations as Aptos adds new authentication methods.

### BCS Serialization

All Aptos transactions are serialized using BCS (Binary Canonical Serialization) before being transmitted. The TypeScript SDK provides utilities for:

- Serializing transaction payloads
- Deserializing received transactions
- Encoding/decoding to/from Base64

### Network Identifiers

CAIP-2 format is used for network identifiers:

- `aptos:1`: Mainnet (Chain ID: 1)
- `aptos:2`: Testnet (Chain ID: 2)

### Account Addresses

Aptos account addresses are 32-byte hex strings, represented with a `0x` prefix. All addresses in the x402 protocol must use the long form (64 hex characters) for consistency and ease of validation.

Example: `0x0000000000000000000000000000000000000000000000000000000000000001` (64 hex characters)

## Recommendation

- Use the spec defined above and only support payments of specific amounts.
- Implement sponsored transactions to enable gasless payments for clients (recommended).
- Leverage the Aptos TypeScript SDK for transaction construction, serialization, and simulation.
- Future versions could explore deferred settlement patterns or usage-based payments if Aptos introduces new primitives that enable such flows.
