"""Wire-format types for the batch-settlement EVM scheme.

Python dataclasses with `to_dict()` / `from_dict()` converters. The JSON
representation uses camelCase to match the spec and the TS / Go SDKs; the
Python field names use snake_case.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from ..types import is_bytes32_hex, is_uint256_string
from .constants import (
    PAYLOAD_TYPE_CLAIM,
    PAYLOAD_TYPE_DEPOSIT,
    PAYLOAD_TYPE_REFUND,
    PAYLOAD_TYPE_SETTLE,
    PAYLOAD_TYPE_VOUCHER,
)
from .errors import (
    ERR_CLAIM_PAYLOAD,
    ERR_DEPOSIT_PAYLOAD,
    ERR_REFUND_PAYLOAD,
    ERR_SETTLE_PAYLOAD,
    ERR_VOUCHER_PAYLOAD,
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


# --- Validation -----------------------------------------------------------------------
# Payloads arrive as untrusted JSON, so verify and settle check the fields that
# `from_dict` and the handlers parse; malformed input is rejected instead of raising.

_HEX_BYTES_RE = re.compile(r"(0x)?(?:[0-9a-fA-F]{2})*")
_ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")
_UINT256_HEX_RE = re.compile(r"0x[0-9a-fA-F]{1,64}")
# Canonical bytes32 channel id: 0x followed by exactly 64 hex digits.
_CHANNEL_ID_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
_UINT40_MAX = 2**40 - 1
_UINT128_MAX = 2**128 - 1


def is_canonical_channel_id(value: object) -> bool:
    """Return True when value is a canonical `0x` + 64-hex-digit channel id."""
    return isinstance(value, str) and _CHANNEL_ID_RE.fullmatch(value) is not None


def _is_uint128_string(value: Any) -> bool:
    return is_uint256_string(value) and int(value) <= _UINT128_MAX


def _is_address(value: Any) -> bool:
    return isinstance(value, str) and _ADDRESS_RE.fullmatch(value) is not None


def _is_hex(value: Any) -> bool:
    return isinstance(value, str) and _HEX_BYTES_RE.fullmatch(value) is not None


def _validate_channel_config(config: Any, path: str) -> str | None:
    if not isinstance(config, dict):
        return f"{path} must be an object"
    for key in ("payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token"):
        if not _is_address(config.get(key)):
            return f"{path}.{key} must be a 20-byte hex address"
    withdraw_delay = config.get("withdrawDelay")
    if (
        not isinstance(withdraw_delay, int)
        or isinstance(withdraw_delay, bool)
        or not 0 <= withdraw_delay <= _UINT40_MAX
    ):
        return f"{path}.withdrawDelay must be a uint40 integer"
    if not is_bytes32_hex(config.get("salt")):
        return f"{path}.salt must be a 32-byte hex string"
    return None


def _validate_voucher_fields(voucher: Any) -> str | None:
    if not isinstance(voucher, dict):
        return "voucher must be an object"
    if not is_canonical_channel_id(voucher.get("channelId")):
        return "voucher.channelId must be 0x followed by 64 hex digits"
    if not _is_hex(voucher.get("signature")):
        return "voucher.signature must be a hex string"
    if not is_uint256_string(voucher.get("maxClaimableAmount")):
        return "voucher.maxClaimableAmount must be a uint256 decimal string"
    return None


def _validate_voucher(payload: dict[str, Any]) -> str | None:
    return _validate_channel_config(
        payload.get("channelConfig"), "channelConfig"
    ) or _validate_voucher_fields(payload.get("voucher"))


def _validate_deposit_erc3009_authorization(authorization: Any) -> str | None:
    path = "deposit.authorization.erc3009Authorization"
    if not isinstance(authorization, dict):
        return f"{path} must be an object"
    # The salt is a uint256; the deposit encoders read it as hex only when it is 0x-prefixed.
    salt = authorization.get("salt")
    if not (isinstance(salt, str) and _UINT256_HEX_RE.fullmatch(salt)):
        return f"{path}.salt must be 0x followed by 1 to 64 hex digits"
    if not isinstance(authorization.get("signature"), str):
        return f"{path}.signature must be a string"
    for key in ("validAfter", "validBefore"):
        if not is_uint256_string(authorization.get(key)):
            return f"{path}.{key} must be a uint256 decimal string"
    return None


def _validate_deposit_permit2_authorization(authorization: Any) -> str | None:
    path = "deposit.authorization.permit2Authorization"
    if not isinstance(authorization, dict):
        return f"{path} must be an object"
    permitted = authorization.get("permitted")
    if not isinstance(permitted, dict):
        return f"{path}.permitted must be an object"
    witness = authorization.get("witness")
    if not isinstance(witness, dict):
        return f"{path}.witness must be an object"
    addresses = {
        "from": authorization.get("from"),
        "spender": authorization.get("spender"),
        "permitted.token": permitted.get("token"),
    }
    for name, value in addresses.items():
        if not _is_address(value):
            return f"{path}.{name} must be a 20-byte hex address"
    strings = {
        "signature": authorization.get("signature"),
        "witness.channelId": witness.get("channelId"),
    }
    for name, value in strings.items():
        if not isinstance(value, str):
            return f"{path}.{name} must be a string"
    numbers = {
        "nonce": authorization.get("nonce"),
        "deadline": authorization.get("deadline"),
        "permitted.amount": permitted.get("amount"),
    }
    for name, value in numbers.items():
        if not is_uint256_string(value):
            return f"{path}.{name} must be a uint256 decimal string"
    return None


def _validate_deposit(payload: dict[str, Any]) -> str | None:
    error = _validate_voucher(payload)
    if error:
        return error
    deposit = payload.get("deposit")
    if not isinstance(deposit, dict):
        return "deposit must be an object"
    if not is_uint256_string(deposit.get("amount")):
        return "deposit.amount must be a uint256 decimal string"
    authorization = deposit.get("authorization")
    if not isinstance(authorization, dict):
        return "deposit.authorization must be an object"
    # Same truthiness as DepositAuthorization.from_dict, which ignores an empty authorization.
    erc3009 = authorization.get("erc3009Authorization")
    if erc3009:
        error = _validate_deposit_erc3009_authorization(erc3009)
        if error:
            return error
    permit2 = authorization.get("permit2Authorization")
    if permit2:
        return _validate_deposit_permit2_authorization(permit2)
    return None


def _validate_refund(payload: dict[str, Any]) -> str | None:
    error = _validate_voucher(payload)
    if error:
        return error
    amount = payload.get("amount")
    if amount is not None and not is_uint256_string(amount):
        return "amount must be a uint256 decimal string"
    return None


def _validate_claims(claims: Any) -> str | None:
    if not isinstance(claims, list):
        return "claims must be a list"
    for index, claim in enumerate(claims):
        path = f"claims[{index}]"
        if not isinstance(claim, dict):
            return f"{path} must be an object"
        if not _is_hex(claim.get("signature")):
            return f"{path}.signature must be a hex string"
        # The ClaimBatch authorization signs both amounts as uint128.
        if not _is_uint128_string(claim.get("totalClaimed")):
            return f"{path}.totalClaimed must be a uint128 decimal string"
        voucher = claim.get("voucher")
        if not isinstance(voucher, dict):
            return f"{path}.voucher must be an object"
        if not _is_uint128_string(voucher.get("maxClaimableAmount")):
            return f"{path}.voucher.maxClaimableAmount must be a uint128 decimal string"
        error = _validate_channel_config(voucher.get("channel"), f"{path}.voucher.channel")
        if error:
            return error
    return None


def _validate_authorizer_signatures(payload: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = payload.get(key)
        if value is not None and not _is_hex(value):
            return f"{key} must be a hex string"
    return None


def _validate_claim(payload: dict[str, Any]) -> str | None:
    return _validate_claims(payload.get("claims")) or _validate_authorizer_signatures(
        payload, ("claimAuthorizerSignature",)
    )


def _validate_enriched_refund(payload: dict[str, Any]) -> str | None:
    error = _validate_channel_config(payload.get("channelConfig"), "channelConfig")
    if error:
        return error
    # The refund handler never reads the voucher; from_dict only needs its keys.
    voucher = payload.get("voucher")
    if not isinstance(voucher, dict):
        return "voucher must be an object"
    for key in ("channelId", "maxClaimableAmount", "signature"):
        if key not in voucher:
            return f"voucher.{key} is required"
    for key in ("amount", "refundNonce"):
        if not is_uint256_string(payload.get(key)):
            return f"{key} must be a uint256 decimal string"
    return _validate_claims(payload.get("claims")) or _validate_authorizer_signatures(
        payload, ("refundAuthorizerSignature", "claimAuthorizerSignature")
    )


def _validate_settle(payload: dict[str, Any]) -> str | None:
    for key in ("receiver", "token"):
        if not _is_address(payload.get(key)):
            return f"{key} must be a 20-byte hex address"
    return None


def _with_reason(reason: str, message: str | None) -> tuple[str, str] | None:
    return (reason, message) if message else None


def validate_batch_settlement_payload(payload: dict[str, Any]) -> tuple[str, str] | None:
    """Check the fields of a client payload (deposit, voucher or refund) before verify parses it.

    Args:
        payload: Raw payload dictionary.

    Returns:
        None if well-formed or not a client payload type, otherwise the payload type's
        error reason and a message naming the first malformed field.
    """
    if is_deposit_payload(payload):
        return _with_reason(ERR_DEPOSIT_PAYLOAD, _validate_deposit(payload))
    if is_voucher_payload(payload):
        return _with_reason(ERR_VOUCHER_PAYLOAD, _validate_voucher(payload))
    if is_refund_payload(payload):
        return _with_reason(ERR_REFUND_PAYLOAD, _validate_refund(payload))
    return None


def validate_batch_settlement_settle_payload(payload: dict[str, Any]) -> tuple[str, str] | None:
    """Check the fields of a settle payload (deposit, claim, refund or settle) before parsing it.

    Args:
        payload: Raw payload dictionary.

    Returns:
        None if well-formed or not a settle payload type, otherwise the payload type's
        error reason and a message naming the first malformed field.
    """
    if is_deposit_payload(payload):
        return _with_reason(ERR_DEPOSIT_PAYLOAD, _validate_deposit(payload))
    if is_claim_payload(payload):
        return _with_reason(ERR_CLAIM_PAYLOAD, _validate_claim(payload))
    if is_enriched_refund_payload(payload):
        return _with_reason(ERR_REFUND_PAYLOAD, _validate_enriched_refund(payload))
    if is_settle_payload(payload):
        return _with_reason(ERR_SETTLE_PAYLOAD, _validate_settle(payload))
    return None


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
    min_deposit: str | None = None
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
        if self.min_deposit is not None:
            out["minDeposit"] = self.min_deposit
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
            min_deposit=str(data["minDeposit"]) if data.get("minDeposit") is not None else None,
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
