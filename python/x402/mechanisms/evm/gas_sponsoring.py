"""Gas sponsoring extension signing for EVM Permit2 client payloads."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from ...schemas import PaymentRequirements
from .signer import (
    ClientEvmSigner,
    ClientEvmSignerWithReadContract,
    ClientEvmSignerWithSignTransaction,
    has_sufficient_permit2_allowance,
    warn_cannot_read_for_sponsoring,
)
from .utils import get_evm_chain_id, normalize_address

ReadSignerResolver = Callable[[str], ClientEvmSignerWithReadContract | None]


def try_sign_gas_sponsoring_extensions(
    signer: ClientEvmSigner,
    resolve_read_signer: ReadSignerResolver,
    requirements: PaymentRequirements,
    result: dict[str, Any],
    extensions: dict[str, Any],
) -> dict[str, Any] | None:
    """Sign an EIP-2612 permit extension, falling back to an ERC-20 approval extension."""
    return _try_sign_eip2612(
        signer, resolve_read_signer, requirements, result, extensions
    ) or _try_sign_erc20_approval(signer, resolve_read_signer, requirements, extensions)


def _try_sign_eip2612(
    signer: ClientEvmSigner,
    resolve_read_signer: ReadSignerResolver,
    requirements: PaymentRequirements,
    result: dict[str, Any],
    extensions: dict[str, Any],
) -> dict[str, Any] | None:
    from ...extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING_KEY
    from ...extensions.eip2612_gas_sponsoring.client import sign_eip2612_permit

    if EIP2612_GAS_SPONSORING_KEY not in extensions:
        return None

    read_signer = resolve_read_signer(str(requirements.network))
    if read_signer is None:
        warn_cannot_read_for_sponsoring(str(requirements.network))
        return None

    extra = requirements.extra or {}
    token_name = extra.get("name")
    token_version = extra.get("version")
    if not token_name or not token_version:
        return None

    chain_id = get_evm_chain_id(str(requirements.network))
    token_address = normalize_address(requirements.asset)

    if has_sufficient_permit2_allowance(
        read_signer, token_address, signer.address, requirements.amount
    ):
        return None

    permit2_auth = result.get("permit2Authorization", {})
    deadline = permit2_auth.get("deadline", "")
    if not deadline:
        deadline = str(int(time.time()) + (requirements.max_timeout_seconds or 3600))

    info = sign_eip2612_permit(
        read_signer,
        token_address,
        token_name,
        token_version,
        chain_id,
        deadline,
        requirements.amount,
    )

    return {EIP2612_GAS_SPONSORING_KEY: {"info": info.to_dict()}}


def _try_sign_erc20_approval(
    signer: ClientEvmSigner,
    resolve_read_signer: ReadSignerResolver,
    requirements: PaymentRequirements,
    extensions: dict[str, Any],
) -> dict[str, Any] | None:
    from ...extensions.erc20_approval_gas_sponsoring import (
        ERC20_APPROVAL_GAS_SPONSORING_KEY,
    )
    from ...extensions.erc20_approval_gas_sponsoring.client import (
        sign_erc20_approval_transaction,
    )

    if ERC20_APPROVAL_GAS_SPONSORING_KEY not in extensions:
        return None

    read_signer = resolve_read_signer(str(requirements.network))
    if read_signer is None:
        warn_cannot_read_for_sponsoring(str(requirements.network))
        return None

    if not isinstance(signer, ClientEvmSignerWithSignTransaction):
        return None

    chain_id = get_evm_chain_id(str(requirements.network))
    token_address = normalize_address(requirements.asset)

    if has_sufficient_permit2_allowance(
        read_signer, token_address, signer.address, requirements.amount
    ):
        return None

    info = sign_erc20_approval_transaction(signer, token_address, chain_id)

    return {ERC20_APPROVAL_GAS_SPONSORING_KEY: {"info": info.to_dict()}}
