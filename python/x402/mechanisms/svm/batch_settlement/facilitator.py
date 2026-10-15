"""SVM batch verification, sponsored settlement, and durable transaction recovery."""

from __future__ import annotations

import base64
import hashlib
import json
import random
import struct
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.instruction import AccountMeta, Instruction
from solders.message import to_bytes_versioned
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from ....schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse
from ..constants import MEMO_PROGRAM_ADDRESS
from ..payment_channels import (
    CHANNEL_ACCOUNT_SIZE,
    PAYMENT_CHANNELS_PROGRAM_ID,
    Channel,
    ChannelSplit,
    ChannelStatus,
    SettleVoucher,
    build_distribute_instruction,
    build_settle_and_seal_instructions,
    build_settle_instructions,
    compile_transaction,
    decode_channel_account,
    distribution_hash,
    find_ata,
    find_payment_channel_pda,
    get_payment_channels_treasury_owner,
)
from ..payment_channels.verification import (
    _writable,
    verify_open_transaction,
    verify_request_close_transaction,
    verify_top_up_transaction,
)
from .close_authorization import verify_close_authorization
from .constants import BATCH_SETTLEMENT_SCHEME
from .errors import BatchError
from .facilitator_storage import (
    BatchPendingSettlementStore,
    MemoryBatchPendingSettlementStore,
    MemoryPaymentChannelStorage,
    PaymentChannelRecord,
    PaymentChannelStorage,
    PendingSettlement,
)
from .receiver_binding import read_receiver_binding_from_open
from .validation import (
    atomic,
    integer,
    validate_channel_config,
    validate_client_payload,
    validate_voucher,
)


@dataclass
class BatchDelegatedReceiverAuth:
    receiver_authorizer: str
    resolve_caller_identity: Callable[[dict[str, Any]], str | None]


@dataclass
class BatchSvmFacilitatorConfig:
    channel_storage: PaymentChannelStorage | None = None
    pending_settlement_store: BatchPendingSettlementStore | None = None
    receiver_binding_history_reader: Any = None
    delegated_receiver_auth: BatchDelegatedReceiverAuth | None = None
    on_distribution_confirmed: Callable[[SettleResponse, PaymentRequirements], None] | None = None
    max_idle_secs: int = 0
    max_compute_units: int = 400_000
    max_priority_fee: int = 5_000_000
    max_required_signatures: int = 2


def _snapshot(channel_id: str, channel: Channel) -> dict[str, Any]:
    return {
        "channelId": channel_id,
        "balance": str(channel.deposit),
        "totalClaimed": str(channel.settled),
        "withdrawRequestedAt": channel.closure_started_at
        if channel.status == ChannelStatus.CLOSING
        else 0,
    }


def _channel_metadata(channel: Channel) -> dict[str, Any]:
    return {**asdict(channel), "distribution_hash": channel.distribution_hash.hex()}


def _failure(
    network: str, reason: str, payer: str = "", signature: str = "", message: str | None = None
) -> SettleResponse:
    return SettleResponse(
        success=False,
        network=network,
        transaction=signature,
        payer=payer,
        error_reason=reason,
        error_message=message,
    )


class BatchSvmScheme:
    scheme = BATCH_SETTLEMENT_SCHEME
    caip_family = "solana:*"

    def __init__(self, signer: Any, config: BatchSvmFacilitatorConfig | None = None):
        self.signer = signer
        self.config = config or BatchSvmFacilitatorConfig()
        for method in (
            "get_addresses",
            "get_account_info",
            "get_account_info_with_context",
            "get_latest_blockhash",
            "get_slot",
            "get_block_height",
            "is_blockhash_valid",
            "get_signature_status",
            "get_transaction",
            "sign_transaction",
            "simulate_transaction",
            "send_transaction",
            "confirm_transaction",
        ):
            if not callable(getattr(signer, method, None)):
                raise TypeError(f"SVM batch facilitator signer must implement {method}")
        if not signer.get_addresses():
            raise ValueError("SVM batch facilitator requires a fee payer")
        if type(self.config.max_idle_secs) is not int or self.config.max_idle_secs < 0:
            raise ValueError("max_idle_secs must be nonnegative")
        if (
            self.config.channel_storage is None
            and self.config.receiver_binding_history_reader is None
        ):
            raise ValueError(
                "configure channel_storage or receiver_binding_history_reader for receiver bindings"
            )
        delegated = self.config.delegated_receiver_auth
        if delegated is not None:
            Pubkey.from_string(delegated.receiver_authorizer)
            if not callable(delegated.resolve_caller_identity):
                raise ValueError("delegated authorization requires a caller identity resolver")
        self.channel_storage = self.config.channel_storage or MemoryPaymentChannelStorage()
        self.pending_store = (
            self.config.pending_settlement_store or MemoryBatchPendingSettlementStore()
        )
        self._confirmation_slots: dict[str, int] = {}

    def get_extra(self, network: str) -> dict[str, Any]:
        extra: dict[str, Any] = {"feePayer": random.choice(self.signer.get_addresses())}
        if self.config.max_idle_secs:
            extra["maxIdleSecs"] = self.config.max_idle_secs
        if self.config.delegated_receiver_auth:
            extra["receiverAuthorizer"] = self.config.delegated_receiver_auth.receiver_authorizer
        return extra

    def get_signers(self, network: str) -> list[str]:
        return list(self.signer.get_addresses())

    def read_channel(self, network: str, channel_id: str) -> Channel | None:
        floor = self._confirmation_slots.get(network)
        for attempt in range(5):
            try:
                result = self.signer.get_account_info_with_context(
                    channel_id, network, min_context_slot=floor
                )
                account, context_slot = result["account"], result["context_slot"]
                if floor is not None and (type(context_slot) is not int or context_slot < floor):
                    raise RuntimeError("account read precedes confirmed transaction slot")
                if account is None:
                    return None
                if account["owner"] != PAYMENT_CHANNELS_PROGRAM_ID or account.get("executable"):
                    raise BatchError(
                        BatchError.CHANNEL_STATE, "channel has wrong owner or is executable"
                    )
                try:
                    channel = decode_channel_account(account["data"])
                except ValueError as error:
                    raise BatchError(BatchError.CHANNEL_STATE, str(error)) from error
                if (
                    find_payment_channel_pda(
                        payer=channel.payer,
                        payee=channel.payee,
                        mint=channel.mint,
                        authorized_signer=channel.authorized_signer,
                        salt=channel.salt,
                        open_slot=channel.open_slot,
                    )
                    != channel_id
                ):
                    raise BatchError(BatchError.CHANNEL_ID_MISMATCH)
                return channel
            except BatchError:
                raise
            except Exception:
                if floor is None or attempt == 4:
                    raise
                time.sleep(0.2 * (attempt + 1))
        return None

    def discover_channels(self, network: str) -> list[tuple[str, Channel]]:
        channels: dict[str, Channel] = {}
        for sponsor in self.signer.get_addresses():
            accounts = self.signer.get_program_accounts(
                PAYMENT_CHANNELS_PROGRAM_ID,
                network,
                filters=[
                    {"dataSize": CHANNEL_ACCOUNT_SIZE},
                    {"memcmp": {"offset": 216, "bytes": sponsor}},
                ],
            )
            for entry in accounts:
                account = entry["account"]
                if account["owner"] != PAYMENT_CHANNELS_PROGRAM_ID or account.get("executable"):
                    continue
                try:
                    channel = decode_channel_account(account["data"])
                    channel_id = find_payment_channel_pda(
                        payer=channel.payer,
                        payee=channel.payee,
                        mint=channel.mint,
                        authorized_signer=channel.authorized_signer,
                        salt=channel.salt,
                        open_slot=channel.open_slot,
                    )
                    if (
                        channel.rent_payer == sponsor
                        and channel.payee == sponsor
                        and channel_id == entry["pubkey"]
                    ):
                        channels[channel_id] = channel
                except ValueError:
                    continue
        return list(channels.items())

    @staticmethod
    def _channel_id(
        config: dict[str, Any], requirements: PaymentRequirements, *, lifecycle: bool = False
    ) -> str:
        if not isinstance(config, dict):
            raise BatchError(BatchError.PAYLOAD_TYPE)
        if lifecycle:
            extra = dict(requirements.extra or {})
            extra["voucherSigner"] = config.get("voucherSigner", "client")
            if extra["voucherSigner"] == "server":
                extra["operator"] = config["payerAuthorizer"]
            else:
                extra.pop("operator", None)
            requirements = requirements.model_copy(update={"extra": extra})
        return validate_channel_config(config, requirements)

    def _terms(
        self, config: dict[str, Any], requirements: PaymentRequirements, *, lifecycle: bool = False
    ) -> str:
        channel_id = self._channel_id(config, requirements, lifecycle=lifecycle)
        extra = requirements.extra or {}
        if extra["feePayer"] not in self.signer.get_addresses():
            raise BatchError(BatchError.FEE_PAYER_MISMATCH)
        if config["withdrawDelay"] < requirements.max_timeout_seconds:
            raise BatchError(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE)
        mint = self.signer.get_account_info(requirements.asset, requirements.network)
        if (
            not mint
            or mint["owner"] != extra["tokenProgram"]
            or mint.get("executable")
            or len(mint["data"]) < 82
            or mint["data"][45] != 1
        ):
            raise BatchError(BatchError.TOKEN_PROGRAM)
        if "memo" in extra and not isinstance(extra["memo"], str):
            raise BatchError(BatchError.SETUP_TRANSACTION)
        return channel_id

    def assert_channel(
        self,
        channel: Channel | None,
        config: dict[str, Any],
        requirements: PaymentRequirements,
        statuses: Sequence[ChannelStatus] = (ChannelStatus.OPEN,),
    ) -> Channel:
        if channel is None:
            raise BatchError(BatchError.CHANNEL_STATE, "channel account is missing")
        if channel.status == ChannelStatus.CLOSING and ChannelStatus.CLOSING not in statuses:
            raise BatchError(BatchError.CHANNEL_CLOSING)
        extra = requirements.extra or {}
        if (
            channel.status not in statuses
            or channel.payer != config["payer"]
            or channel.authorized_signer != config["payerAuthorizer"]
            or channel.mint != config["token"]
            or channel.payee != extra["feePayer"]
            or channel.rent_payer != extra["feePayer"]
            or channel.salt != atomic(config["salt"], "salt")
            or channel.open_slot != config["openSlot"]
            or channel.grace_period != config["withdrawDelay"]
            or channel.distribution_hash
            != distribution_hash([ChannelSplit(config["receiver"], 10_000)])
            or not 0 <= channel.payout_watermark <= channel.settled <= channel.deposit
        ):
            raise BatchError(BatchError.CHANNEL_STATE)
        return channel

    def _limits(self) -> dict[str, int]:
        return {
            "max_compute_units": self.config.max_compute_units,
            "max_priority_fee": self.config.max_priority_fee,
            "max_required_signatures": self.config.max_required_signatures,
        }

    def _check_accounts(
        self, config: dict[str, Any], requirements: PaymentRequirements, deposit: int
    ) -> None:
        token_program = requirements.extra["tokenProgram"]
        owners = [
            ("payer", config["payer"]),
            ("recipient", requirements.pay_to),
            ("treasury", get_payment_channels_treasury_owner(requirements.network)),
        ]
        for name, owner in owners:
            ata = find_ata(owner, requirements.asset, token_program)
            account = self.signer.get_account_info(ata, requirements.network)
            if (
                not account
                or account["owner"] != token_program
                or account.get("executable")
                or len(account["data"]) < 165
            ):
                raise BatchError(
                    BatchError.SETTLEMENT_SIMULATION, f"missing or invalid {name} token account"
                )
            data = account["data"]
            if (
                data[:32] != bytes(Pubkey.from_string(requirements.asset))
                or data[32:64] != bytes(Pubkey.from_string(owner))
                or data[108] != 1
            ):
                raise BatchError(BatchError.SETTLEMENT_SIMULATION, f"unusable {name} token account")
            if name == "payer" and struct.unpack_from("<Q", data, 64)[0] < deposit:
                raise BatchError(
                    BatchError.SETTLEMENT_SIMULATION, "payer token balance is insufficient"
                )

    def _validate_deposit(
        self, raw: dict[str, Any], requirements: PaymentRequirements, *, settling: bool = False
    ) -> tuple[str, Channel | None, int, VersionedTransaction]:
        config, extra = raw["channelConfig"], requirements.extra or {}
        channel_id = self._terms(config, requirements)
        proof_requirements = requirements
        if settling and config.get("voucherSigner") == "server":
            ceiling = atomic(raw.get("authorization", {}).get("authorizedAmount"))
            if atomic(requirements.amount) > ceiling:
                raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
            proof_requirements = requirements.model_copy(update={"amount": str(ceiling)})
        validate_client_payload(raw, proof_requirements)
        deposit = atomic(raw["deposit"]["amount"])
        before = self.read_channel(requirements.network, channel_id)
        if before:
            self.assert_channel(before, config, requirements)
        total = deposit + (before.deposit if before else 0)
        if total > 2**64 - 1:
            raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
        charge = atomic(requirements.amount)
        if config.get("voucherSigner") == "server":
            if charge > total - (before.settled if before else 0):
                raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
        else:
            amount = atomic(raw["voucher"]["maxClaimableAmount"])
            if amount > total:
                raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
            if (before is None and amount != charge) or (
                before and (amount <= before.settled or amount < before.settled + charge)
            ):
                raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
        try:
            kwargs = dict(
                channel_config=config,
                fee_payer=extra["feePayer"],
                token_program=extra["tokenProgram"],
                memo=extra.get("memo"),
                **self._limits(),
            )
            if before:
                transaction = verify_top_up_transaction(
                    raw["deposit"]["transaction"], channel_id=channel_id, amount=deposit, **kwargs
                )
            else:
                recent_slot = extra.get("recentSlot")
                if recent_slot is not None:
                    recent_slot = integer(
                        atomic(recent_slot, "recentSlot")
                        if isinstance(recent_slot, str)
                        else recent_slot,
                        "recentSlot",
                    )
                transaction = verify_open_transaction(
                    raw["deposit"]["transaction"],
                    deposit=deposit,
                    current_slot=recent_slot,
                    **kwargs,
                )
            self._check_accounts(config, requirements, deposit)
            self._simulate(raw["deposit"]["transaction"], requirements.network, sig_verify=False)
        except BatchError:
            raise
        except Exception as error:
            raise BatchError(BatchError.SETUP_TRANSACTION, str(error)) from error
        if before is None:
            self._simulate_open_path(channel_id, config, requirements, total, transaction)
        return channel_id, before, total, transaction

    def verify(
        self, payment: PaymentPayload, requirements: PaymentRequirements, context: Any = None
    ) -> VerifyResponse:
        raw, payer = payment.payload, ""
        try:
            self._check_envelope(payment, requirements)
            if not isinstance(raw, dict):
                raise BatchError(BatchError.PAYLOAD_TYPE)
            payer = raw.get("channelConfig", {}).get("payer", "")
            if raw.get("type") == "deposit":
                channel_id, channel, _, _ = self._validate_deposit(raw, requirements)
                return VerifyResponse(
                    is_valid=True,
                    payer=payer,
                    extra=_snapshot(channel_id, channel) if channel else {"channelId": channel_id},
                )
            channel_id = validate_client_payload(raw, requirements)
            self._terms(raw["channelConfig"], requirements)
            statuses = (
                (ChannelStatus.OPEN, ChannelStatus.CLOSING)
                if raw["type"] == "refund"
                else (ChannelStatus.OPEN,)
            )
            channel = self.assert_channel(
                self.read_channel(requirements.network, channel_id),
                raw["channelConfig"],
                requirements,
                statuses,
            )
            if raw["type"] == "refund":
                if "amount" in raw:
                    raise BatchError(BatchError.CLOSE_AMOUNT_UNSUPPORTED)
                if "voucher" in raw:
                    amount = atomic(raw["voucher"]["maxClaimableAmount"])
                    if not channel.settled <= amount <= channel.deposit:
                        raise BatchError(BatchError.CLOSE_STATE)
                self._check_accounts(raw["channelConfig"], requirements, 0)
                if "transaction" in raw:
                    verify_request_close_transaction(
                        raw["transaction"],
                        payer=payer,
                        channel_id=channel_id,
                        fee_payer=requirements.extra["feePayer"],
                        memo=requirements.extra.get("memo"),
                        **self._limits(),
                    )
            elif raw["type"] == "voucher":
                amount = atomic(raw["voucher"]["maxClaimableAmount"])
                if amount > channel.deposit:
                    raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
                if amount <= channel.settled or amount < channel.settled + atomic(
                    requirements.amount
                ):
                    raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
            elif atomic(requirements.amount) > channel.deposit - channel.settled:
                raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
            return VerifyResponse(is_valid=True, payer=payer, extra=_snapshot(channel_id, channel))
        except Exception as error:
            return VerifyResponse(
                is_valid=False,
                payer=payer,
                invalid_reason=getattr(error, "reason", BatchError.CHANNEL_STATE),
                invalid_message=str(error),
            )

    @staticmethod
    def _check_envelope(payment: PaymentPayload, requirements: PaymentRequirements) -> None:
        if payment.x402_version != 2:
            raise BatchError(
                BatchError.PAYLOAD_TYPE, "SVM batch settlement requires x402 version 2"
            )
        if (
            payment.accepted.scheme != BATCH_SETTLEMENT_SCHEME
            or requirements.scheme != BATCH_SETTLEMENT_SCHEME
        ):
            raise BatchError("unsupported_scheme")
        if payment.accepted.network != requirements.network:
            raise BatchError("network_mismatch")
        accepted = payment.accepted.model_dump()
        required = requirements.model_dump()
        if accepted != required:
            original_amount, actual_amount = accepted.pop("amount"), required.pop("amount")
            raw = payment.payload
            if (
                accepted != required
                or raw.get("type") != "deposit"
                or raw.get("channelConfig", {}).get("voucherSigner") != "server"
                or raw.get("authorization", {}).get("authorizedAmount") != original_amount
                or atomic(actual_amount) > atomic(original_amount)
            ):
                raise BatchError(BatchError.CHANNEL_STATE, "accepted requirements do not match")

    @staticmethod
    def _key(
        raw: dict[str, Any], requirements: PaymentRequirements, *, request_close: bool = False
    ) -> str:
        kind = raw["type"]
        if kind == "deposit" or request_close:
            try:
                wire = raw["deposit"]["transaction"] if kind == "deposit" else raw["transaction"]
                transaction = VersionedTransaction.from_bytes(base64.b64decode(wire, validate=True))
                transaction.sanitize()
            except Exception as error:
                reason = (
                    BatchError.SETUP_TRANSACTION
                    if kind == "deposit"
                    else BatchError.REFUND_TRANSACTION
                )
                raise BatchError(reason, str(error)) from error
            # The sponsor signature may still be a placeholder. Signing the same
            # message produces the same transaction regardless of refreshed proofs.
            identity = hashlib.sha256(to_bytes_versioned(transaction.message)).hexdigest()
            return f"batch:{kind}:{requirements.network}:{identity}"
        if kind in ("seal", "refund"):
            try:
                voucher = raw["voucher"]
                target = atomic(voucher["maxClaimableAmount"], "maxClaimableAmount")
            except (KeyError, TypeError, ValueError) as error:
                raise BatchError(BatchError.VOUCHER_SIGNATURE, str(error)) from error
            return f"batch:close:{requirements.network}:{voucher.get('channelId')}:{target}"
        content = {
            "payload": raw,
            "requirements": requirements.model_dump(mode="json", by_alias=True),
        }
        return (
            "batch:"
            + hashlib.sha256(
                json.dumps(content, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        )

    def _check_cached_request(
        self,
        record: PendingSettlement,
        raw: dict[str, Any],
        requirements: PaymentRequirements,
        context: Any,
        *,
        request_close: bool = False,
    ) -> None:
        if raw["type"] not in ("deposit", "seal", "refund"):
            return
        if request_close:
            kinds = ("request_close",)
        elif raw["type"] in ("seal", "refund"):
            kinds = ("seal", "refund")
        else:
            kinds = ("deposit",)
        if record.kind not in kinds:
            raise BatchError(BatchError.CHANNEL_STATE, "cached transaction operation differs")
        config = raw.get("channelConfig")
        channel_id = self._channel_id(config, requirements, lifecycle=raw["type"] == "seal")
        if tuple(record.channel_ids) != (channel_id,) or record.metadata.get("configs") != [config]:
            raise BatchError(BatchError.CHANNEL_STATE, "cached transaction channel terms differ")
        original = PaymentRequirements.model_validate(record.metadata["requirements"])
        # Config equality and validation bind receiver, authorizers, mode, and delay.
        # Route pricing, timeouts, and construction hints do not identify the transaction.
        terms = [
            (
                value.scheme,
                value.network,
                value.asset,
                value.pay_to,
                (value.extra or {}).get("feePayer"),
                (value.extra or {}).get("tokenProgram"),
            )
            for value in (original, requirements)
        ]
        if terms[0] != terms[1] or (
            raw["type"] == "deposit"
            and raw.get("deposit", {}).get("amount") != record.metadata["deposit_amount"]
        ):
            raise BatchError(BatchError.CHANNEL_STATE, "cached transaction requirements differ")
        if record.kind in ("seal", "refund"):
            self._authenticate_close(
                raw,
                requirements,
                channel_id,
                self._read_binding(requirements.network, channel_id),
                context,
            )

    def settle(
        self, payment: PaymentPayload, requirements: PaymentRequirements, context: Any = None
    ) -> SettleResponse:
        raw, payer = payment.payload, ""
        try:
            self._check_envelope(payment, requirements)
            if not isinstance(raw, dict) or raw.get("type") not in (
                "deposit",
                "claim",
                "settle",
                "seal",
                "refund",
            ):
                raise BatchError(BatchError.PAYLOAD_TYPE)
            config = raw.get("channelConfig")
            payer = config.get("payer", "") if isinstance(config, dict) else ""
            if raw["type"] in ("seal", "refund"):
                return self._settle_close(raw, requirements, context)
            key = self._key(raw, requirements)
            _, existing = self._operation_attempt(key)
            if existing:
                self._check_cached_request(existing, raw, requirements, context)
                # A completed distribute can be reused only until a newer settled watermark appears.
                if raw["type"] != "settle" or existing.response is None:
                    return self._reconcile(existing, requirements)
            if raw["type"] == "deposit":
                return self._settle_deposit(key, raw, requirements, context)
            if raw["type"] in ("claim", "settle"):
                return self._settle_batch(key, raw, requirements)
        except Exception as error:
            return _failure(
                requirements.network,
                getattr(error, "reason", BatchError.CHANNEL_STATE),
                payer,
                message=str(error),
            )

    def _distribute(
        self, channel_id: str, channel: Channel, requirements: PaymentRequirements
    ) -> Instruction:
        return build_distribute_instruction(
            channel_id=channel_id,
            payee=channel.payee,
            payer=channel.payer,
            rent_payer=channel.rent_payer,
            mint=channel.mint,
            token_program=requirements.extra["tokenProgram"],
            splits=[ChannelSplit(requirements.pay_to, 10_000)],
            network=requirements.network,
        )

    def _record_activity(
        self,
        channel_id: str,
        config: dict[str, Any],
        requirements: PaymentRequirements,
        *,
        receiver: str = "",
        identity: str = "",
    ) -> None:
        self.channel_storage.record(
            PaymentChannelRecord(
                network=requirements.network,
                channel_id=channel_id,
                pay_to=requirements.pay_to,
                token_program=requirements.extra["tokenProgram"],
                receiver_authorizer=receiver,
                caller_identity=identity,
                last_activity_at=time.time(),
                channel_config=dict(config),
            )
        )

        stored = self.channel_storage.get(requirements.network, channel_id)
        if stored is None:
            raise BatchError(
                BatchError.RECEIVER_BINDING_UNAVAILABLE, "channel write is not readable"
            )
        if receiver and stored.receiver_authorizer != receiver:
            raise BatchError(BatchError.RECEIVER_AUTHORIZER_MISMATCH)
        if identity and stored.caller_identity != identity:
            raise BatchError(BatchError.DELEGATED_UNAUTHENTICATED)

    def _identity(self, channel_id: str, payer: str, network: str, step: str, context: Any) -> str:
        delegated = self.config.delegated_receiver_auth
        if delegated is None:
            raise BatchError(BatchError.DELEGATED_UNAUTHENTICATED)
        try:
            value = delegated.resolve_caller_identity(
                {
                    "channelId": channel_id,
                    "payer": payer,
                    "network": network,
                    "step": step,
                    "facilitatorContext": context,
                }
            )
        except Exception as error:
            raise BatchError(BatchError.DELEGATED_UNAUTHENTICATED) from error
        if not isinstance(value, str) or not value:
            raise BatchError(BatchError.DELEGATED_UNAUTHENTICATED)
        return value

    def _simulate_open_path(
        self,
        channel_id: str,
        config: dict[str, Any],
        requirements: PaymentRequirements,
        total: int,
        decoded: VersionedTransaction,
    ) -> None:
        extra = requirements.extra
        # Exact setup was simulated above; this composite checks close/refund/payout usability.
        open_ix = next(
            ix
            for ix in decoded.message.instructions
            if str(decoded.message.account_keys[ix.program_id_index]) == PAYMENT_CHANNELS_PROGRAM_ID
        )
        message = decoded.message
        instruction = Instruction(
            Pubkey.from_string(PAYMENT_CHANNELS_PROGRAM_ID),
            bytes(open_ix.data),
            [
                AccountMeta(
                    message.account_keys[i],
                    i < message.header.num_required_signatures,
                    _writable(message, i),
                )
                for i in open_ix.accounts
            ],
        )
        temporary = Channel(
            payer=config["payer"],
            payee=extra["feePayer"],
            authorized_signer=config["payerAuthorizer"],
            mint=config["token"],
            rent_payer=extra["feePayer"],
            salt=atomic(config["salt"]),
            open_slot=config["openSlot"],
            deposit=total,
            settled=0,
            payout_watermark=0,
            grace_period=config["withdrawDelay"],
            distribution_hash=distribution_hash([ChannelSplit(requirements.pay_to, 10_000)]),
        )
        composite = compile_transaction(
            [
                set_compute_unit_limit(1_400_000),
                instruction,
                *build_settle_and_seal_instructions(channel_id, extra["feePayer"]),
                self._distribute(channel_id, temporary, requirements),
            ],
            fee_payer=extra["feePayer"],
            blockhash=str(message.recent_blockhash),
        )
        self._simulate(
            base64.b64encode(bytes(composite)).decode(), requirements.network, sig_verify=False
        )

    def _simulate(self, wire: str, network: str, *, sig_verify: bool) -> int:
        try:
            return self.signer.simulate_transaction(wire, network, sig_verify=sig_verify)
        except Exception as error:
            raise BatchError(BatchError.SETTLEMENT_SIMULATION, str(error)) from error

    def _settle_deposit(
        self, key: str, raw: dict[str, Any], requirements: PaymentRequirements, context: Any
    ) -> SettleResponse:
        channel_id, before, total, decoded = self._validate_deposit(
            raw, requirements, settling=True
        )
        config, extra = raw["channelConfig"], requirements.extra
        identity = ""
        delegated = self.config.delegated_receiver_auth
        if (
            before is None
            and delegated
            and config["receiverAuthorizer"] == delegated.receiver_authorizer
        ):
            identity = self._identity(
                channel_id, config["payer"], requirements.network, "deposit", context
            )
        self._record_activity(
            channel_id,
            config,
            requirements,
            receiver=config["receiverAuthorizer"] if before is None else "",
            identity=identity,
        )
        metadata = {
            "configs": [config],
            "expected_deposit": total,
            "deposit_amount": raw["deposit"]["amount"],
        }
        return self.submit_operation(
            key=key,
            network=requirements.network,
            channel_ids=[channel_id],
            kind="deposit",
            payer=config["payer"],
            fee_payer=extra["feePayer"],
            metadata=metadata,
            requirements=requirements,
            wire_transaction=raw["deposit"]["transaction"],
        )

    def _settle_batch(
        self, key: str, raw: dict[str, Any], requirements: PaymentRequirements
    ) -> SettleResponse:
        claiming = raw["type"] == "claim"
        entries = raw.get("claims" if claiming else "channels")
        if not isinstance(entries, list) or not 1 <= len(entries) <= 4:
            raise BatchError(BatchError.PAYLOAD_TYPE)
        ids, configs = [], []
        for entry in entries:
            if not isinstance(entry, dict):
                raise BatchError(BatchError.PAYLOAD_TYPE)
            channel_id = self._terms(entry.get("channelConfig"), requirements, lifecycle=True)
            if entry.get("channelId") != channel_id or channel_id in ids:
                raise BatchError(BatchError.CHANNEL_ID_MISMATCH)
            ids.append(channel_id)
            configs.append(entry["channelConfig"])
        pending = self.pending_store.find_pending(requirements.network, ids)
        if pending:
            if pending.key == key or pending.metadata.get("request_key") == key:
                return self._reconcile(pending, requirements)
            raise BatchError(BatchError.CHANNEL_BUSY)
        previous = None if claiming else self.pending_store.latest(key)
        channels = [self.read_channel(requirements.network, channel_id) for channel_id in ids]
        instructions, targets, swept_ids, swept_configs, before = [], [], [], [], []
        for channel_id, config, entry, channel in zip(ids, configs, entries, channels, strict=True):
            if channel is None and previous is not None and previous.response:
                continue
            status = (
                (ChannelStatus.OPEN,)
                if claiming
                else (ChannelStatus.OPEN, ChannelStatus.SEALED, ChannelStatus.DISTRIBUTED)
            )
            channel = self.assert_channel(channel, config, requirements, status)
            if claiming:
                target = validate_voucher(
                    entry.get("voucher"), channel_id, config["payerAuthorizer"]
                )
                if target > channel.deposit:
                    raise BatchError(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT)
                if not channel.settled < target <= channel.deposit:
                    raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
                voucher = entry["voucher"]
                instructions.extend(
                    build_settle_instructions(
                        channel_id,
                        SettleVoucher(config["payerAuthorizer"], voucher["signature"], target, 0),
                    )
                )
            else:
                if channel.status == ChannelStatus.DISTRIBUTED or (
                    channel.status == ChannelStatus.OPEN
                    and channel.settled == channel.payout_watermark
                ):
                    continue
                target = channel.settled
                instructions.append(self._distribute(channel_id, channel, requirements))
            targets.append(target)
            swept_ids.append(channel_id)
            swept_configs.append(config)
            before.append(_channel_metadata(channel))
        if not instructions:
            if previous and previous.response:
                return previous.response
            raise BatchError(BatchError.CUMULATIVE_AMOUNT_MISMATCH)
        request_key = key
        if not claiming:
            key += (
                ":"
                + hashlib.sha256(
                    json.dumps(list(zip(swept_ids, targets, strict=True)), sort_keys=True).encode()
                ).hexdigest()
            )
        for channel_id, config in zip(swept_ids, swept_configs, strict=True):
            self._record_activity(channel_id, config, requirements)
        metadata = {
            "configs": swept_configs,
            "targets": targets,
            "before": before,
            "request_key": request_key,
        }
        return self.submit_operation(
            key=key,
            network=requirements.network,
            channel_ids=swept_ids,
            kind="claim" if claiming else "distribute",
            payer="",
            fee_payer=requirements.extra["feePayer"],
            metadata=metadata,
            requirements=requirements,
            instructions=instructions,
        )

    def _read_binding(self, network: str, channel_id: str) -> PaymentChannelRecord | None:
        record = self.channel_storage.get(network, channel_id)
        if record and record.receiver_authorizer:
            return record
        reader = self.config.receiver_binding_history_reader
        if reader is None:
            return record
        signatures, before, seen = [], None, set()
        while True:
            page = reader.get_signatures_for_address(network, channel_id, limit=1000, before=before)
            if not page:
                break
            last = page[-1]["signature"]
            if last in seen:
                raise BatchError(
                    BatchError.RECEIVER_BINDING_UNAVAILABLE, "history pagination repeated a cursor"
                )
            seen.add(last)
            signatures.extend(page)
            if len(page) < 1000:
                break
            before = last
        for item in reversed(signatures):
            if item.get("err") is not None:
                continue
            wire = reader.get_transaction(network, item["signature"])
            bound = read_receiver_binding_from_open(wire, channel_id) if wire else None
            if bound:
                recovered = record or PaymentChannelRecord(network, channel_id, "", "")
                recovered.receiver_authorizer = bound
                self.channel_storage.record(recovered)
                return self.channel_storage.get(network, channel_id)
        return record

    def _settle_close(
        self, raw: dict[str, Any], requirements: PaymentRequirements, context: Any
    ) -> SettleResponse:
        config = raw.get("channelConfig")
        channel_id = self._channel_id(config, requirements, lifecycle=raw["type"] == "seal")
        if raw["type"] == "seal" and raw.get("channelId") != channel_id:
            raise BatchError(BatchError.CHANNEL_ID_MISMATCH)
        if "amount" in raw:
            raise BatchError(BatchError.CLOSE_AMOUNT_UNSUPPORTED)
        if raw["type"] == "refund":
            validate_client_payload(raw, requirements, enriched=True)
        binding = self._read_binding(requirements.network, channel_id)
        bound = binding.receiver_authorizer if binding else ""
        if bound and bound != config["receiverAuthorizer"]:
            raise BatchError(BatchError.RECEIVER_AUTHORIZER_MISMATCH)
        request_close = raw["type"] == "refund" and (
            not bound
            or (isinstance(raw.get("transaction"), str) and not raw.get("closeAuthorization"))
        )
        if request_close and not isinstance(raw.get("transaction"), str):
            raise BatchError(BatchError.RECEIVER_BINDING_UNAVAILABLE)
        key = self._key(raw, requirements, request_close=request_close)
        _, existing = self._operation_attempt(key)
        if existing:
            self._check_cached_request(
                existing, raw, requirements, context, request_close=request_close
            )
            return self._reconcile(existing, requirements)
        self._terms(config, requirements, lifecycle=raw["type"] == "seal")
        channel = self.assert_channel(
            self.read_channel(requirements.network, channel_id),
            config,
            requirements,
            (ChannelStatus.OPEN, ChannelStatus.CLOSING),
        )
        # Payer-signed forced close remains available when receiver/caller authentication is lost.
        if request_close:
            transaction = raw["transaction"]
            try:
                verify_request_close_transaction(
                    transaction,
                    payer=config["payer"],
                    channel_id=channel_id,
                    fee_payer=requirements.extra["feePayer"],
                    memo=requirements.extra.get("memo"),
                    **self._limits(),
                )
            except Exception as error:
                raise BatchError(BatchError.REFUND_TRANSACTION, str(error)) from error
            if channel.status == ChannelStatus.CLOSING:
                return SettleResponse(
                    success=True,
                    network=requirements.network,
                    payer=config["payer"],
                    transaction="",
                    amount="",
                    extra={"channelState": _snapshot(channel_id, channel)},
                )
            self._simulate(transaction, requirements.network, sig_verify=False)
            self._record_activity(channel_id, config, requirements)
            return self.submit_operation(
                key=key,
                network=requirements.network,
                channel_ids=[channel_id],
                kind="request_close",
                payer=config["payer"],
                fee_payer=requirements.extra["feePayer"],
                metadata={"configs": [config]},
                requirements=requirements,
                wire_transaction=transaction,
            )
        target = self._authenticate_close(raw, requirements, channel_id, binding, context)
        if raw["type"] == "refund" and channel.status == ChannelStatus.CLOSING:
            return SettleResponse(
                success=True,
                network=requirements.network,
                payer=config["payer"],
                transaction="",
                amount="",
                extra={"channelState": _snapshot(channel_id, channel)},
            )
        expected_status = ChannelStatus.CLOSING if raw["type"] == "seal" else ChannelStatus.OPEN
        if (
            channel.status != expected_status
            or not channel.settled <= target <= channel.deposit
            or (
                channel.status == ChannelStatus.CLOSING
                and int(time.time()) >= channel.closure_started_at + channel.grace_period
            )
        ):
            raise BatchError(BatchError.CLOSE_STATE)
        voucher = (
            SettleVoucher(config["payerAuthorizer"], raw["voucher"]["signature"], target, 0)
            if target > channel.settled
            else None
        )
        instructions = [
            *build_settle_and_seal_instructions(channel_id, channel.payee, voucher),
            self._distribute(channel_id, channel, requirements),
        ]
        self._record_activity(channel_id, config, requirements)
        return self.submit_operation(
            key=key,
            network=requirements.network,
            channel_ids=[channel_id],
            kind=raw["type"],
            payer=config["payer"],
            fee_payer=requirements.extra["feePayer"],
            metadata={
                "configs": [config],
                "targets": [target],
                "before": [_channel_metadata(channel)],
            },
            requirements=requirements,
            instructions=instructions,
        )

    def _authenticate_close(
        self,
        raw: dict[str, Any],
        requirements: PaymentRequirements,
        channel_id: str,
        binding: PaymentChannelRecord | None,
        context: Any,
    ) -> int:
        config = raw["channelConfig"]
        if not binding or not binding.receiver_authorizer:
            raise BatchError(BatchError.RECEIVER_BINDING_UNAVAILABLE)
        bound = binding.receiver_authorizer
        if bound != config["receiverAuthorizer"]:
            raise BatchError(BatchError.RECEIVER_AUTHORIZER_MISMATCH)
        target = validate_voucher(raw.get("voucher"), channel_id, config["payerAuthorizer"])
        delegated = self.config.delegated_receiver_auth
        if delegated and bound == delegated.receiver_authorizer:
            identity = self._identity(
                channel_id, config["payer"], requirements.network, raw["type"], context
            )
            if not binding.caller_identity or identity != binding.caller_identity:
                raise BatchError(BatchError.DELEGATED_UNAUTHENTICATED)
        elif not verify_close_authorization(
            raw.get("closeAuthorization"),
            receiver_authorizer=bound,
            max_timeout_seconds=requirements.max_timeout_seconds,
            network=requirements.network,
            fee_payer=requirements.extra["feePayer"],
            channel_id=channel_id,
            max_claimable_amount=target,
            voucher_expires_at=0,
        ):
            raise BatchError(BatchError.CLOSE_AUTHORIZATION)
        return target

    def submit_operation(
        self,
        *,
        key: str,
        network: str,
        channel_ids: Sequence[str],
        kind: str,
        payer: str,
        fee_payer: str,
        metadata: dict[str, Any],
        requirements: PaymentRequirements,
        wire_transaction: str | None = None,
        instructions: Sequence[Instruction] | None = None,
    ) -> SettleResponse:
        """Persist signed bytes before broadcast; retries reconcile those exact bytes."""
        key, previous = self._operation_attempt(key)
        if previous:
            return self._reconcile(previous, requirements)
        active = self.pending_store.find_pending(network, channel_ids)
        if active:
            return _failure(network, BatchError.CHANNEL_BUSY, payer, active.signature)
        lifetime = self.signer.get_latest_blockhash(network)
        metadata = {**metadata, "requirements": requirements.model_dump(mode="json", by_alias=True)}
        if wire_transaction is None:
            if not instructions:
                raise ValueError("missing transaction instructions")
            transaction = compile_transaction(
                [
                    set_compute_unit_limit(min(1_400_000, 100_000 * len(channel_ids))),
                    set_compute_unit_price(1),
                    *instructions,
                    Instruction(
                        Pubkey.from_string(MEMO_PROGRAM_ADDRESS),
                        ("x402:batch:" + hashlib.sha256(key.encode()).hexdigest()).encode(),
                        [],
                    ),
                ],
                fee_payer=fee_payer,
                blockhash=lifetime["blockhash"],
            )
            wire_transaction = base64.b64encode(bytes(transaction)).decode()
        signed = self.signer.sign_transaction(wire_transaction, fee_payer, network)
        original = VersionedTransaction.from_bytes(
            base64.b64decode(wire_transaction, validate=True)
        )
        transaction = VersionedTransaction.from_bytes(base64.b64decode(signed, validate=True))
        if (
            to_bytes_versioned(transaction.message) != to_bytes_versioned(original.message)
            or str(transaction.message.account_keys[0]) != fee_payer
            or list(transaction.signatures[1:]) != list(original.signatures[1:])
            or not all(transaction.verify_with_results())
        ):
            raise ValueError(
                "facilitator signer changed the message or returned invalid signatures"
            )
        simulation_slot = self._simulate(signed, network, sig_verify=True)
        metadata["blockhash"] = str(transaction.message.recent_blockhash)
        metadata["simulation_slot"] = simulation_slot
        signature = str(transaction.signatures[0])
        record = PendingSettlement(
            key=key,
            network=network,
            channel_ids=tuple(channel_ids),
            signature=signature,
            wire_transaction=signed,
            last_valid_block_height=lifetime["last_valid_block_height"],
            kind=kind,
            payer=payer,
            metadata=metadata,
        )
        if not self.pending_store.reserve(record):
            previous = self.pending_store.get(key)
            return (
                self._reconcile(previous, requirements)
                if previous
                else _failure(network, BatchError.CHANNEL_BUSY, payer)
            )
        try:
            returned = self.signer.send_transaction(signed, network)
            if returned != signature:
                return _failure(
                    network,
                    "settlement_pending",
                    payer,
                    signature,
                    "RPC returned a different transaction signature",
                )
            slot = self.signer.confirm_transaction(signature, network)
            if isinstance(slot, int):
                self._confirmation_slots[network] = max(
                    self._confirmation_slots.get(network, 0), slot
                )
        except Exception:
            # A transport exception after send does not prove the transaction failed.
            pass
        return self._reconcile(record, requirements, resend=False)

    def _operation_attempt(self, key: str) -> tuple[str, PendingSettlement | None]:
        """Retry proven failures under new immutable keys; never replace a pending attempt."""
        original = key
        while True:
            record = self.pending_store.get(key)
            if (
                record is None
                or record.response is None
                or record.kind in ("deposit", "request_close")
                or record.response.error_reason not in ("transaction_expired", "transaction_failed")
            ):
                return key, record
            key = original + ":retry:" + hashlib.sha256(record.signature.encode()).hexdigest()

    def recover_pending(
        self, record: PendingSettlement, requirements: PaymentRequirements | None = None
    ) -> SettleResponse:
        """Resume persisted work even when its channel account was closed by that work."""
        if requirements is None:
            requirements = PaymentRequirements.model_validate(record.metadata["requirements"])
        return self._reconcile(record, requirements)

    def _reconcile(
        self, record: PendingSettlement, requirements: PaymentRequirements, *, resend: bool = True
    ) -> SettleResponse:
        if record.response is not None:
            return record.response
        if "requirements" in record.metadata:
            requirements = PaymentRequirements.model_validate(record.metadata["requirements"])
        try:
            status = self.signer.get_signature_status(record.signature, record.network)
            if (
                resend
                and record.wire_transaction
                and (
                    not status
                    or status.get("confirmation_status") not in ("confirmed", "finalized")
                )
            ):
                try:
                    self.signer.send_transaction(record.wire_transaction, record.network)
                except Exception:
                    # Broadcast failures never establish non-inclusion; poll the saved identity.
                    pass
                status = self.signer.get_signature_status(record.signature, record.network)
            if (
                status
                and status.get("confirmation_status") in ("confirmed", "finalized")
                and status.get("err") is not None
            ):
                response = _failure(
                    record.network,
                    "transaction_failed",
                    record.payer,
                    record.signature,
                    str(status["err"]),
                )
                self.pending_store.complete(record.key, response)
                return response
            if not status or status.get("confirmation_status") not in ("confirmed", "finalized"):
                if (
                    status is None
                    and self.signer.get_block_height(record.network)
                    > record.last_valid_block_height
                    and type(record.metadata.get("simulation_slot")) is int
                    and not self.signer.is_blockhash_valid(
                        record.metadata["blockhash"],
                        record.network,
                        min_context_slot=record.metadata["simulation_slot"],
                    )
                ):
                    # History is checked after finalized expiry so an earlier stale status is insufficient.
                    status = self.signer.get_signature_status(record.signature, record.network)
                    if status is None:
                        response = _failure(
                            record.network, "transaction_expired", record.payer, record.signature
                        )
                        self.pending_store.complete(record.key, response)
                        return response
                return _failure(
                    record.network, "settlement_pending", record.payer, record.signature
                )
            self._confirmation_slots[record.network] = max(
                self._confirmation_slots.get(record.network, 0), status["slot"]
            )
            response = self._confirmed_response(record, requirements)
            if (
                response.success
                and record.kind == "distribute"
                and self.config.on_distribution_confirmed
            ):
                self.config.on_distribution_confirmed(response, requirements)
            self.pending_store.complete(record.key, response)
            return response
        except Exception as error:
            return _failure(
                record.network, "settlement_pending", record.payer, record.signature, str(error)
            )

    def _confirmed_response(
        self, record: PendingSettlement, requirements: PaymentRequirements
    ) -> SettleResponse:
        try:
            channels = [
                self.read_channel(record.network, channel_id) for channel_id in record.channel_ids
            ]
            configs = record.metadata.get("configs", [])
            for channel, config in zip(channels, configs, strict=False):
                if channel:
                    self.assert_channel(channel, config, requirements, tuple(ChannelStatus))
        except BatchError as error:
            if record.kind != "deposit":
                raise
            return _failure(
                record.network, error.reason, record.payer, record.signature, str(error)
            )
        response = SettleResponse(
            success=True,
            network=record.network,
            transaction=record.signature,
            payer=record.payer,
            amount="",
        )
        if record.kind == "deposit":
            channel = channels[0]
            if (
                channel is None
                or channel.status != ChannelStatus.OPEN
                or channel.deposit < record.metadata["expected_deposit"]
            ):
                return _failure(
                    record.network,
                    BatchError.CHANNEL_CLOSING
                    if channel and channel.status == ChannelStatus.CLOSING
                    else BatchError.CHANNEL_STATE,
                    record.payer,
                    record.signature,
                    "confirmed deposit no longer satisfies the required open-channel state",
                )
            response.amount = record.metadata["deposit_amount"]
            response.extra = {"channelState": _snapshot(record.channel_ids[0], channel)}
        elif record.kind == "claim":
            if any(
                channel is None or channel.settled < target
                for channel, target in zip(channels, record.metadata["targets"], strict=True)
            ):
                raise RuntimeError("confirmed claim watermark is not visible yet")
            response.extra = {
                "accepts": [
                    {"channelId": channel_id, "totalClaimed": str(target)}
                    for channel_id, target in zip(
                        record.channel_ids, record.metadata["targets"], strict=True
                    )
                ]
            }
        elif record.kind == "request_close":
            channel = channels[0]
            if channel and channel.status == ChannelStatus.OPEN:
                raise RuntimeError("confirmed closing state is not visible yet")
            response.extra = (
                {"channelState": _snapshot(record.channel_ids[0], channel)}
                if channel
                else {"channelId": record.channel_ids[0]}
            )
        elif record.kind in ("seal", "refund"):
            if any(channel and channel.status != ChannelStatus.DISTRIBUTED for channel in channels):
                raise RuntimeError("confirmed close state is not visible yet")
            before, target = record.metadata["before"][0], record.metadata["targets"][0]
            response.amount = str(
                before["deposit"] - target
                if record.kind == "refund"
                else target - before["payout_watermark"]
            )
            response.extra = {
                "channelState": {
                    "channelId": record.channel_ids[0],
                    "balance": str(before["deposit"]),
                    "totalClaimed": str(target),
                    "withdrawRequestedAt": 0,
                }
            }
        elif record.kind == "distribute":
            for channel, target in zip(channels, record.metadata["targets"], strict=True):
                if (
                    channel
                    and channel.status != ChannelStatus.DISTRIBUTED
                    and channel.payout_watermark < target
                ):
                    raise RuntimeError("confirmed distribution watermark is not visible yet")
            try:
                response.amount = str(self._payout_amount(record, requirements))
            except BatchError as error:
                if error.reason == BatchError.PAYOUT_ATTRIBUTION_AMBIGUOUS:
                    return _failure(record.network, error.reason, record.payer, record.signature)
                raise
            response.extra = {"channels": list(record.channel_ids)}
        elif record.kind == "maintenance":
            target = record.metadata["expected_status"]
            if any(
                channel is not None
                and (target == "reclaimed" or channel.status != ChannelStatus.DISTRIBUTED)
                for channel in channels
            ):
                raise RuntimeError("confirmed maintenance state is not visible yet")
        else:
            raise ValueError("unknown durable settlement kind")
        return response

    def _payout_amount(self, record: PendingSettlement, requirements: PaymentRequirements) -> int:
        evidence = self.signer.get_transaction(record.signature, record.network)
        if not evidence or not evidence.get("meta"):
            raise RuntimeError("confirmed payout metadata is not visible yet")
        meta = evidence["meta"]
        if meta.get("err") is not None:
            raise RuntimeError("payout transaction failed onchain")
        before, after = meta.get("preTokenBalances"), meta.get("postTokenBalances")
        if before is None or after is None:
            raise RuntimeError("payout token balance evidence is unavailable")
        keys = [
            key if isinstance(key, str) else key["pubkey"]
            for key in evidence["transaction"]["message"]["accountKeys"]
        ]
        recipient = find_ata(
            requirements.pay_to, requirements.asset, requirements.extra["tokenProgram"]
        )
        index = keys.index(recipient)
        if not any(item["accountIndex"] == index for item in after):
            raise RuntimeError("recipient post-transaction balance is unavailable")
        for channel_id, config in zip(record.channel_ids, record.metadata["configs"], strict=True):
            escrow = find_ata(channel_id, requirements.asset, requirements.extra["tokenProgram"])
            escrow_index = keys.index(escrow)
            closed = not any(item["accountIndex"] == escrow_index for item in after)
            if closed and requirements.pay_to in (
                config["payer"],
                get_payment_channels_treasury_owner(record.network),
            ):
                raise BatchError(BatchError.PAYOUT_ATTRIBUTION_AMBIGUOUS)

        def balance(items: list[dict[str, Any]]) -> int:
            entries = [item for item in items if item["accountIndex"] == index]
            if not entries:
                return 0
            if (
                len(entries) != 1
                or entries[0]["mint"] != requirements.asset
                or entries[0].get("owner") != requirements.pay_to
            ):
                raise RuntimeError("recipient payout metadata does not match")
            return atomic(entries[0]["uiTokenAmount"]["amount"])

        amount = balance(after) - balance(before)
        if amount < 0:
            raise RuntimeError("negative recipient payout")
        return amount
