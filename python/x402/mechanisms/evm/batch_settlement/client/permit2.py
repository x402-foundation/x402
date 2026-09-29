"""Permit2 deposit payload construction (client side)."""

from __future__ import annotations

import time

try:
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .....schemas import PaymentRequirements
from ....evm.constants import PERMIT2_ADDRESS
from ....evm.signer import ClientEvmSigner
from ...utils import create_permit2_nonce, get_evm_chain_id
from ..constants import BATCH_PERMIT2_WITNESS_TYPES, PERMIT2_DEPOSIT_COLLECTOR_ADDRESS
from ..types import (
    ChannelConfig,
    DepositAuthorization,
    DepositFields,
    DepositPayload,
    Permit2Authorization,
    Permit2DepositWitness,
    Permit2TokenPermissions,
)
from ..utils import coerce_bytes32, compute_channel_id
from .voucher import sign_voucher


def create_batch_settlement_permit2_deposit_payload(
    signer: ClientEvmSigner,
    requirements: PaymentRequirements,
    channel_config: ChannelConfig,
    deposit_amount: str | int,
    max_claimable_amount: str | int,
    voucher_signer: ClientEvmSigner | None = None,
) -> DepositPayload:
    """Create a deposit payload bundling a Permit2 witness transfer + voucher."""
    chain_id = get_evm_chain_id(str(requirements.network))
    nonce = create_permit2_nonce()
    deadline = str(int(time.time()) + int(requirements.max_timeout_seconds))
    channel_id = compute_channel_id(channel_config, str(requirements.network))

    token = to_checksum_address(requirements.asset)
    spender = to_checksum_address(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS)
    from_addr = to_checksum_address(signer.address)

    domain = {
        "name": "Permit2",
        "chainId": chain_id,
        "verifyingContract": PERMIT2_ADDRESS,
    }
    message = {
        "permitted": {
            "token": token,
            "amount": int(deposit_amount),
        },
        "spender": spender,
        "nonce": int(nonce),
        "deadline": int(deadline),
        "witness": {
            "channelId": coerce_bytes32(channel_id),
        },
    }
    sig_bytes = signer.sign_typed_data(
        domain, BATCH_PERMIT2_WITNESS_TYPES, "PermitWitnessTransferFrom", message
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
            permit2_authorization=Permit2Authorization(
                from_address=from_addr,
                permitted=Permit2TokenPermissions(token=token, amount=str(int(deposit_amount))),
                spender=spender,
                nonce=nonce,
                deadline=deadline,
                witness=Permit2DepositWitness(channel_id=channel_id),
                signature=signature,
            ),
        ),
    )
    return payload


__all__ = ["create_batch_settlement_permit2_deposit_payload"]
