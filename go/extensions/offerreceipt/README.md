# Offer-Receipt Extension Helpers

Helpers for reading `offer-receipt` extension artifacts in Go.

This package extracts signed offers and receipts from x402 extension maps, decodes EIP-712 and JWS payloads, matches signed offers to `accepts[]` entries, and checks whether a receipt payload matches an accepted offer.

It does not verify cryptographic signatures, resolve JWS `kid` values, or decide signer authorization.

```go
offers, err := offerreceipt.ExtractOffersFromPaymentRequired(paymentRequired)
if err != nil {
    return err
}

decoded, err := offerreceipt.DecodeSignedOffers(offers)
if err != nil {
    return err
}
```
