"""BIP-122 mechanism constants for Bitcoin Lightning payments."""

from typing import TypedDict

SCHEME_EXACT = "exact"

BTC_MAINNET_CAIP2 = "bip122:000000000019d6689c085ae165831e93"
BTC_TESTNET_CAIP2 = "bip122:000000000933ea01ad0ee984209779ba"

BTC_ASSET = "BTC"
PAYMENT_METHOD_LIGHTNING = "lightning"
PAY_TO_ANONYMOUS = "anonymous"
DEFAULT_INVOICE_DESCRIPTION = "x402 payment"
DEFAULT_SETTLEMENT_TTL_SECONDS = 86_400.0
SETTLEMENT_TTL_BUFFER_SECONDS = 3_600.0

ERR_UNSUPPORTED_SCHEME = "unsupported_scheme"
ERR_NETWORK_MISMATCH = "network_mismatch"
ERR_INVALID_ASSET = "invalid_asset"
ERR_INVALID_PAY_TO = "invalid_pay_to"
ERR_INVALID_PAYMENT_METHOD = "invalid_payment_method"
ERR_MISSING_INVOICE = "invalid_exact_bip122_payload_missing_invoice"
ERR_INVALID_INVOICE = "invalid_exact_bip122_payload_invalid_invoice"
ERR_INVOICE_MISMATCH = "invalid_exact_bip122_payload_invoice_mismatch"
ERR_UNKNOWN_INVOICE = "unknown_invoice"
ERR_INVOICE_EXPIRED = "invoice_expired"
ERR_AMOUNT_MISMATCH = "amount_mismatch"
ERR_INVOICE_NOT_PAID = "invoice_not_paid"
ERR_INVOICE_IN_FLIGHT = "invoice_in_flight"
ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement"


class NetworkConfig(TypedDict):
    """Configuration for a BIP-122 network."""

    currency: str


NETWORK_CONFIGS: dict[str, NetworkConfig] = {
    BTC_MAINNET_CAIP2: {"currency": "bc"},
    BTC_TESTNET_CAIP2: {"currency": "tb"},
}
