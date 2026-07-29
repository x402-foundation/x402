"""Type definitions for the Sign-In-With-X (SIWX) extension."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

SIGN_IN_WITH_X = "sign-in-with-x"

SignatureScheme = Literal["eip191", "eip1271", "eip6492", "siws"]
SignatureType = Literal["eip191", "ed25519"]


class SupportedChain(BaseModel):
    """Supported chain configuration in supportedChains."""

    chain_id: str = Field(alias="chainId")
    type: SignatureType
    signature_scheme: SignatureScheme | None = Field(default=None, alias="signatureScheme")

    model_config = {"populate_by_name": True}


class SIWxExtensionInfo(BaseModel):
    """Server-declared extension info in PaymentRequired.extensions."""

    domain: str = ""
    uri: str = ""
    statement: str | None = None
    version: str = "1"
    nonce: str | None = None
    issued_at: str | None = Field(default=None, alias="issuedAt")
    expiration_time: str | None = Field(default=None, alias="expirationTime")
    not_before: str | None = Field(default=None, alias="notBefore")
    request_id: str | None = Field(default=None, alias="requestId")
    resources: list[str] | None = None

    model_config = {"populate_by_name": True}


class SIWxExtensionSchema(BaseModel):
    """JSON Schema for SIWX extension validation."""

    schema_: str = Field(alias="$schema")
    type: str
    properties: dict[str, Any]
    required: list[str]

    model_config = {"populate_by_name": True}


class SIWxExtension(BaseModel):
    """Complete SIWX extension structure."""

    info: SIWxExtensionInfo
    supported_chains: list[SupportedChain] = Field(default_factory=list, alias="supportedChains")
    schema_: dict[str, Any] = Field(alias="schema")

    model_config = {"populate_by_name": True}


class SIWxPayload(BaseModel):
    """Client proof payload sent in SIGN-IN-WITH-X header."""

    domain: str
    address: str
    uri: str
    version: str
    chain_id: str = Field(alias="chainId")
    type: SignatureType
    nonce: str
    issued_at: str = Field(alias="issuedAt")
    statement: str | None = None
    expiration_time: str | None = Field(default=None, alias="expirationTime")
    not_before: str | None = Field(default=None, alias="notBefore")
    request_id: str | None = Field(default=None, alias="requestId")
    resources: list[str] | None = None
    signature_scheme: SignatureScheme | None = Field(default=None, alias="signatureScheme")
    signature: str

    model_config = {"populate_by_name": True}


class DeclareSIWxOptions(BaseModel):
    """Options for declaring SIWX extension on server."""

    statement: str | None = None
    version: str | None = None
    network: str | list[str] | None = None
    expiration_seconds: int | None = Field(default=None, alias="expirationSeconds")

    model_config = {"populate_by_name": True}


SIWxValidationCode = Literal[
    "invalid_siwx_domain_mismatch",
    "invalid_siwx_uri_mismatch",
    "invalid_siwx_issued_at",
    "invalid_siwx_issued_at_too_old",
    "invalid_siwx_issued_at_in_future",
    "invalid_siwx_expiration_time",
    "invalid_siwx_expired",
    "invalid_siwx_not_before",
    "invalid_siwx_not_yet_valid",
    "invalid_siwx_nonce",
]

SIWxVerifyCode = Literal[
    "invalid_siwx_signature",
    "invalid_siwx_chain_id",
    "invalid_siwx_unsupported_chain",
    "invalid_siwx_malformed_signature",
    "invalid_siwx_verifier_error",
]

SIWxErrorCode = SIWxValidationCode | SIWxVerifyCode


class SIWxValidationResult(BaseModel):
    """Validation result from validate_siwx_message."""

    is_valid: bool
    invalid_reason: SIWxValidationCode | None = None
    invalid_message: str | None = None


class SIWxValidationOptions(BaseModel):
    """Options for message validation."""

    max_age: int | None = Field(default=None, alias="maxAge")
    check_nonce: Any | None = Field(default=None, alias="checkNonce")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class SIWxVerifyResult(BaseModel):
    """Result from signature verification."""

    is_valid: bool
    payer: str | None = None
    invalid_reason: SIWxVerifyCode | None = None
    invalid_message: str | None = None


class EVMMessageVerifier(Protocol):
    """EVM message verifier for smart wallet support."""

    async def __call__(
        self,
        *,
        address: str,
        message: str,
        signature: str,
    ) -> bool: ...


@dataclass
class SIWxVerifyOptions:
    """Options for SIWX signature verification."""

    evm_verifier: Any | None = None
    provider: Any | None = None
