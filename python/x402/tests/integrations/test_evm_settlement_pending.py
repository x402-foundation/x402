"""EVM integration tests for the settlement-pending auto-recovery mechanism.

Mirrors the Go integration tests `TestEVMIntegrationV2_SettlementPendingReconciliation`
and `TestEVMIntegrationV2_ResourceServerSettlementPendingRetry`
(go/test/integration/evm_test.go), which are themselves the reference for this pattern.

Uses `ForcedPendingReceiptSigner`, a decorator around the real `FacilitatorWeb3Signer`
that forces just `wait_for_transaction_receipt` to fail on demand via a mutable flag,
while every other signer method (`write_contract`, `send_transaction`, `get_code`, etc.)
delegates unmodified to the real signer. This means every broadcast in these tests is a
real Base Sepolia transaction, but the receipt/confirm wait is deterministically
forceable — avoiding any dependency on real chain confirmation speed (empirically,
racing a short timeout against real confirmations is unreliable since confirmations can
land in ~1s).

Required environment variables:
- EVM_CLIENT_PRIVATE_KEY (or EVM_CLIENT_EOA_PRIVATE_KEY): Private key for the client (payer).
- EVM_FACILITATOR_PRIVATE_KEY: Private key for the facilitator submitting txs.
- EVM_RESOURCE_SERVER_ADDRESS: Recipient address for the settled payment.

These must be funded accounts on Base Sepolia with USDC.

WARNING: Every test in this file makes a REAL on-chain transaction.
"""

from __future__ import annotations

import os
from typing import Any

import pytest
from eth_account import Account

from x402 import x402ClientSync, x402ResourceServerSync
from x402.mechanisms.evm import SCHEME_EXACT
from x402.mechanisms.evm.constants import ERR_SETTLEMENT_PENDING
from x402.mechanisms.evm.exact import (
    ExactEvmClientScheme,
    ExactEvmFacilitatorScheme,
    ExactEvmSchemeConfig,
    ExactEvmServerScheme,
)
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

from ._settlement_pending_helpers import SingleSchemeFacilitatorClientSync

CLIENT_PRIVATE_KEY = os.environ.get("EVM_CLIENT_EOA_PRIVATE_KEY") or os.environ.get(
    "EVM_CLIENT_PRIVATE_KEY"
)
FACILITATOR_PRIVATE_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")
RESOURCE_SERVER_ADDRESS = os.environ.get("EVM_RESOURCE_SERVER_ADDRESS")

RPC_URL = os.environ.get("EVM_RPC_URL", "https://sepolia.base.org")
NETWORK = "eip155:84532"
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY or not FACILITATOR_PRIVATE_KEY or not RESOURCE_SERVER_ADDRESS,
    reason=(
        "EVM_CLIENT_EOA_PRIVATE_KEY (or EVM_CLIENT_PRIVATE_KEY), EVM_FACILITATOR_PRIVATE_KEY, "
        "and EVM_RESOURCE_SERVER_ADDRESS environment variables required for settlement_pending "
        "integration tests"
    ),
)


class ForcedPendingReceiptSigner:
    """Wraps a real `FacilitatorEvmSigner` and, while `force_pending` is True, makes
    `wait_for_transaction_receipt` fail immediately instead of delegating to the real
    (network-speed-dependent) receipt wait. Every other attribute/method (write_contract,
    send_transaction, get_code, read_contract, get_addresses, etc.) delegates unmodified
    to the wrapped signer via `__getattr__`, so every broadcast is always real.
    """

    def __init__(self, wrapped: FacilitatorWeb3Signer) -> None:
        self._wrapped = wrapped
        self.force_pending = False
        self.write_contract_calls = 0

    def wait_for_transaction_receipt(self, tx_hash: str) -> Any:
        if self.force_pending:
            raise TimeoutError(
                "forced receipt-wait failure for settlement_pending integration test"
            )
        return self._wrapped.wait_for_transaction_receipt(tx_hash)

    def write_contract(self, *args: Any, **kwargs: Any) -> str:
        self.write_contract_calls += 1
        return self._wrapped.write_contract(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._wrapped, name)


def _build_requirements(pay_to: str, amount: str) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_EXACT,
        network=NETWORK,
        asset=USDC_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra={"name": "USDC", "version": "2"},
    )


def _build_payment_payload() -> tuple[PaymentPayload, PaymentRequirements, str]:
    """Create a real, signed EIP-3009 payment payload shared by the tests below."""
    from x402.schemas import PaymentRequired

    client_account = Account.from_key(CLIENT_PRIVATE_KEY)
    client_signer = EthAccountSigner(client_account)
    client = x402ClientSync().register(NETWORK, ExactEvmClientScheme(client_signer))
    client.set_spend_controls(False)

    requirements = _build_requirements(RESOURCE_SERVER_ADDRESS, "1000")
    resource = ResourceInfo(
        url="https://api.example.com/premium",
        description="Premium API Access",
        mime_type="application/json",
    )
    payment_required = PaymentRequired(x402_version=2, resource=resource, accepts=[requirements])
    payload = client.create_payment_payload(payment_required)
    return payload, requirements, client_signer.address


class TestEvmSettlementPendingReconciliation:
    """Exercises the settlement-pending mechanism layer directly against a real
    on-chain EIP-3009 settlement, mirroring
    `TestEVMIntegrationV2_SettlementPendingReconciliation` in go/test/integration/evm_test.go.
    """

    def test_reconciles_against_the_same_broadcast_transaction(self) -> None:
        """The first Settle call broadcasts for real but is forced to fail its receipt
        wait, producing a settlement_pending SettleResponse with the broadcast hash
        attached and a PendingSettlementStore entry populated. A second Settle call with
        the identical payload, now with receipt-waiting un-forced, must hit the
        pending-store fast path (skip verify/broadcast) and reconcile against that
        already-broadcast transaction, returning success with the SAME transaction hash
        as the first attempt — proving no second transaction was ever broadcast.

        WARNING: This spends real Base Sepolia USDC.
        """
        real_facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY, rpc_url=RPC_URL
        )
        facilitator_signer = ForcedPendingReceiptSigner(real_facilitator_signer)
        facilitator_scheme = ExactEvmFacilitatorScheme(
            facilitator_signer,
            ExactEvmSchemeConfig(),  # type: ignore[arg-type]
        )

        payload, requirements, payer_address = _build_payment_payload()

        # Attempt 1: broadcast is real; the receipt wait is forced to fail regardless of
        # real chain confirmation speed.
        facilitator_signer.force_pending = True

        first = facilitator_scheme.settle(payload, requirements)
        assert first.success is False, f"expected settlement_pending, got: {first}"
        assert first.error_reason == ERR_SETTLEMENT_PENDING
        assert first.transaction, (
            "expected a broadcast transaction hash on the settlement_pending result"
        )
        first_tx_hash = first.transaction
        assert facilitator_signer.write_contract_calls == 1

        # Attempt 2: identical payload/requirements, receipt-waiting no longer forced to
        # fail. Must reconcile against first_tx_hash (pending-store hit) rather than
        # re-verifying and re-broadcasting.
        facilitator_signer.force_pending = False

        second = facilitator_scheme.settle(payload, requirements)
        assert second.success is True, (
            f"expected the reconciliation settle to succeed, got: {second}"
        )
        assert second.transaction == first_tx_hash, (
            "reconciliation must reuse the already-broadcast transaction (no second "
            f"broadcast): first={first_tx_hash} second={second.transaction}"
        )
        assert second.payer.lower() == payer_address.lower()
        # Still exactly one broadcast across both attempts.
        assert facilitator_signer.write_contract_calls == 1


class TestEvmResourceServerSettlementPendingRetry:
    """Exercises the generic `x402ResourceServer(Sync).settle_payment` single-retry-on-
    settlement_pending path (`settle_with_pending_retry` in server_base.py) against a
    real broadcast, mirroring `TestEVMIntegrationV2_ResourceServerSettlementPendingRetry`
    in go/test/integration/evm_test.go.
    """

    def test_retry_reconciles_without_a_second_broadcast(self) -> None:
        """While `force_pending` is True for the whole call, both the initial attempt and
        the SDK's automatic single retry are forced to fail their receipt wait, so both
        are expected to observe settlement_pending. The key assertion is that the retry's
        reported transaction hash is identical to the first attempt's, proving the
        resource-server retry drove the mechanism's pending-cache fast path (reconciling
        against the one broadcast transaction) rather than causing a second on-chain
        broadcast.

        WARNING: This spends real Base Sepolia USDC.
        """
        real_facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY, rpc_url=RPC_URL
        )
        facilitator_signer = ForcedPendingReceiptSigner(real_facilitator_signer)
        facilitator_scheme = ExactEvmFacilitatorScheme(
            facilitator_signer,
            ExactEvmSchemeConfig(),  # type: ignore[arg-type]
        )

        facilitator_client = SingleSchemeFacilitatorClientSync(
            SCHEME_EXACT, NETWORK, facilitator_scheme
        )
        server = x402ResourceServerSync(facilitator_client)
        server.register(NETWORK, ExactEvmServerScheme())
        server.initialize()

        payload, requirements, payer_address = _build_payment_payload()
        accepted = server.find_matching_requirements([requirements], payload)
        assert accepted is not None

        facilitator_signer.force_pending = True

        first_attempt = server.settle_payment(payload, accepted)
        assert first_attempt.success is False, (
            f"expected the resource server's (retried) settle to still return "
            f"settlement_pending while receipt-waiting is forced to fail, got: {first_attempt}"
        )
        assert first_attempt.error_reason == ERR_SETTLEMENT_PENDING
        assert first_attempt.transaction, (
            "expected a broadcast transaction hash after the retried settlement_pending"
        )
        first_attempt_tx_hash = first_attempt.transaction
        # Exactly one broadcast across the initial attempt AND its automatic retry.
        assert facilitator_signer.write_contract_calls == 1

        # Reconcile with receipt-waiting no longer forced to fail, directly against the
        # resource server (its facilitator client shares the same in-process
        # mechanism/pending-store instance) to confirm exactly one transaction was ever
        # broadcast across every attempt so far.
        facilitator_signer.force_pending = False

        final = server.settle_payment(payload, accepted)
        assert final.success is True, f"expected final reconciliation to succeed, got: {final}"
        assert final.transaction == first_attempt_tx_hash, (
            "resource-server retry must not cause a second broadcast: "
            f"first-attempt tx={first_attempt_tx_hash} final tx={final.transaction}"
        )
        assert final.payer.lower() == payer_address.lower()
        assert facilitator_signer.write_contract_calls == 1
