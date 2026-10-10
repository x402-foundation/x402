package cardano

import (
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/fxamacker/cbor/v2"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// PaymentOutput is the single payment the builder creates.
type PaymentOutput struct {
	Address string
	Coin    uint64
	Assets  map[string]uint64
	// Datum is attached inline when non-nil.
	Datum []byte
	// RaiseToMinUtxo lifts Coin to the output's min-UTxO when below it.
	RaiseToMinUtxo bool
}

// PaymentTx describes a payment transaction. Utxos[0] is the nonce input and is
// always spent; further inputs are selected from the rest as needed.
type PaymentTx struct {
	Utxos         []Utxo
	ChangeAddress string
	Payment       PaymentOutput
	TTLSlot       uint64
	Params        ProtocolParameters
}

// TxSigner signs a transaction body hash, returning the verification key and signature.
type TxSigner func(bodyHash []byte) (vkey []byte, signature []byte)

// BuiltTx is a signed transaction ready for the payload.
type BuiltTx struct {
	Bytes  []byte
	TxHash string
	Fee    uint64
	Nonce  string
	// Inputs are the refs of every spent UTxO.
	Inputs []string
}

const (
	// minUtxoRaiseRounds bounds raising an output to its size-dependent min-UTxO.
	minUtxoRaiseRounds = 4
	// feeRounds bounds the fee fixed-point iteration.
	feeRounds = 8
	// tagSet marks CBOR sets (inputs, witnesses); tagEncodedCBOR an inline datum.
	tagSet         = 258
	tagEncodedCBOR = 24
)

var cborEnc = func() cbor.EncMode {
	mode, err := cbor.EncOptions{Sort: cbor.SortCoreDeterministic}.EncMode()
	if err != nil {
		panic(err)
	}
	return mode
}()

type value struct {
	coin   uint64
	assets map[string]uint64
}

func (v *value) add(coin uint64, assets map[string]uint64) {
	v.coin += coin
	for unit, qty := range assets {
		if v.assets == nil {
			v.assets = map[string]uint64{}
		}
		v.assets[unit] += qty
	}
}

// covers reports whether v holds at least coin and every asset of assets.
func (v *value) covers(coin uint64, assets map[string]uint64) bool {
	if v.coin < coin {
		return false
	}
	for unit, qty := range assets {
		if v.assets[unit] < qty {
			return false
		}
	}
	return true
}

// BuildPaymentTx selects inputs, balances fee and change, and signs.
func BuildPaymentTx(spec PaymentTx, sign TxSigner) (*BuiltTx, error) {
	if len(spec.Utxos) == 0 {
		return nil, errors.New("funding wallet has no UTxOs available for the payment")
	}
	payment := spec.Payment
	for i := 0; ; i++ {
		size, err := outputSize(payment.Address, payment.Coin, payment.Assets, payment.Datum)
		if err != nil {
			return nil, err
		}
		minimum := x402cardano.MinUtxoLovelace(size, spec.Params.CoinsPerUtxoByte)
		if payment.Coin >= minimum {
			break
		}
		if !payment.RaiseToMinUtxo || i == minUtxoRaiseRounds-1 {
			return nil, fmt.Errorf("payment of %d lovelace is below the min-UTxO of %d", payment.Coin, minimum)
		}
		payment.Coin = minimum
	}

	selected := []Utxo{spec.Utxos[0]}
	candidates := append([]Utxo(nil), spec.Utxos[1:]...)
	sort.SliceStable(candidates, func(i, j int) bool {
		if (len(candidates[i].Assets) == 0) != (len(candidates[j].Assets) == 0) {
			return len(candidates[i].Assets) == 0
		}
		return candidates[i].Coin > candidates[j].Coin
	})
	for {
		built, shortfall, err := balance(spec, payment, selected, sign, false)
		if err != nil {
			return nil, err
		}
		if built != nil {
			return built, nil
		}
		next := -1
		for i, c := range candidates {
			if c.HasReferenceScript {
				continue
			}
			if len(shortfall.assets) == 0 || hasUnit(c.Assets, shortfall.assets) {
				next = i
				break
			}
		}
		if next < 0 && len(shortfall.assets) == 0 {
			// No input left to fund a change output: fold the remainder into
			// the fee when that covers it.
			if built, _, err := balance(spec, payment, selected, sign, true); err != nil || built != nil {
				return built, err
			}
		}
		if next < 0 {
			return nil, fmt.Errorf("insufficient funds: short %d lovelace%s", shortfall.coin, describeAssets(shortfall.assets))
		}
		selected = append(selected, candidates[next])
		candidates = append(candidates[:next], candidates[next+1:]...)
	}
}

// balance tries to build with the selected inputs. It returns the signed
// transaction, or the shortfall that more inputs must cover. With noChange
// and no assets to return, everything above the payment becomes the fee.
func balance(spec PaymentTx, payment PaymentOutput, inputs []Utxo, sign TxSigner, noChange bool) (*BuiltTx, *value, error) {
	var in value
	for _, u := range inputs {
		in.add(u.Coin, u.Assets)
	}
	if !in.covers(payment.Coin, payment.Assets) {
		short := &value{assets: map[string]uint64{}}
		if in.coin < payment.Coin {
			short.coin = payment.Coin - in.coin
		}
		for unit, qty := range payment.Assets {
			if in.assets[unit] < qty {
				short.assets[unit] = qty - in.assets[unit]
			}
		}
		return nil, short, nil
	}
	changeAssets := map[string]uint64{}
	for unit, qty := range in.assets {
		if rest := qty - payment.Assets[unit]; rest > 0 {
			changeAssets[unit] = rest
		}
	}
	if noChange {
		if len(changeAssets) > 0 {
			return nil, &value{}, nil
		}
		fee := in.coin - payment.Coin
		txBytes, txHash, err := assemble(spec, payment, inputs, nil, nil, fee, sign)
		if err != nil {
			return nil, nil, err
		}
		if needed := spec.Params.MinFeeA*uint64(len(txBytes)) + spec.Params.MinFeeB; needed > fee {
			return nil, &value{coin: needed - fee}, nil
		}
		return finish(spec, inputs, txBytes, txHash, fee)
	}
	fee := uint64(0)
	for i := 0; i < feeRounds; i++ {
		available := in.coin - payment.Coin
		if available < fee {
			return nil, &value{coin: fee - available}, nil
		}
		change := available - fee
		changeSize, err := outputSize(spec.ChangeAddress, change, changeAssets, nil)
		if err != nil {
			return nil, nil, err
		}
		minChange := x402cardano.MinUtxoLovelace(changeSize, spec.Params.CoinsPerUtxoByte)
		if change < minChange {
			return nil, &value{coin: minChange - change}, nil
		}
		txBytes, txHash, err := assemble(spec, payment, inputs, &change, changeAssets, fee, sign)
		if err != nil {
			return nil, nil, err
		}
		needed := spec.Params.MinFeeA*uint64(len(txBytes)) + spec.Params.MinFeeB
		if needed <= fee {
			return finish(spec, inputs, txBytes, txHash, fee)
		}
		fee = needed
	}
	return nil, nil, errors.New("transaction fee did not converge")
}

func finish(spec PaymentTx, inputs []Utxo, txBytes []byte, txHash string, fee uint64) (*BuiltTx, *value, error) {
	if spec.Params.MaxTxSize > 0 && len(txBytes) > spec.Params.MaxTxSize {
		return nil, nil, fmt.Errorf("transaction of %d bytes exceeds the maximum of %d", len(txBytes), spec.Params.MaxTxSize)
	}
	refs := make([]string, len(inputs))
	for i, u := range inputs {
		refs[i] = u.Ref()
	}
	return &BuiltTx{Bytes: txBytes, TxHash: txHash, Fee: fee, Nonce: spec.Utxos[0].Ref(), Inputs: refs}, nil, nil
}

// assemble builds and signs the transaction; a nil change omits the change output.
func assemble(spec PaymentTx, payment PaymentOutput, inputs []Utxo, change *uint64, changeAssets map[string]uint64, fee uint64, sign TxSigner) ([]byte, string, error) {
	sorted := append([]Utxo(nil), inputs...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].TxHash != sorted[j].TxHash {
			return sorted[i].TxHash < sorted[j].TxHash
		}
		return sorted[i].Index < sorted[j].Index
	})
	encodedInputs := make([][]interface{}, 0, len(sorted))
	for _, u := range sorted {
		id, err := hex.DecodeString(u.TxHash)
		if err != nil || len(id) != 32 {
			return nil, "", fmt.Errorf("invalid input %s", u.Ref())
		}
		encodedInputs = append(encodedInputs, []interface{}{id, u.Index})
	}
	paymentOut, err := encodeOutput(payment.Address, payment.Coin, payment.Assets, payment.Datum)
	if err != nil {
		return nil, "", err
	}
	outputs := []cbor.RawMessage{paymentOut}
	if change != nil {
		changeOut, err := encodeOutput(spec.ChangeAddress, *change, changeAssets, nil)
		if err != nil {
			return nil, "", err
		}
		outputs = append(outputs, changeOut)
	}
	body := map[uint64]interface{}{
		0: cbor.Tag{Number: tagSet, Content: encodedInputs},
		1: outputs,
		2: fee,
		3: spec.TTLSlot,
	}
	bodyBytes, err := cborEnc.Marshal(body)
	if err != nil {
		return nil, "", err
	}
	bodyHash := x402cardano.Blake2b256(bodyBytes)
	vkey, signature := sign(bodyHash)
	witnesses := map[uint64]interface{}{
		0: cbor.Tag{Number: tagSet, Content: []interface{}{[]interface{}{vkey, signature}}},
	}
	tx, err := cborEnc.Marshal([]interface{}{cbor.RawMessage(bodyBytes), witnesses, true, nil})
	if err != nil {
		return nil, "", err
	}
	return tx, hex.EncodeToString(bodyHash), nil
}

// encodeOutput encodes an output in the form TypeScript (Evolution) produces:
// the legacy array form without datum, the map form with an inline datum. The
// TS facilitator re-encodes before submitting, so any other encoding would
// change the transaction id there.
func encodeOutput(address string, coin uint64, assets map[string]uint64, datum []byte) (cbor.RawMessage, error) {
	addr, err := x402cardano.ParseAddress(address)
	if err != nil {
		return nil, err
	}
	addrBytes, err := addr.Bytes()
	if err != nil {
		return nil, err
	}
	var value interface{} = coin
	if len(assets) > 0 {
		multi := map[cbor.ByteString]map[cbor.ByteString]uint64{}
		for unit, qty := range assets {
			policy, name, err := x402cardano.ParseAssetUnit(unit)
			if err != nil || policy == "" {
				return nil, fmt.Errorf("invalid asset unit %s", unit)
			}
			policyBytes, _ := hex.DecodeString(policy)
			nameBytes, _ := hex.DecodeString(name)
			if multi[cbor.ByteString(policyBytes)] == nil {
				multi[cbor.ByteString(policyBytes)] = map[cbor.ByteString]uint64{}
			}
			multi[cbor.ByteString(policyBytes)][cbor.ByteString(nameBytes)] = qty
		}
		value = []interface{}{coin, multi}
	}
	if datum == nil {
		return cborEnc.Marshal([]interface{}{addrBytes, value})
	}
	return cborEnc.Marshal(map[uint64]interface{}{
		0: addrBytes,
		1: value,
		2: []interface{}{1, cbor.Tag{Number: tagEncodedCBOR, Content: datum}},
	})
}

func outputSize(address string, coin uint64, assets map[string]uint64, datum []byte) (int, error) {
	encoded, err := encodeOutput(address, coin, assets, datum)
	return len(encoded), err
}

func hasUnit(assets map[string]uint64, wanted map[string]uint64) bool {
	for unit := range wanted {
		if assets[unit] > 0 {
			return true
		}
	}
	return false
}

func describeAssets(assets map[string]uint64) string {
	if len(assets) == 0 {
		return ""
	}
	var parts []string
	for unit, qty := range assets {
		parts = append(parts, fmt.Sprintf("%d %s", qty, unit))
	}
	sort.Strings(parts)
	return " and " + strings.Join(parts, ", ")
}
