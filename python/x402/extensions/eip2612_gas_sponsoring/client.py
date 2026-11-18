"""Client-side EIP-2612 permit signing for Permit2 approval sponsoring."""

from __future__ import annotations

from typing import Any

from ...mechanisms.evm.constants import (
    EIP2612_NONCES_ABI,
    EIP2612_PERMIT_TYPES,
    PERMIT2_ADDRESS,
)
from ...mechanisms.evm.types import TypedDataField
from .types import Eip2612GasSponsoringInfo


def sign_eip2612_permit(
    signer: Any,
    token_address: str,
    token_name: str,
    token_version: str,
    chain_id: int,
    deadline: str,
    amount: str,
) -> Eip2612GasSponsoringInfo:
    """Sign an EIP-2612 permit authorizing Permit2 to spend tokens.

    The signer must implement read_contract (to query nonces) and
    sign_typed_data.

    Args:
        signer: Client signer with read_contract and sign_typed_data.
        token_address: ERC-20 token contract address.
        token_name: Token name for EIP-712 domain.
        token_version: Token version for EIP-712 domain.
        chain_id: Chain ID.
        deadline: Deadline timestamp as decimal string.
        amount: Amount to approve as decimal string.

    Returns:
        Eip2612GasSponsoringInfo ready to attach to payload extensions.
    """
    nonce = signer.read_contract(
        token_address,
        EIP2612_NONCES_ABI,
        "nonces",
        signer.address,
    )

    domain_dict: dict[str, Any] = {
        "name": token_name,
        "version": token_version,
        "chainId": chain_id,
        "verifyingContract": token_address,
    }

    message = {
        "owner": signer.address,
        "spender": PERMIT2_ADDRESS,
        "value": int(amount),
        "nonce": int(nonce),
        "deadline": int(deadline),
    }

    typed_fields: dict[str, list[TypedDataField]] = {
        type_name: [TypedDataField(name=f["name"], type=f["type"]) for f in fields]
        for type_name, fields in EIP2612_PERMIT_TYPES.items()
    }

    sig_bytes = signer.sign_typed_data(
        domain_dict,
        typed_fields,
        "Permit",
        message,
    )
    signature = "0x" + sig_bytes.hex()

    return Eip2612GasSponsoringInfo(
        from_address=signer.address,
        asset=token_address,
        spender=PERMIT2_ADDRESS,
        amount=amount,
        nonce=str(int(nonce)),
        deadline=deadline,
        signature=signature,
        version="1",
    )
