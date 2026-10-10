"""Registration helpers for the v2 SVM batch-settlement scheme."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

from .client import BatchSvmScheme as BatchSvmClientScheme
from .client_types import BatchSvmClientConfig
from .facilitator import BatchSvmFacilitatorConfig
from .facilitator import BatchSvmScheme as BatchSvmFacilitatorScheme
from .server import BatchSvmScheme as BatchSvmServerScheme
from .server import BatchSvmServerConfig

if TYPE_CHECKING:
    from x402 import (
        x402Client,
        x402ClientSync,
        x402Facilitator,
        x402FacilitatorSync,
        x402ResourceServer,
        x402ResourceServerSync,
    )

ClientT = TypeVar("ClientT", "x402Client", "x402ClientSync")
ServerT = TypeVar("ServerT", "x402ResourceServer", "x402ResourceServerSync")
FacilitatorT = TypeVar("FacilitatorT", "x402Facilitator", "x402FacilitatorSync")


def register_batch_svm_client(
    client: ClientT,
    signer: Any,
    networks: str | list[str] | None = None,
    config: BatchSvmClientConfig | None = None,
) -> ClientT:
    scheme = BatchSvmClientScheme(signer, config)
    selected = [networks] if isinstance(networks, str) else networks or ["solana:*"]
    for network in selected:
        client.register(network, scheme)
    client.register_policy(scheme.payment_policy)
    return client


def register_batch_svm_server(
    server: ServerT,
    networks: str | list[str] | None = None,
    config: BatchSvmServerConfig | None = None,
) -> ServerT:
    scheme = BatchSvmServerScheme(config)
    selected = [networks] if isinstance(networks, str) else networks or ["solana:*"]
    for network in selected:
        server.register(network, scheme)
    return server


def register_batch_svm_facilitator(
    facilitator: FacilitatorT,
    signer: Any,
    networks: str | list[str],
    config: BatchSvmFacilitatorConfig,
) -> FacilitatorT:
    scheme = BatchSvmFacilitatorScheme(signer, config)
    facilitator.register([networks] if isinstance(networks, str) else networks, scheme)
    return facilitator
