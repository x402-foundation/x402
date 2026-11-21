---
"@x402/cardano": minor
---

Add the `cardano-request-commitment` extension: binds a payment to the HTTP request it pays for by signing a salted request commitment into the transaction as label 402 metadata, with the salt disclosed to the resource server in the payment payload. The client scheme honors a declared commitment, and the reference signer now keeps the auxiliary data it attaches.
