"""Value conservation and minimum-fee checks before submission."""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass

from ..constants import ERR_FEE_BELOW_MINIMUM, ERR_INPUT_VALUE_UNAVAILABLE, ERR_VALUE_NOT_CONSERVED
from ..types import CardanoProtocolParameters, CardanoUtxoSnapshot, DecodedCardanoTransaction


@dataclass(frozen=True)
class Phase1Check:
    ok: bool
    reason: str | None = None
    detail: str | None = None


def check_value_conservation(
    decoded: DecodedCardanoTransaction, inputs: Sequence[CardanoUtxoSnapshot]
) -> Phase1Check:
    input_coin = 0
    input_assets: dict[str, int] = defaultdict(int)
    for index, snapshot in enumerate(inputs):
        if snapshot.coin is None:
            ref = decoded.inputs[index] if index < len(decoded.inputs) else index
            return Phase1Check(
                False,
                ERR_INPUT_VALUE_UNAVAILABLE,
                f"the chain layer reported no value for input {ref}",
            )
        input_coin += snapshot.coin
        for unit, quantity in (snapshot.assets or {}).items():
            input_assets[unit.lower()] += quantity
    output_coin = decoded.fee
    output_assets: dict[str, int] = defaultdict(int)
    for output in decoded.outputs:
        output_coin += output.coin
        for unit, quantity in output.assets.items():
            output_assets[unit.lower()] += quantity
    if input_coin != output_coin:
        return Phase1Check(
            False,
            ERR_VALUE_NOT_CONSERVED,
            f"inputs carry {input_coin} lovelace but outputs and fee total {output_coin}",
        )
    for unit in input_assets.keys() | output_assets.keys():
        if input_assets[unit] != output_assets[unit]:
            return Phase1Check(
                False,
                ERR_VALUE_NOT_CONSERVED,
                f"inputs carry {input_assets[unit]} of {unit} but outputs carry {output_assets[unit]}",
            )
    return Phase1Check(True)


def check_minimum_fee(
    decoded: DecodedCardanoTransaction, parameters: CardanoProtocolParameters
) -> Phase1Check:
    minimum = parameters.min_fee_constant + parameters.min_fee_coefficient * decoded.size_bytes
    if decoded.fee < minimum:
        return Phase1Check(
            False,
            ERR_FEE_BELOW_MINIMUM,
            f"fee {decoded.fee} is below the protocol minimum {minimum} for {decoded.size_bytes} bytes",
        )
    return Phase1Check(True)
