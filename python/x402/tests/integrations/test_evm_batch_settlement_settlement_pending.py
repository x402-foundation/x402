"""EVM batch-settlement integration tests for the settlement-pending auto-recovery
mechanism, applied to the deposit settle path (`deposit.py::settle_deposit` /
`_reconcile_pending_deposit`).

Follows the same `ForcedPendingReceiptSigner` decorator pattern as
`test_evm_settlement_pending.py` (itself mirroring the Go integration tests in
go/test/integration/evm_test.go): every broadcast is a real Base Sepolia transaction,
but `wait_for_transaction_receipt` is deterministically forceable to fail on demand via a
mutable flag, so the settlement_pending reconciliation path can be exercised without
racing real chain confirmation speed.

Required environment variables:
- EVM_CLIENT_PRIVATE_KEY (or EVM_CLIENT_EOA_PRIVATE_KEY): Private key for the client (payer).
- EVM_FACILITATOR_PRIVATE_KEY: Private key for the facilitator submitting txs.
Optional:
- EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: defaults to EVM_FACILITATOR_PRIVATE_KEY.
- EVM_RPC_URL: defaults to https://sepolia.base.org.

WARNING: Every test in this file makes a REAL on-chain deposit transaction.
"""

from __future__ import annotations

import os
import secrets
from typing import Any

import pytest
from eth_account import Account

from x402 import x402ClientSync, x402ResourceServerSync
from x402.mechanisms.evm.batch_settlement import SCHEME_BATCH_SETTLEMENT
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementDepositPolicy,
    BatchSettlementEvmSchemeOptions,
    InMemoryClientChannelStorage,
)
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme as BatchSettlementClientScheme,
)
from x402.mechanisms.evm.batch_settlement.facilitator import BatchSettlementEvmFacilitator
from x402.mechanisms.evm.batch_settlement.server import (
    BatchSettlementEvmScheme as BatchSettlementServerScheme,
)
from x402.mechanisms.evm.batch_settlement.server import (
    BatchSettlementEvmSchemeServerConfig,
)
from x402.mechanisms.evm.constants import ERR_SETTLEMENT_PENDING
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo

from ._settlement_pending_helpers import SingleSchemeFacilitatorClientSync

CLIENT_PRIVATE_KEY = os.environ.get("EVM_CLIENT_EOA_PRIVATE_KEY") or os.environ.get(
    "EVM_CLIENT_PRIVATE_KEY"
)
FACILITATOR_PRIVATE_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")
RECEIVER_AUTHORIZER_PRIVATE_KEY = os.environ.get(
    "EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", FACILITATOR_PRIVATE_KEY
)

RPC_URL = os.environ.get("EVM_RPC_URL", "https://sepolia.base.org")
NETWORK = "eip155:84532"
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY or not FACILITATOR_PRIVATE_KEY,
    reason=(
        "EVM_CLIENT_EOA_PRIVATE_KEY (or EVM_CLIENT_PRIVATE_KEY) and EVM_FACILITATOR_PRIVATE_KEY "
        "environment variables required for batch-settlement settlement_pending integration tests"
    ),
)


class ForcedPendingReceiptSigner:
    """Wraps a real `FacilitatorEvmSigner` and, while `force_pending` is True, makes
    `wait_for_transaction_receipt` fail immediately instead of delegating to the real
    (network-speed-dependent) receipt wait. Every other method delegates unmodified to
    the wrapped signer via `__getattr__`, so every broadcast is always real.

    `fail_next_n_waits`, when set to a positive count, forces exactly that many
    subsequent `wait_for_transaction_receipt` calls to fail (decrementing on each
    call) before delegating to the real wait again — used by the resource-server retry
    test below to force only the *first* of the two calls the SDK's single automatic
    retry makes within one `settle_payment()` call, without needing a second top-level
    call (which would race the batch-settlement server scheme's own channel-busy
    tracking, an unrelated concern from a different top-level request).
    """

    def __init__(self, wrapped: FacilitatorWeb3Signer) -> None:
        self._wrapped = wrapped
        self.force_pending = False
        self.fail_next_n_waits = 0
        self.write_contract_calls = 0

    def wait_for_transaction_receipt(self, tx_hash: str) -> Any:
        if self.force_pending or self.fail_next_n_waits > 0:
            self.fail_next_n_waits = max(0, self.fail_next_n_waits - 1)
            raise TimeoutError(
                "forced receipt-wait failure for settlement_pending integration test"
            )
        return self._wrapped.wait_for_transaction_receipt(tx_hash)

    def write_contract(self, *args: Any, **kwargs: Any) -> str:
        self.write_contract_calls += 1
        return self._wrapped.write_contract(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._wrapped, name)


def _build_requirements(pay_to: str, amount: str, receiver_authorizer: str) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=USDC_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra={
            "name": "USDC",
            "version": "2",
            "assetTransferMethod": "eip3009",
            "receiverAuthorizer": receiver_authorizer,
        },
    )


def _build_deposit_payload(
    facilitator_address: str, receiver_authorizer: str
) -> tuple[PaymentPayload, PaymentRequirements]:
    """Create a real, signed batch-settlement deposit payload."""
    from x402.schemas import PaymentRequired

    client_account = Account.from_key(CLIENT_PRIVATE_KEY)
    client_signer = EthAccountSigner(client_account)
    channel_salt = "0x" + secrets.token_bytes(32).hex()
    client_storage = InMemoryClientChannelStorage()
    client = x402ClientSync().register(
        NETWORK,
        BatchSettlementClientScheme(
            client_signer,
            BatchSettlementEvmSchemeOptions(
                storage=client_storage,
                salt=channel_salt,
                deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=3),
            ),
        ),
    )

    requirements = _build_requirements(facilitator_address, "1000", receiver_authorizer)
    resource = ResourceInfo(
        url="https://example.com/api",
        description="Settlement-pending integration test resource",
        mime_type="application/json",
    )
    payment_required = PaymentRequired(x402_version=2, resource=resource, accepts=[requirements])
    payload = client.create_payment_payload(payment_required)
    assert payload.payload.get("type") == "deposit"
    return payload, requirements


class TestEvmBatchSettlementDepositSettlementPendingReconciliation:
    """Exercises the settlement-pending mechanism layer directly against a real
    on-chain batch-settlement deposit, mirroring the shape of
    `TestEvmSettlementPendingReconciliation` (test_evm_settlement_pending.py) applied to
    `BatchSettlementEvmFacilitator.settle`.
    """

    def test_reconciles_against_the_same_broadcast_transaction(self) -> None:
        """The first Settle call broadcasts the deposit for real but is forced to fail
        its receipt wait, producing a settlement_pending SettleResponse with the
        broadcast hash attached and a PendingSettlementStore entry populated (keyed by
        the deposit's ERC-3009 authorization signature). A second Settle call with the
        identical payload, now with receipt-waiting un-forced, must hit the pending-store
        fast path (skip verify/broadcast) and reconcile against that already-broadcast
        transaction, returning success with the SAME transaction hash as the first
        attempt.

        WARNING: This spends real Base Sepolia USDC on a deposit.
        """
        real_facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY, rpc_url=RPC_URL
        )
        facilitator_signer = ForcedPendingReceiptSigner(real_facilitator_signer)
        authorizer_signer = LocalAuthorizerSigner(RECEIVER_AUTHORIZER_PRIVATE_KEY)
        facilitator_scheme = BatchSettlementEvmFacilitator(
            facilitator_signer,
            authorizer_signer,  # type: ignore[arg-type]
        )

        payload, requirements = _build_deposit_payload(
            real_facilitator_signer.address, authorizer_signer.address
        )

        facilitator_signer.force_pending = True

        first = facilitator_scheme.settle(payload, requirements)
        assert first.success is False, f"expected settlement_pending, got: {first}"
        assert first.error_reason == ERR_SETTLEMENT_PENDING
        assert first.transaction, (
            "expected a broadcast transaction hash on the settlement_pending result"
        )
        first_tx_hash = first.transaction
        assert facilitator_signer.write_contract_calls == 1

        facilitator_signer.force_pending = False

        second = facilitator_scheme.settle(payload, requirements)
        assert second.success is True, (
            f"expected the reconciliation settle to succeed, got: {second}"
        )
        assert second.transaction == first_tx_hash, (
            "reconciliation must reuse the already-broadcast transaction (no second "
            f"broadcast): first={first_tx_hash} second={second.transaction}"
        )
        # Still exactly one broadcast across both attempts.
        assert facilitator_signer.write_contract_calls == 1


class TestEvmBatchSettlementResourceServerSettlementPendingRetry:
    """Exercises the generic `x402ResourceServerSync.settle_payment` single-retry-on-
    settlement_pending path (`settle_with_pending_retry` in server_base.py) against a
    real batch-settlement deposit broadcast, entirely within one top-level
    `settle_payment()` call (the retry is internal/transparent to the caller — see
    `ForcedPendingReceiptSigner`'s docstring for why this test forces only the first of
    the two internal attempts to fail, rather than making two top-level calls).
    """

    def test_single_internal_retry_reconciles_without_a_second_broadcast(self) -> None:
        """The resource server's `settle_payment` calls the facilitator client's
        `settle` up to twice internally: the initial attempt, and (only if it returned
        settlement_pending) exactly one automatic retry. Forcing only the first of the
        two `wait_for_transaction_receipt` calls to fail means: the initial internal
        attempt broadcasts for real but observes settlement_pending, and the automatic
        retry — resending the identical payload — must hit the pending-store fast path
        (skip verify/broadcast) and reconcile against that already-broadcast
        transaction, so the top-level call returns success having broadcast exactly
        once.

        WARNING: This spends real Base Sepolia USDC on a deposit.
        """
        real_facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY, rpc_url=RPC_URL
        )
        facilitator_signer = ForcedPendingReceiptSigner(real_facilitator_signer)
        authorizer_signer = LocalAuthorizerSigner(RECEIVER_AUTHORIZER_PRIVATE_KEY)
        facilitator_scheme = BatchSettlementEvmFacilitator(
            facilitator_signer,
            authorizer_signer,  # type: ignore[arg-type]
        )

        facilitator_client = SingleSchemeFacilitatorClientSync(
            SCHEME_BATCH_SETTLEMENT, NETWORK, facilitator_scheme
        )
        server = x402ResourceServerSync(facilitator_client)
        server.register(
            NETWORK,
            BatchSettlementServerScheme(
                real_facilitator_signer.address,
                BatchSettlementEvmSchemeServerConfig(
                    receiver_authorizer_signer=authorizer_signer,
                ),
            ),
        )
        server.initialize()

        payload, requirements = _build_deposit_payload(
            real_facilitator_signer.address, authorizer_signer.address
        )
        accepted = server.find_matching_requirements([requirements], payload)
        assert accepted is not None

        # The server's channel-busy tracking (a request_context keyed by id(payload),
        # taken during verify) requires a verify call before settle — matching the real
        # HTTP request flow (and test_evm_batch_settlement.py's pattern) — before the
        # settlement_pending mechanics under test even come into play.
        verify_response = server.verify_payment(payload, accepted)
        assert verify_response.is_valid is True, f"verify failed: {verify_response.invalid_reason}"

        # Fail exactly the first wait_for_transaction_receipt call (the initial
        # internal attempt); the retry's wait (against the pending-store's cached
        # hash) is left un-forced so it observes the real confirmation.
        facilitator_signer.fail_next_n_waits = 1

        result = server.settle_payment(payload, accepted)

        assert result.success is True, (
            "expected the resource server's single automatic retry to reconcile "
            f"against the already-broadcast transaction and succeed, got: {result}"
        )
        assert result.transaction, "expected a transaction hash on the successful settlement"
        assert facilitator_signer.write_contract_calls == 1, (
            "the automatic retry must reconcile against the pending-store fast path "
            "rather than broadcasting a second deposit transaction"
        )
