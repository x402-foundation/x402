"""EVM mechanism for x402 payment protocol."""

# Constants
from .constants import (
    AUTHORIZATION_STATE_ABI,
    BALANCE_OF_ABI,
    DEFAULT_DECIMALS,
    DEFAULT_VALIDITY_PERIOD,
    EIP1271_MAGIC_VALUE,
    ERC6492_MAGIC_VALUE,
    ERR_AUTHORIZATION_VALUE_MISMATCH,
    ERR_FAILED_TO_GET_ASSET_INFO,
    ERR_FAILED_TO_GET_NETWORK_CONFIG,
    ERR_FAILED_TO_VERIFY_SIGNATURE,
    ERR_INSUFFICIENT_BALANCE,
    ERR_INVALID_SIGNATURE,
    ERR_MISSING_EIP712_DOMAIN,
    ERR_NETWORK_MISMATCH,
    ERR_NONCE_ALREADY_USED,
    ERR_RECIPIENT_MISMATCH,
    ERR_SMART_WALLET_DEPLOYMENT_FAILED,
    ERR_TRANSACTION_FAILED,
    ERR_UNDEPLOYED_SMART_WALLET,
    ERR_UNSUPPORTED_SCHEME,
    ERR_VALID_AFTER_FUTURE,
    ERR_VALID_BEFORE_EXPIRED,
    IS_VALID_SIGNATURE_ABI,
    NETWORK_CONFIGS,
    SCHEME_EXACT,
    TRANSFER_WITH_AUTHORIZATION_BYTES_ABI,
    TRANSFER_WITH_AUTHORIZATION_VRS_ABI,
    TX_STATUS_FAILED,
    TX_STATUS_SUCCESS,
    AssetInfo,
    NetworkConfig,
)

# EIP-712
from .eip712 import (
    build_typed_data_for_signing,
    hash_domain,
    hash_eip3009_authorization,
    hash_struct,
    hash_typed_data,
)

# ERC-6492
from .erc6492 import (
    has_deployment_info,
    is_eoa_signature,
    is_erc6492_signature,
    parse_erc6492_signature,
)

# Signer protocols
from .signer import ClientEvmSigner, FacilitatorEvmSigner

# Signer implementations
from .signers import EthAccountSigner, EthAccountSignerWithRPC, FacilitatorWeb3Signer

# Types
from .types import (
    AUTHORIZATION_TYPES,
    DOMAIN_TYPES,
    ERC6492SignatureData,
    ExactEIP3009Authorization,
    ExactEIP3009Payload,
    ExactEvmPayloadV1,
    ExactEvmPayloadV2,
    TransactionReceipt,
    TypedDataDomain,
    TypedDataField,
)

# Utilities
from .utils import (
    bytes_to_hex,
    create_nonce,
    create_validity_window,
    format_amount,
    get_asset_info,
    get_evm_chain_id,
    get_network_config,
    hex_to_bytes,
    is_valid_address,
    is_valid_network,
    normalize_address,
    parse_amount,
    parse_money_to_decimal,
)

# V1 legacy constants (re-exported for backward compatibility)
from .v1.constants import (
    V1_NETWORK_CHAIN_IDS,
    V1_NETWORKS,
)

# Verification
from .verify import (
    verify_eip1271_signature,
    verify_eoa_signature,
    verify_universal_signature,
)

__all__ = [
    # Constants
    "SCHEME_EXACT",
    "DEFAULT_DECIMALS",
    "DEFAULT_VALIDITY_PERIOD",
    "TX_STATUS_SUCCESS",
    "TX_STATUS_FAILED",
    "ERC6492_MAGIC_VALUE",
    "EIP1271_MAGIC_VALUE",
    "NETWORK_CONFIGS",
    "V1_NETWORKS",
    "V1_NETWORK_CHAIN_IDS",
    "ERR_INVALID_SIGNATURE",
    "ERR_UNDEPLOYED_SMART_WALLET",
    "ERR_SMART_WALLET_DEPLOYMENT_FAILED",
    "ERR_RECIPIENT_MISMATCH",
    "ERR_AUTHORIZATION_VALUE_MISMATCH",
    "ERR_VALID_BEFORE_EXPIRED",
    "ERR_VALID_AFTER_FUTURE",
    "ERR_NONCE_ALREADY_USED",
    "ERR_INSUFFICIENT_BALANCE",
    "ERR_MISSING_EIP712_DOMAIN",
    "ERR_NETWORK_MISMATCH",
    "ERR_UNSUPPORTED_SCHEME",
    "ERR_TRANSACTION_FAILED",
    "ERR_FAILED_TO_GET_NETWORK_CONFIG",
    "ERR_FAILED_TO_GET_ASSET_INFO",
    "ERR_FAILED_TO_VERIFY_SIGNATURE",
    "TRANSFER_WITH_AUTHORIZATION_VRS_ABI",
    "TRANSFER_WITH_AUTHORIZATION_BYTES_ABI",
    "AUTHORIZATION_STATE_ABI",
    "BALANCE_OF_ABI",
    "IS_VALID_SIGNATURE_ABI",
    "AssetInfo",
    "NetworkConfig",
    # Types
    "ExactEIP3009Authorization",
    "ExactEIP3009Payload",
    "ExactEvmPayloadV1",
    "ExactEvmPayloadV2",
    "TypedDataDomain",
    "TypedDataField",
    "TransactionReceipt",
    "ERC6492SignatureData",
    "AUTHORIZATION_TYPES",
    "DOMAIN_TYPES",
    # Signer protocols
    "ClientEvmSigner",
    "FacilitatorEvmSigner",
    # Signer implementations
    "EthAccountSigner",
    "EthAccountSignerWithRPC",
    "FacilitatorWeb3Signer",
    # Utilities
    "get_evm_chain_id",
    "get_network_config",
    "get_asset_info",
    "is_valid_network",
    "create_nonce",
    "normalize_address",
    "is_valid_address",
    "parse_amount",
    "format_amount",
    "create_validity_window",
    "hex_to_bytes",
    "bytes_to_hex",
    "parse_money_to_decimal",
    # EIP-712
    "hash_typed_data",
    "hash_eip3009_authorization",
    "hash_struct",
    "hash_domain",
    "build_typed_data_for_signing",
    # ERC-6492
    "is_erc6492_signature",
    "parse_erc6492_signature",
    "is_eoa_signature",
    "has_deployment_info",
    # Verification
    "verify_eoa_signature",
    "verify_eip1271_signature",
    "verify_universal_signature",
]
