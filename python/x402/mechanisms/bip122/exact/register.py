"""Registration helpers for BIP-122 exact payment schemes."""

from typing import TYPE_CHECKING, TypeVar

from ..constants import BTC_MAINNET_CAIP2, BTC_TESTNET_CAIP2

if TYPE_CHECKING:
    from x402 import (
        x402Client,
        x402ClientSync,
        x402Facilitator,
        x402FacilitatorSync,
        x402ResourceServer,
        x402ResourceServerSync,
    )

    from ..payer import LightningPayer
    from ..receiver import LightningReceiver

ClientT = TypeVar("ClientT", "x402Client", "x402ClientSync")
ServerT = TypeVar("ServerT", "x402ResourceServer", "x402ResourceServerSync")
FacilitatorT = TypeVar("FacilitatorT", "x402Facilitator", "x402FacilitatorSync")


def register_exact_bip122_client(
    client: ClientT,
    payer: "LightningPayer",
    networks: str | list[str] | None = None,
    policies: list | None = None,
) -> ClientT:
    """Register BIP-122 exact payment schemes to x402Client."""
    from .client import ExactBip122Scheme as ExactBip122ClientScheme

    scheme = ExactBip122ClientScheme(payer)
    if networks:
        if isinstance(networks, str):
            networks = [networks]
        for network in networks:
            client.register(network, scheme)
    else:
        client.register("bip122:*", scheme)

    if policies:
        for policy in policies:
            client.register_policy(policy)

    return client


def register_exact_bip122_server(
    server: ServerT,
    receiver: "LightningReceiver",
    networks: str | list[str] | None = None,
) -> ServerT:
    """Register BIP-122 exact payment schemes to x402ResourceServer."""
    from .server import ExactBip122Scheme as ExactBip122ServerScheme

    scheme = ExactBip122ServerScheme(receiver)
    if networks:
        if isinstance(networks, str):
            networks = [networks]
        for network in networks:
            server.register(network, scheme)
    else:
        server.register("bip122:*", scheme)

    return server


def register_exact_bip122_facilitator(
    facilitator: FacilitatorT,
    receiver: "LightningReceiver",
    networks: str | list[str] | None = None,
) -> FacilitatorT:
    """Register BIP-122 exact payment schemes to x402Facilitator."""
    from .facilitator import ExactBip122Scheme as ExactBip122FacilitatorScheme

    scheme = ExactBip122FacilitatorScheme(receiver)
    if networks is None:
        networks = [BTC_MAINNET_CAIP2, BTC_TESTNET_CAIP2]
    elif isinstance(networks, str):
        networks = [networks]

    facilitator.register(networks, scheme)
    return facilitator
