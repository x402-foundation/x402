"""Facilitator-side dispatcher for the batch-settlement EVM scheme."""

from __future__ import annotations

from dataclasses import dataclass, field

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


@dataclass
class BatchSettlementEvmFacilitatorConfig:
    """Optional configuration for :class:`BatchSettlementEvmFacilitator`.

    Attributes:
        eip6492_allowed_factories: Allowlist of factory contract addresses (hex strings,
            case-insensitive) the facilitator will call to deploy an undeployed (ERC-6492
            counterfactual) smart wallet before an ERC-3009 deposit.  An empty list
            (the default) denies all factory deployment.
    """

    eip6492_allowed_factories: list[str] = field(default_factory=list)


class BatchSettlementEvmFacilitator:
    """SchemeNetworkFacilitator implementation for batch-settlement on EVM."""

    scheme: str = SCHEME_BATCH_SETTLEMENT
    caip_family: str = "eip155:*"

    def __init__(
        self,
        signer: FacilitatorEvmSigner,
        authorizer_signer: AuthorizerSigner | None = None,
        config: BatchSettlementEvmFacilitatorConfig | None = None,
    ) -> None:
        """Create a facilitator scheme for verifying and settling batch-settlement payments.

        Args:
            signer: Facilitator EVM signer(s) used for tx submission and onchain reads.
            authorizer_signer: Optional dedicated key that provides EIP-712 signatures for
                `claimWithSignature` / `refundWithSignature`. When provided, the facilitator
                advertises its address as `receiverAuthorizer` in `/supported` and signs
                missing authorizer signatures using this key. Omit it so no `receiverAuthorizer`
                is advertised and servers supply their own signatures.
            config: Optional configuration (e.g. ERC-6492 factory allowlist).
        """
        self._signer = signer
        self._authorizer_signer = authorizer_signer
        cfg = config or BatchSettlementEvmFacilitatorConfig()
        self._eip6492_allowed_factories = list(cfg.eip6492_allowed_factories)

    def get_extra(self, network: str) -> dict | None:
        if self._authorizer_signer is None:
            return None
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
            return verify_deposit(
                self._signer,
                payload,
                deposit,
                requirements,
                context,
                self._eip6492_allowed_factories,
            )

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
            return settle_deposit(
                self._signer,
                payload,
                deposit,
                requirements,
                context,
                self._eip6492_allowed_factories,
            )

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
