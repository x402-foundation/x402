"""Shared env + routes for Python e2e resource servers (fastapi/flask).

Route paths and payment requirements come from the mechanisms catalog via
:mod:`catalog`; only scheme registration lives here.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any

from x402.extensions.bazaar import (
    DeclareMcpDiscoveryConfig,
    declare_discovery_extension,
    declare_mcp_discovery_extension,
    OutputConfig,
)
from x402.extensions.eip2612_gas_sponsoring import declare_eip2612_gas_sponsoring_extension
from x402.extensions.erc20_approval_gas_sponsoring import (
    declare_erc20_approval_gas_sponsoring_extension,
)
from catalog import (
    ResolvedRoute,
    catalog_network_ids,
    mcp_tool_name,
    network_caip2_pattern,
    resolve_routes,
    route_discovery_output,
    server_address_env_key,
)


@dataclass(frozen=True)
class ServerConfig:
    port: int
    facilitator_url: str | None
    payees: dict[str, str]  # network id → SERVER_${ID}_ADDRESS
    evm_permit2_asset: str

    def payee(self, network_id: str) -> str | None:
        return self.payees.get(network_id)


def load_server_config() -> ServerConfig:
    """Load and validate shared server env."""
    payees: dict[str, str] = {}
    for network_id in catalog_network_ids():
        addr = os.getenv(server_address_env_key(network_id))
        if addr:
            payees[network_id] = addr

    if not payees:
        print(
            "Error: At least one SERVER_*_ADDRESS for a Python catalog network is required"
        )
        sys.exit(1)

    return ServerConfig(
        port=int(os.getenv("PORT", "4021")),
        facilitator_url=os.getenv("FACILITATOR_URL"),
        payees=payees,
        evm_permit2_asset=os.getenv(
            "EVM_PERMIT2_ASSET", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
        ),
    )


def configure_resource_server(server: Any, cfg: ServerConfig) -> None:
    """Register schemes for configured catalog networks + bazaar on a resource server."""
    from x402.mechanisms.evm.exact import register_exact_evm_server
    from x402.mechanisms.evm.upto import UptoEvmServerScheme
    from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
    from x402.mechanisms.evm.batch_settlement.server import (
        BatchSettlementEvmScheme as BatchSettlementServerScheme,
        BatchSettlementEvmSchemeServerConfig,
    )
    from x402.mechanisms.svm.exact import register_exact_svm_server
    from x402.mechanisms.tvm.exact import ExactTvmServerScheme
    from x402.extensions.bazaar import bazaar_resource_server_extension

    if cfg.payee("evm"):
        evm_pattern = network_caip2_pattern("evm")
        register_exact_evm_server(server, evm_pattern)
        server.register(evm_pattern, UptoEvmServerScheme())
        receiver_authorizer_pk = os.environ.get("SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
        batch_settlement_authorizer_signer = (
            LocalAuthorizerSigner(receiver_authorizer_pk) if receiver_authorizer_pk else None
        )
        server.register(
            evm_pattern,
            BatchSettlementServerScheme(
                cfg.payee("evm"),
                BatchSettlementEvmSchemeServerConfig(
                    receiver_authorizer_signer=batch_settlement_authorizer_signer,
                ),
            ),
        )

    if cfg.payee("svm"):
        register_exact_svm_server(server, network_caip2_pattern("svm"))

    if cfg.payee("tvm"):
        server.register(network_caip2_pattern("tvm"), ExactTvmServerScheme())

    server.register_extension(bazaar_resource_server_extension)


def _declare_extension(extension_id: str, route: ResolvedRoute, transport: str = "http") -> dict[str, Any]:
    """Map a catalog extension id to the SDK call that declares it on a route.

    Declaration comes from mechanisms JSON ``extensions`` per route; process-level
    registration (e.g. bazaar on the resource server) is separate and enables
    enriching/honoring those declarations.
    """
    if extension_id == "bazaar":
        output = route_discovery_output()
        if transport == "mcp":
            return declare_mcp_discovery_extension(
                DeclareMcpDiscoveryConfig(
                    tool_name=mcp_tool_name(route.path),
                    transport="sse",
                    input_schema={"properties": {}},
                    output=OutputConfig(example=output["example"], schema=output["schema"]),
                )
            )
        return declare_discovery_extension(
            output=OutputConfig(example=output["example"], schema=output["schema"])
        )
    if extension_id == "eip2612GasSponsoring":
        return declare_eip2612_gas_sponsoring_extension()
    if extension_id == "erc20ApprovalGasSponsoring":
        return declare_erc20_approval_gas_sponsoring_extension()
    raise ValueError(f'Route {route.path} declares unknown extension "{extension_id}"')


def build_resolved_route_config(route: ResolvedRoute, transport: str = "http") -> dict[str, Any]:
    """Single-route payment config shared by fastapi/flask and MCP tools."""
    accepts: dict[str, Any] = {
        "scheme": route.scheme,
        "payTo": route.pay_to,
        "network": route.network,
        "price": route.price,
    }
    if route.extra:
        accepts["extra"] = route.extra

    entry: dict[str, Any] = {"accepts": accepts}
    if route.extensions:
        extensions: dict[str, Any] = {}
        for extension_id in route.extensions:
            extensions.update(_declare_extension(extension_id, route, transport))
        entry["extensions"] = extensions

    return entry


def build_payment_routes(cfg: ServerConfig) -> dict[str, Any]:
    """Payment route map for fastapi/flask e2e servers, derived from the catalog."""
    return {
        f"GET {route.path}": build_resolved_route_config(route)
        for route in resolve_routes()
    }
