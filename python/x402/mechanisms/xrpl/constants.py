"""XRPL mechanism constants."""

SCHEME_EXACT = "exact"

XRPL_MAINNET = "xrpl:0"
XRPL_TESTNET = "xrpl:1"
XRPL_DEVNET = "xrpl:2"

XRPL_CAIP_FAMILY = "xrpl:*"

# JSON-RPC over HTTP rather than WebSocket: the scheme's ledger reads are
# independent request/response calls, and an HTTP client pools connections.
XRPL_MAINNET_RPC_URL = "https://s1.ripple.com:51234/"
XRPL_TESTNET_RPC_URL = "https://s.altnet.rippletest.net:51234/"
XRPL_DEVNET_RPC_URL = "https://s.devnet.rippletest.net:51234/"

DEFAULT_RPC_URLS = {
    XRPL_MAINNET: XRPL_MAINNET_RPC_URL,
    XRPL_TESTNET: XRPL_TESTNET_RPC_URL,
    XRPL_DEVNET: XRPL_DEVNET_RPC_URL,
}

# Native XRP is identified by the literal "XRP"; issued currencies use a
# 3-character code or 40 hex characters.
ASSET_XRP = "XRP"

DEFAULT_MAX_FEE_DROPS = "10000"
# Longest validity window a facilitator will honour, in seconds; bounds both
# the replay window and the duplicate guard's retention.
DEFAULT_MAX_TIMEOUT_SECONDS = 3600
# Fee the client places on a payment it builds; the ledger's minimum is 10
# drops. Deployments on a fee-escalated ledger should raise it.
DEFAULT_CLIENT_FEE_DROPS = "12"
# Converts maxTimeoutSeconds into a LastLedgerSequence window. Must match the
# TypeScript mechanism, or one implementation rejects the other's payments.
DEFAULT_LEDGER_CLOSE_SECONDS = 5

# Extra ledgers allowed on top, to tolerate close-time variance.
DEFAULT_LEDGER_TOLERANCE = 2

# tfPartialPayment. A partial payment delivers less than Amount, so the scheme
# rejects it outright.
TF_PARTIAL_PAYMENT = 0x00020000

# secp256k1 keys start 02/03, Ed25519 keys start ED. Anchored with \Z, not $,
# which in Python also matches before a trailing newline.
CANONICAL_SIGNING_PUB_KEY_PATTERN = r"\A(?:02|03|ED)[0-9A-F]{64}\Z"

# Prefix for hashing a signed transaction: "TXN\0".
TRANSACTION_ID_PREFIX = 0x54584E00

# Standard networks omit the signed NetworkID field.
STANDARD_NETWORK_ID_CEILING = 1024

# DestinationTag is a uint32 on the ledger.
MAX_DESTINATION_TAG = 2**32 - 1

# NetworkID is a uint32.
MAX_NETWORK_ID = 2**32 - 1

# An XRPL account may hold at most this many outstanding tickets.
MAX_ACCOUNT_TICKETS = 250

# Wire reason codes: a client that switches facilitators should get the same
# string for the same fault. Codes shared with the TypeScript mechanism use
# its spelling exactly; the rest name faults this implementation reports and
# TypeScript does not.
ERR_X402_VERSION = "invalid_x402_version"
ERR_UNSUPPORTED_SCHEME = "unsupported_scheme"
ERR_INVALID_NETWORK = "invalid_network"
ERR_NETWORK_MISMATCH = "invalid_exact_xrpl_network_mismatch"
ERR_ASSET_MISMATCH = "invalid_exact_xrpl_asset_mismatch"
ERR_AMOUNT_MISMATCH = "invalid_exact_xrpl_amount_mismatch"
ERR_PAY_TO_MISMATCH = "invalid_exact_xrpl_pay_to_mismatch"
ERR_MAX_TIMEOUT_MISMATCH = "invalid_exact_xrpl_max_timeout_mismatch"
ERR_MAX_TIMEOUT_INVALID = "invalid_exact_xrpl_max_timeout_invalid"
ERR_MAX_TIMEOUT_TOO_LARGE = "invalid_exact_xrpl_max_timeout_too_large"
ERR_FEES_SPONSORED_UNSUPPORTED = "invalid_exact_xrpl_fees_sponsored_unsupported"
ERR_INVOICE_MISMATCH = "invalid_exact_xrpl_invoice_mismatch"
ERR_DESTINATION_TAG_MISMATCH = "invalid_exact_xrpl_destination_tag_mismatch"
ERR_DESTINATION_TAG_MALFORMED = "invalid_exact_xrpl_destination_tag_malformed"
ERR_IOU_ISSUER_MISSING = "invalid_exact_xrpl_iou_issuer_missing"
ERR_IOU_ISSUER_MISMATCH = "invalid_exact_xrpl_iou_issuer_mismatch"
ERR_ASSET_TRANSFER_METHOD = "invalid_exact_xrpl_asset_transfer_method"
ERR_ASSET_TRANSFER_METHOD_MISMATCH = "invalid_exact_xrpl_asset_transfer_method_mismatch"
ERR_PAYLOAD = "invalid_exact_xrpl_payload"
ERR_PAYLOAD_BLOB = "invalid_exact_xrpl_payload_blob"
ERR_MULTISIG_NOT_SUPPORTED = "invalid_exact_xrpl_payload_multisig_not_supported"
ERR_DELEGATE_NOT_ALLOWED = "invalid_exact_xrpl_payload_delegate_not_allowed"
ERR_SIGNING_PUB_KEY = "invalid_exact_xrpl_payload_signing_pub_key"
ERR_SIGNATURE = "invalid_exact_xrpl_payload_signature"
ERR_TRANSACTION_TYPE = "invalid_exact_xrpl_payload_transaction_type"
ERR_DESTINATION_MISMATCH = "invalid_exact_xrpl_payload_destination_mismatch"
ERR_PAYLOAD_DESTINATION_TAG_MISMATCH = "invalid_exact_xrpl_payload_destination_tag_mismatch"
ERR_NETWORK_ID_FOR_STANDARD_NETWORK = "invalid_exact_xrpl_payload_network_id_for_standard_network"
ERR_NETWORK_ID_MISMATCH = "invalid_exact_xrpl_payload_network_id_mismatch"
ERR_AMOUNT_XRP = "invalid_exact_xrpl_payload_amount_xrp"
ERR_PAYLOAD_AMOUNT_MISMATCH = "invalid_exact_xrpl_payload_amount_mismatch"
ERR_SENDMAX_NOT_ALLOWED = "invalid_exact_xrpl_payload_sendmax_not_allowed"
ERR_IOU_AMOUNT = "invalid_exact_xrpl_payload_iou_amount"
ERR_IOU_CURRENCY_MISMATCH = "invalid_exact_xrpl_payload_iou_currency_mismatch"
ERR_PAYLOAD_IOU_ISSUER_MISMATCH = "invalid_exact_xrpl_payload_iou_issuer_mismatch"
ERR_IOU_VALUE_MISMATCH = "invalid_exact_xrpl_payload_iou_value_mismatch"
ERR_SENDMAX_REQUIRED = "invalid_exact_xrpl_payload_sendmax_required"
ERR_SENDMAX_IOU_MISMATCH = "invalid_exact_xrpl_payload_sendmax_iou_mismatch"
ERR_SENDMAX_TOO_LOW = "invalid_exact_xrpl_payload_sendmax_too_low"
ERR_INVOICE_MISSING = "invalid_exact_xrpl_payload_invoice_missing"
ERR_INVOICE_ID_MISMATCH = "invalid_exact_xrpl_payload_invoice_id_mismatch"
ERR_PARTIAL_PAYMENT_NOT_ALLOWED = "invalid_exact_xrpl_payload_partial_payment_not_allowed"
ERR_DELIVERMIN_NOT_ALLOWED = "invalid_exact_xrpl_payload_delivermin_not_allowed"
ERR_PATHS_NOT_ALLOWED = "invalid_exact_xrpl_payload_paths_not_allowed"
ERR_MEMOS_NOT_ALLOWED = "invalid_exact_xrpl_payload_memos_not_allowed"
ERR_FEE_MISSING = "invalid_exact_xrpl_payload_fee_missing"
ERR_FEE_TOO_HIGH = "invalid_exact_xrpl_payload_fee_too_high"
ERR_LAST_LEDGER_SEQUENCE_MISSING = "invalid_exact_xrpl_payload_lastledgersequence_missing"
ERR_EXPIRED = "invalid_exact_xrpl_payload_expired"
ERR_LAST_LEDGER_SEQUENCE_TOO_LARGE = "invalid_exact_xrpl_payload_lastledgersequence_too_large"
ERR_SEQUENCE_MUST_BE_ZERO = "invalid_exact_xrpl_payload_sequence_must_be_zero"
ERR_TICKET_SEQUENCE_MISSING = "invalid_exact_xrpl_payload_ticket_sequence_missing"
ERR_TICKET_NOT_AVAILABLE = "invalid_exact_xrpl_payload_ticket_not_available"
ERR_TICKET_SEQUENCE_NOT_ALLOWED = "invalid_exact_xrpl_payload_ticket_sequence_not_allowed"
ERR_SEQUENCE_MISSING = "invalid_exact_xrpl_payload_sequence_missing"
ERR_SEQUENCE_NOT_CURRENT = "invalid_exact_xrpl_payload_sequence_not_current"
ERR_MASTER_KEY_DISABLED = "invalid_exact_xrpl_payload_master_key_disabled"
ERR_SIGNER_NOT_AUTHORIZED = "invalid_exact_xrpl_payload_signer_not_authorized"
# Carries the engine result as a suffix: "<code>: <engineResult>".
ERR_SIMULATION_FAILED = "invalid_exact_xrpl_payload_simulation_failed"
# The catch-all for an unexpected failure, spelled as TypeScript spells it.
ERR_VERIFICATION_ERROR = "invalid_exact_xrpl_facilitator_error"
ERR_VERIFICATION_FAILED = "verification_failed"
ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement"
# Both may carry the ledger's result code as a suffix: "<code>: <result>".
ERR_TRANSACTION_FAILED = "transaction_failed"
ERR_TRANSACTION_NOT_VALIDATED = "transaction_not_validated"
