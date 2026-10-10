"""Shared wire and signature validation before consulting channel state."""

from __future__ import annotations

from typing import Any

from solders.pubkey import Pubkey

from ....schemas import PaymentRequirements
from ..constants import TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS
from ..payment_channels import find_payment_channel_pda, verify_voucher
from .authorization import verify_batch_authorization
from .constants import BATCH_SETTLEMENT_SCHEME, MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY
from .errors import BatchError


def atomic(value: Any, name: str = "amount") -> int:
    if not isinstance(value, str) or not value or not value.isascii() or not value.isdecimal():
        raise ValueError(f"{name} must be a decimal u64 string")
    result = int(value)
    if result > 2**64 - 1:
        raise ValueError(f"{name} exceeds u64")
    return result


def integer(value: Any, name: str, maximum: int = 2**53 - 1) -> int:
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError(f"{name} must be a nonnegative safe integer")
    return value


def address(value: Any) -> str:
    if not isinstance(value, str) or str(Pubkey.from_string(value)) != value:
        raise ValueError("Invalid Solana address")
    return value


def validate_channel_config(config: Any, requirements: PaymentRequirements) -> str:
    if not isinstance(config, dict):
        raise BatchError(BatchError.PAYLOAD_TYPE)
    extra = requirements.extra or {}
    if requirements.scheme != BATCH_SETTLEMENT_SCHEME or not requirements.network.startswith(
        "solana:"
    ):
        raise BatchError(BatchError.PAYLOAD_TYPE)
    if extra.get("paymentFlow", "authorization") != "authorization":
        raise BatchError(BatchError.PAYMENT_FLOW)
    if "assetTransferMethod" in extra or "channelProgram" in extra:
        raise BatchError(BatchError.PAYLOAD_TYPE)
    fee_payer = address(extra.get("feePayer"))
    for key in ("payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token"):
        address(config.get(key))
    if config["payer"] == fee_payer or config["payerAuthorizer"] == fee_payer:
        raise BatchError(BatchError.FEE_PAYER_MISMATCH)
    if config["receiver"] != requirements.pay_to or config["token"] != requirements.asset:
        raise BatchError(BatchError.CHANNEL_STATE)
    if config["receiverAuthorizer"] != extra.get("receiverAuthorizer"):
        raise BatchError(BatchError.RECEIVER_AUTHORIZER_MISMATCH)
    delay = integer(config.get("withdrawDelay"), "withdrawDelay")
    if (
        not MIN_WITHDRAW_DELAY <= delay <= MAX_WITHDRAW_DELAY
        or delay < requirements.max_timeout_seconds
    ):
        raise BatchError(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE)
    if delay != extra.get("withdrawDelay"):
        raise BatchError(BatchError.WITHDRAW_DELAY_MISMATCH)
    if extra.get("tokenProgram") not in (TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS):
        raise BatchError(BatchError.TOKEN_PROGRAM)
    mode = config.get("voucherSigner", "client")
    if mode not in ("client", "server") or mode != extra.get("voucherSigner", "client"):
        raise BatchError(BatchError.CHANNEL_STATE)
    if mode == "server":
        if config["payerAuthorizer"] != extra.get("operator"):
            raise BatchError(BatchError.CHANNEL_STATE)
    elif "operator" in extra:
        raise BatchError(BatchError.CHANNEL_STATE)
    atomic(requirements.amount)
    return find_payment_channel_pda(
        payer=config["payer"],
        payee=fee_payer,
        mint=config["token"],
        authorized_signer=config["payerAuthorizer"],
        salt=atomic(config.get("salt"), "salt"),
        open_slot=integer(config.get("openSlot"), "openSlot"),
    )


def validate_voucher(voucher: Any, channel_id: str, signer: str) -> int:
    if not isinstance(voucher, dict):
        raise BatchError(BatchError.VOUCHER_SIGNATURE)
    if voucher.get("channelId") != channel_id:
        raise BatchError(BatchError.CHANNEL_ID_MISMATCH)
    if type(voucher.get("expiresAt")) is not int or voucher["expiresAt"] != 0:
        raise BatchError(BatchError.VOUCHER_EXPIRY)
    amount = atomic(voucher.get("maxClaimableAmount"), "maxClaimableAmount")
    if not verify_voucher(voucher.get("signature"), signer, channel_id, amount, 0):
        raise BatchError(BatchError.VOUCHER_SIGNATURE)
    return amount


def validate_client_payload(
    raw: Any, requirements: PaymentRequirements, *, enriched: bool = False
) -> str:
    if not isinstance(raw, dict) or raw.get("type") not in (
        "deposit",
        "voucher",
        "authorization",
        "refund",
    ):
        raise BatchError(BatchError.PAYLOAD_TYPE)
    config = raw.get("channelConfig")
    channel_id = validate_channel_config(config, requirements)
    mode = config.get("voucherSigner", "client")
    kind = raw["type"]
    if "requestId" in raw or "maxClaimableAmount" in raw:
        raise BatchError(BatchError.PAYLOAD_TYPE)
    if kind == "deposit":
        deposit = raw.get("deposit")
        if not isinstance(deposit, dict) or not isinstance(deposit.get("transaction"), str):
            raise BatchError(BatchError.SETUP_TRANSACTION)
        if atomic(deposit.get("amount"), "deposit.amount") == 0:
            raise BatchError(BatchError.SETUP_TRANSACTION)
    if kind == "refund" and "transaction" in raw and not isinstance(raw["transaction"], str):
        raise BatchError(BatchError.REFUND_TRANSACTION)
    if mode == "client":
        if kind == "authorization" or "authorization" in raw:
            raise BatchError(BatchError.VOUCHER_SIGNATURE)
        validate_voucher(raw.get("voucher"), channel_id, config["payerAuthorizer"])
    else:
        if kind == "voucher" or ("voucher" in raw and not (enriched and kind == "refund")):
            raise BatchError(BatchError.VOUCHER_SIGNATURE)
        auth = raw.get("authorization")
        # Server-enriched cooperative refunds may carry only the operator voucher.
        if enriched and kind == "refund" and auth is None and "voucher" in raw:
            validate_voucher(raw["voucher"], channel_id, config["payerAuthorizer"])
        elif (
            not isinstance(auth, dict)
            or auth.get("channelId") != channel_id
            or auth.get("payer") != config["payer"]
            or auth.get("authorizedAmount") != ("0" if kind == "refund" else requirements.amount)
            or not verify_batch_authorization(auth, config["payerAuthorizer"])
        ):
            raise BatchError(BatchError.VOUCHER_SIGNATURE)
    return channel_id
