"""Tests for ExactSvmScheme facilitator."""

from unittest.mock import patch

from x402.mechanisms.svm import (
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    USDC_DEVNET_ADDRESS,
)
from x402.mechanisms.svm.exact import ExactSvmFacilitatorScheme
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo, VerifyResponse


class MockFacilitatorSigner:
    """Mock facilitator signer for testing."""

    def __init__(self, addresses: list[str] | None = None):
        self._addresses = addresses or ["FeePayer1111111111111111111111111111"]

    def get_addresses(self) -> list[str]:
        return self._addresses

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        if fee_payer not in self._addresses:
            raise ValueError(f"No signer for feePayer {fee_payer}")
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        pass

    def send_transaction(self, tx_base64: str, network: str) -> str:
        return "mockSignature123"

    def confirm_transaction(self, signature: str, network: str) -> None:
        pass


class TestExactSvmSchemeConstructor:
    """Test ExactSvmScheme facilitator constructor."""

    def test_should_create_instance_with_correct_scheme(self):
        """Should create instance with correct scheme."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        assert facilitator.scheme == "exact"


class TestVerify:
    """Test verify method."""

    def test_should_reject_if_scheme_does_not_match(self):
        """Should reject if scheme does not match."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="wrong",  # Wrong scheme
                network=SOLANA_DEVNET_CAIP2,
                asset=USDC_DEVNET_ADDRESS,
                amount="100000",
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=3600,
                extra={"feePayer": "FeePayer1111111111111111111111111111"},
            ),
            payload={"transaction": "base64transaction=="},
        )

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert result.invalid_reason == "unsupported_scheme"

    def test_should_reject_if_network_does_not_match(self):
        """Should reject if network does not match."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="exact",
                network=SOLANA_MAINNET_CAIP2,  # Mainnet
                asset=USDC_DEVNET_ADDRESS,
                amount="100000",
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=3600,
                extra={"feePayer": "FeePayer1111111111111111111111111111"},
            ),
            payload={"transaction": "validbase64transaction=="},
        )

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,  # Devnet
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )

        result = facilitator.verify(payload, requirements)

        # Network check happens early
        assert result.is_valid is False
        assert result.invalid_reason == "network_mismatch"

    def test_should_reject_if_fee_payer_is_missing(self):
        """Should reject if feePayer is missing."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="exact",
                network=SOLANA_DEVNET_CAIP2,
                asset=USDC_DEVNET_ADDRESS,
                amount="100000",
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=3600,
                extra={},  # Missing feePayer
            ),
            payload={"transaction": "base64transaction=="},
        )

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={},  # Missing feePayer
        )

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert result.invalid_reason == "invalid_exact_svm_payload_missing_fee_payer"

    def test_should_reject_if_transaction_cannot_be_decoded(self):
        """Should reject if transaction cannot be decoded."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="exact",
                network=SOLANA_DEVNET_CAIP2,
                asset=USDC_DEVNET_ADDRESS,
                amount="100000",
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=3600,
                extra={"feePayer": "FeePayer1111111111111111111111111111"},
            ),
            payload={"transaction": "invalid!!!"},  # Invalid base64
        )

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        # Transaction decoding or instruction validation fails
        assert "invalid_exact_svm_payload" in result.invalid_reason


class TestSettle:
    """Test settle method."""

    def test_should_fail_settlement_if_verification_fails(self):
        """Should fail settlement if verification fails."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="wrong",  # Wrong scheme
                network=SOLANA_DEVNET_CAIP2,
                asset=USDC_DEVNET_ADDRESS,
                amount="100000",
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=3600,
                extra={"feePayer": "FeePayer1111111111111111111111111111"},
            ),
            payload={"transaction": "base64transaction=="},
        )

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )

        result = facilitator.settle(payload, requirements)

        assert result.success is False
        assert result.error_reason == "unsupported_scheme"
        assert result.network == SOLANA_DEVNET_CAIP2


class TestFacilitatorSchemeAttributes:
    """Test facilitator scheme attributes."""

    def test_scheme_attribute_is_exact(self):
        """scheme attribute should be 'exact'."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        assert facilitator.scheme == "exact"

    def test_caip_family_attribute(self):
        """caip_family attribute should be 'solana:*'."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)

        assert facilitator.caip_family == "solana:*"

    def test_get_extra_returns_fee_payer(self):
        """get_extra should return feePayer address."""
        signer = MockFacilitatorSigner(["TestFeePayer11111111111111111111111"])
        facilitator = ExactSvmFacilitatorScheme(signer)

        extra = facilitator.get_extra(SOLANA_DEVNET_CAIP2)

        assert extra is not None
        assert "feePayer" in extra
        assert extra["feePayer"] == "TestFeePayer11111111111111111111111"

    def test_get_signers_returns_signer_addresses(self):
        """get_signers should return list of signer addresses."""
        addresses = [
            "Signer1111111111111111111111111111111",
            "Signer2222222222222222222222222222222",
        ]
        signer = MockFacilitatorSigner(addresses)
        facilitator = ExactSvmFacilitatorScheme(signer)

        result = facilitator.get_signers(SOLANA_DEVNET_CAIP2)

        assert result == addresses


class TestDuplicateSettlementCache:
    """Test duplicate settlement cache in settle method."""

    def _make_payload(self, transaction: str) -> PaymentPayload:
        return PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="exact",
                network=SOLANA_DEVNET_CAIP2,
                asset=USDC_DEVNET_ADDRESS,
                amount="100000",
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=3600,
                extra={"feePayer": "FeePayer1111111111111111111111111111"},
            ),
            payload={"transaction": transaction},
        )

    def _make_requirements(self) -> PaymentRequirements:
        return PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )

    def test_should_reject_duplicate_settlement(self):
        """Second settle call with the same transaction should be rejected."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)
        requirements = self._make_requirements()
        payload = self._make_payload("sameTransactionBase64==")

        with patch.object(
            facilitator,
            "verify",
            return_value=VerifyResponse(is_valid=True, payer="PayerAddress"),
        ):
            result1 = facilitator.settle(payload, requirements)
            assert result1.success is True

            result2 = facilitator.settle(payload, requirements)
            assert result2.success is False
            assert result2.error_reason == "duplicate_settlement"

    def test_should_allow_distinct_transactions(self):
        """Two different transactions should both settle successfully."""
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)
        requirements = self._make_requirements()

        with patch.object(
            facilitator,
            "verify",
            return_value=VerifyResponse(is_valid=True, payer="PayerAddress"),
        ):
            result1 = facilitator.settle(self._make_payload("transactionA=="), requirements)
            assert result1.success is True

            result2 = facilitator.settle(self._make_payload("transactionB=="), requirements)
            assert result2.success is True

    def test_should_evict_cache_entries_after_ttl(self):
        """Cache entries should be pruned after TTL so they no longer block locally.

        NOTE: In production the Solana RPC would still reject a re-submitted
        transaction that already landed on-chain. This test only verifies that
        the in-memory cache correctly prunes expired entries.
        """
        signer = MockFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)
        requirements = self._make_requirements()
        payload = self._make_payload("expiringTransaction==")

        with patch.object(
            facilitator,
            "verify",
            return_value=VerifyResponse(is_valid=True, payer="PayerAddress"),
        ):
            result1 = facilitator.settle(payload, requirements)
            assert result1.success is True

            # Simulate TTL expiration by backdating the cache entry
            for key in facilitator._settlement_cache.entries:
                facilitator._settlement_cache.entries[key] -= 121.0

            result2 = facilitator.settle(payload, requirements)
            assert result2.success is True

    def test_shared_cache_blocks_cross_version_duplicates(self):
        """V1 and V2 sharing a cache should catch cross-version duplicates."""
        from x402.mechanisms.svm.exact.v1.facilitator import (
            ExactSvmSchemeV1 as ExactSvmFacilitatorSchemeV1,
        )
        from x402.mechanisms.svm.settlement_cache import SettlementCache
        from x402.schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

        signer = MockFacilitatorSigner()
        shared_cache = SettlementCache()
        v2 = ExactSvmFacilitatorScheme(signer, shared_cache)
        v1 = ExactSvmFacilitatorSchemeV1(signer, shared_cache)

        # Settle via V2 first
        with patch.object(
            v2,
            "verify",
            return_value=VerifyResponse(is_valid=True, payer="PayerAddress"),
        ):
            result1 = v2.settle(
                self._make_payload("crossVersionTx=="),
                self._make_requirements(),
            )
            assert result1.success is True

        # Same tx via V1 should be rejected by the shared cache
        v1_payload = PaymentPayloadV1(
            scheme="exact",
            network="solana-devnet",
            payload={"transaction": "crossVersionTx=="},
        )
        v1_requirements = PaymentRequirementsV1(
            scheme="exact",
            network="solana-devnet",
            asset=USDC_DEVNET_ADDRESS,
            max_amount_required="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            resource="https://example.com",
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )
        with patch.object(
            v1,
            "verify",
            return_value=VerifyResponse(is_valid=True, payer="PayerAddress"),
        ):
            result2 = v1.settle(v1_payload, v1_requirements)
            assert result2.success is False
            assert result2.error_reason == "duplicate_settlement"


class TestVerifyFeePayer:
    """Test fee payer verification in verify method."""

    def test_should_reject_if_fee_payer_not_managed(self):
        """Should reject if feePayer is not managed by facilitator."""
        signer = MockFacilitatorSigner(["ManagedPayer111111111111111111111111"])
        facilitator = ExactSvmFacilitatorScheme(signer)

        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=PaymentRequirements(
                scheme="exact",
                network=SOLANA_DEVNET_CAIP2,
                asset=USDC_DEVNET_ADDRESS,
                amount="100000",
                pay_to="PayToAddress11111111111111111111111111",
                max_timeout_seconds=3600,
                extra={"feePayer": "UnmanagedPayer1111111111111111111"},  # Not managed
            ),
            payload={"transaction": "base64transaction=="},
        )

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": "UnmanagedPayer1111111111111111111"},  # Not managed
        )

        result = facilitator.verify(payload, requirements)

        assert result.is_valid is False
        assert result.invalid_reason == "fee_payer_not_managed_by_facilitator"


class TestSettlementCachePruneOptimization:
    """Verify the early-break prune optimization preserves insertion-order semantics."""

    def test_prunes_only_expired_entries_preserves_fresh_ones(self):
        """Entries older than TTL are pruned; newer entries survive."""
        from x402.mechanisms.svm.settlement_cache import SettlementCache

        cache = SettlementCache()

        cache.is_duplicate("tx-a")
        cache.is_duplicate("tx-b")
        cache.is_duplicate("tx-c")

        # Backdate tx-a past TTL (121s), leave tx-b and tx-c fresh
        base = cache.entries["tx-a"]
        cache.entries["tx-a"] = base - 121.0

        assert cache.is_duplicate("tx-a") is False, "expired entry should have been pruned"
        assert cache.is_duplicate("tx-b") is True, "fresh entry should still be cached"
        assert cache.is_duplicate("tx-c") is True, "fresh entry should still be cached"

    def test_prunes_all_entries_when_all_expired(self):
        """When every entry is expired, all should be pruned."""
        from x402.mechanisms.svm.settlement_cache import SettlementCache

        cache = SettlementCache()

        cache.is_duplicate("tx-1")
        cache.is_duplicate("tx-2")
        cache.is_duplicate("tx-3")

        for k in list(cache.entries):
            cache.entries[k] -= 121.0

        assert cache.is_duplicate("tx-1") is False
        assert cache.is_duplicate("tx-2") is False
        assert cache.is_duplicate("tx-3") is False

    def test_prunes_nothing_when_all_fresh(self):
        """When no entries are expired, none should be pruned."""
        from x402.mechanisms.svm.settlement_cache import SettlementCache

        cache = SettlementCache()

        cache.is_duplicate("tx-x")
        cache.is_duplicate("tx-y")
        cache.is_duplicate("tx-z")

        assert cache.is_duplicate("tx-x") is True
        assert cache.is_duplicate("tx-y") is True
        assert cache.is_duplicate("tx-z") is True

    def test_early_break_preserves_ordered_entries(self):
        """Insertion-order iteration means the break fires at the first fresh entry."""
        from x402.mechanisms.svm.settlement_cache import SettlementCache

        cache = SettlementCache()

        # Insert A, B, C in order with small gaps
        cache.is_duplicate("tx-old-1")
        cache.is_duplicate("tx-old-2")
        cache.is_duplicate("tx-fresh")

        # Expire only the first two
        for k in ("tx-old-1", "tx-old-2"):
            cache.entries[k] -= 121.0

        # Trigger prune
        cache.is_duplicate("tx-new")

        assert "tx-old-1" not in cache.entries, "first expired entry should be pruned"
        assert "tx-old-2" not in cache.entries, "second expired entry should be pruned"
        assert "tx-fresh" in cache.entries, "fresh entry after expired ones should survive"
        assert "tx-new" in cache.entries, "newly inserted entry should be present"
