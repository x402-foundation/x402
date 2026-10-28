package cardano

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend"
	"github.com/Salvionied/apollo/v2/backend/fixed"
	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/alonzo"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/gouroboros/ledger/conway"
	"github.com/blinklabs-io/gouroboros/ledger/mary"
	"github.com/blinklabs-io/gouroboros/ledger/shelley"

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

// PaymentTx describes a payment transaction. Nonce is always spent and is the
// payload's replay nonce; further inputs are selected from Utxos as needed.
type PaymentTx struct {
	Nonce   common.Utxo
	Utxos   []common.Utxo
	Wallet  apollo.Wallet
	Payment PaymentOutput
	TTLSlot uint64
	Params  backend.ProtocolParameters
	// NetworkID is the ledger network id of the wallet and payment addresses.
	NetworkID uint8
}

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
	// feeRounds bounds rebuilding when the canonical encoding needs more fee
	// than Apollo balanced for.
	feeRounds = 3
	tagSet    = 258
)

// BuildPaymentTx selects inputs and balances fee and change with Apollo, then
// signs the body in the encoding Evolution (TypeScript) produces.
func BuildPaymentTx(ctx context.Context, spec PaymentTx) (*BuiltTx, error) {
	if spec.Wallet == nil {
		return nil, errors.New("a wallet is required")
	}
	if spec.Nonce.Id == nil || spec.Nonce.Output == nil {
		return nil, errors.New("funding wallet has no UTxOs available for the payment")
	}
	if spec.TTLSlot > math.MaxInt64 {
		return nil, errors.New("ttl slot out of range")
	}
	payTo, err := x402cardano.ParseAddress(spec.Payment.Address)
	if err != nil {
		return nil, err
	}
	coinsPerUtxoByte := uint64(spec.Params.CoinsPerUtxoByteValue())
	payment := spec.Payment
	for i := 0; ; i++ {
		output, err := paymentTxOutput(payTo, payment)
		if err != nil {
			return nil, err
		}
		encoded, err := canonicalOutput(output)
		if err != nil {
			return nil, err
		}
		minimum := x402cardano.MinUtxoLovelace(len(encoded), coinsPerUtxoByte)
		if payment.Coin >= minimum {
			break
		}
		if !payment.RaiseToMinUtxo || i == minUtxoRaiseRounds-1 {
			return nil, fmt.Errorf("payment of %d lovelace is below the min-UTxO of %d", payment.Coin, minimum)
		}
		payment.Coin = minimum
	}
	if payment.Coin > math.MaxInt64 {
		return nil, errors.New("payment amount out of range")
	}
	units, err := paymentUnits(payment.Assets)
	if err != nil {
		return nil, err
	}

	var padding int64
	for round := 0; round < feeRounds; round++ {
		chain := fixed.NewFixedChainContext(spec.Params, backend.GenesisParameters{}, spec.NetworkID)
		builder := apollo.New(chain).WithContext(ctx).
			SetWallet(spec.Wallet).
			SetChangeAddress(spec.Wallet.Address()).
			AddInput(spec.Nonce).
			AddLoadedUTxOs(spec.Utxos...).
			SetTtl(int64(spec.TTLSlot)).
			SetFeePadding(padding)
		if payment.Datum != nil {
			var datum common.Datum
			if err := datum.UnmarshalCBOR(payment.Datum); err != nil {
				return nil, fmt.Errorf("invalid inline datum: %w", err)
			}
			builder = builder.PayToContract(payTo, &datum, int64(payment.Coin), units...)
		} else {
			builder = builder.PayToAddress(payTo, int64(payment.Coin), units...)
		}
		builder, err = builder.Complete()
		if err != nil {
			return nil, fmt.Errorf("cannot balance the payment: %w", err)
		}
		built, minimum, err := signCanonical(spec, builder.GetTx(), payTo, payment)
		if err != nil {
			return nil, err
		}
		if built.Fee < minimum {
			padding += int64(minimum - built.Fee)
			continue
		}
		if spec.Params.MaxTxSize > 0 && len(built.Bytes) > spec.Params.MaxTxSize {
			return nil, fmt.Errorf("transaction of %d bytes exceeds the maximum of %d", len(built.Bytes), spec.Params.MaxTxSize)
		}
		return built, nil
	}
	return nil, errors.New("transaction fee did not converge")
}

// signCanonical re-emits the balanced body in Evolution's encoding and signs
// it: inputs as a tag-258 set, outputs without a datum or script reference in
// the legacy array form. The TypeScript facilitator re-encodes a transaction
// with Evolution before submitting, so any other encoding would change the
// body hash there and invalidate the witness. It also returns the size-based
// minimum fee of the signed transaction.
func signCanonical(spec PaymentTx, tx *conway.ConwayTransaction, payTo common.Address, payment PaymentOutput) (*BuiltTx, uint64, error) {
	if tx == nil {
		return nil, 0, errors.New("apollo produced no transaction")
	}
	if err := restorePayment(spec, tx, payTo, payment); err != nil {
		return nil, 0, err
	}
	body, err := cbor.Encode(&tx.Body)
	if err != nil {
		return nil, 0, err
	}
	var fields map[uint64]cbor.RawMessage
	if _, err := cbor.Decode(body, &fields); err != nil {
		return nil, 0, err
	}
	inputs := append([]shelley.ShelleyTransactionInput(nil), tx.Body.TxInputs.Items()...)
	sort.Slice(inputs, func(i, j int) bool {
		if c := bytes.Compare(inputs[i].TxId.Bytes(), inputs[j].TxId.Bytes()); c != 0 {
			return c < 0
		}
		return inputs[i].OutputIndex < inputs[j].OutputIndex
	})
	encodedInputs := make([]any, len(inputs))
	refs := make([]string, len(inputs))
	for i, in := range inputs {
		encodedInputs[i] = []any{in.TxId.Bytes(), in.OutputIndex}
		refs[i] = x402cardano.FormatUtxoRef(in.TxId.String(), in.OutputIndex)
	}
	if fields[0], err = cbor.Encode(cbor.Tag{Number: tagSet, Content: encodedInputs}); err != nil {
		return nil, 0, err
	}
	outputs := make([]cbor.RawMessage, len(tx.Body.TxOutputs))
	for i, output := range tx.Body.TxOutputs {
		if outputs[i], err = canonicalOutput(output); err != nil {
			return nil, 0, err
		}
	}
	if fields[1], err = cbor.Encode(outputs); err != nil {
		return nil, 0, err
	}
	if body, err = cbor.Encode(fields); err != nil {
		return nil, 0, err
	}
	bodyHash := common.Blake2b256Hash(body)
	witness, err := spec.Wallet.SignTxBody(bodyHash)
	if err != nil {
		return nil, 0, err
	}
	witnesses := map[uint64]any{
		0: cbor.Tag{Number: tagSet, Content: []any{[]any{witness.Vkey, witness.Signature}}},
	}
	signed, err := cbor.Encode([]any{cbor.RawMessage(body), witnesses, true, nil})
	if err != nil {
		return nil, 0, err
	}
	minimum := uint64(spec.Params.MinFeeCoefficient)*uint64(len(signed)) + uint64(spec.Params.MinFeeConstant)
	return &BuiltTx{
		Bytes:  signed,
		TxHash: bodyHash.String(),
		Fee:    tx.Body.TxFee,
		Nonce:  x402cardano.FormatUtxoRef(spec.Nonce.Id.Id().String(), spec.Nonce.Id.Index()),
		Inputs: refs,
	}, minimum, nil
}

// restorePayment holds the payment output to exactly what was asked. Apollo
// raises a payment below 1 ADA to its own min-UTxO, measured in the map
// encoding, which can exceed the canonical minimum; an exact payment then
// overpays. The excess goes back to the change output, which only grows.
func restorePayment(spec PaymentTx, tx *conway.ConwayTransaction, payTo common.Address, payment PaymentOutput) error {
	outputs := tx.Body.TxOutputs
	if len(outputs) == 0 || outputs[0].Address().String() != payTo.String() {
		return errors.New("apollo did not place the payment output first")
	}
	want, err := paymentTxOutput(payTo, payment)
	if err != nil {
		return err
	}
	got := &outputs[0]
	if !sameAssets(got.Assets(), want.Assets()) || (got.Datum() == nil) != (payment.Datum == nil) ||
		(payment.Datum != nil && !bytes.Equal(got.Datum().Cbor(), payment.Datum)) {
		return errors.New("apollo altered the payment output")
	}
	coin := got.OutputAmount.Amount
	switch {
	case coin == payment.Coin:
		return nil
	case coin < payment.Coin:
		return fmt.Errorf("apollo paid %d lovelace instead of %d", coin, payment.Coin)
	}
	change := spec.Wallet.Address().String()
	for i := len(outputs) - 1; i > 0; i-- {
		if outputs[i].Address().String() == change {
			outputs[i].OutputAmount.Amount += coin - payment.Coin
			got.OutputAmount.Amount = payment.Coin
			return nil
		}
	}
	return fmt.Errorf("apollo raised the payment to %d lovelace and left no change to return it to", coin)
}

func sameAssets(a, b *common.MultiAsset[common.MultiAssetTypeOutput]) bool {
	empty := func(m *common.MultiAsset[common.MultiAssetTypeOutput]) bool {
		return m == nil || len(m.Policies()) == 0
	}
	if empty(a) || empty(b) {
		return empty(a) && empty(b)
	}
	return a.Compare(b) && b.Compare(a)
}

// canonicalOutput encodes an output as Evolution does: the legacy array form
// without datum or script reference, the map form otherwise.
func canonicalOutput(o babbage.BabbageTransactionOutput) ([]byte, error) {
	if o.DatumOption == nil && o.TxOutScriptRef == nil {
		return cbor.Encode(&alonzo.AlonzoTransactionOutput{OutputAddress: o.OutputAddress, OutputAmount: o.OutputAmount})
	}
	fresh := babbage.BabbageTransactionOutput{
		OutputAddress:  o.OutputAddress,
		OutputAmount:   o.OutputAmount,
		DatumOption:    o.DatumOption,
		TxOutScriptRef: o.TxOutScriptRef,
	}
	return cbor.Encode(&fresh)
}

// paymentTxOutput is the payment as a ledger output, for sizing.
func paymentTxOutput(addr common.Address, payment PaymentOutput) (babbage.BabbageTransactionOutput, error) {
	value := mary.MaryTransactionOutputValue{Amount: payment.Coin}
	if len(payment.Assets) > 0 {
		assets := map[common.Blake2b224]map[cbor.ByteString]*big.Int{}
		for unit, quantity := range payment.Assets {
			policy, name, err := x402cardano.ParseAssetUnit(unit)
			if err != nil || policy == "" {
				return babbage.BabbageTransactionOutput{}, fmt.Errorf("invalid asset unit %s", unit)
			}
			id, nameBytes, err := assetKey(policy, name)
			if err != nil {
				return babbage.BabbageTransactionOutput{}, err
			}
			if assets[id] == nil {
				assets[id] = map[cbor.ByteString]*big.Int{}
			}
			assets[id][cbor.NewByteString(nameBytes)] = new(big.Int).SetUint64(quantity)
		}
		multi := common.NewMultiAsset[common.MultiAssetTypeOutput](assets)
		value.Assets = &multi
	}
	output := babbage.BabbageTransactionOutput{OutputAddress: addr, OutputAmount: value}
	if payment.Datum != nil {
		option, err := cbor.Encode([]any{1, cbor.Tag{Number: 24, Content: payment.Datum}})
		if err != nil {
			return output, err
		}
		output.DatumOption = &babbage.BabbageTransactionOutputDatumOption{}
		if err := output.DatumOption.UnmarshalCBOR(option); err != nil {
			return output, fmt.Errorf("invalid inline datum: %w", err)
		}
	}
	return output, nil
}

func paymentUnits(assets map[string]uint64) ([]apollo.Unit, error) {
	units := make([]apollo.Unit, 0, len(assets))
	for unit, quantity := range assets {
		policy, name, err := x402cardano.ParseAssetUnit(unit)
		if err != nil || policy == "" {
			return nil, fmt.Errorf("invalid asset unit %s", unit)
		}
		if quantity > math.MaxInt64 {
			return nil, fmt.Errorf("asset quantity of %s out of range", unit)
		}
		units = append(units, apollo.NewUnit(policy, name, int64(quantity)))
	}
	sort.Slice(units, func(i, j int) bool { return units[i].PolicyId+units[i].Name < units[j].PolicyId+units[j].Name })
	return units, nil
}

// assetKey decodes a parsed asset unit into its multi-asset map key.
func assetKey(policy, name string) (common.Blake2b224, []byte, error) {
	policyBytes, err := hex.DecodeString(policy)
	if err != nil || len(policyBytes) != common.Blake2b224Size {
		return common.Blake2b224{}, nil, fmt.Errorf("invalid policy id %q", policy)
	}
	nameBytes, err := hex.DecodeString(name)
	if err != nil {
		return common.Blake2b224{}, nil, fmt.Errorf("invalid asset name %q", name)
	}
	return common.NewBlake2b224(policyBytes), nameBytes, nil
}
