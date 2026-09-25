# Scheme: `shared-payment-token`

## Summary

`shared-payment-token` is an experimental provider-neutral x402 payment scheme
for settling a fixed-price request with an opaque, short-lived Shared Payment
Token (SPT) issued by an SPT-capable processor, wallet, network, or credential
provider.

The scheme uses x402-native field names while preserving the same SPT contract
used by other agentic-commerce protocols: a scoped, single-use,
processor-redeemable credential bound to amount, asset or currency, merchant
identity, processor route, resource context, consent or delegated allowance,
idempotency, and replay protection.

The scheme uses the normal x402 flow:

1. a resource server returns `PaymentRequired`;
2. the client obtains an SPT for the selected `accepts[]` entry;
3. the client submits a `PaymentPayload`;
4. the facilitator verifies the SPT binding and settles through the configured
   processor route;
5. the resource server returns the protected resource and settlement response.

This scheme does not expose raw card credentials, CVC, network-token cryptograms,
wallet secrets, bank credentials, or PSP secrets to the client. The client
receives an opaque credential reference and display-safe metadata only.

## Status

This is an experimental provider-neutral proposal. Implementations should use a
trusted facilitator, trusted processor configuration, and scheme-specific
adapters until the scheme and conformance language are accepted by the x402
Foundation.

## Use Cases

Use this scheme when:

- the protected resource has a known fixed price before the response is served;
- the payer has an enrolled funding source, wallet, delegated allowance, or
  pre-approved payment relationship with an SPT issuer;
- the seller wants x402 negotiation without receiving raw payment credentials
  from the agent;
- settlement should occur through an off-chain card, wallet, bank, PSP,
  acquiring, or network adapter.

This scheme is not intended for on-chain token transfer, streaming usage-based
billing, or generalized budget management. Those may use other x402 schemes or
future SPT profiles.

## PaymentRequirements

Servers advertise this scheme in a `PaymentRequired.accepts[]` entry.

```json
{
  "scheme": "shared-payment-token",
  "network": "spt:sandbox",
  "amount": "1200",
  "asset": "USD",
  "payTo": "merchant_123",
  "maxTimeoutSeconds": 300,
  "extra": {
    "credentialAcquisitionUrl": "https://processor.example/spt/credentials",
    "merchantId": "merchant_123",
    "processorBinding": {
      "processor": "examplepay",
      "merchantAccountId": "acct_merchant_123"
    },
    "allowedFundingSourceClasses": ["card", "network_token", "wallet"],
    "singleUse": true,
    "binding": {
      "resourceOrigin": "https://api.example.com",
      "resourcePath": "/reports/alpha",
      "method": "GET",
      "requestBodySha256": null,
      "nonce": "nonce_01J4ZTK4P6Y57HXBN2P8EJJEZW"
    }
  }
}
```

### Required Fields

The core x402 fields retain their standard meaning:

| Field | Description |
| ----- | ----------- |
| `scheme` | `shared-payment-token`. |
| `network` | SPT environment or network identifier, such as `spt:sandbox` or `spt:production`. |
| `amount` | Amount in the smallest unit for the advertised `asset`, unless the asset has no minor unit. |
| `asset` | Currency code or settlement asset accepted by the facilitator. |
| `payTo` | Merchant, seller, recipient, or account identity authorized to receive the payment. |
| `maxTimeoutSeconds` | Maximum age of the issued SPT before verification. |

The `extra` object MUST include:

| Field | Description |
| ----- | ----------- |
| `credentialAcquisitionUrl` | HTTPS endpoint where the client or wallet obtains the SPT. |
| `merchantId` | Merchant, seller, recipient, or account identifier authorized to receive the payment. |
| `singleUse` | Whether the credential must be invalidated after one successful settlement. |
| `binding` | Request binding inputs the facilitator verifies before settlement. |

If `processorBinding` is present, the facilitator MUST reject settlement through
any other processor route.

## PaymentPayload

The client selects the advertised entry, obtains an SPT, and submits a scheme
payload containing the opaque credential and binding proof.

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "shared-payment-token",
    "network": "spt:sandbox",
    "amount": "1200",
    "asset": "USD",
    "payTo": "merchant_123",
    "maxTimeoutSeconds": 300,
    "extra": {
      "credentialAcquisitionUrl": "https://processor.example/spt/credentials",
      "merchantId": "merchant_123",
      "singleUse": true,
      "binding": {
        "resourceOrigin": "https://api.example.com",
        "resourcePath": "/reports/alpha",
        "method": "GET",
        "requestBodySha256": null,
        "nonce": "nonce_01J4ZTK4P6Y57HXBN2P8EJJEZW"
      }
    }
  },
  "payload": {
    "credential": {
      "type": "shared_payment_token",
      "id": "spt_01J4ZTM7JVAF5J29VE1S58F7RC",
      "token": "spt_sandbox_opaque_value",
      "bindingProof": "sptproof_opaque_value",
      "expiresAt": "2026-07-24T18:05:00Z",
      "singleUse": true
    }
  },
  "extensions": {
    "payment-identifier": {
      "info": {
        "required": true,
        "id": "pay_7d5d747be160e280504c099d984bcfe0"
      }
    }
  }
}
```

The scheme payload MUST NOT contain PAN, CVC, card magnetic-stripe data,
network-token cryptograms, wallet secrets, bank credentials, or PSP secrets.

## Credential Acquisition

Credential acquisition is a scheme-specific pre-payment step. The client or
wallet calls the advertised `credentialAcquisitionUrl` after selecting the
payment requirement and before constructing the `PaymentPayload`.

Example request:

```json
{
  "paymentRequirementDigest": "sha256:9dd1f4...",
  "merchantId": "merchant_123",
  "payer": {
    "accountId": "payer_acct_123",
    "fundingSourceId": "funding_source_456"
  },
  "allowance": {
    "id": "allow_789",
    "maxAmount": {
      "value": "12.00",
      "currency": "USD"
    },
    "expiresAt": "2026-07-24T18:05:00Z"
  },
  "binding": {
    "resourceOrigin": "https://api.example.com",
    "resourcePath": "/reports/alpha",
    "method": "GET",
    "requestBodySha256": null,
    "amount": "1200",
    "asset": "USD",
    "nonce": "nonce_01J4ZTK4P6Y57HXBN2P8EJJEZW"
  }
}
```

Example response:

```json
{
  "credential": {
    "type": "shared_payment_token",
    "id": "spt_01J4ZTM7JVAF5J29VE1S58F7RC",
    "token": "spt_sandbox_opaque_value",
    "bindingProof": "sptproof_opaque_value",
    "display": {
      "fundingSourceType": "card",
      "brand": "visa",
      "last4": "4242"
    },
    "expiresAt": "2026-07-24T18:05:00Z",
    "singleUse": true
  }
}
```

## Verification and Settlement

Facilitators implementing this scheme MUST verify:

- the SPT was issued by an allowed issuer or processor for the selected
  `PaymentRequirements` entry;
- the credential is unexpired, unrevoked, and not already consumed;
- the amount, asset, `payTo`, merchant id, processor route, nonce, and resource
  binding match the advertised requirement;
- any delegated allowance or consent proof is valid for the payer, amount,
  merchant, and operation;
- the idempotency key is either new or matches the same normalized request
  fingerprint;
- settlement can complete without exposing raw funding credentials to the client
  or resource server.

Facilitators MUST reject requests that would require an SPT-to-credential swap
through an unsupported processor, wallet, or network-token route.

## SettlementResponse

The settlement response follows the core x402 `SettlementResponse` shape and
adds scheme-specific receipt information in `extra`.

```json
{
  "success": true,
  "transaction": "spt_settlement_01J4ZTR0AF2ZE4A6ZP3FQCTE6F",
  "network": "spt:sandbox",
  "payer": "payer_acct_123",
  "extra": {
    "credentialId": "spt_01J4ZTM7JVAF5J29VE1S58F7RC",
    "merchantId": "merchant_123",
    "processor": "examplepay",
    "processorPaymentId": "pi_123",
    "amount": "1200",
    "asset": "USD"
  }
}
```

## Error Handling

| Error | Meaning |
| ----- | ------- |
| `invalid_binding` | Amount, asset, merchant, processor, nonce, resource, or idempotency binding does not match. |
| `credential_expired` | Credential expired before verification. |
| `credential_revoked` | Credential was revoked before verification. |
| `credential_replayed` | Credential or idempotency key was reused with a different request fingerprint. |
| `unsupported_processor_route` | The selected merchant route cannot redeem this credential. |
| `payment_declined` | The underlying processor declined the payment. |
| `retryable_settlement_error` | Temporary facilitator, processor, wallet, or network error. |

## Security Considerations

- Credentials SHOULD be single-use and short-lived.
- Facilitators MUST bind idempotency keys to normalized request fingerprints.
- Resource servers SHOULD include the `payment-identifier` extension and set
  `required: true`.
- Clients MUST treat display metadata as informational only. It is not proof of
  settlement.
- The scheme MUST NOT be used as a generic vault detokenization API.
- All credential issuance and redemption calls MUST use authenticated HTTPS.
