"""BIP-122 facilitator implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

from typing import Any

from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..constants import (
    ERR_AMOUNT_MISMATCH,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_INVALID_ASSET,
    ERR_INVALID_INVOICE,
    ERR_INVALID_PAY_TO,
    ERR_INVALID_PAYMENT_METHOD,
    ERR_INVOICE_EXPIRED,
    ERR_INVOICE_IN_FLIGHT,
    ERR_INVOICE_MISMATCH,
    ERR_INVOICE_NOT_PAID,
    ERR_MISSING_INVOICE,
    ERR_NETWORK_MISMATCH,
    ERR_UNKNOWN_INVOICE,
    ERR_UNSUPPORTED_SCHEME,
    PAY_TO_ANONYMOUS,
    PAYMENT_METHOD_LIGHTNING,
    SCHEME_EXACT,
    SETTLEMENT_TTL_BUFFER_SECONDS,
)
from ..receiver import LightningReceiver
from ..settlement_cache import SettlementCache
from ..types import ExactBip122Payload
from ..utils import decode_invoice, normalize_network


class ExactBip122Scheme:
    """BIP-122 facilitator implementation for the Exact payment scheme (V2)."""

    scheme = SCHEME_EXACT
    caip_family = "bip122:*"

    def __init__(
        self,
        receiver: LightningReceiver,
        settlement_cache: SettlementCache | None = None,
    ):
        self._receiver = receiver
        self._settlement_cache = settlement_cache or SettlementCache()

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        _ = normalize_network(str(network))
        return {"paymentMethod": PAYMENT_METHOD_LIGHTNING}

    def get_signers(self, network: Network) -> list[str]:
        _ = normalize_network(str(network))
        return []

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> VerifyResponse:
        """Verify that the referenced invoice was issued here and has been paid."""
        _ = context
        if payload.accepted.scheme != SCHEME_EXACT or requirements.scheme != SCHEME_EXACT:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer="")

        if str(payload.accepted.network) != str(requirements.network):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer="")

        try:
            network = normalize_network(str(requirements.network))
        except ValueError:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer="")

        if requirements.asset != "BTC" or payload.accepted.asset != "BTC":
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_ASSET, payer="")

        if requirements.pay_to != PAY_TO_ANONYMOUS or payload.accepted.pay_to != PAY_TO_ANONYMOUS:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_PAY_TO, payer="")

        requirement_extra = requirements.extra or {}
        accepted_extra = payload.accepted.extra or {}
        if requirement_extra.get("paymentMethod") != PAYMENT_METHOD_LIGHTNING:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_INVALID_PAYMENT_METHOD,
                payer="",
            )
        if accepted_extra.get("paymentMethod") != PAYMENT_METHOD_LIGHTNING:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_INVALID_PAYMENT_METHOD,
                payer="",
            )

        payload_invoice = ExactBip122Payload.from_dict(payload.payload).invoice
        requirement_invoice = requirement_extra.get("invoice")
        accepted_invoice = accepted_extra.get("invoice")
        if not payload_invoice or not isinstance(payload_invoice, str):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_MISSING_INVOICE, payer="")
        if not requirement_invoice or not accepted_invoice:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_MISSING_INVOICE, payer="")
        if payload_invoice != requirement_invoice or payload_invoice != accepted_invoice:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVOICE_MISMATCH, payer="")

        try:
            decoded = decode_invoice(payload_invoice)
        except ValueError:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_INVOICE, payer="")

        invoice_amount_msat = int(decoded.amount_msat or 0)
        if invoice_amount_msat != int(requirements.amount):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_AMOUNT_MISMATCH, payer="")
        if decoded.has_expired():
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVOICE_EXPIRED, payer="")

        if self._settlement_cache.is_used(decoded.payment_hash):
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_DUPLICATE_SETTLEMENT,
                payer=PAY_TO_ANONYMOUS,
            )

        status = self._receiver.lookup_invoice(payload_invoice, network)
        if status is None:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_UNKNOWN_INVOICE, payer="")
        if status.payment_hash != decoded.payment_hash or status.invoice != payload_invoice:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVOICE_MISMATCH, payer="")
        if status.amount_msat != invoice_amount_msat:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_AMOUNT_MISMATCH, payer="")
        if status.status == "in_flight":
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_INVOICE_IN_FLIGHT,
                invalid_message="Payment is still in flight; retry later.",
                payer=status.payer or PAY_TO_ANONYMOUS,
            )
        if status.status != "paid":
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_INVOICE_NOT_PAID,
                payer=status.payer or PAY_TO_ANONYMOUS,
            )

        return VerifyResponse(is_valid=True, payer=status.payer or PAY_TO_ANONYMOUS)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> SettleResponse:
        """Return the invoice payment hash as the settlement identifier."""
        verify_result = self.verify(payload, requirements, context)
        network = str(requirements.network)
        if not verify_result.is_valid:
            return SettleResponse(
                success=False,
                error_reason=verify_result.invalid_reason,
                error_message=verify_result.invalid_message,
                payer=verify_result.payer,
                transaction="",
                network=network,
            )

        try:
            decoded = decode_invoice(ExactBip122Payload.from_dict(payload.payload).invoice)
        except ValueError:
            return SettleResponse(
                success=False,
                error_reason=ERR_INVALID_INVOICE,
                payer=verify_result.payer,
                transaction="",
                network=network,
            )

        ttl_seconds = float(decoded.expiry + SETTLEMENT_TTL_BUFFER_SECONDS)
        if not self._settlement_cache.mark_used(decoded.payment_hash, ttl_seconds=ttl_seconds):
            return SettleResponse(
                success=False,
                error_reason=ERR_DUPLICATE_SETTLEMENT,
                payer=verify_result.payer,
                transaction="",
                network=network,
            )

        return SettleResponse(
            success=True,
            payer=verify_result.payer,
            transaction=decoded.payment_hash,
            network=network,
        )
