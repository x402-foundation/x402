"""Constants from the SVM batch-settlement specification."""

BATCH_SETTLEMENT_SCHEME = "batch-settlement"
MIN_WITHDRAW_DELAY = 900
MAX_WITHDRAW_DELAY = 2_592_000
FULL_SPLIT_BPS = 10_000
CLIENT_VOUCHER_EXPIRES_AT = 0
AUTHORIZATION_DOMAIN = b"x402-batch-authorization-v2"
CLOSE_DOMAIN = b"x402:batch-settlement:svm:close:v1"
CHANNEL_BUSY = "duplicate_settlement"
