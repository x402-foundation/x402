# Scheme: `dhali`

## Summary

The `dhali` scheme allows for high-frequency, micropayment-based access to resources using Dhali's payment channel infrastructure. It leverages payment channels on **XRPL**, **Xahau**, and **Ethereum** blockchains, supporting assets such as **XRP**, **XAH**, **ETH**, **USDC**, and **RLUSD**, and can be extended to support other chains and assets.

This scheme is designed to be trustless for the payer (client), who creates a channel with Dhali and signs a claim for a specified amount (determined by them, as small as they desire) that can only be redeemed for the specific channel. The payee (resource server) trusts Dhali to process and track these claims and settle them on-chain asynchronously (typically on a 24-hour cadence) or when the resource server explicitly requests settlement.

## Payment header payload

The payment payload for the `dhali` scheme is an **unencoded dhali payment claim** (see [here](https://dhali.io/docs/payment-claim-generation/) for more details). This JSON object contains the necessary authorization and cryptographic proof for the payment.

```json
{
  "version": "2",
  "account": "<source_account_address>",
  "destination_account": "<destination_account_address>",
  "signature": "<cryptographic_signature>",
  "protocol": "<network_protocol>",
  "currency": {
    "code": "<currency_code>",
    "scale": <integer_scale>,
    "issuer": "<optional_issuer_address>"
  },
  "channel_id": "<channel_identifier>",
  "authorized_to_claim": "<total_authorized_amount>"
}
```

### Fields

- `version`: MUST be "2".
- `account`: The address of the source account (payer).
- `destination_account`: The address of the destination account (Dhali/Payee).
- `signature`: The cryptographic signature of the claim, verifying the payer's intent.
- `protocol`: The network protocol identifier (e.g., "XRPL.MAINNET", "EVM.SEPOLIA").
- `currency`: An object describing the asset.
    - `code`: The currency code (e.g., "XRP", "USDC").
    - `scale`: The scale/precision of the currency.
    - `issuer`: (Optional) The issuer address for issued tokens.
- `channel_id`: The unique identifier for the payment channel being used.
- `authorized_to_claim`: The cumulative total amount - cryptographically tied to the `signature` - that the payer has authorized to be claimed from this channel.

### Facilitator Routing

To verify or settle a payment, the client must use the following versioned endpoints, supplying the `assetUUID` (the unique identifier of the user's off-chain address) in the URL path:

- **Verify**: `POST https://x402.dhali.io/v2/{assetUUID}/verify`
- **Settle**: `POST https://x402.dhali.io/v2/{assetUUID}/settle`

The `payTo` field in the payment requirements should contain Dhali's on-chain wallet address for the respective network.

## Verification

To verify a payment claim, the facilitator performs the following checks:

1.  **Structure Validation**: Ensures the payload is a valid JSON object confirming to the v2 schema with all required fields.
2.  **Signature Verification**: Validates that the `signature` matches the `account` and the claim contents.
3.  **Channel State**: Checks that the `channel_id` corresponds to an open, valid payment channel on the specified `protocol`.
4.  **Balance Check**: Verifies that the `authorized_to_claim` amount does not exceed the channel's capacity and that the increment from the previous claim covers the cost of the requested resource.
5.  **Reuse Check**: Claims can be reused for multiple requests, provided the `authorized_to_claim` amount is sufficient to cover the cumulative cost of all associated requests.

## Settlement

Settlement in the `dhali` scheme is an asynchronous process managed by Dhali.

1.  **Submission**: The resource server (or facilitator) submits the payment claim to the Dhali backend via the x402 "settle" endpoint. The `assetUUID` must be provided in the URL path: `https://x402.dhali.io/v2/{assetUUID}/settle`.
2.  **Queuing**: The system verifies the claim's validity and queues it. The x402 settlement response returns `success: true` to indicate the claim has been accepted for processing.
3.  **Consolidation & On-Chain Settlement**: A background process (Payment Claim Sweeper / Earnings Settler) continuously aggregates claims. Typically, Dhali executes on-chain settlement transactions on a **24-hour cadence** to close channels or claim funds, minimizing transaction fees while ensuring payees receive their earnings.

### Trust Model

-   **Payer**: Trustless. The payer signs claims for specific amounts they control, which is defined by the `authorized_to_claim` field. The claim is only valid for the specified channel and destination.
-   **Payee**: Trusted (Trusts Dhali). The resource server relies on Dhali's infrastructure to validate claims in real-time and to execute the asynchronous on-chain settlement.

## Appendix

### Security Considerations

-   **Replay Attack Prevention**: Claims are **cumulative**, which means that their lifetime is limited by the `authorized_to_claim` amount. Once they have been spent, they intrinsically have no further value.
-   **Authorization Scope**: Claims are bound to a specific `destination_account` and `channel_id`, preventing use for other services or channels.
-   **Settlement Atomicity**: Settlement is eventually consistent. The 402 acknowledgment guarantees queuing, while the on-chain settlement is guaranteed by Dhali's operational integrity.
