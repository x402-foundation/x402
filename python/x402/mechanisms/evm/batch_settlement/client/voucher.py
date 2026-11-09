"""Client voucher signing."""

from __future__ import annotations

from ....evm.signer import ClientEvmSigner
from ...utils import get_evm_chain_id
from ..constants import VOUCHER_TYPES
from ..types import VoucherFields
from ..utils import coerce_bytes32, get_batch_settlement_eip712_domain


def sign_voucher(
    signer: ClientEvmSigner,
    channel_id: str,
    max_claimable_amount: str | int,
    network: str,
) -> VoucherFields:
    """Sign a cumulative `Voucher` using the client's wallet.

    Args:
        signer: Client wallet that produces the EIP-712 signature.
        channel_id: 0x-prefixed bytes32 channel id (`compute_channel_id(...)`).
        max_claimable_amount: Cumulative ceiling the receiver may claim.
        network: CAIP-2 network identifier (e.g. `eip155:84532`).

    Returns:
        `VoucherFields` ready to embed in a payment payload.
    """
    chain_id = get_evm_chain_id(network)
    domain = get_batch_settlement_eip712_domain(chain_id)
    message = {
        "channelId": coerce_bytes32(channel_id),
        "maxClaimableAmount": int(max_claimable_amount),
    }
    sig_bytes = signer.sign_typed_data(domain, VOUCHER_TYPES, "Voucher", message)
    signature = "0x" + sig_bytes.hex() if not sig_bytes.hex().startswith("0x") else sig_bytes.hex()
    return VoucherFields(
        channel_id=channel_id,
        max_claimable_amount=str(int(max_claimable_amount)),
        signature=signature,
    )


__all__ = ["sign_voucher"]
