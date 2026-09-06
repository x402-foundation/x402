"""Wire-format types for the batch-settlement EVM scheme.

Python dataclasses with `to_dict()` / `from_dict()` converters. The JSON
representation uses camelCase to match the spec and the TS / Go SDKs; the
Python field names use snake_case.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from .constants import (
    PAYLOAD_TYPE_CLAIM,
    PAYLOAD_TYPE_DEPOSIT,
    PAYLOAD_TYPE_REFUND,
    PAYLOAD_TYPE_SETTLE,
    PAYLOAD_TYPE_VOUCHER,
)


@dataclass
class ChannelConfig:
    """Immutable channel identity tuple.

    `channelId = EIP712Hash(ChannelConfig)` against the batch-settlement domain
    (bound to chainId + verifyingContract = BATCH_SETTLEMENT_ADDRESS).
    """

    payer: str
    payer_authorizer: str
    receiver: str
    receiver_authorizer: str
    token: str
    withdraw_delay: int
    salt: str  # 0x-prefixed bytes32

    def to_dict(self) -> dict[str, Any]:
        return {
            "payer": self.payer,
            "payerAuthorizer": self.payer_authorizer,
            "receiver": self.receiver,
            "receiverAuthorizer": self.receiver_authorizer,
            "token": self.token,
            "withdrawDelay": self.withdraw_delay,
            "salt": self.salt,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ChannelConfig:
        return cls(
            payer=data["payer"],
            payer_authorizer=data["payerAuthorizer"],
            receiver=data["receiver"],
            receiver_authorizer=data["receiverAuthorizer"],
            token=data["token"],
            withdraw_delay=int(data["withdrawDelay"]),
            salt=data["salt"],
        )


@dataclass
class ChannelState:
    """Onchain channel snapshot read via `channels(channelId)` + auxiliary calls."""

    balance: int
    total_claimed: int
    withdraw_requested_at: int = 0
    refund_nonce: int = 0


@dataclass
class VoucherFields:
    """Per-request cumulative voucher as carried in the wire payload."""

    channel_id: str
    max_claimable_amount: str
    signature: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "channelId": self.channel_id,
            "maxClaimableAmount": self.max_claimable_amount,
            "signature": self.signature,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VoucherFields:
        return cls(
            channel_id=data["channelId"],
            max_claimable_amount=str(data["maxClaimableAmount"]),
            signature=data["signature"],
        )


@dataclass
class Erc3009Authorization:
    """ERC-3009 ReceiveWithAuthorization fields for a channel deposit.

    The `to` field is implicitly the ERC3009DepositCollector; the `value` is the
    deposit amount; the `from` is the payer. Only validAfter/validBefore/salt/sig
    are carried on the wire — the rest is reconstructed from the channel config.
    """

    valid_after: str
    valid_before: str
    salt: str
    signature: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "validAfter": self.valid_after,
            "validBefore": self.valid_before,
            "salt": self.salt,
            "signature": self.signature,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Erc3009Authorization:
        return cls(
            valid_after=str(data["validAfter"]),
            valid_before=str(data["validBefore"]),
            salt=data["salt"],
            signature=data["signature"],
        )


@dataclass
class Permit2TokenPermissions:
    token: str
    amount: str

    def to_dict(self) -> dict[str, Any]:
        return {"token": self.token, "amount": self.amount}


@dataclass
class Permit2DepositWitness:
    channel_id: str

    def to_dict(self) -> dict[str, Any]:
        return {"channelId": self.channel_id}


@dataclass
class Permit2Authorization:
    """Permit2 PermitWitnessTransferFrom for a channel-bound deposit."""

    from_address: str
    permitted: Permit2TokenPermissions
    spender: str
    nonce: str
    deadline: str
    witness: Permit2DepositWitness
    signature: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_address,
            "permitted": self.permitted.to_dict(),
            "spender": self.spender,
            "nonce": self.nonce,
            "deadline": self.deadline,
            "witness": self.witness.to_dict(),
            "signature": self.signature,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Permit2Authorization:
        permitted = data["permitted"]
        witness = data["witness"]
        return cls(
            from_address=data["from"],
            permitted=Permit2TokenPermissions(
                token=permitted["token"], amount=str(permitted["amount"])
            ),
            spender=data["spender"],
            nonce=str(data["nonce"]),
            deadline=str(data["deadline"]),
            witness=Permit2DepositWitness(channel_id=witness["channelId"]),
            signature=data["signature"],
        )


@dataclass
class DepositAuthorization:
    """Exactly one of `erc3009_authorization` or `permit2_authorization` is set."""

    erc3009_authorization: Erc3009Authorization | None = None
    permit2_authorization: Permit2Authorization | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.erc3009_authorization is not None:
            out["erc3009Authorization"] = self.erc3009_authorization.to_dict()
        if self.permit2_authorization is not None:
            out["permit2Authorization"] = self.permit2_authorization.to_dict()
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DepositAuthorization:
        erc3009 = data.get("erc3009Authorization")
        permit2 = data.get("permit2Authorization")
        return cls(
            erc3009_authorization=Erc3009Authorization.from_dict(erc3009) if erc3009 else None,
            permit2_authorization=Permit2Authorization.from_dict(permit2) if permit2 else None,
        )


@dataclass
class DepositFields:
    amount: str
    authorization: DepositAuthorization

    def to_dict(self) -> dict[str, Any]:
        return {"amount": self.amount, "authorization": self.authorization.to_dict()}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DepositFields:
        return cls(
            amount=str(data["amount"]),
            authorization=DepositAuthorization.from_dict(data["authorization"]),
        )


@dataclass
class DepositPayload:
    """Type=deposit: opens/tops up a channel with a cumulative voucher."""

    type: Literal["deposit"] = field(default=PAYLOAD_TYPE_DEPOSIT, init=False)
    channel_config: ChannelConfig | None = None
    voucher: VoucherFields | None = None
    deposit: DepositFields | None = None

    def to_dict(self) -> dict[str, Any]:
        assert self.channel_config and self.voucher and self.deposit
        return {
            "type": self.type,
            "channelConfig": self.channel_config.to_dict(),
            "voucher": self.voucher.to_dict(),
            "deposit": self.deposit.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DepositPayload:
        p = cls()
        p.channel_config = ChannelConfig.from_dict(data["channelConfig"])
        p.voucher = VoucherFields.from_dict(data["voucher"])
        p.deposit = DepositFields.from_dict(data["deposit"])
        return p


@dataclass
class VoucherPayload:
    """Type=voucher: subsequent request, updates cumulative ceiling only."""

    type: Literal["voucher"] = field(default=PAYLOAD_TYPE_VOUCHER, init=False)
    channel_config: ChannelConfig | None = None
    voucher: VoucherFields | None = None

    def to_dict(self) -> dict[str, Any]:
        assert self.channel_config and self.voucher
        return {
            "type": self.type,
            "channelConfig": self.channel_config.to_dict(),
            "voucher": self.voucher.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VoucherPayload:
        p = cls()
        p.channel_config = ChannelConfig.from_dict(data["channelConfig"])
        p.voucher = VoucherFields.from_dict(data["voucher"])
        return p


@dataclass
class RefundPayload:
    """Type=refund: cooperative refund initiation with zero-charge voucher."""

    type: Literal["refund"] = field(default=PAYLOAD_TYPE_REFUND, init=False)
    channel_config: ChannelConfig | None = None
    voucher: VoucherFields | None = None
    amount: str | None = None  # optional partial refund

    def to_dict(self) -> dict[str, Any]:
        assert self.channel_config and self.voucher
        out: dict[str, Any] = {
            "type": self.type,
            "channelConfig": self.channel_config.to_dict(),
            "voucher": self.voucher.to_dict(),
        }
        if self.amount is not None:
            out["amount"] = self.amount
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RefundPayload:
        p = cls()
        p.channel_config = ChannelConfig.from_dict(data["channelConfig"])
        p.voucher = VoucherFields.from_dict(data["voucher"])
        amt = data.get("amount")
        p.amount = str(amt) if amt is not None else None
        return p


@dataclass
class VoucherClaim:
    """Server-side claim entry: voucher + signature + claimed total."""

    channel: ChannelConfig
    max_claimable_amount: str
    signature: str
    total_claimed: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "voucher": {
                "channel": self.channel.to_dict(),
                "maxClaimableAmount": self.max_claimable_amount,
            },
            "signature": self.signature,
            "totalClaimed": self.total_claimed,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VoucherClaim:
        voucher = data["voucher"]
        return cls(
            channel=ChannelConfig.from_dict(voucher["channel"]),
            max_claimable_amount=str(voucher["maxClaimableAmount"]),
            signature=data["signature"],
            total_claimed=str(data["totalClaimed"]),
        )


@dataclass
class ClaimPayload:
    """Server -> facilitator settle-action: batch of voucher claims."""

    type: Literal["claim"] = field(default=PAYLOAD_TYPE_CLAIM, init=False)
    claims: list[VoucherClaim] = field(default_factory=list)
    claim_authorizer_signature: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "type": self.type,
            "claims": [c.to_dict() for c in self.claims],
        }
        if self.claim_authorizer_signature:
            out["claimAuthorizerSignature"] = self.claim_authorizer_signature
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ClaimPayload:
        p = cls()
        p.claims = [VoucherClaim.from_dict(c) for c in data.get("claims", [])]
        p.claim_authorizer_signature = data.get("claimAuthorizerSignature")
        return p


@dataclass
class SettlePayload:
    """Server -> facilitator settle-action: sweep claimed funds to receiver."""

    type: Literal["settle"] = field(default=PAYLOAD_TYPE_SETTLE, init=False)
    receiver: str = ""
    token: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "receiver": self.receiver, "token": self.token}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SettlePayload:
        return cls(receiver=data["receiver"], token=data["token"])


@dataclass
class EnrichedRefundPayload:
    """Server -> facilitator settle-action: refundWithSignature + optional claims.

    Built by the server from the client's `RefundPayload` after the server
    resolves the omitted amount, looks up the onchain `refundNonce`, and
    optionally batches outstanding claims so they settle atomically with the
    refund via `multicall`.
    """

    type: Literal["refund"] = field(default=PAYLOAD_TYPE_REFUND, init=False)
    channel_config: ChannelConfig | None = None
    voucher: VoucherFields | None = None
    amount: str = "0"
    refund_nonce: str = "0"
    claims: list[VoucherClaim] = field(default_factory=list)
    refund_authorizer_signature: str | None = None
    claim_authorizer_signature: str | None = None

    def to_dict(self) -> dict[str, Any]:
        assert self.channel_config and self.voucher
        out: dict[str, Any] = {
            "type": self.type,
            "channelConfig": self.channel_config.to_dict(),
            "voucher": self.voucher.to_dict(),
            "amount": self.amount,
            "refundNonce": self.refund_nonce,
            "claims": [c.to_dict() for c in self.claims],
        }
        if self.refund_authorizer_signature:
            out["refundAuthorizerSignature"] = self.refund_authorizer_signature
        if self.claim_authorizer_signature:
            out["claimAuthorizerSignature"] = self.claim_authorizer_signature
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EnrichedRefundPayload:
        p = cls()
        p.channel_config = ChannelConfig.from_dict(data["channelConfig"])
        p.voucher = VoucherFields.from_dict(data["voucher"])
        p.amount = str(data["amount"])
        p.refund_nonce = str(data["refundNonce"])
        p.claims = [VoucherClaim.from_dict(c) for c in data.get("claims", [])]
        p.refund_authorizer_signature = data.get("refundAuthorizerSignature")
        p.claim_authorizer_signature = data.get("claimAuthorizerSignature")
        return p


# --- Discriminators -------------------------------------------------------------------


def is_deposit_payload(payload: dict[str, Any]) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("type") == PAYLOAD_TYPE_DEPOSIT
        and "channelConfig" in payload
        and "voucher" in payload
        and "deposit" in payload
    )


def is_voucher_payload(payload: dict[str, Any]) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("type") == PAYLOAD_TYPE_VOUCHER
        and "channelConfig" in payload
        and "voucher" in payload
    )


def is_refund_payload(payload: dict[str, Any]) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("type") == PAYLOAD_TYPE_REFUND
        and "channelConfig" in payload
        and "voucher" in payload
    )


def is_claim_payload(payload: dict[str, Any]) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("type") == PAYLOAD_TYPE_CLAIM
        and "claims" in payload
    )


def is_settle_payload(payload: dict[str, Any]) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("type") == PAYLOAD_TYPE_SETTLE
        and "receiver" in payload
        and "token" in payload
    )


def is_enriched_refund_payload(payload: dict[str, Any]) -> bool:
    return is_refund_payload(payload) and "refundNonce" in payload and "claims" in payload


# --- Per-extension snapshots (PaymentRequirements.extra / settle response extra) ------


@dataclass
class ChannelStateExtra:
    """The onchain snapshot embedded in verify/settle response `extra`."""

    channel_id: str
    balance: str
    total_claimed: str
    withdraw_requested_at: int = 0
    refund_nonce: str = "0"
    charged_cumulative_amount: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "channelId": self.channel_id,
            "balance": self.balance,
            "totalClaimed": self.total_claimed,
            "withdrawRequestedAt": self.withdraw_requested_at,
            "refundNonce": self.refund_nonce,
        }
        if self.charged_cumulative_amount is not None:
            out["chargedCumulativeAmount"] = self.charged_cumulative_amount
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ChannelStateExtra:
        cca = data.get("chargedCumulativeAmount")
        return cls(
            channel_id=data["channelId"],
            balance=str(data["balance"]),
            total_claimed=str(data["totalClaimed"]),
            withdraw_requested_at=int(data.get("withdrawRequestedAt", 0)),
            refund_nonce=str(data.get("refundNonce", "0")),
            charged_cumulative_amount=str(cca) if cca is not None else None,
        )


@dataclass
class VoucherStateExtra:
    signed_max_claimable: str | None = None
    signature: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.signed_max_claimable is not None:
            out["signedMaxClaimable"] = self.signed_max_claimable
        if self.signature is not None:
            out["signature"] = self.signature
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VoucherStateExtra:
        return cls(
            signed_max_claimable=(
                str(data["signedMaxClaimable"]) if "signedMaxClaimable" in data else None
            ),
            signature=data.get("signature"),
        )


@dataclass
class PaymentRequirementsExtra:
    """Shape of `PaymentRequirements.extra` for batch-settlement."""

    receiver_authorizer: str
    withdraw_delay: int
    name: str
    version: str
    asset_transfer_method: str | None = None  # "eip3009" (default) or "permit2"
    channel_state: ChannelStateExtra | None = None
    voucher_state: VoucherStateExtra | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "receiverAuthorizer": self.receiver_authorizer,
            "withdrawDelay": self.withdraw_delay,
            "name": self.name,
            "version": self.version,
        }
        if self.asset_transfer_method is not None:
            out["assetTransferMethod"] = self.asset_transfer_method
        if self.channel_state is not None:
            out["channelState"] = self.channel_state.to_dict()
        if self.voucher_state is not None:
            out["voucherState"] = self.voucher_state.to_dict()
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PaymentRequirementsExtra:
        cs = data.get("channelState")
        vs = data.get("voucherState")
        return cls(
            receiver_authorizer=data["receiverAuthorizer"],
            withdraw_delay=int(data["withdrawDelay"]),
            name=data["name"],
            version=data["version"],
            asset_transfer_method=data.get("assetTransferMethod"),
            channel_state=ChannelStateExtra.from_dict(cs) if cs else None,
            voucher_state=VoucherStateExtra.from_dict(vs) if vs else None,
        )


@dataclass
class PaymentResponseExtra:
    """Shape of `SettleResponse.extra` for batch-settlement."""

    charged_amount: str | None = None
    channel_state: ChannelStateExtra | None = None
    voucher_state: VoucherStateExtra | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.charged_amount is not None:
            out["chargedAmount"] = self.charged_amount
        if self.channel_state is not None:
            out["channelState"] = self.channel_state.to_dict()
        if self.voucher_state is not None:
            out["voucherState"] = self.voucher_state.to_dict()
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PaymentResponseExtra:
        cs = data.get("channelState")
        vs = data.get("voucherState")
        return cls(
            charged_amount=str(data["chargedAmount"]) if "chargedAmount" in data else None,
            channel_state=ChannelStateExtra.from_dict(cs) if cs else None,
            voucher_state=VoucherStateExtra.from_dict(vs) if vs else None,
        )


# --- AuthorizerSigner protocol --------------------------------------------------------


@runtime_checkable
class AuthorizerSigner(Protocol):
    """EIP-712 signer for ClaimBatch / Refund typed-data digests.

    Wraps the receiver-authorizer key. The facilitator uses this protocol to
    auto-sign claim and refund authorizations when the server delegates that
    key to the facilitator; otherwise the server's own signer fills these in.
    """

    @property
    def address(self) -> str: ...

    def sign_typed_data(
        self,
        domain: dict[str, Any],
        types: dict[str, list[dict[str, str]]],
        primary_type: str,
        message: dict[str, Any],
    ) -> str:
        """Return a 0x-prefixed hex signature."""
        ...
