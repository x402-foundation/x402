package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"strings"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// checkPhase1 rejects what the ledger would refuse and provider data can show:
// unbalanced value, a fee below the floor, an output below its min-UTXO. A
// transaction moving value the inputs and outputs do not show needs a
// complete phase-1 validator.
func (f *ExactCardanoScheme) checkPhase1(ctx context.Context, transaction string, decoded *cardano.DecodedTransaction, inputs []*cardano.UtxoSnapshot, params *cardano.ProtocolParameters, network string) (string, string) {
	validator, hasValidator := f.signer.(cardano.Phase1Validator)
	if len(decoded.BalanceChangingOperations) > 0 {
		if !hasValidator {
			return cardano.ErrTransactionPhase1Invalid, fmt.Sprintf(
				"transaction carries %s; without a complete phase-1 validator only plain payments are accepted",
				strings.Join(decoded.BalanceChangingOperations, ", "))
		}
	} else if reason, detail := checkValueConservation(decoded, inputs); reason != "" {
		return reason, detail
	}
	if params != nil {
		if reason, detail := checkMinimumFee(decoded, params); reason != "" {
			return reason, detail
		}
		for i, output := range decoded.Outputs {
			if minimum := cardano.MinUtxoLovelace(output.SerializedSize, params.CoinsPerUtxoByte); output.Coin < minimum {
				return cardano.ErrMinUtxoInsufficient, fmt.Sprintf("output %d carries %d lovelace, min-UTXO requires %d", i, output.Coin, minimum)
			}
		}
	}
	if hasValidator {
		if err := validator.ValidatePhase1Transaction(ctx, transaction, network); err != nil {
			return cardano.ErrTransactionPhase1Invalid, err.Error()
		}
	}
	return "", ""
}

// checkValueConservation requires inputs to equal outputs plus fee for
// lovelace and every native asset.
func checkValueConservation(decoded *cardano.DecodedTransaction, inputs []*cardano.UtxoSnapshot) (string, string) {
	inputCoin := new(big.Int)
	inputAssets := map[string]*big.Int{}
	for i, snapshot := range inputs {
		if snapshot.Coin == nil {
			return cardano.ErrInputValueUnavailable, fmt.Sprintf("the chain layer reported no value for input %s", decoded.Inputs[i])
		}
		inputCoin.Add(inputCoin, new(big.Int).SetUint64(*snapshot.Coin))
		addAssets(inputAssets, snapshot.Assets)
	}
	outputCoin := new(big.Int).SetUint64(decoded.Fee)
	outputAssets := map[string]*big.Int{}
	for _, output := range decoded.Outputs {
		outputCoin.Add(outputCoin, new(big.Int).SetUint64(output.Coin))
		addAssets(outputAssets, output.Assets)
	}
	if inputCoin.Cmp(outputCoin) != 0 {
		return cardano.ErrValueNotConserved, fmt.Sprintf("inputs carry %s lovelace but outputs and fee total %s", inputCoin, outputCoin)
	}
	units := map[string]bool{}
	for unit := range inputAssets {
		units[unit] = true
	}
	for unit := range outputAssets {
		units[unit] = true
	}
	sorted := make([]string, 0, len(units))
	for unit := range units {
		sorted = append(sorted, unit)
	}
	sort.Strings(sorted)
	for _, unit := range sorted {
		consumed, produced := valueOf(inputAssets, unit), valueOf(outputAssets, unit)
		if consumed.Cmp(produced) != 0 {
			return cardano.ErrValueNotConserved, fmt.Sprintf("inputs carry %s of %s but outputs carry %s", consumed, unit, produced)
		}
	}
	return "", ""
}

// checkMinimumFee requires fee >= minFeeConstant + minFeeCoefficient * size.
func checkMinimumFee(decoded *cardano.DecodedTransaction, params *cardano.ProtocolParameters) (string, string) {
	minimum := params.MinFeeConstant + params.MinFeeCoefficient*uint64(decoded.SizeBytes)
	if decoded.Fee < minimum {
		return cardano.ErrFeeBelowMinimum, fmt.Sprintf("fee %d is below the protocol minimum %d for %d bytes", decoded.Fee, minimum, decoded.SizeBytes)
	}
	return "", ""
}

func addAssets(target map[string]*big.Int, assets map[string]uint64) {
	for unit, qty := range assets {
		if qty == 0 {
			continue
		}
		key := strings.ToLower(unit)
		if target[key] == nil {
			target[key] = new(big.Int)
		}
		target[key].Add(target[key], new(big.Int).SetUint64(qty))
	}
}

func valueOf(m map[string]*big.Int, unit string) *big.Int {
	if v := m[unit]; v != nil {
		return v
	}
	return new(big.Int)
}
