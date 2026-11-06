"""Registration helpers for SVM exact payment schemes."""

from collections.abc import Sequence
from typing import TYPE_CHECKING, TypeVar

from ....schemas.helpers import matches_network_pattern
from ..constants import V1_NETWORKS, V1_TO_V2_NETWORK_MAP

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
    from .client import ApproveSplits

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
    approve_splits: "ApproveSplits | None" = None,
) -> ClientT:
    """Register SVM exact payment schemes to x402Client.

    Registers:
    - V2: solana:* wildcard (or specific networks if provided)
    - V1: All supported SVM networks (or those matching networks if provided)

    Args:
        client: x402Client instance.
        signer: SVM signer for payment authorizations.
        networks: Optional specific network(s) (default: wildcard).
        policies: Optional payment policies.
        rpc_url: Optional custom RPC URL.
        approve_splits: Optional consent hook for requirements carrying
            ``extra.splits`` (V2 only); without it such requirements are refused.

    Returns:
        Client for chaining.
    """
    from .client import ExactSvmScheme as ExactSvmClientScheme
    from .v1.client import ExactSvmSchemeV1 as ExactSvmClientSchemeV1

    scheme = ExactSvmClientScheme(signer, rpc_url, approve_splits=approve_splits)

    if networks:
        if isinstance(networks, str):
            networks = [networks]
        for network in networks:
            client.register(network, scheme)
    else:
        client.register("solana:*", scheme)

    v1_networks = V1_NETWORKS
    if networks:
        v1_networks = [
            name
            for name in V1_NETWORKS
            if name in V1_TO_V2_NETWORK_MAP
            and any(
                matches_network_pattern(V1_TO_V2_NETWORK_MAP[name], pattern) for pattern in networks
            )
        ]

    v1_scheme = ExactSvmClientSchemeV1(signer, rpc_url)
    for network in v1_networks:
        client.register_v1(network, v1_scheme)

    if policies:
        for policy in policies:
            client.register_policy(policy)

    return client


def register_exact_svm_server(
    server: ServerT,
    networks: str | list[str] | None = None,
    rpc_url: str | None = None,
) -> ServerT:
    """Register SVM exact payment schemes to x402ResourceServer.

    V2 only (no server-side for V1).

    Args:
        server: x402ResourceServer instance.
        networks: Optional specific network(s) (default: wildcard).
        rpc_url: Optional RPC URL used to add blockhash construction hints.

    Returns:
        Server for chaining.
    """
    from .server import ExactSvmScheme as ExactSvmServerScheme

    scheme = ExactSvmServerScheme(rpc_url)

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
    max_splits: int = 0,
    ata_creation_sponsored: bool = False,
    transaction_versions: Sequence[int] | None = None,
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
        max_splits: Maximum ``extra.splits`` entries the V2 scheme accepts (0-8).
        ata_creation_sponsored: Whether the V2 scheme's fee payer funds ATA
            creation for recipients marked ``ataCreationRequired``.
        transaction_versions: Transaction message versions to accept and
            advertise, applied to both the V2 and V1 schemes. Defaults to
            ``[0, 1]``.

    Returns:
        Facilitator for chaining.
    """
    from ..settlement_cache import SettlementCache
    from .facilitator import ExactSvmScheme as ExactSvmFacilitatorScheme
    from .v1.facilitator import ExactSvmSchemeV1 as ExactSvmFacilitatorSchemeV1

    settlement_cache = SettlementCache()

    scheme = ExactSvmFacilitatorScheme(
        signer,
        settlement_cache,
        max_splits=max_splits,
        ata_creation_sponsored=ata_creation_sponsored,
        transaction_versions=transaction_versions,
    )

    if isinstance(networks, str):
        networks = [networks]
    facilitator.register(networks, scheme)

    # Register V1
    v1_scheme = ExactSvmFacilitatorSchemeV1(
        signer, settlement_cache, transaction_versions=transaction_versions
    )
    facilitator.register_v1(V1_NETWORKS, v1_scheme)

    return facilitator
