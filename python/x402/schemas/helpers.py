"""Utility functions for the x402 Python SDK."""

import json
from typing import Any, TypeVar

from .base import Network
from .payments import PaymentPayload, PaymentRequired, PaymentRequirements
from .v1 import PaymentPayloadV1, PaymentRequiredV1, PaymentRequirementsV1


def detect_version(data: bytes | dict[str, Any]) -> int:
    """Extract x402Version from JSON bytes or dict.

    Args:
        data: JSON bytes or parsed dict.

    Returns:
        Protocol version (1 or 2).

    Raises:
        ValueError: If version is missing or invalid.
    """
    if isinstance(data, bytes):
        parsed = json.loads(data)
    else:
        parsed = data

    version = parsed.get("x402Version")
    if version is None:
        raise ValueError("Missing x402Version field")

    if version not in (1, 2):
        raise ValueError(f"Invalid x402Version: {version}")

    return version


def get_scheme_and_network(
    version: int,
    payload: bytes | dict[str, Any],
) -> tuple[str, str]:
    """Extract scheme and network from payment payload.

    Args:
        version: Protocol version (1 or 2).
        payload: Payment payload as bytes or dict.

    Returns:
        Tuple of (scheme, network).

    Raises:
        ValueError: If required fields are missing.
    """
    if isinstance(payload, bytes):
        parsed = json.loads(payload)
    else:
        parsed = payload

    if version == 1:
        # V1: scheme/network at top level
        scheme = parsed.get("scheme")
        network = parsed.get("network")
    else:
        # V2: scheme/network in accepted field
        accepted = parsed.get("accepted", {})
        scheme = accepted.get("scheme")
        network = accepted.get("network")

    if not scheme:
        raise ValueError("Missing scheme field")
    if not network:
        raise ValueError("Missing network field")

    return scheme, network


def match_payload_to_requirements(
    version: int,
    payload: bytes | dict[str, Any],
    requirements: bytes | dict[str, Any],
) -> bool:
    """Check if payment payload matches requirements.

    Args:
        version: Protocol version.
        payload: Payment payload.
        requirements: Payment requirements.

    Returns:
        True if payload matches requirements.
    """
    if isinstance(payload, bytes):
        payload = json.loads(payload)
    if isinstance(requirements, bytes):
        requirements = json.loads(requirements)

    if version == 1:
        # V1: Compare scheme and network
        return payload.get("scheme") == requirements.get("scheme") and payload.get(
            "network"
        ) == requirements.get("network")
    else:
        # V2: Compare scheme, network, amount, asset, payTo
        accepted = payload.get("accepted", {})
        return (
            accepted.get("scheme") == requirements.get("scheme")
            and accepted.get("network") == requirements.get("network")
            and accepted.get("amount") == requirements.get("amount")
            and accepted.get("asset") == requirements.get("asset")
            and accepted.get("payTo") == requirements.get("payTo")
        )


def parse_payment_required(
    data: bytes | dict[str, Any],
) -> PaymentRequired | PaymentRequiredV1:
    """Parse 402 response into appropriate version type.

    Args:
        data: JSON bytes or parsed dict.

    Returns:
        PaymentRequired (V2) or PaymentRequiredV1 (V1).
    """
    version = detect_version(data)

    if isinstance(data, bytes):
        json_str = data.decode("utf-8")
    else:
        json_str = json.dumps(data)

    if version == 1:
        return PaymentRequiredV1.model_validate_json(json_str)
    else:
        return PaymentRequired.model_validate_json(json_str)


def parse_payment_payload(
    data: bytes | dict[str, Any],
) -> PaymentPayload | PaymentPayloadV1:
    """Parse payment payload into appropriate version type.

    Args:
        data: JSON bytes or parsed dict.

    Returns:
        PaymentPayload (V2) or PaymentPayloadV1 (V1).
    """
    version = detect_version(data)

    if isinstance(data, bytes):
        json_str = data.decode("utf-8")
    else:
        json_str = json.dumps(data)

    if version == 1:
        return PaymentPayloadV1.model_validate_json(json_str)
    else:
        return PaymentPayload.model_validate_json(json_str)


def parse_payment_requirements(
    x402_version: int,
    data: bytes | dict[str, Any],
) -> PaymentRequirements | PaymentRequirementsV1:
    """Parse payment requirements based on protocol version.

    Unlike parse_payment_payload which auto-detects version from the data,
    requirements don't contain x402Version - so the version must be provided
    from the corresponding payment payload.

    Args:
        x402_version: Protocol version (1 or 2) from the payment payload.
        data: JSON bytes or parsed dict of payment requirements.

    Returns:
        PaymentRequirements (V2) or PaymentRequirementsV1 (V1).

    Raises:
        ValueError: If version is invalid.
    """
    if x402_version not in (1, 2):
        raise ValueError(f"Invalid x402Version: {x402_version}")

    if isinstance(data, bytes):
        json_str = data.decode("utf-8")
    else:
        json_str = json.dumps(data)

    if x402_version == 1:
        return PaymentRequirementsV1.model_validate_json(json_str)
    else:
        return PaymentRequirements.model_validate_json(json_str)


def matches_network_pattern(network: Network, pattern: Network) -> bool:
    """Check if network matches a pattern (supports wildcards).

    Args:
        network: Specific network (e.g., "eip155:8453").
        pattern: Pattern to match (e.g., "eip155:*" or "eip155:8453").

    Returns:
        True if network matches pattern.

    Examples:
        >>> matches_network_pattern("eip155:8453", "eip155:*")
        True
        >>> matches_network_pattern("eip155:8453", "eip155:8453")
        True
        >>> matches_network_pattern("eip155:8453", "solana:*")
        False
    """
    if pattern.endswith(":*"):
        return network.startswith(pattern[:-1])
    return pattern == network


def derive_network_pattern(networks: list[Network]) -> Network:
    """Derive common pattern from list of networks.

    If all networks share same namespace, returns wildcard pattern.
    Otherwise returns first network.

    Args:
        networks: List of networks.

    Returns:
        Derived pattern.

    Raises:
        ValueError: If networks list is empty.

    Examples:
        >>> derive_network_pattern(["eip155:8453", "eip155:84532"])
        'eip155:*'
        >>> derive_network_pattern(["eip155:8453", "solana:mainnet"])
        'eip155:8453'
    """
    if not networks:
        raise ValueError("At least one network required")

    namespaces = {n.split(":")[0] for n in networks}
    if len(namespaces) == 1:
        return f"{namespaces.pop()}:*"
    return networks[0]


T = TypeVar("T")


def find_schemes_by_network(
    schemes: dict[Network, dict[str, T]],
    network: Network,
) -> dict[str, T] | None:
    """Find schemes registered for a network (with wildcard matching).

    Args:
        schemes: Map of network -> (scheme -> implementation).
        network: Network to find schemes for.

    Returns:
        Dict of scheme -> implementation, or None if not found.
    """
    # Try exact match first
    if network in schemes:
        return schemes[network]

    # Try wildcard patterns
    for pattern, scheme_map in schemes.items():
        if matches_network_pattern(network, pattern):
            return scheme_map

    return None
