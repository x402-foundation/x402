"""Validate paid Lightning proofs without access to a receiver node."""

import time
from collections.abc import Callable
from typing import Any

from ....interfaces import FacilitatorContext
from ....schemas import Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse
from ..constants import (
    DEFAULT_CLOCK_SKEW,
    NETWORKS,
    REPLAY_RETENTION_SECONDS,
    LightningValidationError,
    invalid,
)
from ..replay_store import ReplayStore
from ..validation import match_requirements, validate_invoice, validate_preimage, validate_skew


class ExactLnbtcScheme:
    scheme = "exact"
    caip_family = "lnbtc:*"

    def __init__(
        self,
        replay_store: ReplayStore,
        *,
        clock: Callable[[], float] = time.time,
        clock_skew: int = DEFAULT_CLOCK_SKEW,
    ) -> None:
        validate_skew(clock_skew)
        self._store = replay_store
        self._clock = clock
        self._skew = clock_skew

    def get_extra(self, network: Network) -> dict[str, Any]:
        if network not in NETWORKS:
            raise LightningValidationError("unsupported_network")
        return {"assetTransferMethod": "bolt11", "paymentFlow": "upfront"}

    def get_signers(self, network: Network) -> list[str]:
        self.get_extra(network)
        return []

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> VerifyResponse:
        return VerifyResponse(is_valid=False, invalid_reason="invalid_exact_lnbtc_payment_flow")

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> SettleResponse:
        try:
            match_requirements(payload.accepted, requirements)
            now = self._clock()
            invoice = validate_invoice(
                payload.accepted.extra["invoice"],
                requirements,
                now=now,
                clock_skew=self._skew,
                check_expiry=False,
            )
            validate_preimage(payload.payload, invoice.payment_hash)
            expiry = invoice.date + invoice.expiry + self._skew
            if now > expiry:
                raise invalid("invoice_expired")
        except LightningValidationError as exc:
            return SettleResponse(
                success=False, error_reason=str(exc), transaction="", network=requirements.network
            )
        try:
            consumed = self._store.consume(
                f"{requirements.network}:{invoice.payment_hash}", expiry + REPLAY_RETENTION_SECONDS
            )
        except Exception:
            return SettleResponse(
                success=False,
                error_reason="settlement_failed",
                transaction="",
                network=requirements.network,
            )
        if not consumed:
            return SettleResponse(
                success=False,
                error_reason="duplicate_settlement",
                transaction="",
                network=requirements.network,
            )
        return SettleResponse(
            success=True, transaction=invoice.payment_hash, network=requirements.network
        )
