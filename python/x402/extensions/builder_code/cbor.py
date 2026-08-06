"""ERC-8021 Schema 2 CBOR encoding for builder code suffixes.

Schema 2 suffix format::

    [cbor_data (variable)] [suffix_data_length (2 bytes)] [schema_id = 0x02 (1 byte)] [ERC-8021 marker (16 bytes)]

The CBOR payload uses single-letter keys:
- ``a`` — app builder code (string)
- ``w`` — wallet/facilitator builder code (string)
- ``s`` — service codes (string array)

Hand-rolled CBOR keeps the extension dependency-free (stdlib only).
"""

from __future__ import annotations

from .types import ERC_8021_MARKER, SCHEMA_2_ID, BuilderCodeExtensionData

# CBOR major types used by this encoder.
_MAJOR_TEXT_STRING = 3
_MAJOR_ARRAY = 4
_MAJOR_MAP = 5


def _normalize_service_codes(s: str | list[str] | None) -> list[str]:
    """Normalize the ``s`` field (string or list of strings) into a list."""
    if isinstance(s, str):
        return [s]
    if isinstance(s, list):
        return s
    return []


def _encode_major_type(major_type: int, value: int) -> bytes:
    """Encode a CBOR major type with its argument value.

    Rules:
    - 0-23: single byte ``(major_type << 5) | value``
    - 24-255: two bytes ``(major_type << 5) | 24``, value
    - 256-65535: three bytes ``(major_type << 5) | 25``, value (big-endian)
    """
    mt = major_type << 5
    if value <= 23:
        return bytes([mt | value])
    if value <= 0xFF:
        return bytes([mt | 24, value])
    if value <= 0xFFFF:
        return bytes([mt | 25, (value >> 8) & 0xFF, value & 0xFF])
    raise ValueError(f"CBOR value too large: {value}")


def _encode_string(value: str) -> bytes:
    """Encode a CBOR text string (major type 3)."""
    encoded = value.encode("utf-8")
    return _encode_major_type(_MAJOR_TEXT_STRING, len(encoded)) + encoded


def _encode_array(values: list[str]) -> bytes:
    """Encode a CBOR array of text strings (major type 4)."""
    result = _encode_major_type(_MAJOR_ARRAY, len(values))
    for value in values:
        result += _encode_string(value)
    return result


def _encode_cbor_map(data: BuilderCodeExtensionData) -> bytes:
    """Encode a minimal CBOR map from builder code data, in ``a``, ``w``, ``s`` order."""
    entries = bytearray()
    map_size = 0

    if data.a:
        map_size += 1
        entries += _encode_string("a")
        entries += _encode_string(data.a)

    if data.w:
        map_size += 1
        entries += _encode_string("w")
        entries += _encode_string(data.w)

    service_codes = _normalize_service_codes(data.s)
    if service_codes:
        map_size += 1
        entries += _encode_string("s")
        entries += _encode_array(service_codes)

    return _encode_major_type(_MAJOR_MAP, map_size) + bytes(entries)


def encode_builder_code_suffix(data: BuilderCodeExtensionData) -> str:
    """Build a complete ERC-8021 Schema 2 data suffix from builder code data.

    Format: ``[cbor_data][suffix_data_length (2 bytes)][schema_id (1 byte)][marker (16 bytes)]``.
    ``suffix_data_length`` covers the CBOR data only.

    Args:
        data: Builder code fields to encode.

    Returns:
        Hex-encoded suffix (with ``0x`` prefix) ready to append to calldata.
    """
    cbor_bytes = _encode_cbor_map(data)
    cbor_length = len(cbor_bytes)

    suffix = (
        cbor_bytes
        + bytes([(cbor_length >> 8) & 0xFF, cbor_length & 0xFF])
        + bytes([SCHEMA_2_ID])
        + bytes.fromhex(ERC_8021_MARKER)
    )
    return "0x" + suffix.hex()


def _read_length(byte: int, data: bytes, offset: int) -> tuple[int | None, int]:
    """Read a CBOR argument that is either inline (<=23) or a single following byte (24)."""
    info = byte & 0x1F
    if info <= 23:
        return info, offset
    if info == 24:
        return data[offset], offset + 1
    return None, offset


def parse_builder_code_suffix_from_calldata(
    calldata: str,
) -> BuilderCodeExtensionData | None:
    """Parse ERC-8021 Schema 2 builder code attribution from settlement calldata.

    Args:
        calldata: Full transaction input data (with or without ``0x`` prefix).

    Returns:
        Decoded builder code fields, or ``None`` if no valid suffix is present.
    """
    hex_str = calldata[2:] if calldata.startswith("0x") else calldata
    marker = ERC_8021_MARKER.lower()
    marker_pos = hex_str.lower().rfind(marker)
    if marker_pos < 6:
        return None

    if int(hex_str[marker_pos - 2 : marker_pos], 16) != SCHEMA_2_ID:
        return None

    cbor_length = int(hex_str[marker_pos - 6 : marker_pos - 2], 16)
    suffix_start = marker_pos - 6 - cbor_length * 2
    if suffix_start < 0 or suffix_start + (cbor_length + 19) * 2 != len(hex_str):
        return None

    data = bytes.fromhex(hex_str[suffix_start : marker_pos - 6])
    offset = 0

    if data[offset] >> 5 != _MAJOR_MAP:
        return None

    map_size, offset = _read_length(data[offset], data, offset + 1)
    if map_size is None:
        return None

    result = BuilderCodeExtensionData()
    for _ in range(map_size):
        if data[offset] >> 5 != _MAJOR_TEXT_STRING:
            return None
        key_len, offset = _read_length(data[offset], data, offset + 1)
        if key_len is None:
            return None
        key = data[offset : offset + key_len].decode("utf-8")
        offset += key_len

        if key in ("a", "w"):
            if data[offset] >> 5 != _MAJOR_TEXT_STRING:
                return None
            value_len, offset = _read_length(data[offset], data, offset + 1)
            if value_len is None:
                return None
            value = data[offset : offset + value_len].decode("utf-8")
            offset += value_len
            setattr(result, key, value)
            continue

        if key == "s":
            if data[offset] >> 5 != _MAJOR_ARRAY:
                return None
            array_size, offset = _read_length(data[offset], data, offset + 1)
            if array_size is None:
                return None
            codes: list[str] = []
            for _ in range(array_size):
                if data[offset] >> 5 != _MAJOR_TEXT_STRING:
                    return None
                item_len, offset = _read_length(data[offset], data, offset + 1)
                if item_len is None:
                    return None
                codes.append(data[offset : offset + item_len].decode("utf-8"))
                offset += item_len
            if codes:
                result.s = codes
            continue

        return None

    return result
