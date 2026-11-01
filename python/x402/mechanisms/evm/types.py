"""EVM-specific payload and data types."""

import re
from dataclasses import dataclass
from typing import Any

_UINT256_MAX = 2**256 - 1
# The digit cap also keeps int() below Python's 4300-digit conversion limit.
_UINT256_DECIMAL_RE = re.compile(r"[0-9]{1,78}")
_BYTES32_HEX_RE = re.compile(r"(0x)?[0-9a-fA-F]{64}")


@dataclass
class ExactEIP3009Authorization:
    """EIP-3009 TransferWithAuthorization data."""

    from_address: str  # 'from' is reserved in Python
    to: str
    value: str  # Amount in smallest unit as string
    valid_after: str  # Unix timestamp as string
    valid_before: str  # Unix timestamp as string
    nonce: str  # 32-byte nonce as hex string (0x...)


@dataclass
class ExactEIP3009Payload:
    """Exact payment payload for EVM networks."""

    authorization: ExactEIP3009Authorization
    signature: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization.

        Returns:
            Dict with authorization and signature fields.
        """
        result: dict[str, Any] = {
            "authorization": {
                "from": self.authorization.from_address,
                "to": self.authorization.to,
                "value": self.authorization.value,
                "validAfter": self.authorization.valid_after,
                "validBefore": self.authorization.valid_before,
                "nonce": self.authorization.nonce,
            }
        }
        if self.signature:
            result["signature"] = self.signature
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExactEIP3009Payload":
        """Create from dictionary.

        Args:
            data: Dict with authorization and optional signature.

        Returns:
            ExactEIP3009Payload instance.
        """
        auth = data.get("authorization", {})
        return cls(
            authorization=ExactEIP3009Authorization(
                from_address=auth.get("from", ""),
                to=auth.get("to", ""),
                value=auth.get("value", ""),
                valid_after=auth.get("validAfter", ""),
                valid_before=auth.get("validBefore", ""),
                nonce=auth.get("nonce", ""),
            ),
            signature=data.get("signature"),
        )


# Type aliases for V1/V2 compatibility
ExactEvmPayloadV1 = ExactEIP3009Payload
ExactEvmPayloadV2 = ExactEIP3009Payload


@dataclass
class ExactPermit2Witness:
    """Witness data for Permit2 PermitWitnessTransferFrom."""

    to: str  # Recipient address
    valid_after: str  # Unix timestamp as string (lower time bound)


@dataclass
class ExactPermit2TokenPermissions:
    """Token permissions for Permit2."""

    token: str  # ERC-20 token address
    amount: str  # Amount in smallest unit as string


@dataclass
class ExactPermit2Authorization:
    """Permit2 PermitWitnessTransferFrom data."""

    from_address: str  # 'from' field (payer address)
    permitted: ExactPermit2TokenPermissions
    spender: str  # x402ExactPermit2Proxy address
    nonce: str  # Random uint256 as decimal string
    deadline: str  # Unix timestamp as string (upper time bound)
    witness: ExactPermit2Witness


@dataclass
class ExactPermit2Payload:
    """Exact payment payload for Permit2 flow."""

    permit2_authorization: ExactPermit2Authorization
    signature: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization.

        Returns:
            Dict with permit2Authorization and signature fields.
        """
        result: dict[str, Any] = {
            "permit2Authorization": {
                "from": self.permit2_authorization.from_address,
                "permitted": {
                    "token": self.permit2_authorization.permitted.token,
                    "amount": self.permit2_authorization.permitted.amount,
                },
                "spender": self.permit2_authorization.spender,
                "nonce": self.permit2_authorization.nonce,
                "deadline": self.permit2_authorization.deadline,
                "witness": {
                    "to": self.permit2_authorization.witness.to,
                    "validAfter": self.permit2_authorization.witness.valid_after,
                },
            }
        }
        if self.signature:
            result["signature"] = self.signature
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExactPermit2Payload":
        """Create from dictionary.

        Args:
            data: Dict with permit2Authorization and optional signature.

        Returns:
            ExactPermit2Payload instance.
        """
        auth = data.get("permit2Authorization", {})
        permitted = auth.get("permitted", {})
        witness = auth.get("witness", {})
        return cls(
            permit2_authorization=ExactPermit2Authorization(
                from_address=auth.get("from", ""),
                permitted=ExactPermit2TokenPermissions(
                    token=permitted.get("token", ""),
                    amount=permitted.get("amount", ""),
                ),
                spender=auth.get("spender", ""),
                nonce=auth.get("nonce", ""),
                deadline=auth.get("deadline", ""),
                witness=ExactPermit2Witness(
                    to=witness.get("to", ""),
                    valid_after=witness.get("validAfter", ""),
                ),
            ),
            signature=data.get("signature"),
        )


def is_permit2_payload(payload: dict[str, Any]) -> bool:
    """Check if a raw payload dict is a Permit2 payload.

    Args:
        payload: Raw payload dictionary.

    Returns:
        True if the payload contains permit2Authorization key.
    """
    return "permit2Authorization" in payload


@dataclass
class UptoPermit2Witness:
    """Witness data for upto Permit2 PermitWitnessTransferFrom.

    Includes facilitator field for access control (vs exact which has only to + validAfter).
    """

    to: str
    facilitator: str
    valid_after: str


@dataclass
class UptoPermit2Authorization:
    """Upto Permit2 PermitWitnessTransferFrom data."""

    from_address: str
    permitted: ExactPermit2TokenPermissions
    spender: str
    nonce: str
    deadline: str
    witness: UptoPermit2Witness


@dataclass
class UptoPermit2Payload:
    """Upto payment payload for Permit2 flow."""

    permit2_authorization: UptoPermit2Authorization
    signature: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "permit2Authorization": {
                "from": self.permit2_authorization.from_address,
                "permitted": {
                    "token": self.permit2_authorization.permitted.token,
                    "amount": self.permit2_authorization.permitted.amount,
                },
                "spender": self.permit2_authorization.spender,
                "nonce": self.permit2_authorization.nonce,
                "deadline": self.permit2_authorization.deadline,
                "witness": {
                    "to": self.permit2_authorization.witness.to,
                    "facilitator": self.permit2_authorization.witness.facilitator,
                    "validAfter": self.permit2_authorization.witness.valid_after,
                },
            }
        }
        if self.signature:
            result["signature"] = self.signature
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UptoPermit2Payload":
        auth = data.get("permit2Authorization", {})
        permitted = auth.get("permitted", {})
        witness = auth.get("witness", {})
        return cls(
            permit2_authorization=UptoPermit2Authorization(
                from_address=auth.get("from", ""),
                permitted=ExactPermit2TokenPermissions(
                    token=permitted.get("token", ""),
                    amount=permitted.get("amount", ""),
                ),
                spender=auth.get("spender", ""),
                nonce=auth.get("nonce", ""),
                deadline=auth.get("deadline", ""),
                witness=UptoPermit2Witness(
                    to=witness.get("to", ""),
                    facilitator=witness.get("facilitator", ""),
                    valid_after=witness.get("validAfter", ""),
                ),
            ),
            signature=data.get("signature"),
        )


def is_upto_permit2_payload(payload: dict[str, Any]) -> bool:
    """Check if a raw payload dict is an upto Permit2 payload.

    Distinguishes from exact Permit2 by checking for the facilitator field in witness.
    """
    auth = payload.get("permit2Authorization")
    if not isinstance(auth, dict):
        return False
    witness = auth.get("witness")
    if not isinstance(witness, dict):
        return False
    return "facilitator" in witness


def is_eip3009_payload(payload: dict[str, Any]) -> bool:
    """Check if a raw payload dict is an EIP-3009 payload.

    Args:
        payload: Raw payload dictionary.

    Returns:
        True if the payload contains authorization key.
    """
    return "authorization" in payload


def _is_uint256_string(value: Any) -> bool:
    return (
        isinstance(value, str)
        and _UINT256_DECIMAL_RE.fullmatch(value) is not None
        and int(value) <= _UINT256_MAX
    )


def _validate_signature(payload: dict[str, Any]) -> str | None:
    signature = payload.get("signature")
    if signature is not None and not isinstance(signature, str):
        return "signature must be a string"
    return None


def _validate_eip3009_authorization(authorization: Any) -> str | None:
    if not isinstance(authorization, dict):
        return "authorization must be an object"
    for key in ("from", "to"):
        if not isinstance(authorization.get(key), str):
            return f"authorization.{key} must be a string"
    nonce = authorization.get("nonce")
    if not isinstance(nonce, str) or _BYTES32_HEX_RE.fullmatch(nonce) is None:
        return "authorization.nonce must be a 32-byte hex string"
    for key in ("value", "validAfter", "validBefore"):
        if not _is_uint256_string(authorization.get(key)):
            return f"authorization.{key} must be a uint256 decimal string"
    return None


def _validate_permit2_authorization(authorization: Any) -> str | None:
    if not isinstance(authorization, dict):
        return "permit2Authorization must be an object"
    permitted = authorization.get("permitted")
    if not isinstance(permitted, dict):
        return "permit2Authorization.permitted must be an object"
    witness = authorization.get("witness")
    if not isinstance(witness, dict):
        return "permit2Authorization.witness must be an object"
    strings = {
        "from": authorization.get("from"),
        "spender": authorization.get("spender"),
        "permitted.token": permitted.get("token"),
        "witness.to": witness.get("to"),
    }
    for name, value in strings.items():
        if not isinstance(value, str):
            return f"permit2Authorization.{name} must be a string"
    numbers = {
        "nonce": authorization.get("nonce"),
        "deadline": authorization.get("deadline"),
        "permitted.amount": permitted.get("amount"),
        "witness.validAfter": witness.get("validAfter"),
    }
    for name, value in numbers.items():
        if not _is_uint256_string(value):
            return f"permit2Authorization.{name} must be a uint256 decimal string"
    return None


def validate_eip3009_payload(payload: dict[str, Any]) -> str | None:
    """Check that a raw EIP-3009 payload has the field types verify and settle parse.

    Args:
        payload: Raw payload dictionary.

    Returns:
        None if well-formed, otherwise a message naming the first malformed field.
    """
    return _validate_signature(payload) or _validate_eip3009_authorization(
        payload.get("authorization")
    )


def validate_exact_evm_payload(payload: dict[str, Any]) -> str | None:
    """Check that a raw exact EVM payload has the field types verify and settle parse.

    The payload is client-supplied, so malformed input must be rejected as invalid
    instead of raising. Permit2 and EIP-3009 payloads are told apart the same way
    verify and settle route them.

    Args:
        payload: Raw payload dictionary.

    Returns:
        None if well-formed, otherwise a message naming the first malformed field.
    """
    if is_permit2_payload(payload):
        return _validate_signature(payload) or _validate_permit2_authorization(
            payload["permit2Authorization"]
        )
    return validate_eip3009_payload(payload)


def get_payload_payer(payload: dict[str, Any]) -> str | None:
    """Get the payer address from a raw exact EVM payload without validating it.

    Args:
        payload: Raw payload dictionary.

    Returns:
        The authorization's ``from`` value if it is a string, otherwise None.
    """
    key = "permit2Authorization" if is_permit2_payload(payload) else "authorization"
    authorization = payload.get(key)
    payer = authorization.get("from") if isinstance(authorization, dict) else None
    return payer if isinstance(payer, str) else None


@dataclass
class TypedDataDomain:
    """EIP-712 domain separator."""

    name: str
    version: str
    chain_id: int
    verifying_contract: str


@dataclass
class TypedDataField:
    """Field definition for EIP-712 types."""

    name: str
    type: str


@dataclass
class TransactionReceipt:
    """Transaction receipt from blockchain."""

    status: int
    block_number: int
    tx_hash: str
    logs: list[Any] | None = None


@dataclass
class ERC6492SignatureData:
    """Parsed ERC-6492 signature components."""

    factory: bytes  # 20-byte factory address (zero if not ERC-6492)
    factory_calldata: bytes  # Deployment calldata (empty if not ERC-6492)
    inner_signature: bytes  # The actual signature (EIP-1271 or EOA)
    # Whether the signer had bytecode, as determined by verify_universal_signature.
    # Zero value elsewhere.
    code_deployed: bool = False


# EIP-712 authorization types for signing
AUTHORIZATION_TYPES: dict[str, list[dict[str, str]]] = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ]
}

# EIP-712 domain types
DOMAIN_TYPES: dict[str, list[dict[str, str]]] = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ]
}
