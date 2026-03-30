"""Tests for BIP-122 mechanism exports and utilities."""

from unittest.mock import patch

import pytest

from x402.mechanisms.bip122 import (
    BTC_ASSET,
    BTC_MAINNET_CAIP2,
    BTC_TESTNET_CAIP2,
    PAY_TO_ANONYMOUS,
    PAYMENT_METHOD_LIGHTNING,
    SCHEME_EXACT,
    ExactBip122Payload,
    LightningInvoiceStatus,
    LightningPayer,
    LightningReceiver,
    SettlementCache,
    decode_invoice,
    get_invoice_payment_hash,
    get_network_config,
    msat_to_sat,
    normalize_network,
    sat_to_msat,
    validate_bip122_network,
)
from x402.mechanisms.bip122.exact import (
    ExactBip122ClientScheme,
    ExactBip122FacilitatorScheme,
    ExactBip122Scheme,
    ExactBip122ServerScheme,
)

from .helpers import InMemoryLightningReceiver, build_invoice


class TestExports:
    """Test that main classes and constants are exported."""

    def test_should_export_main_classes(self) -> None:
        assert ExactBip122Scheme is not None
        assert ExactBip122ClientScheme is not None
        assert ExactBip122ServerScheme is not None
        assert ExactBip122FacilitatorScheme is not None

    def test_should_export_protocols_and_types(self) -> None:
        assert LightningPayer is not None
        assert LightningReceiver is not None
        assert ExactBip122Payload is not None
        assert LightningInvoiceStatus is not None

    def test_should_export_constants(self) -> None:
        assert SCHEME_EXACT == "exact"
        assert BTC_ASSET == "BTC"
        assert PAY_TO_ANONYMOUS == "anonymous"
        assert PAYMENT_METHOD_LIGHTNING == "lightning"


class TestNetworks:
    """Test network helper functions."""

    def test_should_validate_supported_networks(self) -> None:
        assert validate_bip122_network(BTC_MAINNET_CAIP2) is True
        assert validate_bip122_network(BTC_TESTNET_CAIP2) is True

    def test_should_reject_unsupported_networks(self) -> None:
        assert validate_bip122_network("bip122:*") is False
        assert validate_bip122_network("eip155:8453") is False
        with pytest.raises(ValueError, match="Unsupported BIP-122 network"):
            normalize_network("bip122:*")

    def test_should_return_network_config(self) -> None:
        assert get_network_config(BTC_MAINNET_CAIP2)["currency"] == "bc"
        assert get_network_config(BTC_TESTNET_CAIP2)["currency"] == "tb"


class TestInvoiceUtilities:
    """Test invoice-related helpers."""

    def test_should_decode_invoice_and_extract_payment_hash(self) -> None:
        invoice, payment_hash = build_invoice(amount_msat=21_000, memo="premium access")

        decoded = decode_invoice(invoice)

        assert int(decoded.amount_msat or 0) == 21_000
        assert decoded.description == "premium access"
        assert decoded.payment_hash == payment_hash
        assert get_invoice_payment_hash(invoice) == payment_hash

    def test_should_raise_for_invalid_invoice(self) -> None:
        with pytest.raises(ValueError, match="Invalid BOLT11 invoice"):
            decode_invoice("not-an-invoice")


class TestAmountConversions:
    """Test satoshi conversion helpers."""

    def test_should_convert_sats_to_msats(self) -> None:
        assert sat_to_msat(1) == 1000
        assert sat_to_msat("21 sat") == 21_000
        assert sat_to_msat("0.5 sats") == 500

    def test_should_convert_msats_to_sats(self) -> None:
        assert msat_to_sat(1000) == "1"
        assert msat_to_sat("2500") == "2.5"

    def test_should_reject_invalid_money_inputs(self) -> None:
        with pytest.raises(ValueError, match="Lightning prices must be denominated"):
            sat_to_msat("$1.00")
        with pytest.raises(ValueError, match="Invalid amount"):
            msat_to_sat("-1")


class TestSettlementCache:
    """Test duplicate-settlement cache behavior."""

    def test_should_mark_and_expire_entries(self) -> None:
        cache = SettlementCache(default_ttl_seconds=1.0)

        with patch("x402.mechanisms.bip122.settlement_cache.time.time", return_value=100.0):
            assert cache.mark_used("hash-1") is True

        with patch("x402.mechanisms.bip122.settlement_cache.time.time", return_value=100.5):
            assert cache.is_used("hash-1") is True

        with patch("x402.mechanisms.bip122.settlement_cache.time.time", return_value=101.1):
            assert cache.is_used("hash-1") is False

    def test_should_reject_duplicate_entries(self) -> None:
        cache = SettlementCache()

        assert cache.mark_used("hash-1") is True
        assert cache.mark_used("hash-1") is False


class TestReceiverHelper:
    """Sanity check the in-memory receiver used by mechanism tests."""

    def test_receiver_should_store_created_invoice(self) -> None:
        receiver = InMemoryLightningReceiver()

        invoice = receiver.create_invoice(
            amount_msat=5_000,
            memo="receiver smoke test",
            expiry_seconds=120,
            network=BTC_MAINNET_CAIP2,
        )
        status = receiver.lookup_invoice(invoice, BTC_MAINNET_CAIP2)

        assert status is not None
        assert status.status == "unpaid"
        assert status.amount_msat == 5_000
