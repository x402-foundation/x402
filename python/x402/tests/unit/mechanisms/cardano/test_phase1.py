"""Ledger value and fee checks."""

from x402.mechanisms.cardano.types import (
    CardanoProtocolParameters,
    CardanoUtxoOutput,
    CardanoUtxoSnapshot,
    DecodedCardanoTransaction,
)


def test_value_conservation_includes_fee_and_each_native_asset():
    from x402.mechanisms.cardano.exact.phase1 import check_value_conservation

    tx = DecodedCardanoTransaction(
        "tx", ["ref"], [CardanoUtxoOutput("addr", 2_000_000, {"ab.cd": 4})], 200_000, 100
    )
    snapshot = CardanoUtxoSnapshot(True, coin=2_200_000, assets={"AB.CD": 4})
    assert check_value_conservation(tx, [snapshot]).ok
    snapshot.assets["AB.CD"] = 5
    assert check_value_conservation(tx, [snapshot]).reason.endswith("value_not_conserved")
    snapshot.assets["AB.CD"] = 4
    snapshot.coin = 2_000_000
    assert check_value_conservation(tx, [snapshot]).reason.endswith("value_not_conserved")
    snapshot.coin = None
    assert check_value_conservation(tx, [snapshot]).reason.endswith("input_value_unavailable")


def test_minimum_fee_boundary():
    from x402.mechanisms.cardano.exact.phase1 import check_minimum_fee

    tx = DecodedCardanoTransaction("tx", [], [], 159_781, 100)
    params = CardanoProtocolParameters(4310, 44, 155_381)
    assert check_minimum_fee(tx, params).ok
    tx.fee -= 1
    assert check_minimum_fee(tx, params).reason.endswith("fee_below_minimum")
