# Scheme: `<name>` `<network kind>`

## Summary

Summarize the purpose and behavior of your scheme here. Include example use cases.

## Payment payload

Document how to construct the `PaymentPayload` for your scheme, based on the
`PaymentRequirements` returned in the `402` response.

Over the HTTP transport the client sends it in the `PAYMENT-SIGNATURE` header and the
server advertises requirements in `PAYMENT-REQUIRED`; see
[transports-v2/http.md](transports-v2/http.md).

## Verification

Document the steps needed to verify a payment for your scheme is valid.

## Settlement

Document how to settle a payment for your scheme.

## Appendix
