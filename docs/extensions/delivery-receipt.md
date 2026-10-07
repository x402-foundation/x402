# delivery-receipt Extension

Optional proof-of-delivery attestation for x402 v2 responses.

## Header
Delivered over existing `x402-Extension-Responses` channel with name `delivery-receipt`.

## Schema v0
See `packages/x402/src/types/delivery-receipt.ts`.

Receipt schema:
```
scheme    x402-receipts/v0
payment   { chain_id, tx_hash, asset, amount, payer, payee }
request   { method, url_hash(sha256), params_hash(sha256), ts }
response  { status, body_sha256, content_type, ts, latency_ms }
seller    { erc8004_agent_id, sig (EIP-712) }
buyer     { countersig (EIP-712) | null }
anchor    { batch_merkle_root, base_tx, leaf_index } | null
```

Raw request/response bodies are never stored, only sha256 fingerprints.

## Verification
Three independent checks:
1. Signatures/schema - fails closed when payer == payee
2. On-chain settlement - referenced tx confirmed moving exact amount of recognized asset from payer to payee on claimed chain
3. RFC-6962 merkle inclusion for EAS anchoring

Anchoring uses EAS on Base OP-stack predeploy `0x4200000000000000000000000000000000000021`. Each anchor's `refUID` chains to prior one.

Fail-open: verification failures never block response delivery.

## Reference
https://github.com/StelarDigital/x402-receipts
