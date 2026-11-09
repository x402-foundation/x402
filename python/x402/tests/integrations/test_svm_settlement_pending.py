"""SVM integration tests for the settlement-pending auto-recovery mechanism.

Mirrors the Go integration tests `TestSVMIntegrationV2_SettlementPendingReconciliation`
and `TestSVMIntegrationV2_ResourceServerSettlementPendingRetry`
(go/test/integration/svm_test.go), which are themselves the reference for this pattern —
see also `test_evm_settlement_pending.py` for the EVM equivalent this file mirrors.

Uses `ForcedPendingConfirmSigner`, a decorator around the real `FacilitatorKeypairSigner`
that forces just `confirm_transaction` to fail on demand via a mutable flag, while every
other signer method (`sign_transaction`, `send_transaction`, `simulate_transaction`,
`get_addresses`) delegates unmodified to the real signer. This means every broadcast in
these tests is a real Solana devnet transaction, but the confirmation wait is
deterministically forceable — avoiding any dependency on real chain confirmation speed.

Required environment variables:
- SVM_CLIENT_PRIVATE_KEY: Base58 private key for the client (payer).
- SVM_FACILITATOR_PRIVATE_KEY: Base58 private key for the facilitator (fee payer).
- SVM_FACILITATOR_ADDRESS: The facilitator's fee-payer address.
- SVM_RESOURCE_SERVER_ADDRESS: Recipient address for the settled payment.

These must be funded accounts on Solana Devnet with SOL and USDC.

WARNING: Every test in this file makes a REAL on-chain transaction.
"""

from __future__ import annotations

import os
from typing import Any

import pytest
from solders.keypair import Keypair

from x402 import x402ClientSync, x402ResourceServerSync
from x402.mechanisms.svm import (
    SCHEME_EXACT,
    SOLANA_DEVNET_CAIP2,
    USDC_DEVNET_ADDRESS,
    KeypairSigner,
)
from x402.mechanisms.svm.exact import (
    ExactSvmClientScheme,
    ExactSvmFacilitatorScheme,
    ExactSvmServerScheme,
)
from x402.mechanisms.svm.signers import FacilitatorKeypairSigner
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo

from ._settlement_pending_helpers import SingleSchemeFacilitatorClientSync

CLIENT_PRIVATE_KEY = os.environ.get("SVM_CLIENT_PRIVATE_KEY")
FACILITATOR_PRIVATE_KEY = os.environ.get("SVM_FACILITATOR_PRIVATE_KEY")
FACILITATOR_ADDRESS = os.environ.get("SVM_FACILITATOR_ADDRESS")
RESOURCE_SERVER_ADDRESS = os.environ.get("SVM_RESOURCE_SERVER_ADDRESS")

RPC_URL = os.environ.get("SVM_RPC_URL")
NETWORK = SOLANA_DEVNET_CAIP2

pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY
    or not FACILITATOR_PRIVATE_KEY
    or not FACILITATOR_ADDRESS
    or not RESOURCE_SERVER_ADDRESS,
    reason=(
        "SVM_CLIENT_PRIVATE_KEY, SVM_FACILITATOR_PRIVATE_KEY, SVM_FACILITATOR_ADDRESS, and "
        "SVM_RESOURCE_SERVER_ADDRESS environment variables required for settlement_pending "
        "integration tests"
    ),
)


class ForcedPendingConfirmSigner:
    """Wraps a real `FacilitatorSvmSigner` and, while `force_pending` is True, makes
    `confirm_transaction` fail immediately instead of delegating to the real
    (network-speed-dependent) confirmation polling. Every other method
    (sign_transaction, send_transaction, simulate_transaction, get_addresses) delegates
    unmodified to the wrapped signer via `__getattr__`, so every broadcast is always
    real.
    """

    def __init__(self, wrapped: FacilitatorKeypairSigner) -> None:
        self._wrapped = wrapped
        self.force_pending = False
        self.send_transaction_calls = 0

    def confirm_transaction(self, signature: str, network: str) -> None:
        if self.force_pending:
            raise TimeoutError(
                "forced confirmation failure for settlement_pending integration test"
            )
        return self._wrapped.confirm_transaction(signature, network)

    def send_transaction(self, tx_base64: str, network: str) -> str:
        self.send_transaction_calls += 1
        return self._wrapped.send_transaction(tx_base64, network)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._wrapped, name)


def _build_requirements(pay_to: str, amount: str, fee_payer: str) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_EXACT,
        network=NETWORK,
        asset=USDC_DEVNET_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra={"feePayer": fee_payer},
    )


def _build_payment_payload() -> tuple[PaymentPayload, PaymentRequirements, str]:
    """Create a real, signed SVM exact payment payload shared by the tests below."""
    client_keypair = Keypair.from_base58_string(CLIENT_PRIVATE_KEY)
    client_signer = KeypairSigner(client_keypair)
    client = x402ClientSync().register(
        NETWORK, ExactSvmClientScheme(client_signer, rpc_url=RPC_URL)
    )
    client.set_spend_controls(False)

    requirements = _build_requirements(RESOURCE_SERVER_ADDRESS, "1000", FACILITATOR_ADDRESS)
    resource = ResourceInfo(
        url="https://api.example.com/premium",
        description="Premium API Access",
        mime_type="application/json",
    )
    payment_required = PaymentRequired(x402_version=2, resource=resource, accepts=[requirements])
    payload = client.create_payment_payload(payment_required)
    return payload, requirements, client_signer.address


class TestSvmSettlementPendingReconciliation:
    """Exercises the settlement-pending mechanism layer directly against a real
    on-chain SVM exact settlement, mirroring
    `TestSVMIntegrationV2_SettlementPendingReconciliation` in go/test/integration/svm_test.go.
    """

    def test_reconciles_against_the_same_broadcast_signature(self) -> None:
        """The first Settle call broadcasts for real but is forced to fail
        `ConfirmTransaction`, producing a settlement_pending SettleResponse with the
        broadcast signature attached and a PendingSettlementStore entry populated
        (keyed by the transaction's message hash). A second Settle call with the
        identical payload, now with confirmation no longer forced to fail, must hit the
        pending-store fast path (skip verify/re-send) and reconcile against that
        already-broadcast signature, returning success with the SAME signature as the
        first attempt — proving no second transaction was ever broadcast.

        WARNING: This spends real Solana Devnet USDC.
        """
        real_facilitator_signer = FacilitatorKeypairSigner.from_base58(
            FACILITATOR_PRIVATE_KEY, rpc_url=RPC_URL
        )
        facilitator_signer = ForcedPendingConfirmSigner(real_facilitator_signer)
        facilitator_scheme = ExactSvmFacilitatorScheme(facilitator_signer)  # type: ignore[arg-type]

        payload, requirements, payer_address = _build_payment_payload()

        # Attempt 1: broadcast is real; confirmation is forced to fail regardless of
        # real devnet confirmation speed.
        facilitator_signer.force_pending = True

        first = facilitator_scheme.settle(payload, requirements)
        assert first.success is False, f"expected settlement_pending, got: {first}"
        assert first.error_reason == "settlement_pending"
        assert first.transaction, (
            "expected a broadcast transaction signature on the settlement_pending result"
        )
        first_signature = first.transaction
        assert facilitator_signer.send_transaction_calls == 1

        # Attempt 2: identical payload/requirements, confirmation no longer forced to
        # fail. Must reconcile against first_signature (pending-store hit) rather than
        # re-verifying and re-sending.
        facilitator_signer.force_pending = False

        second = facilitator_scheme.settle(payload, requirements)
        assert second.success is True, (
            f"expected the reconciliation settle to succeed, got: {second}"
        )
        assert second.transaction == first_signature, (
            "reconciliation must reuse the already-broadcast transaction (no second "
            f"broadcast): first={first_signature} second={second.transaction}"
        )
        assert second.payer == payer_address
        # Still exactly one broadcast across both attempts.
        assert facilitator_signer.send_transaction_calls == 1


class TestSvmResourceServerSettlementPendingRetry:
    """Exercises the generic `x402ResourceServer(Sync).settle_payment` single-retry-on-
    settlement_pending path (`settle_with_pending_retry` in server_base.py) against a
    real SVM broadcast, mirroring
    `TestSVMIntegrationV2_ResourceServerSettlementPendingRetry` in
    go/test/integration/svm_test.go.
    """

    def test_retry_reconciles_without_a_second_broadcast(self) -> None:
        """While `force_pending` is True for the whole call, both the initial attempt
        and the SDK's automatic single retry are forced to fail confirmation, so both
        are expected to observe settlement_pending. The key assertion is that the
        retry's reported transaction signature is identical to the first attempt's,
        proving the resource-server retry drove the mechanism's pending-cache fast path
        (reconciling against the one broadcast transaction) rather than causing a second
        on-chain broadcast.

        WARNING: This spends real Solana Devnet USDC.
        """
        real_facilitator_signer = FacilitatorKeypairSigner.from_base58(
            FACILITATOR_PRIVATE_KEY, rpc_url=RPC_URL
        )
        facilitator_signer = ForcedPendingConfirmSigner(real_facilitator_signer)
        facilitator_scheme = ExactSvmFacilitatorScheme(facilitator_signer)  # type: ignore[arg-type]

        facilitator_client = SingleSchemeFacilitatorClientSync(
            SCHEME_EXACT, NETWORK, facilitator_scheme
        )
        server = x402ResourceServerSync(facilitator_client)
        server.register(NETWORK, ExactSvmServerScheme())
        server.initialize()

        payload, requirements, payer_address = _build_payment_payload()
        accepted = server.find_matching_requirements([requirements], payload)
        assert accepted is not None

        facilitator_signer.force_pending = True

        first_attempt = server.settle_payment(payload, accepted)
        assert first_attempt.success is False, (
            f"expected the resource server's (retried) settle to still return "
            f"settlement_pending while confirmation is forced to fail, got: {first_attempt}"
        )
        assert first_attempt.error_reason == "settlement_pending"
        assert first_attempt.transaction, (
            "expected a broadcast transaction signature after the retried settlement_pending"
        )
        first_attempt_signature = first_attempt.transaction
        # Exactly one broadcast across the initial attempt AND its automatic retry.
        assert facilitator_signer.send_transaction_calls == 1

        # Reconcile with confirmation no longer forced to fail, directly against the
        # resource server (its facilitator client shares the same in-process
        # mechanism/pending-store instance) to confirm exactly one transaction was ever
        # broadcast across every attempt so far.
        facilitator_signer.force_pending = False

        final = server.settle_payment(payload, accepted)
        assert final.success is True, f"expected final reconciliation to succeed, got: {final}"
        assert final.transaction == first_attempt_signature, (
            "resource-server retry must not cause a second broadcast: "
            f"first-attempt tx={first_attempt_signature} final tx={final.transaction}"
        )
        assert final.payer == payer_address
        assert facilitator_signer.send_transaction_calls == 1
