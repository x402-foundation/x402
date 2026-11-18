"""ERC-8021 Schema 2 CBOR encoding for builder code suffixes.

Schema 2 suffix format::

    [cbor_data (variable)] [suffix_data_length (2 bytes)] [schema_id = 0x02 (1 byte)] [ERC-8021 marker (16 bytes)]

The CBOR payload uses single-letter keys:
- ``a`` — app builder code (string)
- ``w`` — wallet/facilitator builder code (string)
- ``s`` — service codes (string array)
- ``m`` — facilitator-authored settlement metadata (map of unsigned integers, strings, arrays, and maps)

Hand-rolled CBOR keeps the extension dependency-free (stdlib only).
"""

from __future__ import annotations

from .types import (
    ERC_8021_MARKER,
    SCHEMA_2_ID,
    BuilderCodeExtensionData,
    BuilderCodeSuffixData,
    SettlementMetadata,
    SettlementMetadataValue,
)

# CBOR major types used by this encoder.
_MAJOR_UNSIGNED = 0
_MAJOR_TEXT_STRING = 3
_MAJOR_ARRAY = 4
_MAJOR_MAP = 5

# suffix_data_length is 2 bytes, so the CBOR itself must fit in 65,535 bytes.
_MAX_CBOR_LENGTH = 0xFFFF

_MAX_UINT64 = (1 << 64) - 1

_SuffixInput = BuilderCodeExtensionData | BuilderCodeSuffixData


class _CborDecodeError(Exception):
    pass


class _CborCursor:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0

    def peek_major(self) -> int:
        if self.offset >= len(self.data):
            raise _CborDecodeError("Unexpected end of CBOR data")
        return self.data[self.offset] >> 5

    def read_argument(self) -> int:
        if self.offset >= len(self.data):
            raise _CborDecodeError("Unexpected end of CBOR data")
        info = self.data[self.offset] & 0x1F
        self.offset += 1
        if info <= 23:
            return info
        if info > 27:
            raise _CborDecodeError("Unsupported CBOR argument")
        width = 1 << (info - 24)
        if self.offset + width > len(self.data):
            raise _CborDecodeError("Unsupported CBOR argument")
        value = int.from_bytes(self.data[self.offset : self.offset + width], "big")
        self.offset += width
        return value

    def read_length(self) -> int:
        length = self.read_argument()
        if length > len(self.data) - self.offset:
            raise _CborDecodeError("CBOR length exceeds available data")
        return length


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
    - 65536-2^32-1: five bytes ``(major_type << 5) | 26``, value (big-endian)
    - 2^32-2^64-1: nine bytes ``(major_type << 5) | 27``, value (big-endian)
    """
    if value < 0 or value > _MAX_UINT64:
        raise ValueError(f"CBOR value out of range: {value}")
    mt = major_type << 5
    if value <= 23:
        return bytes([mt | value])
    if value <= 0xFF:
        return bytes([mt | 24, value])
    if value <= 0xFFFF:
        return bytes([mt | 25]) + value.to_bytes(2, "big")
    if value <= 0xFFFFFFFF:
        return bytes([mt | 26]) + value.to_bytes(4, "big")
    return bytes([mt | 27]) + value.to_bytes(8, "big")


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


def _metadata_type_name(value: object) -> str:
    if value is None:
        return "null"
    return type(value).__name__


def _encode_cbor_items(items: list[object] | tuple[object, ...]) -> bytes:
    result = _encode_major_type(_MAJOR_ARRAY, len(items))
    for item in items:
        result += _encode_cbor_value(item)
    return result


def _encode_cbor_value_map(entries: dict[object, object]) -> bytes:
    encoded: list[tuple[bytes, bytes]] = []
    for key, item in entries.items():
        if not isinstance(key, str):
            raise ValueError(f"Unsupported CBOR metadata value: {_metadata_type_name(key)}")
        key_bytes = _encode_string(key)
        encoded.append((key_bytes, _encode_cbor_value(item)))
    encoded.sort(key=lambda pair: pair[0])

    result = _encode_major_type(_MAJOR_MAP, len(encoded))
    for key_bytes, value_bytes in encoded:
        result += key_bytes + value_bytes
    return result


def _encode_cbor_value(value: object) -> bytes:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"Unsupported CBOR metadata value: {_metadata_type_name(value)}")
    if isinstance(value, str):
        return _encode_string(value)
    if isinstance(value, int):
        return _encode_major_type(_MAJOR_UNSIGNED, value)
    if isinstance(value, dict):
        return _encode_cbor_value_map(value)
    if isinstance(value, (list, tuple)):
        return _encode_cbor_items(value)
    raise ValueError(f"Unsupported CBOR metadata value: {_metadata_type_name(value)}")


def _encode_cbor_map(data: _SuffixInput) -> bytes:
    """Encode a minimal CBOR map, emitting present fields in ``a``, ``w``, ``s``, ``m`` order."""
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

    metadata = data.m if isinstance(data, BuilderCodeSuffixData) else None
    if metadata:
        if not isinstance(metadata, dict):
            raise ValueError(f"Unsupported CBOR metadata value: {_metadata_type_name(metadata)}")
        map_size += 1
        entries += _encode_string("m")
        entries += _encode_cbor_value(metadata)

    return _encode_major_type(_MAJOR_MAP, map_size) + bytes(entries)


def encode_builder_code_suffix(data: _SuffixInput) -> str:
    """Build a complete ERC-8021 Schema 2 data suffix from builder code data.

    Format: ``[cbor_data][suffix_data_length (2 bytes)][schema_id (1 byte)][marker (16 bytes)]``.
    ``suffix_data_length`` covers the CBOR data only.

    Args:
        data: Builder code fields to encode. ``m`` is read from
            ``BuilderCodeSuffixData``.

    Returns:
        Hex-encoded suffix (with ``0x`` prefix) ready to append to calldata.

    Raises:
        ValueError: The CBOR data exceeds 65,535 bytes, or ``m`` contains a value
            this encoder does not allow.
    """
    cbor_bytes = _encode_cbor_map(data)
    cbor_length = len(cbor_bytes)
    if cbor_length > _MAX_CBOR_LENGTH:
        raise ValueError(
            f"Builder code CBOR data is {cbor_length} bytes, maximum is {_MAX_CBOR_LENGTH}"
        )

    suffix = (
        cbor_bytes
        + bytes([(cbor_length >> 8) & 0xFF, cbor_length & 0xFF])
        + bytes([SCHEMA_2_ID])
        + bytes.fromhex(ERC_8021_MARKER)
    )
    return "0x" + suffix.hex()


def _read_text(cursor: _CborCursor) -> str:
    if cursor.peek_major() != _MAJOR_TEXT_STRING:
        raise _CborDecodeError("Expected CBOR text string")
    length = cursor.read_length()
    raw = cursor.data[cursor.offset : cursor.offset + length]
    cursor.offset += length
    return raw.decode("utf-8")


def _read_map(cursor: _CborCursor) -> SettlementMetadata:
    if cursor.peek_major() != _MAJOR_MAP:
        raise _CborDecodeError("Expected CBOR map")
    size = cursor.read_length()
    entries: dict[str, SettlementMetadataValue] = {}
    for _ in range(size):
        key = _read_text(cursor)
        entries[key] = _read_value(cursor)
    return entries


def _read_value(cursor: _CborCursor) -> SettlementMetadataValue:
    major = cursor.peek_major()
    if major == _MAJOR_UNSIGNED:
        return cursor.read_argument()
    if major == _MAJOR_TEXT_STRING:
        return _read_text(cursor)
    if major == _MAJOR_ARRAY:
        size = cursor.read_length()
        return [_read_value(cursor) for _ in range(size)]
    if major == _MAJOR_MAP:
        return _read_map(cursor)
    raise _CborDecodeError("Unsupported CBOR type in metadata")


def _parse_cbor_map(data: bytes) -> BuilderCodeSuffixData:
    cursor = _CborCursor(data)
    if cursor.peek_major() != _MAJOR_MAP:
        raise _CborDecodeError("Expected CBOR map")

    map_size = cursor.read_length()
    result = BuilderCodeSuffixData()
    for _ in range(map_size):
        key = _read_text(cursor)
        if key == "a":
            result.a = _read_text(cursor)
        elif key == "w":
            result.w = _read_text(cursor)
        elif key == "s":
            if cursor.peek_major() != _MAJOR_ARRAY:
                raise _CborDecodeError("Expected CBOR array")
            array_size = cursor.read_length()
            codes = [_read_text(cursor) for _ in range(array_size)]
            if codes:
                result.s = codes
        elif key == "m":
            result.m = _read_map(cursor)
        else:
            raise _CborDecodeError(f"Unknown builder-code key: {key}")
    return result


def parse_builder_code_suffix_from_calldata(
    calldata: str,
) -> BuilderCodeSuffixData | None:
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

    try:
        data = bytes.fromhex(hex_str[suffix_start : marker_pos - 6])
        return _parse_cbor_map(data)
    except (_CborDecodeError, UnicodeDecodeError, ValueError):
        return None
