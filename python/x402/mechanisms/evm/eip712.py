"""EIP-712 typed data hashing utilities."""

from typing import Any

try:
    from eth_abi import encode
    from eth_utils import keccak
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .types import (
    AUTHORIZATION_TYPES,
    DOMAIN_TYPES,
    ExactEIP3009Authorization,
    TypedDataDomain,
)


def _encode_type(type_name: str, types: dict[str, list[dict[str, str]]]) -> str:
    """Encode type string for EIP-712.

    Args:
        type_name: Name of the type.
        types: All type definitions.

    Returns:
        Encoded type string.
    """
    # Get direct type definition
    if type_name not in types:
        return ""

    fields = types[type_name]
    field_strs = [f"{f['type']} {f['name']}" for f in fields]
    return f"{type_name}({','.join(field_strs)})"


def _type_hash(type_name: str, types: dict[str, list[dict[str, str]]]) -> bytes:
    """Compute type hash for EIP-712.

    Args:
        type_name: Name of the type.
        types: All type definitions.

    Returns:
        32-byte type hash.
    """
    encoded = _encode_type(type_name, types)
    return keccak(text=encoded)


def _encode_data(
    type_name: str,
    types: dict[str, list[dict[str, str]]],
    data: dict[str, Any],
) -> bytes:
    """Encode data for EIP-712 struct hash.

    Args:
        type_name: Name of the type.
        types: All type definitions.
        data: Data to encode.

    Returns:
        Encoded data bytes.
    """
    if type_name not in types:
        raise ValueError(f"Unknown type: {type_name}")

    fields = types[type_name]
    encoded_values: list[bytes] = [_type_hash(type_name, types)]

    for field in fields:
        name = field["name"]
        field_type = field["type"]
        value = data.get(name)

        if value is None:
            raise ValueError(f"Missing field: {name}")

        if field_type == "string":
            encoded_values.append(keccak(text=str(value)))
        elif field_type == "bytes":
            if isinstance(value, bytes):
                encoded_values.append(keccak(value))
            else:
                encoded_values.append(keccak(bytes.fromhex(str(value).removeprefix("0x"))))
        elif field_type == "bytes32":
            if isinstance(value, bytes):
                encoded_values.append(value)
            else:
                encoded_values.append(bytes.fromhex(str(value).removeprefix("0x")))
        elif field_type == "address":
            encoded_values.append(encode(["address"], [value]))
        elif field_type.startswith("uint") or field_type.startswith("int"):
            encoded_values.append(encode([field_type], [int(value)]))
        elif field_type == "bool":
            encoded_values.append(encode(["bool"], [bool(value)]))
        else:
            # Nested struct or array - not commonly needed for EIP-3009
            raise ValueError(f"Unsupported field type: {field_type}")

    return b"".join(encoded_values)


def hash_struct(
    type_name: str,
    types: dict[str, list[dict[str, str]]],
    data: dict[str, Any],
) -> bytes:
    """Compute struct hash for EIP-712.

    Args:
        type_name: Name of the type.
        types: All type definitions.
        data: Struct data.

    Returns:
        32-byte struct hash.
    """
    encoded = _encode_data(type_name, types, data)
    return keccak(encoded)


def hash_domain(domain: TypedDataDomain) -> bytes:
    """Compute domain separator hash.

    Args:
        domain: EIP-712 domain.

    Returns:
        32-byte domain separator hash.
    """
    domain_data = {
        "name": domain.name,
        "version": domain.version,
        "chainId": domain.chain_id,
        "verifyingContract": domain.verifying_contract,
    }
    return hash_struct("EIP712Domain", DOMAIN_TYPES, domain_data)


def hash_typed_data(
    domain: TypedDataDomain,
    types: dict[str, list[dict[str, str]]],
    primary_type: str,
    message: dict[str, Any],
) -> bytes:
    """Hash EIP-712 typed data.

    Creates hash: keccak256("\\x19\\x01" + domainSeparator + structHash)

    Args:
        domain: EIP-712 domain separator.
        types: Type definitions.
        primary_type: Primary type being hashed.
        message: Message data.

    Returns:
        32-byte hash suitable for signing/verification.
    """
    # Merge domain types with provided types
    all_types = {**DOMAIN_TYPES, **types}

    domain_separator = hash_domain(domain)
    struct_hash = hash_struct(primary_type, all_types, message)

    # EIP-712 final hash
    return keccak(b"\x19\x01" + domain_separator + struct_hash)


def hash_eip3009_authorization(
    authorization: ExactEIP3009Authorization,
    chain_id: int,
    verifying_contract: str,
    token_name: str,
    token_version: str,
) -> bytes:
    """Hash EIP-3009 TransferWithAuthorization message.

    Convenience wrapper around hash_typed_data with EIP-3009 types.

    Args:
        authorization: Authorization data.
        chain_id: Chain ID.
        verifying_contract: Token contract address.
        token_name: Token name for domain.
        token_version: Token version for domain.

    Returns:
        32-byte hash for signing/verification.
    """
    domain = TypedDataDomain(
        name=token_name,
        version=token_version,
        chain_id=chain_id,
        verifying_contract=verifying_contract,
    )

    message = {
        "from": authorization.from_address,
        "to": authorization.to,
        "value": int(authorization.value),
        "validAfter": int(authorization.valid_after),
        "validBefore": int(authorization.valid_before),
        "nonce": bytes.fromhex(authorization.nonce.removeprefix("0x")),
    }

    return hash_typed_data(domain, AUTHORIZATION_TYPES, "TransferWithAuthorization", message)


def build_typed_data_for_signing(
    authorization: ExactEIP3009Authorization,
    chain_id: int,
    verifying_contract: str,
    token_name: str,
    token_version: str,
) -> tuple[TypedDataDomain, dict[str, list[dict[str, str]]], str, dict[str, Any]]:
    """Build typed data components for signing.

    Returns all components needed for sign_typed_data.

    Args:
        authorization: Authorization data.
        chain_id: Chain ID.
        verifying_contract: Token contract address.
        token_name: Token name for domain.
        token_version: Token version for domain.

    Returns:
        Tuple of (domain, types, primary_type, message).
    """
    domain = TypedDataDomain(
        name=token_name,
        version=token_version,
        chain_id=chain_id,
        verifying_contract=verifying_contract,
    )

    message = {
        "from": authorization.from_address,
        "to": authorization.to,
        "value": int(authorization.value),
        "validAfter": int(authorization.valid_after),
        "validBefore": int(authorization.valid_before),
        "nonce": bytes.fromhex(authorization.nonce.removeprefix("0x")),
    }

    return (domain, AUTHORIZATION_TYPES, "TransferWithAuthorization", message)
