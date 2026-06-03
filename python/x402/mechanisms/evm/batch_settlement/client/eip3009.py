"""ERC-3009 deposit payload construction (client side)."""

from __future__ import annotations

import time

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements
from ....evm.signer import ClientEvmSigner
from ...utils import create_nonce, get_evm_chain_id
from ..constants import ERC3009_DEPOSIT_COLLECTOR_ADDRESS, RECEIVE_AUTHORIZATION_TYPES
from ..encoding import build_erc3009_deposit_nonce
from ..types import (
    ChannelConfig,
    DepositAuthorization,
    DepositFields,
    DepositPayload,
    Erc3009Authorization,
)
from ..utils import coerce_bytes32, compute_channel_id
from .voucher import sign_voucher


def create_batch_settlement_eip3009_deposit_payload(
    signer: ClientEvmSigner,
    requirements: PaymentRequirements,
    channel_config: ChannelConfig,
    deposit_amount: str | int,
    max_claimable_amount: str | int,
    voucher_signer: ClientEvmSigner | None = None,
) -> DepositPayload:
    """Create a deposit payload bundling an ERC-3009 authorization + voucher."""
    extra = requirements.extra or {}
    name = extra.get("name")
    version = extra.get("version")
    if not name or not version:
        raise ValueError(
            "EIP-712 domain parameters (name, version) are required in payment "
            f"requirements for asset {requirements.asset}"
        )

    salt = create_nonce()
    now = int(time.time())
    valid_after = now - 600
    valid_before = now + int(requirements.max_timeout_seconds)
    chain_id = get_evm_chain_id(str(requirements.network))
    channel_id = compute_channel_id(channel_config, str(requirements.network))

    erc3009_nonce = build_erc3009_deposit_nonce(channel_id, salt)

    domain = {
        "name": name,
        "version": version,
        "chainId": chain_id,
        "verifyingContract": to_checksum_address(requirements.asset),
    }
    message = {
        "from": to_checksum_address(signer.address),
        "to": to_checksum_address(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
        "value": int(deposit_amount),
        "validAfter": valid_after,
        "validBefore": valid_before,
        "nonce": coerce_bytes32(erc3009_nonce),
    }
    sig_bytes = signer.sign_typed_data(
        domain, RECEIVE_AUTHORIZATION_TYPES, "ReceiveWithAuthorization", message
    )
    signature = "0x" + sig_bytes.hex() if not sig_bytes.hex().startswith("0x") else sig_bytes.hex()

    voucher = sign_voucher(
        voucher_signer or signer,
        channel_id,
        max_claimable_amount,
        str(requirements.network),
    )

    payload = DepositPayload()
    payload.channel_config = channel_config
    payload.voucher = voucher
    payload.deposit = DepositFields(
        amount=str(int(deposit_amount)),
        authorization=DepositAuthorization(
            erc3009_authorization=Erc3009Authorization(
                valid_after=str(valid_after),
                valid_before=str(valid_before),
                salt=salt,
                signature=signature,
            ),
        ),
    )
    return payload


__all__ = ["create_batch_settlement_eip3009_deposit_payload"]
