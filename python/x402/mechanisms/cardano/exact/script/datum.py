"""Decode a bounded inline Plutus datum."""

import re
from typing import Any

from pycardano import RawPlutusData

from ...limits import MAX_CARDANO_DATUM_BYTES
from ...utils import decode_cbor


def build_script_datum_inline(extra: dict[str, Any]) -> RawPlutusData | None:
    """Return the supplied inline datum, if present."""
    if "datum" not in extra:
        return None
    value = extra["datum"]
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"(?:[0-9a-fA-F]{2})+", value)
        or len(value) // 2 > MAX_CARDANO_DATUM_BYTES
    ):
        raise ValueError('Cardano script payment "datum" must be non-empty CBOR hex')
    try:
        raw = bytes.fromhex(value)
        decode_cbor(raw)
        return RawPlutusData.from_cbor(raw)
    except Exception as exc:
        raise ValueError('Cardano script payment "datum" is not valid Plutus data') from exc
