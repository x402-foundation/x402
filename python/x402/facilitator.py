"""x402Facilitator - Payment verification and settlement component.

Provides both async (x402Facilitator) and sync (x402FacilitatorSync)
implementations. Runs as a service, manages scheme mechanisms, handles V1/V2 routing.
"""

from __future__ import annotations

import asyncio
from typing import Any

from typing_extensions import Self

from .facilitator_base import (
    AfterSettleHook,
    AfterVerifyHook,
    BeforeSettleHook,
    BeforeVerifyHook,
    OnSettleFailureHook,
    OnVerifyFailureHook,
    SyncAfterSettleHook,
    SyncAfterVerifyHook,
    SyncBeforeSettleHook,
    SyncBeforeVerifyHook,
    SyncOnSettleFailureHook,
    SyncOnVerifyFailureHook,
    x402FacilitatorBase,
)
from .schemas import (
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequirements,
    PaymentRequirementsV1,
    SettleResponse,
    VerifyResponse,
)

# ============================================================================
# Async Facilitator (Default)
# ============================================================================


class x402Facilitator(x402FacilitatorBase):
    """Async payment verification and settlement component.

    Supports both sync and async hooks (auto-detected).
    Use x402FacilitatorSync for sync-only environments.

    Example:
        ```python
        from x402 import x402Facilitator
        from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme

        facilitator = x402Facilitator()
        facilitator.register(
            ["eip155:8453", "eip155:84532"],
            ExactEvmFacilitatorScheme(wallet=facilitator_wallet),
        )
        facilitator.register_extension(FacilitatorExtension(key="bazaar"))

        # Verify payment
        result = await facilitator.verify(payload, requirements)

        # Get supported kinds for /supported endpoint
        supported = facilitator.get_supported()
        ```
    """

    def __init__(self) -> None:
        """Initialize async x402Facilitator."""
        super().__init__()
        # Type the hook lists properly
        self._before_verify_hooks: list[BeforeVerifyHook] = []
        self._after_verify_hooks: list[AfterVerifyHook] = []
        self._on_verify_failure_hooks: list[OnVerifyFailureHook] = []

        self._before_settle_hooks: list[BeforeSettleHook] = []
        self._after_settle_hooks: list[AfterSettleHook] = []
        self._on_settle_failure_hooks: list[OnSettleFailureHook] = []

    # ========================================================================
    # Hook Registration
    # ========================================================================

    def on_before_verify(self, hook: BeforeVerifyHook) -> Self:
        """Register hook before verification. Return AbortResult to abort."""
        self._before_verify_hooks.append(hook)
        return self

    def on_after_verify(self, hook: AfterVerifyHook) -> Self:
        """Register hook after successful verification."""
        self._after_verify_hooks.append(hook)
        return self

    def on_verify_failure(self, hook: OnVerifyFailureHook) -> Self:
        """Register hook on verification failure. Return RecoveredVerifyResult to recover."""
        self._on_verify_failure_hooks.append(hook)
        return self

    def on_before_settle(self, hook: BeforeSettleHook) -> Self:
        """Register hook before settlement. Return AbortResult to abort."""
        self._before_settle_hooks.append(hook)
        return self

    def on_after_settle(self, hook: AfterSettleHook) -> Self:
        """Register hook after successful settlement."""
        self._after_settle_hooks.append(hook)
        return self

    def on_settle_failure(self, hook: OnSettleFailureHook) -> Self:
        """Register hook on settlement failure. Return RecoveredSettleResult to recover."""
        self._on_settle_failure_hooks.append(hook)
        return self

    # ========================================================================
    # Verify (Async)
    # ========================================================================

    async def verify(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None = None,
        requirements_bytes: bytes | None = None,
    ) -> VerifyResponse:
        """Verify a payment.

        Routes to V1 or V2 verification based on payload version.

        Args:
            payload: Payment payload to verify.
            requirements: Requirements to verify against.
            payload_bytes: Raw payload bytes (escape hatch for extensions).
            requirements_bytes: Raw requirements bytes (escape hatch).

        Returns:
            VerifyResponse with is_valid=True or is_valid=False.

        Raises:
            SchemeNotFoundError: If no facilitator registered for scheme/network.
            PaymentAbortedError: If a before hook aborts.
        """
        gen = self._verify_core(payload, requirements, payload_bytes, requirements_bytes)
        result = None
        try:
            while True:
                _, hook, ctx = gen.send(result)
                result = await self._execute_hook(hook, ctx)
        except StopIteration as e:
            return e.value

    # ========================================================================
    # Settle (Async)
    # ========================================================================

    async def settle(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None = None,
        requirements_bytes: bytes | None = None,
    ) -> SettleResponse:
        """Settle a payment.

        Routes to V1 or V2 settlement based on payload version.

        Args:
            payload: Payment payload to settle.
            requirements: Requirements for settlement.
            payload_bytes: Raw payload bytes (escape hatch for extensions).
            requirements_bytes: Raw requirements bytes (escape hatch).

        Returns:
            SettleResponse with success=True or success=False.

        Raises:
            SchemeNotFoundError: If no facilitator registered for scheme/network.
            PaymentAbortedError: If a before hook aborts.
        """
        gen = self._settle_core(payload, requirements, payload_bytes, requirements_bytes)
        result = None
        try:
            while True:
                _, hook, ctx = gen.send(result)
                result = await self._execute_hook(hook, ctx)
        except StopIteration as e:
            return e.value

    async def _execute_hook(self, hook: Any, context: Any) -> Any:
        """Execute hook, auto-detecting sync/async."""
        result = hook(context)
        if asyncio.iscoroutine(result) or asyncio.isfuture(result):
            return await result
        return result


# ============================================================================
# Sync Facilitator
# ============================================================================


class x402FacilitatorSync(x402FacilitatorBase):
    """Sync payment verification and settlement component.

    Only supports sync hooks. For async hook support, use x402Facilitator.

    Example:
        ```python
        from x402 import x402FacilitatorSync
        from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme

        facilitator = x402FacilitatorSync()
        facilitator.register(
            ["eip155:8453", "eip155:84532"],
            ExactEvmFacilitatorScheme(wallet=facilitator_wallet),
        )

        # Verify payment
        result = facilitator.verify(payload, requirements)
        ```
    """

    def __init__(self) -> None:
        """Initialize sync x402Facilitator."""
        super().__init__()
        # Type the hook lists for sync-only
        self._before_verify_hooks: list[SyncBeforeVerifyHook] = []
        self._after_verify_hooks: list[SyncAfterVerifyHook] = []
        self._on_verify_failure_hooks: list[SyncOnVerifyFailureHook] = []

        self._before_settle_hooks: list[SyncBeforeSettleHook] = []
        self._after_settle_hooks: list[SyncAfterSettleHook] = []
        self._on_settle_failure_hooks: list[SyncOnSettleFailureHook] = []

    # ========================================================================
    # Hook Registration
    # ========================================================================

    def on_before_verify(self, hook: SyncBeforeVerifyHook) -> Self:
        """Register hook before verification. Return AbortResult to abort."""
        self._before_verify_hooks.append(hook)
        return self

    def on_after_verify(self, hook: SyncAfterVerifyHook) -> Self:
        """Register hook after successful verification."""
        self._after_verify_hooks.append(hook)
        return self

    def on_verify_failure(self, hook: SyncOnVerifyFailureHook) -> Self:
        """Register hook on verification failure. Return RecoveredVerifyResult to recover."""
        self._on_verify_failure_hooks.append(hook)
        return self

    def on_before_settle(self, hook: SyncBeforeSettleHook) -> Self:
        """Register hook before settlement. Return AbortResult to abort."""
        self._before_settle_hooks.append(hook)
        return self

    def on_after_settle(self, hook: SyncAfterSettleHook) -> Self:
        """Register hook after successful settlement."""
        self._after_settle_hooks.append(hook)
        return self

    def on_settle_failure(self, hook: SyncOnSettleFailureHook) -> Self:
        """Register hook on settlement failure. Return RecoveredSettleResult to recover."""
        self._on_settle_failure_hooks.append(hook)
        return self

    # ========================================================================
    # Verify (Sync)
    # ========================================================================

    def verify(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None = None,
        requirements_bytes: bytes | None = None,
    ) -> VerifyResponse:
        """Verify a payment.

        Routes to V1 or V2 verification based on payload version.

        Args:
            payload: Payment payload to verify.
            requirements: Requirements to verify against.
            payload_bytes: Raw payload bytes (escape hatch for extensions).
            requirements_bytes: Raw requirements bytes (escape hatch).

        Returns:
            VerifyResponse with is_valid=True or is_valid=False.

        Raises:
            SchemeNotFoundError: If no facilitator registered for scheme/network.
            PaymentAbortedError: If a before hook aborts.
        """
        gen = self._verify_core(payload, requirements, payload_bytes, requirements_bytes)
        result = None
        try:
            while True:
                _, hook, ctx = gen.send(result)
                result = self._execute_hook_sync(hook, ctx)
        except StopIteration as e:
            return e.value

    # ========================================================================
    # Settle (Sync)
    # ========================================================================

    def settle(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None = None,
        requirements_bytes: bytes | None = None,
    ) -> SettleResponse:
        """Settle a payment.

        Routes to V1 or V2 settlement based on payload version.

        Args:
            payload: Payment payload to settle.
            requirements: Requirements for settlement.
            payload_bytes: Raw payload bytes (escape hatch for extensions).
            requirements_bytes: Raw requirements bytes (escape hatch).

        Returns:
            SettleResponse with success=True or success=False.

        Raises:
            SchemeNotFoundError: If no facilitator registered for scheme/network.
            PaymentAbortedError: If a before hook aborts.
        """
        gen = self._settle_core(payload, requirements, payload_bytes, requirements_bytes)
        result = None
        try:
            while True:
                _, hook, ctx = gen.send(result)
                result = self._execute_hook_sync(hook, ctx)
        except StopIteration as e:
            return e.value

    def _execute_hook_sync(self, hook: Any, context: Any) -> Any:
        """Execute hook synchronously. Raises if async hook detected."""
        result = hook(context)
        if asyncio.iscoroutine(result):
            result.close()  # Prevent warning
            raise TypeError(
                "Async hooks are not supported in x402FacilitatorSync. "
                "Use x402Facilitator for async hook support."
            )
        return result
