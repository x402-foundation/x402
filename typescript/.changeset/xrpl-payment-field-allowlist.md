---
"@x402/xrpl": patch
---

Pin decoded XRPL `Payment` blobs to an explicit field allowlist and require the blob to be the canonical serialisation of its transaction; oversized or odd-length blobs are refused before decoding. Mirrors the hardening proposed for the Python mechanism in #3017.
