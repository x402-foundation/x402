"""Registration helpers for TVM exact payment schemes."""

from typing import TYPE_CHECKING, TypeVar

from ..constants import SUPPORTED_NETWORKS

if TYPE_CHECKING:
    from x402 import (
        x402Client,
        x402ClientSync,
        x402Facilitator,
        x402FacilitatorSync,
        x402ResourceServer,
        x402ResourceServerSync,
    )

    from ..signer import ClientTvmSigner, FacilitatorTvmSigner

ClientT = TypeVar("ClientT", "x402Client", "x402ClientSync")
ServerT = TypeVar("ServerT", "x402ResourceServer", "x402ResourceServerSync")
FacilitatorT = TypeVar("FacilitatorT", "x402Facilitator", "x402FacilitatorSync")


def register_exact_tvm_client(
    client: ClientT,
    signer: "ClientTvmSigner",
    networks: str | list[str] | None = None,
    policies: list | None = None,
) -> ClientT:
    """Register TVM exact payment schemes to x402Client."""
    from .client import ExactTvmScheme as ExactTvmClientScheme

    scheme = ExactTvmClientScheme(signer)

    if networks is None:
        networks = [signer.network]
    elif isinstance(networks, str):
        networks = [networks]

    for network in networks:
        client.register(network, scheme)

    if policies:
        for policy in policies:
            client.register_policy(policy)

    return client


def register_exact_tvm_server(
    server: ServerT,
    networks: str | list[str] | None = None,
) -> ServerT:
    """Register TVM exact payment schemes to x402ResourceServer."""
    from .server import ExactTvmScheme as ExactTvmServerScheme

    scheme = ExactTvmServerScheme()

    if networks is None:
        networks = list(SUPPORTED_NETWORKS)
    elif isinstance(networks, str):
        networks = [networks]

    for network in networks:
        server.register(network, scheme)

    return server


def register_exact_tvm_facilitator(
    facilitator: FacilitatorT,
    signer: "FacilitatorTvmSigner",
    networks: str | list[str],
) -> FacilitatorT:
    """Register TVM exact payment schemes to x402Facilitator."""
    from ..settlement_cache import SettlementCache
    from .facilitator import ExactTvmScheme as ExactTvmFacilitatorScheme

    scheme = ExactTvmFacilitatorScheme(signer, SettlementCache())

    if isinstance(networks, str):
        networks = [networks]
    facilitator.register(networks, scheme)
    return facilitator
