"""Local operator grants and per-channel escrow caps for server signer mode."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from fnmatch import fnmatchcase

from solders.pubkey import Pubkey

from ....schemas import PaymentRequirements
from ..default_assets import find_default_asset


@dataclass(frozen=True)
class ServerSignedChannelsAsset:
    network: str
    asset: str
    max_deposit: str | None = None


@dataclass(frozen=True)
class BatchServerSignedChannelsPolicy:
    """Grant listed operators authority over escrow, capped at $1 by default."""

    allowed_operators: tuple[str, ...] | list[str] = ()
    max_deposit: str | int | float | bool = "$1"
    allowed_assets: tuple[ServerSignedChannelsAsset, ...] | list[ServerSignedChannelsAsset] = ()


@dataclass(frozen=True)
class ResolvedServerSignedTrust:
    operator: str
    max_deposit: int | None = None


class UntrustedOperatorError(ValueError):
    def __init__(self, message: str, operator: str | None = None):
        super().__init__(message)
        self.operator = operator


def is_server_signed_accept(accept: PaymentRequirements) -> bool:
    return (
        accept.scheme == "batch-settlement"
        and (accept.extra or {}).get("voucherSigner") == "server"
    )


class ServerSignedTrustPolicy:
    def __init__(self, policy: BatchServerSignedChannelsPolicy | None = None):
        policy = policy or BatchServerSignedChannelsPolicy()
        self.operators = frozenset(policy.allowed_operators)
        for operator in self.operators:
            Pubkey.from_string(operator)
        self.assets = tuple(policy.allowed_assets)
        for entry in self.assets:
            if entry.max_deposit is not None and (
                not isinstance(entry.max_deposit, str)
                or not entry.max_deposit.isascii()
                or not entry.max_deposit.isdigit()
                or int(entry.max_deposit) <= 0
            ):
                raise ValueError("allowed_assets.max_deposit must be a positive atomic integer")
        self.usd_cap: Decimal | None = None
        if policy.max_deposit is not False:
            try:
                raw = str(policy.max_deposit).removeprefix("$")
                self.usd_cap = Decimal(raw)
                if not self.usd_cap.is_finite() or self.usd_cap <= 0:
                    raise ValueError
            except (InvalidOperation, ValueError):
                raise ValueError(
                    "server_signed_channels_policy.max_deposit must be positive"
                ) from None

    def grant_for(self, requirements: PaymentRequirements) -> ResolvedServerSignedTrust:
        operator = (requirements.extra or {}).get("operator")
        if not isinstance(operator, str) or operator not in self.operators:
            raise UntrustedOperatorError(
                f"Operator {operator or '<missing>'} can claim the entire channel deposit. "
                "Grant trust explicitly using server_signed_channels_policy.allowed_operators "
                "and bound escrow with max_deposit.",
                operator if isinstance(operator, str) else None,
            )
        default = find_default_asset(requirements.asset, str(requirements.network))
        for entry in self.assets:
            if fnmatchcase(str(requirements.network), entry.network) and (
                entry.asset == requirements.asset
                or (default is not None and entry.asset.upper() == default["symbol"].upper())
            ):
                return ResolvedServerSignedTrust(
                    operator, None if entry.max_deposit is None else int(entry.max_deposit)
                )
        if default is None:
            raise UntrustedOperatorError(
                "Non-default assets require an explicit allowed_assets grant with an atomic cap",
                operator,
            )
        cap = None if self.usd_cap is None else int(self.usd_cap * 10 ** default["decimals"])
        if cap is not None and cap <= 0:
            raise ValueError("server signer escrow cap is below one atomic unit")
        return ResolvedServerSignedTrust(operator, cap)

    def filter_accepts(self, accepts: list[PaymentRequirements]) -> list[PaymentRequirements]:
        remaining, trusted, refused = [], set(), []
        for accept in accepts:
            if is_server_signed_accept(accept):
                try:
                    self.grant_for(accept)
                except UntrustedOperatorError as error:
                    refused.append(error)
                    continue
                trusted.add(id(accept))
            remaining.append(accept)
        if not remaining and refused:
            raise refused[0]
        result, seen = [], set()
        for accept in remaining:
            if accept.scheme == "batch-settlement" and accept.network not in seen:
                seen.add(accept.network)
                result.extend(
                    a for a in remaining if a.network == accept.network and id(a) in trusted
                )
            if id(accept) not in trusted:
                result.append(accept)
        return result
