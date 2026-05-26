"""Receiver-authorizer EIP-712 signing helpers (ClaimBatch + Refund)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_account.signers.local import LocalAccount
    from eth_utils import to_checksum_address
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from ..utils import get_evm_chain_id
from .constants import CLAIM_BATCH_TYPES, REFUND_TYPES
from .types import AuthorizerSigner, VoucherClaim
from .utils import (
    coerce_bytes32,
    compute_channel_id,
    get_batch_settlement_eip712_domain,
)

if TYPE_CHECKING:
    pass


class LocalAuthorizerSigner:
    """In-process AuthorizerSigner backed by an `eth_account` LocalAccount."""

    def __init__(self, account: LocalAccount | str):
        if isinstance(account, str):
            account = Account.from_key(account)
        self._account = account

    @property
    def address(self) -> str:
        return to_checksum_address(self._account.address)

    def sign_typed_data(
        self,
        domain: dict[str, Any],
        types: dict[str, list[dict[str, str]]],
        primary_type: str,
        message: dict[str, Any],
    ) -> str:
        # eth_account encode_typed_data infers the primary type as the first
        # entry in `types` that is not referenced as a field-type of another;
        # we always pass the full type definition, so this just works.
        signable = encode_typed_data(
            domain_data=domain,
            message_types=types,
            message_data=message,
        )
        signed = self._account.sign_message(signable)
        return (
            signed.signature.hex()
            if signed.signature.hex().startswith("0x")
            else ("0x" + signed.signature.hex())
        )


def sign_claim_batch(
    signer: AuthorizerSigner,
    claims: list[VoucherClaim],
    network: str,
) -> str:
    """Sign a `ClaimBatch` EIP-712 digest for `claimWithSignature()`.

    Args:
        signer: AuthorizerSigner holding the `receiverAuthorizer` key.
        claims: Voucher claims to include in the batch.
        network: CAIP-2 network identifier (e.g. `"eip155:84532"`).

    Returns:
        0x-prefixed EIP-712 signature over `ClaimBatch(ClaimEntry[] claims)`.
    """
    chain_id = get_evm_chain_id(network)

    claim_entries: list[dict[str, Any]] = []
    for c in claims:
        cid = compute_channel_id(c.channel, chain_id)
        claim_entries.append(
            {
                "channelId": coerce_bytes32(cid),
                "maxClaimableAmount": int(c.max_claimable_amount),
                "totalClaimed": int(c.total_claimed),
            }
        )

    return signer.sign_typed_data(
        domain=get_batch_settlement_eip712_domain(chain_id),
        types=CLAIM_BATCH_TYPES,
        primary_type="ClaimBatch",
        message={"claims": claim_entries},
    )


def sign_refund(
    signer: AuthorizerSigner,
    channel_id: str,
    amount: str | int,
    nonce: str | int,
    network: str,
) -> str:
    """Sign a `Refund` EIP-712 digest for `refundWithSignature()`."""
    chain_id = get_evm_chain_id(network)
    return signer.sign_typed_data(
        domain=get_batch_settlement_eip712_domain(chain_id),
        types=REFUND_TYPES,
        primary_type="Refund",
        message={
            "channelId": coerce_bytes32(channel_id),
            "nonce": int(nonce),
            "amount": int(amount),
        },
    )


__all__ = [
    "AuthorizerSigner",
    "LocalAuthorizerSigner",
    "sign_claim_batch",
    "sign_refund",
]
