"""Synchronous SVM batch client with durable pending-payment accounting."""

from __future__ import annotations

import json
import time
from copy import deepcopy
from dataclasses import replace
from threading import RLock
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

from solana.rpc.api import Client as SolanaClient
from solana.rpc.types import MemcmpOpts
from solders.pubkey import Pubkey

from ....interfaces import PaymentPayloadContext
from ....schemas import (
    PaymentCreationFailureContext,
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    PaymentResponseContext,
    RecoveredPayloadResult,
    RecoveredResponseResult,
    SettleResponse,
)
from ..constants import TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS
from ..default_assets import find_default_asset
from ..mint_cache import get_cached_mint_metadata
from ..payment_channels import (
    PAYMENT_CHANNELS_PROGRAM_ID,
    ChannelSplit,
    ChannelStatus,
    build_open_transaction,
    build_request_close_transaction,
    build_top_up_transaction,
    decode_channel_account,
    find_payment_channel_pda,
    sign_voucher,
    verify_voucher,
)
from ..utils import get_network_config, normalize_network, resolve_blockhash
from .authorization import sign_batch_authorization
from .client_types import (
    BatchSvmClientConfig,
    InMemoryBatchClientChannelStorage,
    OpenChannel,
    PendingChannel,
)
from .constants import BATCH_SETTLEMENT_SCHEME, MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY
from .trust import ResolvedServerSignedTrust, ServerSignedTrustPolicy, UntrustedOperatorError


def _u64(value: Any, label: str) -> int:
    if type(value) is int:
        amount = value
    elif isinstance(value, str) and value.isascii() and value.isdigit():
        amount = int(value)
    else:
        raise ValueError(f"{label} must be a decimal u64")
    if not 0 <= amount < 2**64:
        raise ValueError(f"{label} must fit in a u64")
    return amount


def sign_batch_voucher(signer: Any, channel_id: str, cumulative: int) -> dict[str, Any]:
    return {
        "channelId": channel_id,
        "maxClaimableAmount": str(cumulative),
        "expiresAt": 0,
        "signature": sign_voucher(signer, channel_id, cumulative, 0),
    }


def align_refund_requirements(
    requirements: PaymentRequirements, channel_config: dict[str, Any]
) -> PaymentRequirements:
    """Bind a refund probe to the mode in which its channel was opened."""
    extra = dict(requirements.extra or {})
    extra["voucherSigner"] = channel_config.get("voucherSigner", "client")
    if extra["voucherSigner"] == "server":
        extra["operator"] = channel_config["payerAuthorizer"]
    else:
        extra.pop("operator", None)
    return requirements.model_copy(update={"extra": extra})


class NoBatchChannelToRefundError(ValueError):
    def __init__(self) -> None:
        super().__init__("no batch-settlement channel to refund")


class BatchSvmScheme:
    """One in-flight allocation per channel; confirmation advances its watermark.

    Storage must persist entire records atomically. Multiple processes sharing a
    wallet and storage must serialize channel operations externally.
    """

    scheme = BATCH_SETTLEMENT_SCHEME
    find_default_asset = staticmethod(find_default_asset)

    def __init__(self, signer: Any, config: BatchSvmClientConfig | None = None):
        self._signer = signer
        self.config = config or BatchSvmClientConfig()
        self._payer = str(signer.address) if hasattr(signer, "address") else str(signer.pubkey())
        Pubkey.from_string(self._payer)
        self._salt = _u64(self.config.salt, "salt")
        self._multiplier = (
            self.config.deposit_policy.deposit_multiplier if self.config.deposit_policy else 5
        )
        if type(self._multiplier) is not int or self._multiplier < 3:
            raise ValueError("deposit_multiplier must be an integer >= 3")
        if self.config.deposit_amount is not None:
            _u64(self.config.deposit_amount, "deposit_amount")
        self._trust = ServerSignedTrustPolicy(self.config.server_signed_channels_policy)
        self._storage = self.config.channel_storage or InMemoryBatchClientChannelStorage()
        self._channels: dict[str, OpenChannel] = {}
        self._pending: dict[str, PendingChannel] = {}
        self._clients: dict[str, SolanaClient] = {}
        self._mint_cache: dict = {}
        self._lock = RLock()
        self._creation_contexts: dict[int, PaymentPayloadContext] = {}
        self.scheme_hooks = SimpleNamespace(
            on_payment_response=self.on_payment_response,
            on_payment_creation_failure=self._fallback,
        )

    def _get_client(self, network: str) -> SolanaClient:
        network = normalize_network(network)
        if network not in self._clients:
            self._clients[network] = SolanaClient(
                self.config.rpc_url or get_network_config(network)["rpc_url"]
            )
        return self._clients[network]

    def payment_policy(
        self, _x402_version: int, accepts: list[PaymentRequirements]
    ) -> list[PaymentRequirements]:
        return self._trust.filter_accepts(accepts)

    def _terms(
        self, requirements: PaymentRequirements, *, refund: bool = False
    ) -> tuple[dict[str, Any], ResolvedServerSignedTrust | None]:
        if requirements.scheme != self.scheme:
            raise ValueError("requirements must use batch-settlement")
        extra = requirements.extra or {}
        if extra.get("paymentFlow", "authorization") != "authorization":
            raise ValueError('extra.paymentFlow must be "authorization"')
        delay = extra.get("withdrawDelay")
        if (
            type(delay) is not int
            or not MIN_WITHDRAW_DELAY <= delay <= MAX_WITHDRAW_DELAY
            or delay < requirements.max_timeout_seconds
        ):
            raise ValueError("extra.withdrawDelay is outside the allowed range")
        for name in ("feePayer", "receiverAuthorizer"):
            if not isinstance(extra.get(name), str):
                raise ValueError(f"extra.{name} is required")
            Pubkey.from_string(extra[name])
        Pubkey.from_string(requirements.pay_to)
        Pubkey.from_string(requirements.asset)
        mode = extra.get("voucherSigner", "client")
        if mode not in ("client", "server"):
            raise ValueError('extra.voucherSigner must be "client" or "server"')
        operator = extra.get("operator")
        if mode == "server":
            if not isinstance(operator, str):
                raise ValueError("extra.operator is required for server voucher signing")
            Pubkey.from_string(operator)
        elif "operator" in extra:
            raise ValueError("extra.operator is only valid for server voucher signing")
        if extra["feePayer"] in (self._payer, operator):
            raise ValueError("feePayer must differ from payer and payerAuthorizer")
        trust = self._trust.grant_for(requirements) if mode == "server" and not refund else None
        token_program = extra.get("tokenProgram")
        if token_program not in (TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS):
            raise ValueError("extra.tokenProgram is not a supported SPL token program")
        metadata = get_cached_mint_metadata(
            self._get_client(str(requirements.network)),
            str(requirements.network),
            Pubkey.from_string(requirements.asset),
            self._mint_cache,
        )
        if str(metadata.token_program) != token_program:
            raise ValueError("extra.tokenProgram does not own requirements.asset")
        if "memo" in extra and not isinstance(extra["memo"], str):
            raise ValueError("extra.memo must be a string")
        return dict(extra, voucherSigner=mode), trust

    def _key(self, requirements: PaymentRequirements, terms: dict[str, Any]) -> str:
        return json.dumps(
            [
                str(requirements.network),
                requirements.asset,
                requirements.pay_to,
                terms["feePayer"],
                terms["withdrawDelay"],
                terms["receiverAuthorizer"],
                terms["voucherSigner"],
                terms.get("operator", ""),
                self._payer,
                str(self._salt),
            ],
            separators=(",", ":"),
        )

    def _deposit_amount(
        self,
        requirements: PaymentRequirements,
        needed: int,
        existing: int,
        context: PaymentPayloadContext | None,
        trust: ResolvedServerSignedTrust | None,
    ) -> int:
        charge = _u64(requirements.amount, "amount")
        hint = (requirements.extra or {}).get("minDeposit")
        announced = None
        if isinstance(hint, str) and hint.isascii() and hint.isdigit():
            value = int(hint)
            if charge <= value < 2**64:
                announced = value
        target = (
            _u64(self.config.deposit_amount, "deposit_amount")
            if self.config.deposit_amount is not None
            else announced
            if announced is not None
            else charge * self._multiplier
        )
        if not existing and self.config.deposit_amount is not None and target < charge:
            raise ValueError("deposit_amount must cover the current request")
        proposed = max(target, needed)
        if context is not None and context.max_amount_per_payment is not None:
            cap = _u64(context.max_amount_per_payment, "max_amount_per_payment") * self._multiplier
            if needed > cap:
                raise ValueError("required deposit exceeds deposit_multiplier × spend cap")
            proposed = min(proposed, cap)
        if trust is not None and trust.max_deposit is not None:
            room = trust.max_deposit - existing
            if needed > room:
                raise ValueError("required deposit exceeds remaining server signer max_deposit")
            proposed = min(proposed, room)
        _u64(existing + proposed, "total deposit")
        return _u64(proposed, "deposit")

    def _credential(self, channel: OpenChannel, charge: int, timeout: int) -> dict[str, Any]:
        if channel.channel_config.get("voucherSigner") == "server":
            return {
                "authorization": sign_batch_authorization(
                    self._signer,
                    channel.channel_id,
                    channel.channel_config["payerAuthorizer"],
                    str(uuid4()),
                    charge,
                    int(time.time()) + max(1, timeout),
                )
            }
        return {
            "voucher": sign_batch_voucher(
                self._signer, channel.channel_id, channel.cumulative + charge
            )
        }

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any] | None = None,
        context: PaymentPayloadContext | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if context is not None:
                self._creation_contexts[id(requirements)] = context
                # Retain only contexts needed by a synchronous creation-failure hook.
                if len(self._creation_contexts) > 64:
                    self._creation_contexts.pop(next(iter(self._creation_contexts)))
            terms, trust = self._terms(requirements)
            charge = _u64(requirements.amount, "amount")
            if charge == 0:
                raise ValueError("batch-settlement amount must be positive")
            key = self._key(requirements, terms)
            existing = self._load(key)
            pending = self._pending.get(key)
            if pending is not None:
                if pending.amount != charge:
                    raise ValueError("channel has a pending allocation for a different amount")
                if terms["voucherSigner"] == "server":
                    raise ValueError("server-signed channel has a pending request")
                return deepcopy(pending.payload)
            if existing is None:
                existing = self._discover(requirements, terms)
                if existing is not None:
                    self._save_confirmed(key, existing)
            credential_channel = existing
            payload: dict[str, Any]
            if existing is None:
                deposit = self._deposit_amount(requirements, charge, 0, context, trust)
                rpc = self._get_client(str(requirements.network))
                blockhash = resolve_blockhash(rpc, terms.get("recentBlockhash"))
                try:
                    slot = _u64(terms.get("recentSlot"), "recentSlot")
                    if slot > 2**53 - 1:
                        raise ValueError("recentSlot exceeds the wire safe-integer range")
                except ValueError:
                    slot = _u64(rpc.get_slot(commitment="finalized").value, "openSlot")
                authorizer = terms.get("operator", self._payer)
                channel_id = find_payment_channel_pda(
                    payer=self._payer,
                    payee=terms["feePayer"],
                    mint=requirements.asset,
                    authorized_signer=authorizer,
                    salt=self._salt,
                    open_slot=slot,
                )
                config = {
                    "payer": self._payer,
                    "payerAuthorizer": authorizer,
                    "receiver": requirements.pay_to,
                    "receiverAuthorizer": terms["receiverAuthorizer"],
                    "token": requirements.asset,
                    "withdrawDelay": terms["withdrawDelay"],
                    "salt": str(self._salt),
                    "openSlot": slot,
                }
                if terms["voucherSigner"] == "server":
                    config["voucherSigner"] = "server"
                credential_channel = OpenChannel(channel_id, config, deposit)
                transaction = build_open_transaction(
                    payer=self._signer,
                    fee_payer=terms["feePayer"],
                    payee=terms["feePayer"],
                    mint=requirements.asset,
                    authorized_signer=authorizer,
                    token_program=terms["tokenProgram"],
                    deposit=deposit,
                    salt=self._salt,
                    open_slot=slot,
                    grace_period=terms["withdrawDelay"],
                    blockhash=str(blockhash),
                    recipients=[ChannelSplit(requirements.pay_to, 10_000)],
                    memo=terms.get("memo"),
                    binding_memo="x402:batch-settlement:svm:rcvauth:v1:"
                    + terms["receiverAuthorizer"],
                )
                payload = {
                    "type": "deposit",
                    "deposit": {"amount": str(deposit), "transaction": transaction},
                }
            elif existing.cumulative + charge > existing.deposit:
                amount = self._deposit_amount(
                    requirements,
                    existing.cumulative + charge - existing.deposit,
                    existing.deposit,
                    context,
                    trust,
                )
                transaction = build_top_up_transaction(
                    payer=self._signer,
                    channel_id=existing.channel_id,
                    mint=requirements.asset,
                    token_program=terms["tokenProgram"],
                    fee_payer=terms["feePayer"],
                    amount=amount,
                    blockhash=str(
                        resolve_blockhash(
                            self._get_client(str(requirements.network)),
                            terms.get("recentBlockhash"),
                        )
                    ),
                    memo=terms.get("memo"),
                )
                credential_channel = replace(existing, deposit=existing.deposit + amount)
                payload = {
                    "type": "deposit",
                    "deposit": {"amount": str(amount), "transaction": transaction},
                }
            else:
                payload = {
                    "type": "authorization" if terms["voucherSigner"] == "server" else "voucher"
                }
            assert credential_channel is not None
            payload["channelConfig"] = deepcopy(credential_channel.channel_config)
            payload.update(
                self._credential(credential_channel, charge, requirements.max_timeout_seconds)
            )
            pending = PendingChannel(credential_channel, existing, charge, payload)
            self._persist_pending(key, pending)
            self._pending[key] = pending
            return deepcopy(payload)

    def _record(self, channel: OpenChannel) -> dict[str, Any]:
        return {
            "channelId": channel.channel_id,
            "channelConfig": channel.channel_config,
            "deposit": str(channel.deposit),
            "chargedCumulativeAmount": str(channel.cumulative),
        }

    def _hydrate(self, record: dict[str, Any]) -> OpenChannel:
        config = deepcopy(record["channelConfig"])
        if config["payer"] != self._payer:
            raise ValueError("stored channel belongs to another payer")
        deposit = _u64(record["deposit"], "stored deposit")
        cumulative = _u64(record["chargedCumulativeAmount"], "stored cumulative")
        if cumulative > deposit:
            raise ValueError("stored cumulative exceeds deposit")
        return OpenChannel(record["channelId"], config, deposit, cumulative)

    def _load(self, key: str) -> OpenChannel | None:
        if key in self._pending or key in self._channels:
            return self._channels.get(key)
        record = self._storage.get(key)
        if record is None:
            return None
        channel = self._hydrate(record)
        saved = record.get("pending")
        if saved:
            confirmed = channel if record.get("hasConfirmedState") else None
            pending_channel = replace(channel, deposit=_u64(saved["deposit"], "pending deposit"))
            self._pending[key] = PendingChannel(
                pending_channel,
                confirmed,
                _u64(saved["amount"], "pending amount"),
                saved["payload"],
            )
            if confirmed:
                self._channels[key] = confirmed
            return confirmed
        self._channels[key] = channel
        return channel

    def _persist_pending(self, key: str, pending: PendingChannel) -> None:
        record = self._record(pending.confirmed or pending.channel)
        record.update(
            hasConfirmedState=pending.confirmed is not None,
            pending={
                "deposit": str(pending.channel.deposit),
                "amount": str(pending.amount),
                "payload": pending.payload,
            },
        )
        self._storage.set(key, record)

    def _save_confirmed(self, key: str, channel: OpenChannel) -> None:
        self._storage.set(key, self._record(channel))
        self._channels[key] = channel
        self._pending.pop(key, None)

    def _restore(self, key: str, pending: PendingChannel) -> None:
        if pending.confirmed is None:
            self._storage.delete(key)
            self._channels.pop(key, None)
            self._pending.pop(key, None)
        else:
            self._save_confirmed(key, pending.confirmed)

    def _fallback(self, context: PaymentCreationFailureContext) -> RecoveredPayloadResult | None:
        if not isinstance(context.error, UntrustedOperatorError):
            return None
        refused = context.selected_requirements
        cap_context = self._creation_contexts.pop(id(refused), None)
        for accept in context.payment_required.accepts:
            if (
                accept.scheme == self.scheme
                and accept.network == refused.network
                and accept.asset == refused.asset
                and (accept.extra or {}).get("voucherSigner", "client") == "client"
                and _u64(accept.amount, "amount") <= _u64(refused.amount, "amount")
            ):
                inner = self.create_payment_payload(accept, context=cap_context)
                return RecoveredPayloadResult(
                    PaymentPayload(
                        x402_version=context.payment_required.x402_version,
                        accepted=accept,
                        payload=inner,
                        resource=context.payment_required.resource,
                        extensions=context.payment_required.extensions,
                    )
                )
        return None

    def on_payment_response(
        self, context: PaymentResponseContext
    ) -> RecoveredResponseResult | None:
        with self._lock:
            payload = context.payment_payload.payload
            if payload.get("type") not in ("deposit", "voucher", "authorization", "refund"):
                return None
            terms, _ = self._terms(context.requirements, refund=True)
            key = self._key(context.requirements, terms)
            existing = self._load(key)
            if payload["type"] == "refund":
                if (
                    context.settle_response is not None
                    and context.settle_response.success
                    and existing is not None
                    and existing.channel_config == payload.get("channelConfig")
                ):
                    self._storage.delete(key)
                    self._channels.pop(key, None)
                return None
            pending = self._pending.get(key)
            # Old or unrelated responses cannot consume the current allocation.
            if pending is None or payload != pending.payload:
                return None
            response = context.settle_response
            if response is None and context.payment_required is None:
                return None  # An interrupted transport has an unknown payment outcome.
            if response is not None and response.error_reason == "settlement_pending":
                return None
            if response is None or not response.success:
                recovered = self._corrective(
                    pending, context.payment_required, context.requirements
                )
                if recovered is not None:
                    self._save_confirmed(key, recovered)
                    return RecoveredResponseResult()
                self._restore(key, pending)
                return None
            try:
                extra = response.extra or {}
                prior = pending.confirmed.cumulative if pending.confirmed else 0
                if pending.channel.channel_config.get("voucherSigner") == "server":
                    voucher = extra.get("voucher")
                    cumulative = self._verified_voucher(voucher, pending.channel)
                    if cumulative is None:
                        raise ValueError("PAYMENT-RESPONSE has an invalid server voucher")
                    if not prior <= cumulative <= prior + pending.amount:
                        raise ValueError(
                            "PAYMENT-RESPONSE server charge exceeds the authorized ceiling"
                        )
                else:
                    if extra.get("chargedAmount") != str(pending.amount):
                        raise ValueError("PAYMENT-RESPONSE charged an unexpected amount")
                    cumulative = prior + pending.amount
                state = extra.get("channelState", {})
                if (
                    not isinstance(extra.get("commitmentId"), str)
                    or not extra["commitmentId"]
                    or not isinstance(state, dict)
                    or (
                        "chargedCumulativeAmount" in state
                        and state["chargedCumulativeAmount"] != str(cumulative)
                    )
                    or cumulative > pending.channel.deposit
                ):
                    raise ValueError("PAYMENT-RESPONSE contains inconsistent channel accounting")
            except ValueError:
                # Funding may have landed without a trustworthy charge receipt.
                # Retain its exact transaction; only offchain allocations roll back.
                if pending.payload["type"] != "deposit":
                    self._restore(key, pending)
                raise
            self._save_confirmed(key, replace(pending.channel, cumulative=cumulative))
            return None

    def _verified_voucher(self, voucher: Any, channel: OpenChannel) -> int | None:
        try:
            amount = _u64(voucher["maxClaimableAmount"], "voucher amount")
            if (
                voucher["channelId"] != channel.channel_id
                or type(voucher["expiresAt"]) is not int
                or voucher["expiresAt"] != 0
            ):
                return None
            if verify_voucher(
                voucher["signature"],
                channel.channel_config["payerAuthorizer"],
                channel.channel_id,
                amount,
                0,
            ):
                return amount
        except (TypeError, ValueError, KeyError):
            pass
        return None

    def _corrective(
        self,
        pending: PendingChannel,
        required: PaymentRequired | None,
        requirements: PaymentRequirements,
    ) -> OpenChannel | None:
        if (
            required is None
            or required.error != "invalid_batch_settlement_svm_cumulative_amount_mismatch"
        ):
            return None
        channel = pending.channel
        for accept in required.accepts:
            state = (accept.extra or {}).get("channelState")
            if (
                accept.scheme != self.scheme
                or accept.network != requirements.network
                or accept.asset != requirements.asset
                or accept.pay_to != requirements.pay_to
                or not isinstance(state, dict)
                or state.get("channelId") != channel.channel_id
            ):
                continue
            try:
                charged = _u64(state["chargedCumulativeAmount"], "charged cumulative")
                claimed = _u64(state["totalClaimed"], "claimed")
                deposit = _u64(state["balance"], "balance")
                prior = pending.confirmed.cumulative if pending.confirmed else 0
                if not prior <= charged <= deposit <= channel.deposit or charged < claimed:
                    return None
                if (
                    channel.channel_config.get("voucherSigner") == "server"
                    and charged > prior + pending.amount
                ):
                    return None
                proof = (accept.extra or {}).get("voucherState")
                if proof is not None:
                    signed = _u64(proof["signedMaxClaimable"], "signed cumulative")
                    if (
                        charged > signed
                        or self._verified_voucher(
                            {
                                "channelId": channel.channel_id,
                                "maxClaimableAmount": str(signed),
                                "expiresAt": proof["expiresAt"],
                                "signature": proof["signature"],
                            },
                            channel,
                        )
                        is None
                    ):
                        return None
                else:
                    if charged != claimed:
                        return None
                    # An unsigned snapshot is not evidence of the chain watermark.
                    onchain = self._read_channel(requirements, channel.channel_id)
                    if onchain is None or charged != onchain.settled or deposit != onchain.deposit:
                        return None
                return replace(channel, cumulative=charged, deposit=deposit)
            except (ValueError, KeyError, TypeError):
                return None
        return None

    def _read_channel(self, requirements: PaymentRequirements, channel_id: str) -> Any:
        account = (
            self._get_client(str(requirements.network))
            .get_account_info(Pubkey.from_string(channel_id), commitment="confirmed")
            .value
        )
        if account is None or str(account.owner) != PAYMENT_CHANNELS_PROGRAM_ID:
            return None
        channel = decode_channel_account(bytes(account.data))
        derived = find_payment_channel_pda(
            payer=channel.payer,
            payee=channel.payee,
            mint=channel.mint,
            authorized_signer=channel.authorized_signer,
            salt=channel.salt,
            open_slot=channel.open_slot,
        )
        return channel if derived == channel_id else None

    def _discover(
        self, requirements: PaymentRequirements, terms: dict[str, Any]
    ) -> OpenChannel | None:
        if not self.config.discover_channels:
            return None
        rpc = self._get_client(str(requirements.network))
        try:
            rows = rpc.get_program_accounts(
                Pubkey.from_string(PAYMENT_CHANNELS_PROGRAM_ID),
                commitment="confirmed",
                encoding="base64",
                filters=[256, MemcmpOpts(offset=88, bytes=self._payer)],
            ).value
        except Exception:
            return None
        candidates = []
        for row in rows:
            try:
                if str(row.account.owner) != PAYMENT_CHANNELS_PROGRAM_ID:
                    continue
                ch = decode_channel_account(bytes(row.account.data))
                if (
                    ch.status != ChannelStatus.OPEN
                    or ch.closure_started_at != 0
                    or ch.payer != self._payer
                    or ch.payee != terms["feePayer"]
                    or ch.rent_payer != terms["feePayer"]
                    or ch.mint != requirements.asset
                    or ch.authorized_signer != terms.get("operator", self._payer)
                    or ch.grace_period != terms["withdrawDelay"]
                    or ch.salt != self._salt
                ):
                    continue
                channel_id = find_payment_channel_pda(
                    payer=ch.payer,
                    payee=ch.payee,
                    mint=ch.mint,
                    authorized_signer=ch.authorized_signer,
                    salt=ch.salt,
                    open_slot=ch.open_slot,
                )
                if str(row.pubkey) != channel_id:
                    continue
                # The distribution binds the intended receiver independently of the PDA.
                from ..payment_channels import distribution_hash

                if ch.distribution_hash != distribution_hash(
                    [ChannelSplit(requirements.pay_to, 10_000)]
                ):
                    continue
                config = {
                    "payer": ch.payer,
                    "payerAuthorizer": ch.authorized_signer,
                    "receiver": requirements.pay_to,
                    "receiverAuthorizer": terms["receiverAuthorizer"],
                    "token": ch.mint,
                    "withdrawDelay": ch.grace_period,
                    "salt": str(ch.salt),
                    "openSlot": ch.open_slot,
                }
                if terms["voucherSigner"] == "server":
                    config["voucherSigner"] = "server"
                candidates.append(OpenChannel(channel_id, config, ch.deposit, ch.settled))
            except (ValueError, TypeError, AttributeError):
                continue
        return max(candidates, key=lambda ch: ch.channel_config["openSlot"], default=None)

    def create_refund_payload(
        self, requirements: PaymentRequirements, *, with_transaction: bool = False
    ) -> dict[str, Any]:
        with self._lock:
            terms, _ = self._terms(requirements, refund=True)
            key = self._key(requirements, terms)
            channel = self._load(key)
            if channel is None and terms["voucherSigner"] == "server":
                alternate = align_refund_requirements(requirements, {})
                alternate_terms, _ = self._terms(alternate, refund=True)
                alternate_key = self._key(alternate, alternate_terms)
                alternate_channel = self._load(alternate_key)
                if alternate_channel is None and alternate_key not in self._pending:
                    alternate_channel = self._discover(alternate, alternate_terms)
                if alternate_channel is not None:
                    channel, requirements, terms, key = (
                        alternate_channel,
                        alternate,
                        alternate_terms,
                        alternate_key,
                    )
            if channel is None:
                route = json.loads(key)
                for cached_key, cached in self._channels.items():
                    candidate = json.loads(cached_key)
                    if candidate[:6] == route[:6] and candidate[8:] == route[8:]:
                        channel = cached
                        requirements = align_refund_requirements(
                            requirements, cached.channel_config
                        )
                        terms, _ = self._terms(requirements, refund=True)
                        key = cached_key
                        break
            if key in self._pending:
                raise ValueError("resolve the channel's pending payment before refunding")
            if channel is None:
                channel = self._discover(requirements, terms)
            if channel is None:
                raise NoBatchChannelToRefundError()
            payload = {
                "type": "refund",
                "channelConfig": deepcopy(channel.channel_config),
                **self._credential(channel, 0, requirements.max_timeout_seconds),
            }
            if with_transaction:
                payload["transaction"] = build_request_close_transaction(
                    payer=self._signer,
                    channel_id=channel.channel_id,
                    fee_payer=terms["feePayer"],
                    blockhash=str(
                        resolve_blockhash(
                            self._get_client(str(requirements.network)),
                            terms.get("recentBlockhash"),
                        )
                    ),
                    memo=terms.get("memo"),
                )
            return payload

    def refund(
        self, url: str, *, requirements: PaymentRequirements | None = None, fetch: Any = None
    ) -> SettleResponse:
        """GET a protected route and close its channel; fetch(url, headers) is injectable."""
        from ....http.utils import (
            decode_payment_required_header,
            decode_payment_response_header,
            encode_payment_signature_header,
        )

        if fetch is None:
            import httpx

            def fetch(url: str, headers: dict[str, str]) -> Any:
                return httpx.get(url, headers=headers)

        def header(response: Any, name: str) -> str | None:
            return next((v for k, v in response.headers.items() if k.lower() == name.lower()), None)

        version, resource = 2, None
        accepts = [requirements] if requirements is not None else []
        if requirements is None:
            probe = fetch(url, {})
            raw = header(probe, "PAYMENT-REQUIRED")
            if getattr(probe, "status_code", getattr(probe, "status", None)) != 402 or not raw:
                raise ValueError("refund probe requires a 402 with PAYMENT-REQUIRED")
            required = decode_payment_required_header(raw)
            version, resource = required.x402_version, required.resource
            accepts = [
                a
                for a in required.accepts
                if a.scheme == self.scheme and str(a.network).startswith("solana:")
            ]
        selected, payload = None, None
        for accept in accepts:
            try:
                payload = self.create_refund_payload(accept)
                selected = accept
                break
            except NoBatchChannelToRefundError:
                continue
        if selected is None or payload is None:
            raise NoBatchChannelToRefundError()
        selected = align_refund_requirements(selected, payload["channelConfig"])
        selected = next(
            (
                accept
                for accept in accepts
                if (
                    accept.network == selected.network
                    and accept.asset == selected.asset
                    and accept.pay_to == selected.pay_to
                    and (accept.extra or {}).get("voucherSigner", "client")
                    == selected.extra["voucherSigner"]
                    and (accept.extra or {}).get("operator") == selected.extra.get("operator")
                )
            ),
            selected,
        )
        for with_transaction in (False, True):
            if with_transaction:
                payload = self.create_refund_payload(selected, with_transaction=True)
            payment = PaymentPayload(
                x402_version=version, accepted=selected, payload=payload, resource=resource
            )
            response = fetch(url, {"PAYMENT-SIGNATURE": encode_payment_signature_header(payment)})
            raw = header(response, "PAYMENT-RESPONSE")
            settled = decode_payment_response_header(raw) if raw else None
            corrective = header(response, "PAYMENT-REQUIRED")
            reason = (
                settled.error_reason
                if settled
                else decode_payment_required_header(corrective).error
                if corrective
                else None
            )
            if (
                not with_transaction
                and reason == "invalid_batch_settlement_svm_receiver_binding_unavailable"
            ):
                continue
            if settled is None:
                raise ValueError(f"refund refused: {reason or 'missing PAYMENT-RESPONSE'}")
            if settled.success:
                with self._lock:
                    terms, _ = self._terms(selected, refund=True)
                    key = self._key(selected, terms)
                    self._storage.delete(key)
                    self._channels.pop(key, None)
            return settled
        raise RuntimeError("refund did not complete")
