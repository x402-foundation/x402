"""Catalog CAIP-2 helpers for Python e2e clients."""

from __future__ import annotations

import json
import os
from pathlib import Path


def _catalog_testnet_caip2(network_id: str) -> str:
    """Read testnet.caip2 from e2e/config/mechanisms_<id>.json."""
    injected = os.getenv("E2E_MECHANISMS_CATALOG")
    candidates: list[Path] = []
    if injected:
        candidates.append(Path(injected))
    here = Path(__file__).resolve()
    candidates.extend(parent / "config" for parent in here.parents)
    for catalog_dir in candidates:
        path = catalog_dir / f"mechanisms_{network_id}.json"
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            return data["testnet"]["caip2"]
    raise FileNotFoundError(f"Could not locate mechanisms_{network_id}.json")


def resolve_network_caip2(network_id: str) -> str:
    """Prefer `${ID}_NETWORK`, else catalog testnet CAIP-2."""
    return os.environ.get(f"{network_id.upper()}_NETWORK") or _catalog_testnet_caip2(network_id)


def caip2_pattern(caip2: str) -> str:
    """Derive a CAIP-2 namespace wildcard (`eip155:*`) from a concrete CAIP-2 id."""
    ns = caip2.split(":", 1)[0]
    if not ns:
        raise ValueError(f"invalid caip2: {caip2}")
    return f"{ns}:*"


def network_caip2_pattern(network_id: str) -> str:
    """Client registration pattern for a catalog network id."""
    return caip2_pattern(resolve_network_caip2(network_id))
