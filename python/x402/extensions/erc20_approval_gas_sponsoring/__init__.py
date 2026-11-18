"""ERC-20 Approval Gas Sponsoring Extension for x402 Permit2 flows."""

from .facilitator import (
    extract_erc20_approval_gas_sponsoring_info,
    validate_erc20_approval_for_payment,
    validate_erc20_approval_gas_sponsoring_info,
)
from .server import declare_erc20_approval_gas_sponsoring_extension
from .types import (
    ERC20_APPROVAL_GAS_SPONSORING_KEY,
    Erc20ApprovalFacilitatorExtension,
    Erc20ApprovalGasSponsoringInfo,
    Erc20ApprovalGasSponsoringSigner,
    TransactionRequest,
    WriteContractCall,
)

__all__ = [
    "ERC20_APPROVAL_GAS_SPONSORING_KEY",
    "Erc20ApprovalFacilitatorExtension",
    "Erc20ApprovalGasSponsoringInfo",
    "Erc20ApprovalGasSponsoringSigner",
    "TransactionRequest",
    "WriteContractCall",
    "declare_erc20_approval_gas_sponsoring_extension",
    "extract_erc20_approval_gas_sponsoring_info",
    "validate_erc20_approval_for_payment",
    "validate_erc20_approval_gas_sponsoring_info",
]
