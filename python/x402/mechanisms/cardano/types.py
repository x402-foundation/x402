"""Cardano payloads and decoded transaction records."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class CardanoConfirmationPolicy:
    l1_confirmations: int = 1

    def to_dict(self) -> dict[str, int]:
        return {"l1Confirmations": self.l1_confirmations}


@dataclass(frozen=True)
class ExactCardanoPayload:
    """Signed, unbroadcast transaction and the input used as its nonce."""

    transaction: str
    nonce: str

    def to_dict(self) -> dict[str, str]:
        return {"transaction": self.transaction, "nonce": self.nonce}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ExactCardanoPayload:
        from .utils import decode_cardano_payload

        return decode_cardano_payload(data)


@dataclass
class CardanoUtxoOutput:
    address: str
    coin: int
    assets: dict[str, int] = field(default_factory=dict)
    datum: str | None = None
    serialized_size: int | None = None
    has_reference_script: bool = False


@dataclass
class DecodedCardanoTransaction:
    tx_hash: str
    inputs: list[str]
    outputs: list[CardanoUtxoOutput]
    fee: int
    size_bytes: int
    network_id: int | None = None
    ttl_slot: int | None = None
    validity_start_slot: int | None = None
    balance_changing_operations: list[str] = field(default_factory=list)
    vkey_witness_count: int = 0
    vkey_hashes: list[str] = field(default_factory=list)
    script_witness_count: int = 0
    redeemer_count: int = 0
    signatures_valid: bool = False
    is_valid: bool = True
    auxiliary_data_hash: str | None = None
    required_signer_hashes: list[str] = field(default_factory=list)


@dataclass
class CardanoUtxoSnapshot:
    exists: bool
    address: str | None = None
    coin: int | None = None
    assets: dict[str, int] | None = None
    payment_key_hash: str | None = None


@dataclass(frozen=True)
class CardanoProtocolParameters:
    coins_per_utxo_byte: int
    min_fee_coefficient: int
    min_fee_constant: int


@dataclass(frozen=True)
class CardanoSettlementEvidence:
    status: Literal["unknown", "mempool", "confirmed"]
    confirmations: int


@dataclass(frozen=True)
class CardanoSubmissionResult:
    tx_hash: str
    status: Literal["mempool", "confirmed"]
