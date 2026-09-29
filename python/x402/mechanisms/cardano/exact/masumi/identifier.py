"""LZ-String blockchain identifiers with bounded decompression."""

import re

from lzstring import LZString

from ...limits import MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES, MAX_MASUMI_IDENTIFIER_TEXT_CHARS


def build_identifier_text(parts: dict[str, str]) -> str:
    return ".".join(
        [
            parts["sellerNonce"] + parts["agentIdentifier"],
            parts["buyerNonce"],
            parts["referenceSignature"],
            parts["referenceKey"],
            parts["contractAddress"],
        ]
    )


def encode_blockchain_identifier(parts: dict[str, str]) -> str:
    text = build_identifier_text(parts)
    units = text.encode("utf-16-be")
    if len(units) // 2 > MAX_MASUMI_IDENTIFIER_TEXT_CHARS:
        raise ValueError("Masumi identifier text exceeds the character limit")
    # JavaScript LZ-String consumes UTF-16 code units, not Unicode code points.
    text = "".join(chr(int.from_bytes(units[i : i + 2], "big")) for i in range(0, len(units), 2))
    compressed = b"".join(ord(char).to_bytes(2, "big") for char in LZString.compress(text))
    if len(compressed) > MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES:
        raise ValueError("Masumi identifier exceeds the compressed byte limit")
    return compressed.hex()


def decompress_lz_string_bounded(data: bytes, max_chars: int) -> str | None:
    if not data or len(data) % 2:
        return None
    position = 0

    def bits(count: int) -> int:
        nonlocal position
        if position + count > len(data) * 8:
            raise ValueError("Truncated LZ-String")
        result = 0
        for shift in range(count):
            result |= ((data[position // 8] >> (7 - position % 8)) & 1) << shift
            position += 1
        return result

    try:
        kind = bits(2)
        if kind == 2:
            return ""
        previous = chr(bits(8 if kind == 0 else 16))
        if max_chars < 1:
            return None
        dictionary = ["", "", "", previous]
        output = [previous]
        length, enlarge, width = 1, 4, 3
        while True:
            code = bits(width)
            if code in (0, 1):
                dictionary.append(chr(bits(8 if code == 0 else 16)))
                code = len(dictionary) - 1
                enlarge -= 1
            elif code == 2:
                units = "".join(output)
                return b"".join(ord(char).to_bytes(2, "big") for char in units).decode("utf-16-be")
            if enlarge == 0:
                enlarge = 1 << width
                width += 1
            if code < len(dictionary) and dictionary[code]:
                entry = dictionary[code]
            elif code == len(dictionary):
                entry = previous + previous[0]
            else:
                return None
            if length + len(entry) > max_chars:
                return None
            output.append(entry)
            length += len(entry)
            dictionary.append(previous + entry[0])
            previous = entry
            enlarge -= 1
            if enlarge == 0:
                enlarge = 1 << width
                width += 1
    except (ValueError, UnicodeError):
        return None


def decode_blockchain_identifier(identifier: str) -> dict[str, str] | None:
    if (
        not isinstance(identifier, str)
        or not identifier
        or len(identifier) % 2
        or len(identifier) // 2 > MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES
        or not re.fullmatch(r"[0-9a-f]+", identifier)
    ):
        return None
    text = decompress_lz_string_bounded(bytes.fromhex(identifier), MAX_MASUMI_IDENTIFIER_TEXT_CHARS)
    if not text:
        return None
    segments = text.split(".")
    if len(segments) != 5 or len(segments[0]) < 64:
        return None
    return {
        "sellerNonce": segments[0][:64],
        "agentIdentifier": segments[0][64:],
        "buyerNonce": segments[1],
        "referenceSignature": segments[2],
        "referenceKey": segments[3],
        "contractAddress": segments[4],
    }
