"""Derive and validate the payment credential of a parameterized script."""

import re
from hashlib import blake2b
from typing import Any

from pycardano import Address, RawPlutusData, ScriptHash

from ..limits import (
    MAX_CARDANO_SCRIPT_BYTES,
    MAX_CARDANO_SCRIPT_PARAMETER_BYTES,
    MAX_CARDANO_SCRIPT_PARAMETERS,
)
from .script.flat import apply_data_parameters


def script_address_matches(extra: dict[str, Any], pay_to: str) -> bool:
    """Check that payTo carries the expected script payment credential."""
    try:
        credential = Address.from_primitive(pay_to).payment_part
        return isinstance(
            credential, ScriptHash
        ) and credential.payload.hex() == derive_script_hash_hex(extra)
    except Exception:
        return False


def _parameter(parameter: Any) -> tuple[dict[str, Any], int]:
    if not isinstance(parameter, dict):
        raise ValueError("Cardano script parameter must be an object")
    kind, value = parameter.get("type"), parameter.get("value")
    if kind == "bytes":
        if not isinstance(value, str) or not re.fullmatch(r"(?:[0-9a-f]{2})*", value):
            raise ValueError("Cardano bytes parameter must be lowercase even-length hex")
        return {"bytes": value}, len(value) // 2
    if kind == "string" and isinstance(value, str):
        raw = value.encode("utf-8")
        return {"bytes": raw.hex()}, len(raw)
    if kind in ("integer", "bigint"):
        if (
            type(value) not in (str, int)
            or not re.fullmatch(r"(?:0|[1-9]\d*|-[1-9]\d*)", str(value))
            or len(str(value).lstrip("-")) > 128
        ):
            raise ValueError("Cardano integer parameter must use canonical decimal syntax")
        return {"int": int(str(value))}, len(str(value).lstrip("-"))
    if kind == "boolean" and type(value) is bool:
        return {"constructor": int(value), "fields": []}, 1
    raise ValueError("Unsupported Cardano script parameter type or value")


def derive_script_hash_hex(extra: dict[str, Any]) -> str:
    """Apply parameters in JavaScript property order and hash the Plutus script."""
    script = extra.get("script")
    if isinstance(script, dict) and script.get("code"):
        code = script["code"]
        if (
            not isinstance(code, str)
            or not re.fullmatch(r"(?:[0-9a-f]{2})+", code)
            or len(code) // 2 > MAX_CARDANO_SCRIPT_BYTES
        ):
            raise ValueError("Cardano script code is invalid or exceeds the byte limit")
        entries = extra.get("parameters", {})
        if not isinstance(entries, dict) or len(entries) > MAX_CARDANO_SCRIPT_PARAMETERS:
            raise ValueError("Cardano script has too many parameters")
        if any(not isinstance(name, str) for name in entries):
            raise ValueError("Cardano script parameter names must be strings")
        # Object.entries lists array-index keys first; other keys retain insertion order.
        # 2**32 - 1 and noncanonical decimal spellings are ordinary string keys.
        names = sorted(
            entries,
            key=lambda name: (
                (0, int(name))
                if re.fullmatch(r"0|[1-9][0-9]{0,9}", name) and int(name) < 2**32 - 1
                else (1, 0)
            ),
        )
        budget = 0
        parameters = []
        for name in names:
            data, size = _parameter(entries[name])
            budget += len(name.encode("utf-8")) + size
            if budget > MAX_CARDANO_SCRIPT_PARAMETER_BYTES:
                raise ValueError("Cardano script parameters exceed the byte limit")
            parameters.append(RawPlutusData.from_dict(data).to_cbor())
        version = {"plutusV1": 1, "plutusV2": 2, "plutusV3": 3}.get(str(script.get("type")))
        if version is None:
            raise ValueError("Unsupported Cardano script type")
        applied = apply_data_parameters(bytes.fromhex(code), parameters)
        return blake2b(bytes([version]) + applied, digest_size=28).hexdigest()
    digest = extra.get("scriptHash")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{56}", digest):
        raise ValueError("Cardano script payment requires a script or lowercase scriptHash")
    return digest
