"""Wire-format types for the x402 batch-settlement mechanism.

Mirrors ``typescript/packages/mechanisms/evm/src/batch-settlement/types.ts``.

Validation philosophy: this module declares Pydantic models for type-checking
and JSON serialization, but wire-level invariants (XOR deposit auth, hex
format, EIP-712 byte equivalence, integer-as-string) are enforced through
cross-language fixture tests (Layer 2 invariants) rather than Pydantic
Annotated validators or discriminated unions. This mirrors the pre-existing
``exact`` / ``upto`` mechanism conventions.

Wire spec conventions:
- ``uint256`` / large integers (``balance``, ``totalClaimed``, ``refundNonce``,
  ``maxClaimableAmount``, ``amount``, ``validAfter``/``validBefore``,
  ``deadline``) are carried as **str** on the wire to avoid JSON precision
  loss; conversion to ``int`` happens at call sites that need arithmetic.
- ``uint40`` / Unix timestamps (``withdrawDelay``, ``withdrawRequestedAt``)
  are carried as **int** on the wire (fits safely in JSON number).
- Unknown wire fields are silently dropped (``BaseX402Model`` default
  ``extra="ignore"``) — TS interop relies on schema strictness at the
  cross-language fixture layer, not on Python forbidding extras.
"""

from typing import Any, Literal

from pydantic import Field

from x402.schemas.base import BaseX402Model

# --- Inner state (not on the wire) ---


class ChannelState(BaseX402Model):
    """Internal channel state. Not serialized to the wire."""

    balance: int
    total_claimed: int
    withdraw_requested_at: int
    refund_nonce: int


# --- Wire structs ---


class ChannelConfig(BaseX402Model):
    """EIP-712 ChannelConfig struct mirror."""

    payer: str
    payer_authorizer: str
    receiver: str
    receiver_authorizer: str
    token: str
    withdraw_delay: int
    salt: str


class BatchSettlementErc3009Authorization(BaseX402Model):
    valid_after: str
    valid_before: str
    salt: str
    signature: str


class BatchSettlementPermit2Permitted(BaseX402Model):
    token: str
    amount: str


class BatchSettlementPermit2Witness(BaseX402Model):
    channel_id: str


class BatchSettlementPermit2Authorization(BaseX402Model):
    from_: str = Field(alias="from")
    permitted: BatchSettlementPermit2Permitted
    spender: str
    nonce: str
    deadline: str
    witness: BatchSettlementPermit2Witness
    signature: str


class BatchSettlementVoucherFields(BaseX402Model):
    channel_id: str
    max_claimable_amount: str
    signature: str


class BatchSettlementDepositAuthorization(BaseX402Model):
    """One of erc3009 / permit2 (XOR enforced via parse_payload)."""

    erc3009_authorization: BatchSettlementErc3009Authorization | None = None
    permit2_authorization: BatchSettlementPermit2Authorization | None = None


BatchSettlementAssetTransferMethod = Literal["eip3009", "permit2"]


# --- Voucher claim (used in claim/refund) ---


class _VoucherClaimVoucher(BaseX402Model):
    channel: ChannelConfig
    max_claimable_amount: str


class BatchSettlementVoucherClaim(BaseX402Model):
    voucher: _VoucherClaimVoucher
    signature: str
    total_claimed: str


# --- Extras (wire metadata) ---


class BatchSettlementChannelStateExtra(BaseX402Model):
    channel_id: str
    balance: str
    total_claimed: str
    withdraw_requested_at: int
    refund_nonce: str
    charged_cumulative_amount: str | None = None


class BatchSettlementVoucherStateExtra(BaseX402Model):
    signed_max_claimable: str | None = None
    signature: str | None = None


class BatchSettlementPaymentRequirementsExtra(BaseX402Model):
    receiver_authorizer: str
    withdraw_delay: int
    name: str
    version: str
    asset_transfer_method: BatchSettlementAssetTransferMethod | None = None
    channel_state: BatchSettlementChannelStateExtra | None = None
    voucher_state: BatchSettlementVoucherStateExtra | None = None


class BatchSettlementPaymentResponseExtra(BaseX402Model):
    charged_amount: str | None = None
    channel_state: BatchSettlementChannelStateExtra | None = None
    voucher_state: BatchSettlementVoucherStateExtra | None = None


# --- Client-side payloads (3 types) ---


class _DepositInner(BaseX402Model):
    amount: str
    authorization: BatchSettlementDepositAuthorization


class BatchSettlementDepositPayload(BaseX402Model):
    type: Literal["deposit"] = "deposit"
    channel_config: ChannelConfig
    voucher: BatchSettlementVoucherFields
    deposit: _DepositInner


class BatchSettlementVoucherPayload(BaseX402Model):
    type: Literal["voucher"] = "voucher"
    channel_config: ChannelConfig
    voucher: BatchSettlementVoucherFields


class BatchSettlementRefundPayload(BaseX402Model):
    type: Literal["refund"] = "refund"
    channel_config: ChannelConfig
    voucher: BatchSettlementVoucherFields
    amount: str | None = None


# --- Facilitator-side payloads ---


class BatchSettlementClaimPayload(BaseX402Model):
    type: Literal["claim"] = "claim"
    claims: list[BatchSettlementVoucherClaim]
    claim_authorizer_signature: str | None = None


class BatchSettlementSettlePayload(BaseX402Model):
    type: Literal["settle"] = "settle"
    receiver: str
    token: str


class BatchSettlementEnrichedRefundPayload(BaseX402Model):
    """Refund payload with mandatory enriched fields for facilitator-side settlement.

    Shares ``type`` literal with :class:`BatchSettlementRefundPayload`; runtime
    narrowing happens in :func:`parse_facilitator_payload` by the presence of
    the mandatory enriched fields.
    """

    type: Literal["refund"] = "refund"
    channel_config: ChannelConfig
    voucher: BatchSettlementVoucherFields
    amount: str
    refund_nonce: str
    claims: list[BatchSettlementVoucherClaim]
    refund_authorizer_signature: str | None = None
    claim_authorizer_signature: str | None = None


# --- Union type aliases (no Annotated discriminator) ---

BatchSettlementPayload = (
    BatchSettlementDepositPayload | BatchSettlementVoucherPayload | BatchSettlementRefundPayload
)

BatchSettlementFacilitatorSettlePayload = (
    BatchSettlementDepositPayload
    | BatchSettlementClaimPayload
    | BatchSettlementSettlePayload
    | BatchSettlementEnrichedRefundPayload
)


# --- Manual parsing helpers ---


def _validate_deposit_xor(auth: BatchSettlementDepositAuthorization) -> None:
    has_erc = auth.erc3009_authorization is not None
    has_p2 = auth.permit2_authorization is not None
    if has_erc == has_p2:
        raise ValueError(
            "BatchSettlementDepositAuthorization: exactly one of "
            "erc3009Authorization or permit2Authorization must be set"
        )


def parse_payload(data: dict[str, Any]) -> BatchSettlementPayload:
    """Discriminate a client-side payload on ``type`` and validate XOR auth."""
    type_value = data.get("type")
    if type_value == "deposit":
        payload = BatchSettlementDepositPayload.model_validate(data)
        _validate_deposit_xor(payload.deposit.authorization)
        return payload
    if type_value == "voucher":
        return BatchSettlementVoucherPayload.model_validate(data)
    if type_value == "refund":
        return BatchSettlementRefundPayload.model_validate(data)
    raise ValueError(f"unknown BatchSettlementPayload type: {type_value!r}")


def parse_facilitator_payload(
    data: dict[str, Any],
) -> BatchSettlementFacilitatorSettlePayload:
    """Discriminate a facilitator-side payload, including enriched refund.

    A ``"refund"`` payload here must carry the enriched mandatory fields
    (``amount`` / ``refundNonce`` / ``claims``); plain client-side refund
    is not a valid facilitator payload.
    """
    type_value = data.get("type")
    if type_value == "deposit":
        payload = BatchSettlementDepositPayload.model_validate(data)
        _validate_deposit_xor(payload.deposit.authorization)
        return payload
    if type_value == "claim":
        return BatchSettlementClaimPayload.model_validate(data)
    if type_value == "settle":
        return BatchSettlementSettlePayload.model_validate(data)
    if type_value == "refund":
        # Treat ``null`` and absent the same here so the caller sees a single
        # ``ValueError`` for "not an enriched refund" instead of mixing in a
        # Pydantic ``ValidationError`` for ``amount: str`` rejecting ``None``.
        if all(data.get(k) is not None for k in ("amount", "refundNonce", "claims")):
            return BatchSettlementEnrichedRefundPayload.model_validate(data)
        raise ValueError(
            "facilitator refund payload missing mandatory fields (amount/refundNonce/claims)"
        )
    raise ValueError(f"unknown BatchSettlementFacilitatorSettlePayload type: {type_value!r}")


__all__ = [
    # Inner state
    "ChannelState",
    # Wire structs
    "ChannelConfig",
    "BatchSettlementErc3009Authorization",
    "BatchSettlementPermit2Permitted",
    "BatchSettlementPermit2Witness",
    "BatchSettlementPermit2Authorization",
    "BatchSettlementVoucherFields",
    "BatchSettlementDepositAuthorization",
    "BatchSettlementAssetTransferMethod",
    # Voucher claim
    "BatchSettlementVoucherClaim",
    # Extras
    "BatchSettlementChannelStateExtra",
    "BatchSettlementVoucherStateExtra",
    "BatchSettlementPaymentRequirementsExtra",
    "BatchSettlementPaymentResponseExtra",
    # Payloads (client)
    "BatchSettlementDepositPayload",
    "BatchSettlementVoucherPayload",
    "BatchSettlementRefundPayload",
    # Payloads (facilitator)
    "BatchSettlementClaimPayload",
    "BatchSettlementSettlePayload",
    "BatchSettlementEnrichedRefundPayload",
    # Union aliases
    "BatchSettlementPayload",
    "BatchSettlementFacilitatorSettlePayload",
    # Parsers
    "parse_payload",
    "parse_facilitator_payload",
]
