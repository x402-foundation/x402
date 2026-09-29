"""Closed wire schemas and input budgets for Masumi lock requirements."""

import math
import re
from dataclasses import dataclass
from typing import Any, cast

from pycardano import Address, VerificationKeyHash

from ...constants import get_cardano_network_id
from ...limits import (
    MAX_MASUMI_ADMIN_KEYS,
    MAX_MASUMI_COMMITMENT_CONTENT_BYTES,
    MAX_MASUMI_COMMITMENT_PARTS,
    MAX_MASUMI_COSE_BYTES,
    MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES,
)
from ...policy import normalize_confirmation_policy
from .digests import commitment_part_bytes


@dataclass(frozen=True)
class MasumiSchemaResult:
    ok: bool
    extra: dict[str, Any] | None = None
    detail: str | None = None


def _record(value: Any, allowed: str, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    unknown = value.keys() - set(allowed.split())
    if unknown:
        raise ValueError(f"{label} has unknown field {next(iter(unknown))}")
    return cast(dict[str, Any], value)


def _hex(value: Any, length: int | None = None) -> bool:
    return (
        isinstance(value, str)
        and (length is None or len(value) == length)
        and re.fullmatch(r"(?:[0-9a-f]{2})*", value) is not None
    )


def is_posix_ms_string(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= 20
        and re.fullmatch(r"[1-9][0-9]*", value) is not None
    )


def is_key_credential_address_on(value: Any, network: str) -> bool:
    try:
        address = Address.from_primitive(value)
        return (
            isinstance(value, str)
            and isinstance(address.payment_part, VerificationKeyHash)
            and (
                address.staking_part is None
                or isinstance(address.staking_part, VerificationKeyHash)
            )
            and address.network.value == get_cardano_network_id(network)
        )
    except Exception:
        return False


def validate_deployment(value: Any) -> dict[str, Any]:
    value = _record(value, "requiredAdmins adminVkeys cooldownPeriod", "deployment")
    admins = value.get("adminVkeys")
    if (
        not isinstance(admins, list)
        or not 1 <= len(admins) <= MAX_MASUMI_ADMIN_KEYS
        or not all(_hex(k, 56) for k in admins)
    ):
        raise ValueError("deployment.adminVkeys must be a non-empty array of 28-byte lowercase hex")
    required = value.get("requiredAdmins")
    if (
        not isinstance(required, str)
        or len(required) > 3
        or not re.fullmatch(r"[1-9][0-9]*", required)
        or int(required) > len(admins)
    ):
        raise ValueError("deployment.requiredAdmins exceeds adminVkeys length or is invalid")
    cooldown = value.get("cooldownPeriod")
    if (
        not isinstance(cooldown, str)
        or len(cooldown) > 20
        or not re.fullmatch(r"(?:0|[1-9][0-9]*)", cooldown)
    ):
        raise ValueError("deployment.cooldownPeriod must be a non-negative integer string")
    return cast(dict[str, Any], value)


def _json_budget(value: Any) -> None:
    pending = [(value, 0, False)]
    seen: set[int] = set()
    count = size = 0
    while pending:
        item, depth, leaving = pending.pop()
        if leaving:
            seen.remove(id(item))
            continue
        count += 1
        if count > 100_000 or depth > 64:
            raise ValueError("JCS content exceeds the value or nesting limit")
        if item is None or type(item) is bool:
            continue
        if type(item) in (int, float):
            if not math.isfinite(item):
                raise ValueError("JCS content contains a non-finite number")
        elif isinstance(item, str):
            size += len(item.encode("utf-8"))
        elif type(item) in (dict, list):
            if id(item) in seen:
                raise ValueError("JCS content contains a cycle")
            seen.add(id(item))
            pending.append((item, depth, True))
            if isinstance(item, dict):
                for key in item:
                    if not isinstance(key, str):
                        raise ValueError("JCS object keys must be strings")
                    size += len(key.encode("utf-8"))
                values = item.values()
            else:
                values = item
            pending.extend((child, depth + 1, False) for child in values)
        else:
            raise ValueError("JCS content is not valid JSON")
        if size > MAX_MASUMI_COMMITMENT_CONTENT_BYTES:
            raise ValueError("JCS content exceeds the byte limit")


def validate_commitment(value: Any) -> dict[str, Any]:
    value = _record(value, "version algorithm parts digest", "inputCommitment")
    if (
        value.get("version") != "1"
        or value.get("algorithm") != "sha256"
        or not _hex(value.get("digest"), 64)
    ):
        raise ValueError("inputCommitment version, algorithm or digest is invalid")
    parts = value.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= MAX_MASUMI_COMMITMENT_PARTS:
        raise ValueError("inputCommitment.parts must be a non-empty bounded array")
    names: set[str] = set()
    for index, part in enumerate(parts):
        _record(part, "name canonicalization mediaType content digest", f"parts[{index}]")
        name = part.get("name")
        if (
            not isinstance(name, str)
            or not 1 <= len(name.encode("utf-16-le")) // 2 <= 128
            or name in names
        ):
            raise ValueError("inputCommitment part names must be non-empty, bounded and unique")
        names.add(name)
        if part.get("canonicalization") not in ("jcs", "raw") or not _hex(part.get("digest"), 64):
            raise ValueError("Commitment part canonicalization or digest is invalid")
        if "mediaType" in part and (
            not isinstance(part["mediaType"], str)
            or len(part["mediaType"].encode("utf-16-le")) // 2 > 256
        ):
            raise ValueError("Commitment mediaType must be a bounded string")
        if "content" in part:
            if part["canonicalization"] == "jcs":
                _json_budget(part["content"])
            elif len(part["content"]) > (MAX_MASUMI_COMMITMENT_CONTENT_BYTES * 4 + 2) // 3:
                raise ValueError("Raw content exceeds the byte limit")
            if len(commitment_part_bytes(part)) > MAX_MASUMI_COMMITMENT_CONTENT_BYTES:
                raise ValueError("Commitment content exceeds the byte limit")
    return cast(dict[str, Any], value)


def validate_terms(value: Any, network: str, commitment_digest: str) -> dict[str, Any]:
    value = _record(
        value,
        "version paymentType sellerAddress sellerReturnAddress sellerNonce buyerNonce agentIdentifier inputHash payByTime submitResultTime unlockTime externalDisputeUnlockTime",
        "terms",
    )
    if value.get("version") != "1" or value.get("paymentType") != "Web3CardanoV2":
        raise ValueError("terms version or paymentType is invalid")
    for field in ("sellerAddress", "sellerReturnAddress"):
        if field == "sellerAddress" or field in value:
            if not is_key_credential_address_on(value.get(field), network):
                raise ValueError(f"terms.{field} must be a key-credential address on network")
    if not _hex(value.get("sellerNonce"), 64):
        raise ValueError("terms.sellerNonce must be 32-byte lowercase hex")
    nonce = value.get("buyerNonce")
    if not _hex(nonce) or (len(nonce) != 0 and not 14 <= len(nonce) <= 26):
        raise ValueError("terms.buyerNonce must be empty or 14-26 lowercase hex chars")
    agent = value.get("agentIdentifier")
    if agent is not None and (not _hex(agent) or len(agent) > 120):
        raise ValueError("terms.agentIdentifier must be null or lowercase hex")
    if value.get("inputHash") != commitment_digest:
        raise ValueError("terms.inputHash must equal inputCommitment.digest")
    for field in ("payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"):
        if not is_posix_ms_string(value.get(field)):
            raise ValueError(f"terms.{field} must be a positive POSIX-ms integer string")
    return cast(dict[str, Any], value)


def validate_masumi_extra(value: Any, network: str) -> MasumiSchemaResult:
    try:
        _record(
            value,
            "assetTransferMethod confirmationPolicy areFeesSponsored inputCommitment terms referenceKey referenceSignature blockchainIdentifier deployment",
            "extra",
        )
        if value.get("assetTransferMethod") != "masumi":
            raise ValueError("extra.assetTransferMethod must be masumi")
        if (
            "confirmationPolicy" in value
            and normalize_confirmation_policy(value["confirmationPolicy"]) is None
        ):
            raise ValueError("extra.confirmationPolicy must be { l1Confirmations: -1..20 }")
        if "areFeesSponsored" in value and value["areFeesSponsored"] is not False:
            raise ValueError("extra.areFeesSponsored must be false")
        for field in ("referenceKey", "referenceSignature", "blockchainIdentifier"):
            limit = (
                MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES
                if field == "blockchainIdentifier"
                else MAX_MASUMI_COSE_BYTES
            )
            encoded = value.get(field)
            if not _hex(encoded) or not encoded or len(encoded) // 2 > limit:
                raise ValueError(f"extra.{field} must be non-empty bounded lowercase hex")
        commitment = validate_commitment(value.get("inputCommitment"))
        validate_terms(value.get("terms"), network, commitment["digest"])
        if "deployment" in value:
            validate_deployment(value["deployment"])
        return MasumiSchemaResult(True, value)
    except (ValueError, TypeError, OverflowError, RecursionError) as exc:
        return MasumiSchemaResult(False, detail=str(exc))
