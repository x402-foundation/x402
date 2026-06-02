"""Sign-In-With-X extension for x402 v2."""

from .client import CompleteSIWxInfo, create_siwx_payload
from .declare import declare_siwx_extension, get_signature_type
from .encode import encode_siwx_header
from .evm import (
    extract_evm_chain_id,
    format_siwe_message,
    is_evm_signer,
    verify_evm_signature,
)
from .hooks import (
    CreateSIWxClientExtensionOptions,
    CreateSIWxHookOptions,
    SIWxHookEvent,
    create_siwx_client_extension,
    create_siwx_client_hook,
    create_siwx_request_hook,
    create_siwx_settle_hook,
)
from .message import create_siwx_message
from .parse import parse_siwx_header
from .schema import build_siwx_schema
from .server import (
    CreateSIWxResourceServerExtensionOptions,
    create_siwx_resource_server_extension,
)
from .sign import (
    SIWxSigner,
    get_evm_address,
    get_solana_address,
    sign_evm_message,
    sign_solana_message,
)
from .solana import (
    SOLANA_DEVNET,
    SOLANA_MAINNET,
    SOLANA_TESTNET,
    decode_base58,
    encode_base58,
    extract_solana_chain_reference,
    format_siws_message,
    is_solana_signer,
    verify_solana_signature,
)
from .storage import InMemorySIWxStorage, SIWxStorage
from .types import (
    SIGN_IN_WITH_X,
    DeclareSIWxOptions,
    EVMMessageVerifier,
    SignatureScheme,
    SignatureType,
    SIWxExtension,
    SIWxExtensionInfo,
    SIWxExtensionSchema,
    SIWxPayload,
    SIWxValidationOptions,
    SIWxValidationResult,
    SIWxVerifyOptions,
    SIWxVerifyResult,
    SupportedChain,
)
from .validate import validate_siwx_message
from .verify import verify_siwx_signature

__all__ = [
    "SIGN_IN_WITH_X",
    "SOLANA_MAINNET",
    "SOLANA_DEVNET",
    "SOLANA_TESTNET",
    "SIWxExtension",
    "SIWxExtensionInfo",
    "SIWxExtensionSchema",
    "SIWxPayload",
    "DeclareSIWxOptions",
    "SignatureScheme",
    "SignatureType",
    "SupportedChain",
    "SIWxValidationResult",
    "SIWxValidationOptions",
    "SIWxVerifyResult",
    "EVMMessageVerifier",
    "SIWxVerifyOptions",
    "CompleteSIWxInfo",
    "SIWxHookEvent",
    "declare_siwx_extension",
    "create_siwx_resource_server_extension",
    "CreateSIWxResourceServerExtensionOptions",
    "parse_siwx_header",
    "validate_siwx_message",
    "verify_siwx_signature",
    "build_siwx_schema",
    "create_siwx_message",
    "create_siwx_payload",
    "encode_siwx_header",
    "create_siwx_client_extension",
    "CreateSIWxClientExtensionOptions",
    "create_siwx_client_hook",
    "create_siwx_settle_hook",
    "create_siwx_request_hook",
    "CreateSIWxHookOptions",
    "SIWxStorage",
    "InMemorySIWxStorage",
    "format_siwe_message",
    "verify_evm_signature",
    "extract_evm_chain_id",
    "is_evm_signer",
    "format_siws_message",
    "verify_solana_signature",
    "decode_base58",
    "encode_base58",
    "extract_solana_chain_reference",
    "is_solana_signer",
    "get_evm_address",
    "get_solana_address",
    "sign_evm_message",
    "sign_solana_message",
    "SIWxSigner",
    "get_signature_type",
]
