"""Utilities for the BIP-122 Lightning mechanism."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

try:
    from bolt11 import Bolt11, decode
except ImportError as e:
    raise ImportError(
        "Lightning mechanism requires bolt11. Install with: pip install x402[lightning]"
    ) from e

from .constants import NETWORK_CONFIGS, NetworkConfig


def normalize_network(network: str) -> str:
    """Validate and normalize a BIP-122 network identifier."""
    if network not in NETWORK_CONFIGS:
        raise ValueError(f"Unsupported BIP-122 network: {network}")
    return network


def validate_bip122_network(network: str) -> bool:
    """Return True when the network is a supported BIP-122 identifier."""
    return network in NETWORK_CONFIGS


def get_network_config(network: str) -> NetworkConfig:
    """Return the configuration for a supported BIP-122 network."""
    return NETWORK_CONFIGS[normalize_network(network)]


def decode_invoice(invoice: str) -> Bolt11:
    """Decode a BOLT11 invoice or raise ValueError."""
    try:
        return decode(invoice, strict=True)
    except Exception as e:
        raise ValueError("Invalid BOLT11 invoice") from e


def get_invoice_payment_hash(invoice: str) -> str:
    """Decode and return the invoice payment hash."""
    return decode_invoice(invoice).payment_hash


def sat_to_msat(amount: str | int | float | Decimal) -> int:
    """Convert a satoshi-denominated value to millisatoshis."""
    if isinstance(amount, Decimal):
        text = format(amount, "f")
    else:
        text = str(amount)

    normalized = text.strip().lower()
    if normalized.endswith("sats"):
        normalized = normalized[:-4].strip()
    elif normalized.endswith("sat"):
        normalized = normalized[:-3].strip()

    if normalized.startswith("$") or "usd" in normalized or "btc" in normalized:
        raise ValueError("Lightning prices must be denominated in sats or provided as AssetAmount")

    try:
        sat_amount = Decimal(normalized)
    except InvalidOperation as e:
        raise ValueError("Invalid amount") from e

    if sat_amount < 0:
        raise ValueError("Invalid amount")

    msat_amount = sat_amount * Decimal("1000")
    if msat_amount != msat_amount.to_integral_value():
        raise ValueError("Amounts must not exceed millisatoshi precision")

    return int(msat_amount)


def msat_to_sat(amount_msat: str | int) -> str:
    """Convert millisatoshis to a normalized satoshi string."""
    try:
        msat = Decimal(str(amount_msat))
    except InvalidOperation as e:
        raise ValueError("Invalid amount") from e

    if msat < 0:
        raise ValueError("Invalid amount")

    sat_amount = msat / Decimal("1000")
    text = format(sat_amount, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"
