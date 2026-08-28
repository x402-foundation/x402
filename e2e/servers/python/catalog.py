"""Mechanisms catalog loader for the Python e2e resource servers.

SSOT is e2e/config/mechanisms_global.json + one e2e/config/mechanisms_<id>.json
per network. Route paths, payment requirements, and declared extensions all
come from there, so adding a mechanism does not require editing
fastapi/flask entrypoints.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

SDK = "python"
PROTECTED_ROUTE_MESSAGE = "Protected endpoint accessed successfully"

_NETWORK_FILE_RE = re.compile(r"^mechanisms_(.+)\.json$")


def _find_catalog_dir() -> Path:
    """Prefer the harness-injected directory, else walk up from this file (then cwd)."""
    injected = os.getenv("E2E_MECHANISMS_CATALOG")
    if injected:
        path = Path(injected)
        if not path.is_dir():
            raise FileNotFoundError(
                f"E2E_MECHANISMS_CATALOG does not point at a directory: {injected}"
            )
        return path

    for start in (Path(__file__).resolve(), Path.cwd().resolve() / "_"):
        for parent in start.parents:
            candidate = parent / "config"
            if (candidate / "mechanisms_global.json").is_file():
                return candidate
    raise FileNotFoundError("Could not locate e2e/config/mechanisms_global.json")


def _read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _flatten_env(env: dict[str, Any]) -> dict[str, list[str]]:
    """Normalize per-key {required, roles} env map to required/optional lists."""
    required: list[str] = []
    optional: list[str] = []
    for key, decl in env.items():
        if not isinstance(decl, dict) or "required" not in decl or "roles" not in decl:
            raise ValueError(f"env.{key} must be {{ required: bool, roles: [...] }}")
        if decl["required"]:
            required.append(key)
        else:
            optional.append(key)
    return {"required": sorted(required), "optional": sorted(optional)}


def _load() -> dict[str, Any]:
    catalog_dir = _find_catalog_dir()
    global_file = _read_json(catalog_dir / "mechanisms_global.json")

    networks: dict[str, Any] = {}
    routes: dict[str, Any] = {}

    network_files = sorted(
        name
        for name in os.listdir(catalog_dir)
        if _NETWORK_FILE_RE.match(name) and name != "mechanisms_global.json"
    )

    for file_name in network_files:
        network_id = _NETWORK_FILE_RE.match(file_name).group(1)  # type: ignore[union-attr]
        file_data = _read_json(catalog_dir / file_name)

        networks[network_id] = {
            "env": _flatten_env(file_data["env"]),
            "networks": {"testnet": file_data["testnet"], "mainnet": file_data["mainnet"]},
        }

        for path, definition in (file_data.get("routes") or {}).items():
            if path in routes:
                raise ValueError(f"Duplicate route path across mechanisms catalog files: {path}")
            routes[path] = {**definition, "network": network_id}

    return {"globalEnv": _flatten_env(global_file["env"]), "networks": networks, "routes": routes}


_CATALOG = _load()


@dataclass(frozen=True)
class CatalogRoute:
    """One paid HTTP route as declared in the catalog."""

    path: str
    scheme: str
    network: str
    asset_transfer_method: str | None
    price: dict[str, Any]
    extensions: list[str]
    settlement_override: dict[str, str] | None
    payment_flow: str | None


@dataclass(frozen=True)
class ResolvedRoute:
    """A catalog route with env-dependent payment requirements resolved."""

    path: str
    network_id: str
    scheme: str
    network: str
    pay_to: str
    price: Any
    extra: dict[str, str] | None
    extensions: list[str] = field(default_factory=list)
    settlement_override: dict[str, str] | None = None


def _network_definition(network_id: str) -> dict[str, Any]:
    definition = _CATALOG["networks"].get(network_id)
    if definition is None:
        raise KeyError(f"Unknown network in catalog: {network_id}")
    return definition


def _derived_network_key(network_id: str) -> str:
    """Derived network env key: `${ID}_NETWORK`."""
    return f"{network_id.upper()}_NETWORK"


def _server_address_env_key(network_id: str) -> str:
    """Server payee address env key for a network, by fixed naming convention."""
    return f"SERVER_{network_id.upper()}_ADDRESS"


def _route_filter() -> tuple[set[str], set[str]]:
    """Scheme/network exclusions for surfaces narrower than the catalog."""

    def parse(name: str) -> set[str]:
        return {part.strip() for part in os.getenv(name, "").split(",") if part.strip()}

    return parse("E2E_EXCLUDE_SCHEMES"), parse("E2E_EXCLUDE_NETWORKS")


def catalog_routes() -> list[CatalogRoute]:
    """Routes this SDK implements, after applying the harness exclusions."""
    excluded_schemes, excluded_networks = _route_filter()
    routes: list[CatalogRoute] = []

    for path, definition in _CATALOG["routes"].items():
        if SDK not in definition.get("sdks", []):
            continue
        network = definition["network"]
        if definition["scheme"] in excluded_schemes or network in excluded_networks:
            continue
        routes.append(
            CatalogRoute(
                path=path,
                scheme=definition["scheme"],
                network=network,
                asset_transfer_method=definition.get("assetTransferMethod"),
                price=definition["price"],
                extensions=list(definition.get("extensions", [])),
                settlement_override=definition.get("settlementOverride"),
                payment_flow=definition.get("paymentFlow"),
            )
        )

    return routes


def network_caip2(network_id: str, env: Callable[[str], str | None] = os.getenv) -> str:
    """CAIP-2 id for a network: the harness env override, else the catalog testnet."""
    definition = _network_definition(network_id)
    return env(_derived_network_key(network_id)) or definition["networks"]["testnet"]["caip2"]


def caip2_pattern(caip2: str) -> str:
    """Derive a CAIP-2 namespace wildcard (`eip155:*`) from a concrete CAIP-2 id."""
    ns = caip2.split(":", 1)[0]
    if not ns:
        raise ValueError(f"invalid caip2: {caip2}")
    return f"{ns}:*"


def network_caip2_pattern(
    network_id: str, env: Callable[[str], str | None] = os.getenv
) -> str:
    """Client/resource-server registration pattern for a catalog network id."""
    return caip2_pattern(network_caip2(network_id, env))


def catalog_network_ids() -> list[str]:
    """Network ids that have at least one route for this SDK, in stable order."""
    seen: list[str] = []
    for route in catalog_routes():
        if route.network not in seen:
            seen.append(route.network)
    return seen


def server_address_env_key(network_id: str) -> str:
    """Exported `SERVER_${ID}_ADDRESS` env key for a network."""
    return _server_address_env_key(network_id)


def _network_mode(network_id: str, caip2: str) -> str:
    modes = _network_definition(network_id)["networks"]
    return "mainnet" if modes["mainnet"]["caip2"] == caip2 else "testnet"


def _resolve_price(
    route: CatalogRoute, caip2: str, env: Callable[[str], str | None]
) -> tuple[Any, dict[str, str] | None]:
    spec = route.price

    if "usd" in spec:
        extra = (
            {"assetTransferMethod": route.asset_transfer_method}
            if spec.get("declareAssetTransferMethod") and route.asset_transfer_method
            else None
        )
        return spec["usd"], extra

    mode_config = _network_definition(route.network)["networks"][_network_mode(route.network, caip2)]

    amount = (env(spec["amountEnv"]) if spec.get("amountEnv") else None) or spec.get("amount")
    if not amount:
        raise ValueError(f"Route {route.path}: price has no amount")

    asset_default = (
        mode_config.get("permit2Asset") if spec.get("assetRef") == "permit2" else spec.get("asset")
    )
    asset = (env(spec["assetEnv"]) if spec.get("assetEnv") else None) or asset_default
    if not asset:
        raise ValueError(f"Route {route.path}: price has no asset")
    asset_overridden = bool(asset_default) and asset != asset_default

    extra: dict[str, str] = {}
    if route.asset_transfer_method:
        extra["assetTransferMethod"] = route.asset_transfer_method
    if spec.get("permit2Domain") and mode_config.get("permit2AssetName"):
        extra["name"] = mode_config["permit2AssetName"]
        extra["version"] = "2"
    for key, env_spec in (spec.get("extraEnv") or {}).items():
        if env_spec.get("whenAssetOverridden") and not asset_overridden:
            continue
        value = env(env_spec["env"])
        if value:
            extra[key] = value

    price: dict[str, Any] = {"amount": amount, "asset": asset}
    if extra:
        price["extra"] = extra
    return price, None


def _merge_route_extra(
    price_extra: dict[str, str] | None,
    payment_flow: str | None,
) -> dict[str, str] | None:
    """Merge price-derived extra with catalog paymentFlow.

    Authorization is omitted on the wire, matching core applyPaymentFlowWireExtra.
    """
    wire_flow = payment_flow if payment_flow and payment_flow != "authorization" else None
    if not wire_flow and not price_extra:
        return None
    extra = dict(price_extra or {})
    if wire_flow:
        extra["paymentFlow"] = wire_flow
    return extra


def resolve_routes(env: Callable[[str], str | None] = os.getenv) -> list[ResolvedRoute]:
    """Resolve catalog routes for one server process.

    The payee address and CAIP-2 identifier per network come from the env keys the
    catalog declares. Routes whose network has no configured payee are dropped, so
    the server only advertises what it can settle.
    """
    resolved: list[ResolvedRoute] = []

    for route in catalog_routes():
        pay_to = env(_server_address_env_key(route.network))
        if not pay_to:
            continue

        caip2 = network_caip2(route.network, env)
        price, extra = _resolve_price(route, caip2, env)
        extra = _merge_route_extra(extra, route.payment_flow)

        resolved.append(
            ResolvedRoute(
                path=route.path,
                network_id=route.network,
                scheme=route.scheme,
                network=caip2,
                pay_to=pay_to,
                price=price,
                extra=extra,
                extensions=route.extensions,
                settlement_override=route.settlement_override,
            )
        )

    return resolved


@dataclass(frozen=True)
class ServedNetwork:
    """One network this server serves, with the payee it settles to."""

    id: str
    network: str
    pay_to: str


def served_networks(env: Callable[[str], str | None] = os.getenv) -> list[ServedNetwork]:
    """Networks the resolved routes cover, in catalog order — for banners/health."""
    served: dict[str, ServedNetwork] = {}
    for route in resolve_routes(env):
        served.setdefault(
            route.network_id,
            ServedNetwork(id=route.network_id, network=route.network, pay_to=route.pay_to),
        )
    return list(served.values())


def mcp_tool_name(path: str) -> str:
    """MCP tool name for a catalog path: `/exact/evm/eip3009` -> `exact_evm_eip3009`."""
    return re.sub(r"[/-]", "_", path.lstrip("/"))


_GAS_SPONSORING_LABELS = {
    "eip2612GasSponsoring": "EIP-2612 gas sponsoring",
    "erc20ApprovalGasSponsoring": "ERC-20 approval gas sponsoring",
}


def route_description(
    network_id: str,
    scheme: str,
    asset_transfer_method: str | None,
    extensions: list[str] | None,
    payment_flow: str | None = None,
) -> str:
    """Human-readable description for an MCP tool, mirroring the TS catalog helper."""
    label = network_id.upper()
    scheme_prefix = "" if scheme == "exact" else f"{scheme} "
    transfer = f"{asset_transfer_method} " if asset_transfer_method else ""
    sponsoring = [
        _GAS_SPONSORING_LABELS[ext_id]
        for ext_id in (extensions or [])
        if ext_id in _GAS_SPONSORING_LABELS
    ]
    suffix = f" with {' and '.join(sponsoring)}" if sponsoring else ""
    flow = ""
    if payment_flow and payment_flow != "authorization":
        flow = f" {payment_flow}"
    return f"Protected {scheme_prefix}{transfer}endpoint on {label}{flow}{suffix}"


def route_discovery_output() -> dict[str, Any]:
    """Bazaar discovery metadata matching the fixed paid-route success body."""
    example = {"message": PROTECTED_ROUTE_MESSAGE, "timestamp": "2024-01-01T00:00:00Z"}
    return {
        "example": example,
        "schema": {
            "properties": {key: {"type": "string"} for key in example},
            "required": list(example),
        },
    }
