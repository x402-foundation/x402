"""Client-side ERC-20 approval transaction signing for Permit2 approval sponsoring."""

from __future__ import annotations

from typing import Any

from ...mechanisms.evm.constants import (
    ERC20_APPROVE_ABI,
    ERC20_APPROVE_GAS_LIMIT,
    PERMIT2_ADDRESS,
)
from .types import Erc20ApprovalGasSponsoringInfo

MAX_UINT256 = 2**256 - 1


def sign_erc20_approval_transaction(
    signer: Any,
    token_address: str,
    chain_id: int,
) -> Erc20ApprovalGasSponsoringInfo:
    """Sign an ERC-20 approve(Permit2, MaxUint256) transaction.

    The signer must implement:
    - address: str property
    - sign_transaction(tx_dict) -> hex string
    - get_transaction_count(address) -> int
    - estimate_fees_per_gas() -> (max_fee, max_priority_fee) (optional)

    Args:
        signer: Client signer with transaction signing capabilities.
        token_address: ERC-20 token contract address.
        chain_id: Chain ID.

    Returns:
        Erc20ApprovalGasSponsoringInfo ready to attach to payload extensions.
    """
    try:
        from web3 import Web3

        w3 = Web3()
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(token_address),
            abi=ERC20_APPROVE_ABI,
        )
        calldata = contract.encode_abi(
            abi_element_identifier="approve",
            args=[Web3.to_checksum_address(PERMIT2_ADDRESS), MAX_UINT256],
        )
    except ImportError:
        calldata = (
            "0x095ea7b3" + PERMIT2_ADDRESS[2:].lower().zfill(64) + hex(MAX_UINT256)[2:].zfill(64)
        )

    nonce = signer.get_transaction_count(signer.address)

    max_fee = 1_000_000_000
    max_priority_fee = 100_000_000
    if hasattr(signer, "estimate_fees_per_gas"):
        try:
            fees = signer.estimate_fees_per_gas()
            max_fee = fees[0] if isinstance(fees, tuple) else fees["maxFeePerGas"]
            max_priority_fee = fees[1] if isinstance(fees, tuple) else fees["maxPriorityFeePerGas"]
        except Exception:
            pass

    tx = {
        "to": token_address,
        "data": calldata,
        "nonce": nonce,
        "gas": ERC20_APPROVE_GAS_LIMIT,
        "maxFeePerGas": max_fee,
        "maxPriorityFeePerGas": max_priority_fee,
        "chainId": chain_id,
        "type": 2,
    }

    signed_tx_hex = signer.sign_transaction(tx)

    return Erc20ApprovalGasSponsoringInfo(
        from_address=signer.address,
        asset=token_address,
        spender=PERMIT2_ADDRESS,
        amount=str(MAX_UINT256),
        signed_transaction=signed_tx_hex,
        version="1",
    )
