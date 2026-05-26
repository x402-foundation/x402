"""x402Client - Client-side component for creating payment payloads.

Provides both async (x402Client) and sync (x402ClientSync) implementations.
Async is the default with full async hook support.
"""

from __future__ import annotations

import asyncio
from typing import Any

from typing_extensions import Self

from .client_base import (
    AfterPaymentCreationHook,
    BeforePaymentCreationHook,
    OnPaymentCreationFailureHook,
    OnPaymentResponseHook,
    PaymentRequirementsSelector,
    SchemeRegistration,
    SyncAfterPaymentCreationHook,
    SyncBeforePaymentCreationHook,
    SyncOnPaymentCreationFailureHook,
    SyncOnPaymentResponseHook,
    default_payment_selector,
    max_amount,
    prefer_network,
    prefer_scheme,
    x402ClientBase,
    x402ClientConfig,
)

# Re-export from client_base for external use
from .hook_adapters import get_labeled_client_hooks
from .schemas import (
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequiredV1,
    PaymentResponseContext,
    RecoveredResponseResult,
    ResourceInfo,
)

__all__ = [
    "x402Client",
    "x402ClientSync",
    "x402ClientConfig",
    "SchemeRegistration",
    "default_payment_selector",
    "prefer_network",
    "prefer_scheme",
    "max_amount",
]


# ============================================================================
# Async Client (Default)
# ============================================================================


class x402Client(x402ClientBase):
    """Async client-side component for creating payment payloads.

    Supports both sync and async hooks (auto-detected).
    Use x402ClientSync for sync-only environments.

    Example:
        ```python
        from x402 import x402Client
        from x402.mechanisms.evm.exact import ExactEvmScheme

        client = x402Client()
        client.register("eip155:8453", ExactEvmScheme(signer=my_signer))
        client.register_policy(prefer_network("eip155:8453"))

        # Create payment payload from 402 response
        payload = await client.create_payment_payload(payment_required)
        ```
    """

    def __init__(
        self,
        payment_requirements_selector: PaymentRequirementsSelector | None = None,
    ) -> None:
        """Initialize async x402Client."""
        super().__init__(payment_requirements_selector)
        # Type the hook lists properly
        self._before_payment_creation_hooks: list[BeforePaymentCreationHook] = []
        self._after_payment_creation_hooks: list[AfterPaymentCreationHook] = []
        self._on_payment_creation_failure_hooks: list[OnPaymentCreationFailureHook] = []
        self._payment_response_hooks: list[OnPaymentResponseHook] = []

    # ========================================================================
    # Factory Methods
    # ========================================================================

    @classmethod
    def from_config(cls, config: x402ClientConfig) -> x402Client:
        """Create a new x402Client instance from a configuration object."""
        client = cls(config.payment_requirements_selector)
        for scheme in config.schemes:
            if scheme.x402_version == 1:
                client.register_v1(scheme.network, scheme.client)  # type: ignore[arg-type]
            else:
                client.register(scheme.network, scheme.client)  # type: ignore[arg-type]
        for policy in config.policies or []:
            client.register_policy(policy)
        return client

    # ========================================================================
    #

    # ========================================================================

    def on_before_payment_creation(self, hook: BeforePaymentCreationHook) -> Self:
        """Register hook before payment creation. Return AbortResult to abort."""
        self._before_payment_creation_hooks.append(hook)
        return self

    def on_after_payment_creation(self, hook: AfterPaymentCreationHook) -> Self:
        """Register hook after successful payment creation."""
        self._after_payment_creation_hooks.append(hook)
        return self

    def on_payment_creation_failure(self, hook: OnPaymentCreationFailureHook) -> Self:
        """Register hook on failure. Return RecoveredPayloadResult to recover."""
        self._on_payment_creation_failure_hooks.append(hook)
        return self

    def on_payment_response(self, hook: OnPaymentResponseHook) -> Self:
        """Register hook after a paid request. Return RecoveredResponseResult to recover."""
        self._payment_response_hooks.append(hook)
        return self

    async def handle_payment_response(
        self, ctx: PaymentResponseContext
    ) -> RecoveredResponseResult | None:
        """Run payment response hooks; first recovery result wins."""
        declared = (
            ctx.payment_required.extensions
            if ctx.payment_required and ctx.payment_required.extensions
            else {}
        )
        for _label, hook in get_labeled_client_hooks(
            "on_payment_response",
            self,
            ctx.payment_payload.x402_version,
            ctx.requirements,
            declared,
        ):
            result = await self._execute_hook(hook, ctx)
            if result is not None:
                return result
        return None

    # ========================================================================
    # Payment Creation (Async)
    # ========================================================================

    async def create_payment_payload(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
        resource: ResourceInfo | None = None,
        extensions: dict[str, Any] | None = None,
    ) -> PaymentPayload | PaymentPayloadV1:
        """Create a payment payload for the given 402 response.

        Args:
            payment_required: The 402 response from the server.
            resource: Optional resource info to include.
            extensions: Optional extensions to include.

        Returns:
            PaymentPayload (V2) or PaymentPayloadV1 (V1).

        Raises:
            NoMatchingRequirementsError: If no requirements match registered schemes.
            SchemeNotFoundError: If scheme not found for selected requirement.
            PaymentAbortedError: If a before hook aborts the operation.
        """
        version = payment_required.x402_version

        if version == 1:
            return await self._create_payment_payload_v1(
                payment_required,  # type: ignore[arg-type]
            )
        else:
            return await self._create_payment_payload_v2(
                payment_required,  # type: ignore[arg-type]
                resource,
                extensions,
            )

    async def _create_payment_payload_v2(
        self,
        payment_required: PaymentRequired,
        resource: ResourceInfo | None,
        extensions: dict[str, Any] | None,
    ) -> PaymentPayload:
        """Create V2 payment payload using generator."""
        gen = self._create_payment_payload_v2_core(payment_required, resource, extensions)
        result = None
        try:
            while True:
                _, hook, ctx = gen.send(result)
                result = await self._execute_hook(hook, ctx)
        except StopIteration as e:
            return await self._enrich_payment_payload_with_extensions_async(
                e.value,
                payment_required,
            )

    async def _create_payment_payload_v1(
        self,
        payment_required: PaymentRequiredV1,
    ) -> PaymentPayloadV1:
        """Create V1 payment payload using generator."""
        gen = self._create_payment_payload_v1_core(payment_required)
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
# Sync Client
# ============================================================================


class x402ClientSync(x402ClientBase):
    """Sync client-side component for creating payment payloads.

    Only supports sync hooks. For async hook support, use x402Client.

    Example:
        ```python
        from x402 import x402ClientSync
        from x402.mechanisms.evm.exact import ExactEvmScheme

        client = x402ClientSync()
        client.register("eip155:8453", ExactEvmScheme(signer=my_signer))

        # Create payment payload from 402 response
        payload = client.create_payment_payload(payment_required)
        ```
    """

    def __init__(
        self,
        payment_requirements_selector: PaymentRequirementsSelector | None = None,
    ) -> None:
        """Initialize sync x402Client."""
        super().__init__(payment_requirements_selector)
        # Type the hook lists for sync-only
        self._before_payment_creation_hooks: list[SyncBeforePaymentCreationHook] = []
        self._after_payment_creation_hooks: list[SyncAfterPaymentCreationHook] = []
        self._on_payment_creation_failure_hooks: list[SyncOnPaymentCreationFailureHook] = []
        self._payment_response_hooks: list[SyncOnPaymentResponseHook] = []

    # ========================================================================
    # Factory Methods
    # ========================================================================

    @classmethod
    def from_config(cls, config: x402ClientConfig) -> x402ClientSync:
        """Create a new x402ClientSync instance from a configuration object."""
        client = cls(config.payment_requirements_selector)
        for scheme in config.schemes:
            if scheme.x402_version == 1:
                client.register_v1(scheme.network, scheme.client)  # type: ignore[arg-type]
            else:
                client.register(scheme.network, scheme.client)  # type: ignore[arg-type]
        for policy in config.policies or []:
            client.register_policy(policy)
        return client

    # ========================================================================
    # Hook Registration
    # ========================================================================

    def on_before_payment_creation(self, hook: SyncBeforePaymentCreationHook) -> Self:
        """Register hook before payment creation. Return AbortResult to abort."""
        self._before_payment_creation_hooks.append(hook)
        return self

    def on_after_payment_creation(self, hook: SyncAfterPaymentCreationHook) -> Self:
        """Register hook after successful payment creation."""
        self._after_payment_creation_hooks.append(hook)
        return self

    def on_payment_creation_failure(self, hook: SyncOnPaymentCreationFailureHook) -> Self:
        """Register hook on failure. Return RecoveredPayloadResult to recover."""
        self._on_payment_creation_failure_hooks.append(hook)
        return self

    def on_payment_response(self, hook: SyncOnPaymentResponseHook) -> Self:
        """Register hook after a paid request. Return RecoveredResponseResult to recover."""
        self._payment_response_hooks.append(hook)
        return self

    def handle_payment_response(
        self, ctx: PaymentResponseContext
    ) -> RecoveredResponseResult | None:
        """Run payment response hooks; first recovery result wins."""
        declared = (
            ctx.payment_required.extensions
            if ctx.payment_required and ctx.payment_required.extensions
            else {}
        )
        for _label, hook in get_labeled_client_hooks(
            "on_payment_response",
            self,
            ctx.payment_payload.x402_version,
            ctx.requirements,
            declared,
        ):
            result = self._execute_hook_sync(hook, ctx)
            if result is not None:
                return result
        return None

    # ========================================================================
    # Payment Creation (Sync)
    # ========================================================================

    def create_payment_payload(
        self,
        payment_required: PaymentRequired | PaymentRequiredV1,
        resource: ResourceInfo | None = None,
        extensions: dict[str, Any] | None = None,
    ) -> PaymentPayload | PaymentPayloadV1:
        """Create a payment payload for the given 402 response.

        Args:
            payment_required: The 402 response from the server.
            resource: Optional resource info to include.
            extensions: Optional extensions to include.

        Returns:
            PaymentPayload (V2) or PaymentPayloadV1 (V1).

        Raises:
            NoMatchingRequirementsError: If no requirements match registered schemes.
            SchemeNotFoundError: If scheme not found for selected requirement.
            PaymentAbortedError: If a before hook aborts the operation.
        """
        version = payment_required.x402_version

        if version == 1:
            return self._create_payment_payload_v1(
                payment_required,  # type: ignore[arg-type]
            )
        else:
            return self._create_payment_payload_v2(
                payment_required,  # type: ignore[arg-type]
                resource,
                extensions,
            )

    def _create_payment_payload_v2(
        self,
        payment_required: PaymentRequired,
        resource: ResourceInfo | None,
        extensions: dict[str, Any] | None,
    ) -> PaymentPayload:
        """Create V2 payment payload using generator."""
        gen = self._create_payment_payload_v2_core(payment_required, resource, extensions)
        result = None
        try:
            while True:
                _, hook, ctx = gen.send(result)
                result = self._execute_hook_sync(hook, ctx)
        except StopIteration as e:
            return self._enrich_payment_payload_with_extensions(e.value, payment_required)

    def _create_payment_payload_v1(
        self,
        payment_required: PaymentRequiredV1,
    ) -> PaymentPayloadV1:
        """Create V1 payment payload using generator."""
        gen = self._create_payment_payload_v1_core(payment_required)
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
                "Async hooks are not supported in x402ClientSync. "
                "Use x402Client for async hook support."
            )
        return result
