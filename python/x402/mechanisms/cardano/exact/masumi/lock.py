"""Balance escrow collateral against the datum's post-result minimum UTxO."""

from dataclasses import dataclass
from typing import Any

from pycardano import RawPlutusData

from .constants import masumi_collateral_lovelace
from .datum import MasumiLockDatumInput, build_masumi_lock_datum


@dataclass(frozen=True)
class MasumiLock:
    datum: RawPlutusData
    collateral_lovelace: int
    locked_lovelace: int


def build_masumi_lock(
    extra: dict[str, Any],
    buyer_address: str,
    asset: str,
    amount: int,
    coins_per_utxo_byte: int,
    buyer_return_address: str | None = None,
) -> MasumiLock:
    terms = extra["terms"]
    requested = amount if asset.lower() == "lovelace" else 0
    token_count = 0 if asset.lower() == "lovelace" else 1

    def build(collateral: int) -> RawPlutusData:
        return build_masumi_lock_datum(
            MasumiLockDatumInput(
                buyer_address=buyer_address,
                seller_address=terms["sellerAddress"],
                buyer_return_address=buyer_return_address,
                seller_return_address=terms.get("sellerReturnAddress"),
                reference_key=extra["referenceKey"],
                reference_signature=extra["referenceSignature"],
                seller_nonce=terms["sellerNonce"],
                buyer_nonce=terms["buyerNonce"],
                agent_identifier=terms.get("agentIdentifier") or "",
                collateral_return_lovelace=collateral,
                input_hash=terms["inputHash"],
                pay_by_time=int(terms["payByTime"]),
                submit_result_time=int(terms["submitResultTime"]),
                unlock_time=int(terms["unlockTime"]),
                external_dispute_unlock_time=int(terms["externalDisputeUnlockTime"]),
            )
        )

    collateral = 0
    datum = build(collateral)
    for _ in range(4):
        needed = masumi_collateral_lovelace(
            requested, len(datum.to_cbor()), token_count, coins_per_utxo_byte
        )
        if needed <= collateral:
            return MasumiLock(datum, collateral, requested + collateral)
        collateral = needed
        datum = build(collateral)
    raise ValueError("Masumi collateral did not converge; refusing to build an unspendable lock")
