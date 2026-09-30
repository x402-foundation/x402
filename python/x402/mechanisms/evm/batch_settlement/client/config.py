"""Client-side configuration types and helpers."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ....evm.signer import ClientEvmSigner
from ..types import ChannelConfig
from .storage import (
    BatchSettlementClientContext,
    ClientChannelStorage,
    InMemoryClientChannelStorage,
)

DEFAULT_SALT = "0x" + "00" * 32


@dataclass
class BatchSettlementDepositPolicy:
    """Caller-tunable policy controlling how the client sizes channel deposits."""

    deposit_multiplier: int | None = None


@dataclass
class BatchSettlementDepositStrategyContext:
    """Inputs supplied before the client signs a deposit authorization."""

    payment_requirements: Any
    channel_config: ChannelConfig
    channel_id: str
    client_context: BatchSettlementClientContext
    request_amount: str
    max_claimable_amount: str
    current_balance: str
    minimum_deposit_amount: str
    deposit_amount: str
    max_deposit: str | None = None


# Return either a positive integer string, False to skip the deposit, or None
# to accept the default deposit amount.
BatchSettlementDepositStrategyResult = str | int | bool | None
BatchSettlementDepositStrategy = Callable[
    [BatchSettlementDepositStrategyContext], BatchSettlementDepositStrategyResult
]


@dataclass
class BatchSettlementEvmSchemeOptions:
    """Full options object accepted by `BatchSettlementEvmScheme`.

    Either this or a bare `BatchSettlementDepositPolicy` can be passed as the
    second constructor argument.
    """

    deposit_policy: BatchSettlementDepositPolicy | None = None
    deposit_strategy: BatchSettlementDepositStrategy | None = None
    storage: ClientChannelStorage | None = None
    salt: str | None = None
    payer_authorizer: str | None = None
    rpc_url: str | None = None
    voucher_signer: ClientEvmSigner | None = None


@dataclass
class ResolvedClientOptions:
    """Internal merged options shape used by the scheme + helpers."""

    storage: ClientChannelStorage
    salt: str
    deposit_policy: BatchSettlementDepositPolicy | None = None
    deposit_strategy: BatchSettlementDepositStrategy | None = None
    payer_authorizer: str | None = None
    voucher_signer: ClientEvmSigner | None = None
    rpc_url: str | None = None


def is_batch_settlement_evm_scheme_options(value: Any) -> bool:
    """Return True when `value` looks like a full options object."""
    return isinstance(value, BatchSettlementEvmSchemeOptions)


def resolve_client_options(
    second: BatchSettlementEvmSchemeOptions | BatchSettlementDepositPolicy | None,
) -> ResolvedClientOptions:
    """Normalise the constructor's second argument into a uniform options shape."""
    if second is None:
        return ResolvedClientOptions(
            storage=InMemoryClientChannelStorage(),
            salt=DEFAULT_SALT,
        )

    if isinstance(second, BatchSettlementEvmSchemeOptions):
        return ResolvedClientOptions(
            storage=second.storage or InMemoryClientChannelStorage(),
            salt=second.salt or DEFAULT_SALT,
            deposit_policy=second.deposit_policy,
            deposit_strategy=second.deposit_strategy,
            payer_authorizer=second.payer_authorizer,
            voucher_signer=second.voucher_signer,
            rpc_url=second.rpc_url,
        )

    if isinstance(second, BatchSettlementDepositPolicy):
        return ResolvedClientOptions(
            storage=InMemoryClientChannelStorage(),
            salt=DEFAULT_SALT,
            deposit_policy=second,
        )

    raise TypeError(
        "Unsupported batch-settlement scheme options: expected "
        "BatchSettlementEvmSchemeOptions or BatchSettlementDepositPolicy"
    )


def validate_deposit_policy(policy: BatchSettlementDepositPolicy | None) -> None:
    """Validate a deposit policy, raising on invalid fields."""
    if policy is None:
        return
    m = policy.deposit_multiplier
    if m is None:
        return
    if not isinstance(m, int) or isinstance(m, bool) or m < 3:
        raise ValueError("deposit_multiplier must be an integer >= 3")


_DIGITS = re.compile(r"^\d+$")


def parse_announced_min_deposit(value: Any, request_amount: int) -> int | None:
    """Parse a server-announced ``extra.minDeposit`` when it is a valid deposit target.

    Returns the parsed minimum deposit target, or ``None`` when invalid or below
    ``request_amount``.
    """
    if not isinstance(value, str) or not _DIGITS.fullmatch(value):
        return None

    parsed = int(value)
    if parsed <= 0 or parsed < request_amount:
        return None

    return parsed


def max_deposit_from_spend_cap(
    max_amount_per_payment: Any,
    deposit_multiplier: int = 5,
) -> int | None:
    """Derive the deposit ceiling as ``deposit_multiplier ×`` the resolved spend cap.

    Returns the atomic deposit ceiling, or ``None`` when the payment is uncapped.
    """
    if (
        not isinstance(max_amount_per_payment, str)
        or not _DIGITS.fullmatch(max_amount_per_payment)
        or int(max_amount_per_payment) <= 0
    ):
        return None
    return int(max_amount_per_payment) * deposit_multiplier


def apply_max_deposit(deposit: int, needed: int, max_deposit: int | None = None) -> str:
    """Clamp a computed deposit to ``max_deposit``. Throw when the voucher gap exceeds the cap."""
    if max_deposit is None:
        return str(deposit)
    if needed > max_deposit:
        raise ValueError(
            f"Required deposit {needed} exceeds deposit_multiplier × "
            f"spend_controls.max_amount_per_payment ({max_deposit}). "
            "Raise max_amount_per_payment or deposit_multiplier."
        )
    return str(max_deposit if deposit > max_deposit else deposit)


def deposit_amount_for_request(
    policy: BatchSettlementDepositPolicy | None,
    request_amount: int,
    needed: int,
    extra: dict[str, Any] | None,
    max_deposit: int | None = None,
) -> str:
    """Compute the deposit amount from the voucher gap, server hint, or deposit multiplier."""
    announced = parse_announced_min_deposit(
        extra.get("minDeposit") if extra else None, request_amount
    )
    multiplier = policy.deposit_multiplier if (policy and policy.deposit_multiplier) else 5
    target = announced if announced is not None else multiplier * int(request_amount)
    deposit = needed if needed > target else target
    return apply_max_deposit(deposit, needed, max_deposit)


def normalize_strategy_deposit_amount(value: str | int | bool) -> str:
    """Normalise and validate a strategy-provided base-unit deposit amount."""
    if isinstance(value, bool):
        raise ValueError("deposit_strategy must return a positive integer deposit amount")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError("deposit_strategy must return a positive integer deposit amount")
        return str(value)
    if isinstance(value, str) and _DIGITS.match(value) and int(value) > 0:
        return str(int(value))
    raise ValueError("deposit_strategy must return a positive integer deposit amount")


__all__ = [
    "DEFAULT_SALT",
    "BatchSettlementDepositPolicy",
    "BatchSettlementDepositStrategy",
    "BatchSettlementDepositStrategyContext",
    "BatchSettlementDepositStrategyResult",
    "BatchSettlementEvmSchemeOptions",
    "ResolvedClientOptions",
    "is_batch_settlement_evm_scheme_options",
    "resolve_client_options",
    "validate_deposit_policy",
    "parse_announced_min_deposit",
    "max_deposit_from_spend_cap",
    "apply_max_deposit",
    "deposit_amount_for_request",
    "normalize_strategy_deposit_amount",
]
