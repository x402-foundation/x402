"""Facilitator-side dispatcher for the batch-settlement EVM scheme."""

from __future__ import annotations

from .....interfaces import FacilitatorContext
from .....schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ...signer import FacilitatorEvmSigner
from ..constants import SCHEME_BATCH_SETTLEMENT
from ..errors import (
    ERR_INVALID_PAYLOAD_TYPE,
    ERR_INVALID_SCHEME,
    ERR_NETWORK_MISMATCH,
)
from ..types import (
    AuthorizerSigner,
    ChannelConfig,
    ClaimPayload,
    DepositPayload,
    EnrichedRefundPayload,
    SettlePayload,
    is_claim_payload,
    is_deposit_payload,
    is_enriched_refund_payload,
    is_refund_payload,
    is_settle_payload,
    is_voucher_payload,
)


class BatchSettlementEvmFacilitator:
    """SchemeNetworkFacilitator implementation for batch-settlement on EVM."""

    scheme: str = SCHEME_BATCH_SETTLEMENT
    caip_family: str = "eip155:*"

    def __init__(
        self,
        signer: FacilitatorEvmSigner,
        authorizer_signer: AuthorizerSigner,
    ) -> None:
        self._signer = signer
        self._authorizer_signer = authorizer_signer

    def get_extra(self, network: str) -> dict | None:
        return {"receiverAuthorizer": self._authorizer_signer.address}

    def get_signers(self, network: str) -> list[str]:
        return list(self._signer.get_addresses())

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> VerifyResponse:
        raw = payload.payload

        if (
            payload.accepted.scheme != SCHEME_BATCH_SETTLEMENT
            or requirements.scheme != SCHEME_BATCH_SETTLEMENT
        ):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_SCHEME)

        if payload.accepted.network != requirements.network:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH)

        if is_deposit_payload(raw):
            from .deposit import verify_deposit

            deposit = DepositPayload.from_dict(raw)
            return verify_deposit(self._signer, payload, deposit, requirements, context)

        if is_voucher_payload(raw):
            from .voucher import verify_voucher

            channel_config = ChannelConfig.from_dict(raw["channelConfig"])
            return verify_voucher(self._signer, raw, requirements, channel_config)

        if is_refund_payload(raw):
            from .voucher import verify_voucher

            channel_config = ChannelConfig.from_dict(raw["channelConfig"])
            return verify_voucher(self._signer, raw, requirements, channel_config)

        return VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_PAYLOAD_TYPE)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> SettleResponse:
        raw = payload.payload
        network = str(requirements.network)

        if is_deposit_payload(raw):
            from .deposit import settle_deposit

            deposit = DepositPayload.from_dict(raw)
            return settle_deposit(self._signer, payload, deposit, requirements, context)

        if is_claim_payload(raw):
            from .claim import execute_claim_with_signature

            claim = ClaimPayload.from_dict(raw)
            return execute_claim_with_signature(
                self._signer, claim, requirements, self._authorizer_signer
            )

        if is_enriched_refund_payload(raw):
            from .refund import execute_refund_with_signature

            refund = EnrichedRefundPayload.from_dict(raw)
            return execute_refund_with_signature(
                self._signer, refund, requirements, self._authorizer_signer
            )

        if is_settle_payload(raw):
            from .settle import execute_settle

            settle = SettlePayload.from_dict(raw)
            return execute_settle(self._signer, settle, requirements)

        return SettleResponse(
            success=False,
            error_reason=ERR_INVALID_PAYLOAD_TYPE,
            transaction="",
            network=network,
        )


__all__ = ["BatchSettlementEvmFacilitator"]
