"""Registration helpers for SVM exact payment schemes."""

from typing import TYPE_CHECKING, TypeVar

from ..constants import V1_NETWORKS

if TYPE_CHECKING:
    from x402 import (
        x402Client,
        x402ClientSync,
        x402Facilitator,
        x402FacilitatorSync,
        x402ResourceServer,
        x402ResourceServerSync,
    )

    from ..signer import ClientSvmSigner, FacilitatorSvmSigner

# Type vars for accepting both async and sync variants
ClientT = TypeVar("ClientT", "x402Client", "x402ClientSync")
ServerT = TypeVar("ServerT", "x402ResourceServer", "x402ResourceServerSync")
FacilitatorT = TypeVar("FacilitatorT", "x402Facilitator", "x402FacilitatorSync")


def register_exact_svm_client(
    client: ClientT,
    signer: "ClientSvmSigner",
    networks: str | list[str] | None = None,
    policies: list | None = None,
    rpc_url: str | None = None,
) -> ClientT:
    """Register SVM exact payment schemes to x402Client.

    Registers:
    - V2: solana:* wildcard (or specific networks if provided)
    - V1: All supported SVM networks

    Args:
        client: x402Client instance.
        signer: SVM signer for payment authorizations.
        networks: Optional specific network(s) (default: wildcard).
        policies: Optional payment policies.
        rpc_url: Optional custom RPC URL.

    Returns:
        Client for chaining.
    """
    from .client import ExactSvmScheme as ExactSvmClientScheme
    from .v1.client import ExactSvmSchemeV1 as ExactSvmClientSchemeV1

    scheme = ExactSvmClientScheme(signer, rpc_url)

    if networks:
        if isinstance(networks, str):
            networks = [networks]
        for network in networks:
            client.register(network, scheme)
    else:
        client.register("solana:*", scheme)

    # Register V1 for all legacy networks
    v1_scheme = ExactSvmClientSchemeV1(signer, rpc_url)
    for network in V1_NETWORKS:
        client.register_v1(network, v1_scheme)

    if policies:
        for policy in policies:
            client.register_policy(policy)

    return client


def register_exact_svm_server(
    server: ServerT,
    networks: str | list[str] | None = None,
) -> ServerT:
    """Register SVM exact payment schemes to x402ResourceServer.

    V2 only (no server-side for V1).

    Args:
        server: x402ResourceServer instance.
        networks: Optional specific network(s) (default: wildcard).

    Returns:
        Server for chaining.
    """
    from .server import ExactSvmScheme as ExactSvmServerScheme

    scheme = ExactSvmServerScheme()

    if networks:
        if isinstance(networks, str):
            networks = [networks]
        for network in networks:
            server.register(network, scheme)
    else:
        server.register("solana:*", scheme)

    return server


def register_exact_svm_facilitator(
    facilitator: FacilitatorT,
    signer: "FacilitatorSvmSigner",
    networks: str | list[str],
) -> FacilitatorT:
    """Register SVM exact payment schemes to x402Facilitator.

    Registers:
    - V2: Specified networks
    - V1: All supported SVM networks

    A single settlement cache is shared across V1 and V2 so that a duplicate
    transaction submitted through one protocol version is also caught by the other.

    Args:
        facilitator: x402Facilitator instance.
        signer: SVM signer for verification/settlement.
        networks: Network(s) to register.

    Returns:
        Facilitator for chaining.
    """
    from ..settlement_cache import SettlementCache
    from .facilitator import ExactSvmScheme as ExactSvmFacilitatorScheme
    from .v1.facilitator import ExactSvmSchemeV1 as ExactSvmFacilitatorSchemeV1

    settlement_cache = SettlementCache()

    scheme = ExactSvmFacilitatorScheme(signer, settlement_cache)

    if isinstance(networks, str):
        networks = [networks]
    facilitator.register(networks, scheme)

    # Register V1
    v1_scheme = ExactSvmFacilitatorSchemeV1(signer, settlement_cache)
    facilitator.register_v1(V1_NETWORKS, v1_scheme)

    return facilitator
