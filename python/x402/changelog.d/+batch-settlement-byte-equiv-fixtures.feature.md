Add pure EIP-712 digest helpers for the batch-settlement EVM scheme
(`compute_channel_config_digest` / `compute_voucher_digest` /
`compute_refund_digest` / `compute_claim_batch_digest` in
`x402.mechanisms.evm.batch_settlement.digest`), plus cross-language
byte-equivalence fixtures under
`tests/fixtures/batch-settlement-byte-equivalence/v0/` and a CI
drift-detection job. The existing `compute_channel_id` helper is now a thin
wrapper over `compute_channel_config_digest` (behaviour unchanged).
