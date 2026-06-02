"""Client-side `BatchSettlementEvmScheme` implementation."""

from __future__ import annotations

from typing import Any

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequired, PaymentRequirements, SettleResponse
from ....evm.constants import ERC20_ALLOWANCE_ABI, PERMIT2_ADDRESS
from ....evm.signer import (
    ClientEvmSigner,
    ClientEvmSignerWithReadContract,
    ClientEvmSignerWithSignTransaction,
)
from ...utils import get_evm_chain_id, normalize_address
from ..constants import SCHEME_BATCH_SETTLEMENT
from ..types import ChannelConfig, VoucherPayload
from ..utils import compute_channel_id
from .channel import (
    BatchSettlementClientDeps,
    build_channel_config,
    process_settle_response,
    recover_channel,
)
from .config import (
    BatchSettlementDepositPolicy,
    BatchSettlementDepositStrategyContext,
    BatchSettlementEvmSchemeOptions,
    deposit_amount_for_request,
    normalize_strategy_deposit_amount,
    resolve_client_options,
    validate_deposit_policy,
)
from .eip3009 import create_batch_settlement_eip3009_deposit_payload
from .permit2 import create_batch_settlement_permit2_deposit_payload
from .recovery import process_corrective_payment_required
from .refund import RefundOptions, refund_channel
from .storage import BatchSettlementClientContext
from .voucher import sign_voucher


def _wrap_if_local_account(signer: Any) -> ClientEvmSigner:
    """Auto-wrap an `eth_account` LocalAccount in `EthAccountSigner`."""
    try:
        from eth_account.signers.local import LocalAccount

        if isinstance(signer, LocalAccount):
            from ....evm.signers import EthAccountSigner

            return EthAccountSigner(signer)
    except ImportError:
        pass
    return signer


class _BatchSettlementSchemeHooks:
    """Scheme-level hooks for BatchSettlementEvmScheme.

    Wired up as `scheme.scheme_hooks` so the x402 client infrastructure
    calls `on_payment_response` after every paid HTTP request.
    """

    def __init__(self, scheme: BatchSettlementEvmScheme) -> None:
        self._scheme = scheme

    def on_payment_response(self, ctx: Any) -> Any:
        """Update local channel storage after a paid request or corrective 402."""
        from .....schemas import RecoveredResponseResult

        if ctx.settle_response is not None:
            process_settle_response(self._scheme._storage, ctx.settle_response)
            return None

        if ctx.payment_required is not None:
            deps = self._scheme._deps()
            recovered = process_corrective_payment_required(deps, ctx.payment_required)
            if recovered:
                return RecoveredResponseResult()

        return None


class BatchSettlementEvmScheme:
    """Client-side implementation of the `batch-settlement` scheme for EVM.

    Builds payment payloads (deposit + voucher or voucher-only), processes
    server responses to update local session state via `process_settle_response`,
    handles corrective 402 resynchronisation via
    `process_corrective_payment_required`, and supports on-demand cooperative
    refund requests via `refund`.
    """

    scheme = SCHEME_BATCH_SETTLEMENT

    def __init__(
        self,
        signer: ClientEvmSigner,
        options: BatchSettlementEvmSchemeOptions | BatchSettlementDepositPolicy | None = None,
    ):
        self._signer = _wrap_if_local_account(signer)
        resolved = resolve_client_options(options)
        self._storage = resolved.storage
        self._deposit_policy = resolved.deposit_policy
        self._deposit_strategy = resolved.deposit_strategy
        self._salt = resolved.salt
        self._payer_authorizer = resolved.payer_authorizer
        self._voucher_signer = resolved.voucher_signer
        self._rpc_url = resolved.rpc_url

        if (
            self._payer_authorizer is not None
            and self._voucher_signer is not None
            and to_checksum_address(self._payer_authorizer)
            != to_checksum_address(self._voucher_signer.address)
        ):
            raise ValueError("payer_authorizer address must match voucher_signer.address")

        validate_deposit_policy(self._deposit_policy)
        self.scheme_hooks = _BatchSettlementSchemeHooks(self)
        self._url_channel_map: dict[str, str] = {}

    # ------------------------------------------------------------------ API

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create the inner payment payload dict for a batch-settlement request."""
        deps = self._deps()
        config = build_channel_config(deps, requirements)
        channel_id = compute_channel_id(config, str(requirements.network))
        key = channel_id.lower()

        batched_ctx = self._storage.get(key)
        if batched_ctx is None and hasattr(self._signer, "read_contract"):
            try:
                batched_ctx = recover_channel(deps, requirements)
            except Exception:
                batched_ctx = None
        if batched_ctx is None:
            batched_ctx = BatchSettlementClientContext()

        needs_initial_deposit = not batched_ctx.balance or int(batched_ctx.balance or "0") == 0

        base_cumulative = int(batched_ctx.charged_cumulative_amount or "0")
        request_amount = int(requirements.amount)
        max_claimable_amount = str(base_cumulative + request_amount)

        current_balance = int(batched_ctx.balance or "0")
        needs_top_up = not needs_initial_deposit and int(max_claimable_amount) > current_balance

        if needs_initial_deposit or needs_top_up:
            computed_deposit = deposit_amount_for_request(self._deposit_policy, request_amount)
            minimum_deposit_amount = str(int(max_claimable_amount) - current_balance)
            deposit_amount = self._resolve_deposit_amount(
                BatchSettlementDepositStrategyContext(
                    payment_requirements=requirements,
                    channel_config=config,
                    channel_id=channel_id,
                    client_context=batched_ctx,
                    request_amount=str(request_amount),
                    max_claimable_amount=max_claimable_amount,
                    current_balance=str(current_balance),
                    minimum_deposit_amount=minimum_deposit_amount,
                    deposit_amount=computed_deposit,
                )
            )
            if deposit_amount is None:
                return self._create_voucher_payload(
                    channel_id, max_claimable_amount, str(requirements.network), config
                )

            extra = requirements.extra or {}
            asset_transfer_method = extra.get("assetTransferMethod") or "eip3009"

            if asset_transfer_method == "eip3009":
                deposit_payload = create_batch_settlement_eip3009_deposit_payload(
                    self._signer,
                    requirements,
                    config,
                    deposit_amount,
                    max_claimable_amount,
                    self._voucher_signer,
                )
                return deposit_payload.to_dict()

            if asset_transfer_method != "permit2":
                raise ValueError(
                    f"unsupported batch-settlement assetTransferMethod: {asset_transfer_method}"
                )

            deposit_payload = create_batch_settlement_permit2_deposit_payload(
                self._signer,
                requirements,
                config,
                deposit_amount,
                max_claimable_amount,
                self._voucher_signer,
            )
            result = deposit_payload.to_dict()
            if extensions:
                ext_data = self._try_sign_extensions_for_permit2(requirements, result, extensions)
                if ext_data:
                    result["__extensions"] = ext_data
            return result

        return self._create_voucher_payload(
            channel_id, max_claimable_amount, str(requirements.network), config
        )

    def refund(self, url: str, options: RefundOptions | None = None) -> SettleResponse:
        """Send a cooperative refund request for the channel backing `url`."""
        return refund_channel(self._deps(), url, options, _url_cache=self._url_channel_map)

    def process_settle_response(self, settle: SettleResponse) -> None:
        """Update local channel state from a server settle response."""
        process_settle_response(self._storage, settle)

    def process_corrective_payment_required(self, payment_required: PaymentRequired) -> bool:
        """Resync local channel state from a corrective 402 response."""
        return process_corrective_payment_required(self._deps(), payment_required)

    def build_channel_config(self, requirements: PaymentRequirements) -> ChannelConfig:
        """Build the immutable `ChannelConfig` for a given set of payment requirements."""
        return build_channel_config(self._deps(), requirements)

    # ------------------------------------------------------------------ internals

    def _resolve_deposit_amount(
        self,
        context: BatchSettlementDepositStrategyContext,
    ) -> str | None:
        """Return the deposit amount to sign, or `None` to skip this deposit attempt."""
        if self._deposit_strategy is None:
            return context.deposit_amount
        result = self._deposit_strategy(context)
        if result is False:
            return None
        if result is None or result is True:
            return context.deposit_amount
        deposit_amount = normalize_strategy_deposit_amount(result)
        if int(deposit_amount) < int(context.minimum_deposit_amount):
            raise ValueError(
                f"deposit_strategy returned {deposit_amount}, below required top-up "
                f"{context.minimum_deposit_amount}"
            )
        return deposit_amount

    def _create_voucher_payload(
        self,
        channel_id: str,
        max_claimable_amount: str,
        network: str,
        config: ChannelConfig,
    ) -> dict[str, Any]:
        voucher_signer = self._voucher_signer or self._signer
        voucher = sign_voucher(voucher_signer, channel_id, max_claimable_amount, network)
        payload = VoucherPayload()
        payload.channel_config = config
        payload.voucher = voucher
        return payload.to_dict()

    def _try_sign_extensions_for_permit2(
        self,
        requirements: PaymentRequirements,
        deposit_dict: dict[str, Any],
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Try EIP-2612 then ERC-20 approval gas sponsoring for a Permit2 deposit."""
        eip2612 = self._try_sign_eip2612_for_deposit(requirements, deposit_dict, extensions)
        if eip2612:
            return eip2612
        return self._try_sign_erc20_approval_for_deposit(requirements, extensions)

    def _try_sign_eip2612_for_deposit(
        self,
        requirements: PaymentRequirements,
        deposit_dict: dict[str, Any],
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        from .....extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING_KEY
        from .....extensions.eip2612_gas_sponsoring.client import sign_eip2612_permit

        if EIP2612_GAS_SPONSORING_KEY not in extensions:
            return None
        if not isinstance(self._signer, ClientEvmSignerWithReadContract):
            return None

        extra = requirements.extra or {}
        token_name = extra.get("name")
        token_version = extra.get("version")
        if not token_name or not token_version:
            return None

        chain_id = get_evm_chain_id(str(requirements.network))
        token_address = normalize_address(requirements.asset)

        try:
            allowance = self._signer.read_contract(
                token_address,
                ERC20_ALLOWANCE_ABI,
                "allowance",
                self._signer.address,
                PERMIT2_ADDRESS,
            )
            if int(allowance) >= int(requirements.amount):
                return None
        except Exception:
            pass

        deposit = deposit_dict.get("deposit", {})
        authorization = deposit.get("authorization", {})
        permit2_auth = authorization.get("permit2Authorization", {})
        deadline = permit2_auth.get("deadline", "")
        if not deadline:
            import time

            deadline = str(int(time.time()) + (requirements.max_timeout_seconds or 3600))

        deposit_amount = deposit.get("amount", requirements.amount)

        info = sign_eip2612_permit(
            self._signer,
            token_address,
            token_name,
            token_version,
            chain_id,
            deadline,
            deposit_amount,
        )
        return {EIP2612_GAS_SPONSORING_KEY: {"info": info.to_dict()}}

    def _try_sign_erc20_approval_for_deposit(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        from .....extensions.erc20_approval_gas_sponsoring import (
            ERC20_APPROVAL_GAS_SPONSORING_KEY,
        )
        from .....extensions.erc20_approval_gas_sponsoring.client import (
            sign_erc20_approval_transaction,
        )

        if ERC20_APPROVAL_GAS_SPONSORING_KEY not in extensions:
            return None
        if not isinstance(self._signer, ClientEvmSignerWithSignTransaction):
            return None

        chain_id = get_evm_chain_id(str(requirements.network))
        token_address = normalize_address(requirements.asset)

        if isinstance(self._signer, ClientEvmSignerWithReadContract):
            try:
                allowance = self._signer.read_contract(
                    token_address,
                    ERC20_ALLOWANCE_ABI,
                    "allowance",
                    self._signer.address,
                    PERMIT2_ADDRESS,
                )
                if int(allowance) >= int(requirements.amount):
                    return None
            except Exception:
                pass

        info = sign_erc20_approval_transaction(self._signer, token_address, chain_id)
        return {ERC20_APPROVAL_GAS_SPONSORING_KEY: {"info": info.to_dict()}}

    def _deps(self) -> BatchSettlementClientDeps:
        return BatchSettlementClientDeps(
            signer=self._signer,
            storage=self._storage,
            salt=self._salt,
            payer_authorizer=self._payer_authorizer,
            voucher_signer=self._voucher_signer,
        )


__all__ = ["BatchSettlementEvmScheme"]
