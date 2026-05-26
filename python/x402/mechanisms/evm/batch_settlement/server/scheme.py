"""Server-side `BatchSettlementEvmScheme` for EVM batch settlement."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....interfaces import SchemePaymentRequiredContext
from .....schemas import (
    AssetAmount,
    Network,
    PaymentPayload,
    PaymentRequirements,
    Price,
    SettleResultContext,
    SupportedKind,
)
from .....schemas.hooks import (
    AbortResult,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    SettleContext,
    SettleFailureContext,
    SkipHandlerResult,
    SkipSettleResult,
    SkipVerifyResult,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyFailureContext,
    VerifyResultContext,
)
from ...utils import get_asset_info, get_network_config, parse_amount, parse_money_to_decimal
from ..constants import MIN_WITHDRAW_DELAY, SCHEME_BATCH_SETTLEMENT
from ..types import AuthorizerSigner
from .storage import Channel, ChannelStorage, InMemoryChannelStorage

MoneyParser = Callable[[float, str], AssetAmount | None]

_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


@dataclass
class BatchSettlementEvmSchemeServerConfig:
    storage: ChannelStorage | None = None
    receiver_authorizer_signer: AuthorizerSigner | None = None
    withdraw_delay: int | None = None
    onchain_state_ttl_ms: int | None = None


@dataclass
class BatchSettlementRequestContext:
    channel_id: str | None = None
    pending_id: str | None = None
    channel_snapshot: Channel | None = None
    local_verify: bool = False


def _default_onchain_state_ttl_ms(withdraw_delay_seconds: int) -> int:
    ms = max(0, withdraw_delay_seconds) * 1000
    return min(5 * 60 * 1000, max(30 * 1000, ms // 3))


class BatchSettlementEvmScheme:
    """Server-side `batch-settlement` scheme for EVM networks.

    Implements both `SchemeNetworkServer` (price parsing + requirements
    enhancement) and the scheme-side `before_verify` / `after_verify` /
    `before_settle` / `after_settle` / `on_*_failure` lifecycle hooks the
    Python framework dispatches via attribute lookup.
    """

    scheme = SCHEME_BATCH_SETTLEMENT

    def __init__(
        self,
        receiver_address: str,
        config: BatchSettlementEvmSchemeServerConfig | None = None,
    ):
        self._receiver_address = to_checksum_address(receiver_address)
        cfg = config or BatchSettlementEvmSchemeServerConfig()
        self._storage: ChannelStorage = cfg.storage or InMemoryChannelStorage()
        self._receiver_authorizer_signer = cfg.receiver_authorizer_signer
        self._withdraw_delay = (
            cfg.withdraw_delay if cfg.withdraw_delay is not None else MIN_WITHDRAW_DELAY
        )
        self._onchain_state_ttl_ms = (
            cfg.onchain_state_ttl_ms
            if cfg.onchain_state_ttl_ms is not None
            else _default_onchain_state_ttl_ms(self._withdraw_delay)
        )
        self._money_parsers: list[MoneyParser] = []

        self._request_lock = threading.Lock()
        self._request_contexts: dict[int, BatchSettlementRequestContext] = {}

    def get_storage(self) -> ChannelStorage:
        return self._storage

    def get_receiver_address(self) -> str:
        return self._receiver_address

    def get_withdraw_delay(self) -> int:
        return self._withdraw_delay

    def get_onchain_state_ttl_ms(self) -> int:
        return self._onchain_state_ttl_ms

    def get_receiver_authorizer_signer(self) -> AuthorizerSigner | None:
        return self._receiver_authorizer_signer

    def register_money_parser(self, parser: MoneyParser) -> BatchSettlementEvmScheme:
        self._money_parsers.append(parser)
        return self

    def get_asset_decimals(self, asset: str, network: Network) -> int:
        try:
            asset_info = get_asset_info(str(network), asset)
            return asset_info["decimals"]
        except ValueError:
            pass
        return 6

    def merge_request_context(
        self,
        payload: PaymentPayload,
        context: BatchSettlementRequestContext,
    ) -> None:
        key = id(payload)
        with self._request_lock:
            existing = self._request_contexts.get(key)
            if existing is None:
                self._request_contexts[key] = context
                return
            if context.channel_id is not None:
                existing.channel_id = context.channel_id
            if context.pending_id is not None:
                existing.pending_id = context.pending_id
            if context.channel_snapshot is not None:
                existing.channel_snapshot = context.channel_snapshot
            if context.local_verify:
                existing.local_verify = context.local_verify

    def read_request_context(self, payload: PaymentPayload) -> BatchSettlementRequestContext | None:
        with self._request_lock:
            return self._request_contexts.get(id(payload))

    def take_request_context(self, payload: PaymentPayload) -> BatchSettlementRequestContext | None:
        with self._request_lock:
            return self._request_contexts.pop(id(payload), None)

    def remember_channel_snapshot(self, payload: PaymentPayload, channel: Channel) -> None:
        self.merge_request_context(
            payload,
            BatchSettlementRequestContext(
                channel_id=channel.channel_id,
                channel_snapshot=channel,
            ),
        )

    def take_channel_snapshot(self, payload: PaymentPayload) -> Channel | None:
        ctx = self.take_request_context(payload)
        return ctx.channel_snapshot if ctx else None

    def clear_pending_request(self, payload: PaymentPayload) -> None:
        ctx = self.take_request_context(payload)
        if not ctx or not ctx.channel_id or not ctx.pending_id:
            return
        snapshot = ctx.channel_snapshot

        def update(current: Channel | None) -> Channel | None:
            if current is None or (
                current.pending_request is None
                or current.pending_request.pending_id != ctx.pending_id
            ):
                return current
            if snapshot is None:
                return None
            next_ch = current.copy()
            next_ch.pending_request = None
            return next_ch

        self._storage.update_channel(ctx.channel_id, update)

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        if isinstance(price, dict) and "amount" in price:
            if not price.get("asset"):
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return AssetAmount(
                amount=price["amount"],
                asset=price["asset"],
                extra=price.get("extra", {}),
            )
        if isinstance(price, AssetAmount):
            if not price.asset:
                raise ValueError(f"Asset address required for AssetAmount on {network}")
            return price

        decimal_amount = parse_money_to_decimal(price)
        for parser in self._money_parsers:
            result = parser(decimal_amount, str(network))
            if result is not None:
                return result
        return self._default_money_conversion(decimal_amount, str(network))

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        _extension_keys: list[str],
    ) -> PaymentRequirements:

        config = get_network_config(str(requirements.network))
        if not requirements.asset:
            default = config.get("default_asset")
            if not default or not default.get("address"):
                raise ValueError(
                    f"No default stablecoin configured for network {requirements.network}"
                )
            requirements.asset = default["address"]

        try:
            asset_info = get_asset_info(str(requirements.network), requirements.asset)
        except ValueError:
            asset_info = None

        if "." in requirements.amount:
            if asset_info is None:
                raise ValueError(
                    f"Token {requirements.asset} is not a registered asset for "
                    f"network {requirements.network}; provide amount in atomic units"
                )
            requirements.amount = str(parse_amount(requirements.amount, asset_info["decimals"]))

        extra = dict(requirements.extra or {})

        receiver_authorizer = None
        if self._receiver_authorizer_signer is not None:
            receiver_authorizer = self._receiver_authorizer_signer.address
        elif isinstance(supported_kind.extra, dict):
            supplied = supported_kind.extra.get("receiverAuthorizer")
            if isinstance(supplied, str):
                receiver_authorizer = supplied

        if not receiver_authorizer or to_checksum_address(receiver_authorizer) == _ZERO_ADDRESS:
            raise ValueError(
                "Payment requirements must include a non-zero extra.receiverAuthorizer"
            )

        extra["receiverAuthorizer"] = to_checksum_address(receiver_authorizer)
        extra["withdrawDelay"] = self._withdraw_delay
        if asset_info is not None:
            extra.setdefault("name", asset_info["name"])
            extra.setdefault("version", asset_info["version"])
            atm = asset_info.get("asset_transfer_method")
            if "assetTransferMethod" not in extra and atm:
                extra["assetTransferMethod"] = atm

        requirements.extra = extra
        return requirements

    def _default_money_conversion(self, amount: float, network: str) -> AssetAmount:
        config = get_network_config(network)
        asset = config.get("default_asset")
        if not asset or not asset.get("address"):
            raise ValueError(f"No default stablecoin configured for network {network}")
        token_amount = int(amount * (10 ** asset["decimals"]))
        atm = asset.get("asset_transfer_method")
        extra: dict[str, Any] = {"name": asset["name"], "version": asset["version"]}
        if atm:
            extra["assetTransferMethod"] = atm
        return AssetAmount(amount=str(token_amount), asset=asset["address"], extra=extra)

    def before_verify(self, context: VerifyContext) -> AbortResult | SkipVerifyResult | None:
        from .verify import handle_before_verify

        return handle_before_verify(self, context)

    def after_verify(self, context: VerifyResultContext) -> SkipHandlerResult | None:
        from .verify import handle_after_verify

        return handle_after_verify(self, context)

    def on_verify_failure(self, context: VerifyFailureContext) -> RecoveredVerifyResult | None:
        from .verify import handle_verify_failure

        handle_verify_failure(self, context)
        return None

    def on_verified_payment_canceled(self, context: VerifiedPaymentCanceledContext) -> None:
        from .verify import handle_verified_payment_canceled

        handle_verified_payment_canceled(self, context)

    def before_settle(self, context: SettleContext) -> AbortResult | SkipSettleResult | None:
        from .settle import handle_before_settle

        return handle_before_settle(self, context)

    def after_settle(self, context: SettleResultContext) -> None:
        from .settle import handle_after_settle

        handle_after_settle(self, context)

    def on_settle_failure(self, context: SettleFailureContext) -> RecoveredSettleResult | None:
        from .settle import handle_settle_failure

        handle_settle_failure(self, context)
        return None

    def enrich_payment_required_response(
        self, context: SchemePaymentRequiredContext
    ) -> list[PaymentRequirements] | None:
        from .verify import handle_enrich_payment_required_response

        return handle_enrich_payment_required_response(self, context)

    def enrich_settlement_payload(self, context: SettleContext) -> dict[str, Any] | None:
        from .settle import handle_enrich_settlement_payload

        return handle_enrich_settlement_payload(self, context)

    def enrich_settlement_response(self, context: SettleResultContext) -> dict[str, Any] | None:
        from .settle import handle_enrich_settlement_response

        return handle_enrich_settlement_response(self, context)

    def create_channel_manager(
        self,
        facilitator: Any,
        network: Network,
    ) -> Any:
        """Create an async `BatchSettlementChannelManager` for this scheme."""
        import inspect

        from .channel_manager import BatchSettlementChannelManager
        from .channel_manager_common import ChannelManagerConfig

        settle_method = getattr(facilitator, "settle", None)
        if settle_method is not None and not inspect.iscoroutinefunction(settle_method):
            raise TypeError(
                "create_channel_manager requires an async facilitator client "
                f"(got {type(facilitator).__name__} with sync settle). "
                "Use create_channel_manager_sync with a sync facilitator client."
            )

        config = get_network_config(str(network))
        default_asset = config.get("default_asset") or {}
        token = default_asset.get("address")
        if not token:
            raise ValueError(f"No default asset configured for network {network}")
        return BatchSettlementChannelManager(
            ChannelManagerConfig(
                scheme=self,
                facilitator=facilitator,  # type: ignore[arg-type]
                receiver=self._receiver_address,
                token=token,
                network=str(network),
            )
        )

    def create_channel_manager_sync(
        self,
        facilitator: Any,
        network: Network,
    ) -> Any:
        """Create a sync `BatchSettlementChannelManagerSync` for this scheme."""
        import inspect

        from .channel_manager_common import ChannelManagerConfigSync
        from .channel_manager_sync import BatchSettlementChannelManagerSync

        settle_method = getattr(facilitator, "settle", None)
        if settle_method is not None and inspect.iscoroutinefunction(settle_method):
            raise TypeError(
                "create_channel_manager_sync requires a sync facilitator client "
                f"(got {type(facilitator).__name__} with async settle). "
                "Use create_channel_manager with an async facilitator client."
            )

        config = get_network_config(str(network))
        default_asset = config.get("default_asset") or {}
        token = default_asset.get("address")
        if not token:
            raise ValueError(f"No default asset configured for network {network}")
        return BatchSettlementChannelManagerSync(
            ChannelManagerConfigSync(
                scheme=self,
                facilitator=facilitator,
                receiver=self._receiver_address,
                token=token,
                network=str(network),
            )
        )


__all__ = [
    "BatchSettlementEvmScheme",
    "BatchSettlementEvmSchemeServerConfig",
    "BatchSettlementRequestContext",
]
