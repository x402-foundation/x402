"""Wallet and chain-query protocols for Cardano payment schemes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ...schemas import ResourceInfo
from .types import CardanoSubmissionResult, CardanoUtxoSnapshot, ExactCardanoPayload


@dataclass(frozen=True)
class ClientCardanoSignInput:
    network: str
    pay_to: str
    asset: str
    amount: str
    max_timeout_seconds: int
    extra: dict[str, Any] | None = None
    resource: ResourceInfo | None = None


ClientCardanoSignResult = ExactCardanoPayload


class ClientCardanoSigner(Protocol):
    def get_address(self) -> str: ...

    def build_and_sign_payment_transaction(
        self, input: ClientCardanoSignInput
    ) -> ClientCardanoSignResult: ...


class FacilitatorCardanoSigner(Protocol):
    """Required chain operations; optional evidence and validation hooks are capability-based."""

    def get_addresses(self) -> list[str]: ...

    def get_utxo(self, ref: str, network: str) -> CardanoUtxoSnapshot: ...

    def get_current_slot(self, network: str) -> int: ...

    def submit_transaction(
        self, signed_transaction_base64: str, network: str
    ) -> CardanoSubmissionResult: ...
