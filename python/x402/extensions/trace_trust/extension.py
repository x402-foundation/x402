"""TRACE API Trust Provider Extension."""

import asyncio
from typing import Any

try:
    import httpx
except ImportError as e:
    raise ImportError(
        "TRACE trust extension requires httpx. Install with: uv add x402[httpx]"
    ) from e

from x402.schemas.errors import PaymentAbortedError
from x402.schemas.extensions import (
    ResourceServerExtension,
    ResourceServerExtensionHooks,
    ResourceServerTransportExtensionHooks,
)
from x402.schemas.hooks import (
    ServerPaymentRequiredContext,
    SettleContext,
    SettleFailureContext,
    SettleResultContext,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyFailureContext,
    VerifyResultContext,
)


class TraceTrustExtensionHooks(ResourceServerExtensionHooks):
    """Hooks for verifying TRACE trust score."""

    def __init__(self, api_url: str, api_key: str, min_score: float = 0.35, fail_closed: bool = True):
        self._client = httpx.AsyncClient(timeout=5.0)
        self.api_url = api_url
        self.api_key = api_key
        self.min_score = min_score
        self.fail_closed = fail_closed

    async def aclose(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def on_after_verify(
        self,
        declaration: Any,
        context: VerifyResultContext,
    ) -> None:
        """Query TRACE API to verify payer's trust score."""
        if not context.result.is_valid or not context.result.payer:
            return

        try:
            resp = await self._client.post(
                f"{self.api_url.rstrip('/')}/v1/score",
                json={
                    "provider_id": context.result.payer,
                    "job": {
                        "capability": declaration.get("capability", "unknown") if isinstance(declaration, dict) else "unknown",
                    },
                },
                headers={"X-API-Key": self.api_key},
            )

            if resp.status_code == 200:
                data = resp.json()
                score = float(data.get("score", 1.0))
                decision = data.get("routing_decision")

                if decision in ("HOLD", "INVESTIGATE") or score < self.min_score:
                    raise PaymentAbortedError(f"Payment rejected: Payer trust score too low (score={score}, decision={decision})")
            elif self.fail_closed:
                raise PaymentAbortedError(f"TRACE API error: {resp.status_code}")

        except PaymentAbortedError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if self.fail_closed:
                raise PaymentAbortedError(f"TRACE API call failed: {e}") from e

    # No-ops for other hooks
    def on_before_verify(self, declaration: Any, context: VerifyContext) -> None:
        pass

    def on_verify_failure(self, declaration: Any, context: VerifyFailureContext) -> None:
        pass

    def on_before_settle(self, declaration: Any, context: SettleContext) -> None:
        pass

    def on_after_settle(self, declaration: Any, context: SettleResultContext) -> None:
        pass

    def on_settle_failure(self, declaration: Any, context: SettleFailureContext) -> None:
        pass

    def on_verified_payment_canceled(self, declaration: Any, context: VerifiedPaymentCanceledContext) -> None:
        pass


class TraceTrustExtension(ResourceServerExtension):
    """x402 Resource Server extension for TRACE API trust evaluation."""

    def __init__(self, api_url: str, api_key: str, min_score: float = 0.35, fail_closed: bool = True):
        self._hooks = TraceTrustExtensionHooks(api_url, api_key, min_score, fail_closed)

    async def aclose(self) -> None:
        """Close any owned resources (e.g., the underlying HTTP client)."""
        await self._hooks.aclose()

    @property
    def key(self) -> str:
        return "trace_trust"

    def enrich_declaration(self, declaration: Any, transport_context: Any) -> Any:
        return declaration

    def enrich_payment_required_response(self, declaration: Any, context: ServerPaymentRequiredContext) -> Any | None:
        return None

    def enrich_settlement_response(self, declaration: Any, context: SettleResultContext) -> Any | None:
        return None

    @property
    def hooks(self) -> ResourceServerExtensionHooks:
        return self._hooks

    @property
    def transport_hooks(self) -> ResourceServerTransportExtensionHooks | None:
        return None
