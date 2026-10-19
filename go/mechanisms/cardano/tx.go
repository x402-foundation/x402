package cardano

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/conway"
)

// UtxoOutput is a decoded transaction output.
type UtxoOutput struct {
	Address string
	Coin    uint64
	// Assets maps policyId.assetNameHex to quantity.
	Assets map[string]uint64
	// Datum is the inline datum CBOR (hex), empty when absent.
	Datum string
	// SerializedSize is the output's encoded size as carried in the transaction.
	SerializedSize int
	// ValueSize is the encoded size of the output's value, which the ledger
	// bounds by maxValueSize.
	ValueSize          int
	NetworkID          int
	HasReferenceScript bool
}

// DecodedTransaction is the verification view of a signed Conway transaction.
type DecodedTransaction struct {
	TxHash                    string
	NetworkID                 *int
	TTLSlot                   *uint64
	ValidityStartSlot         *uint64
	Inputs                    []string
	Fee                       uint64
	SizeBytes                 int
	BalanceChangingOperations []string
	// UnverifiedFeatures are body fields and witnesses the built-in checks
	// cannot judge from provider data; only a complete phase-1 validator can.
	UnverifiedFeatures []string
	// AuxiliaryDataMismatch is set when the body's auxiliary data hash and
	// the transaction's auxiliary data disagree, which the ledger rejects.
	AuxiliaryDataMismatch bool
	Outputs               []UtxoOutput
	VkeyWitnessCount      int
	VkeyHashes            []string
	ScriptWitnessCount    int
	RedeemerCount         int
	SignaturesValid       bool
	IsValid               bool
	// Bytes are the exact transaction bytes; they are submitted unchanged.
	Bytes []byte
}

// maxTransactionBase64Len is the base64 length of MaxTransactionBytes.
const maxTransactionBase64Len = (MaxTransactionBytes + 2) / 3 * 4

// DecodeTransactionBytes decodes canonical padded base64 within the size limit.
func DecodeTransactionBytes(transactionBase64 string) ([]byte, error) {
	if len(transactionBase64) == 0 || len(transactionBase64) > maxTransactionBase64Len {
		return nil, errors.New("cardano transaction exceeds the decode limit")
	}
	decoded, err := base64.StdEncoding.DecodeString(transactionBase64)
	if err != nil || len(decoded) == 0 || len(decoded) > MaxTransactionBytes ||
		base64.StdEncoding.EncodeToString(decoded) != transactionBase64 {
		return nil, errors.New("cardano transaction must use canonical padded base64")
	}
	return decoded, nil
}

// DecodePayload extracts the scheme payload from the generic payload map.
func DecodePayload(raw map[string]interface{}) (ExactCardanoPayload, error) {
	transaction, _ := raw["transaction"].(string)
	nonce, _ := raw["nonce"].(string)
	if transaction == "" {
		return ExactCardanoPayload{}, errors.New("cardano payload is missing a transaction string")
	}
	if len(transaction) > maxTransactionBase64Len {
		return ExactCardanoPayload{}, errors.New("cardano payload transaction exceeds the decode limit")
	}
	if nonce == "" {
		return ExactCardanoPayload{}, errors.New("cardano payload is missing a nonce string")
	}
	return ExactCardanoPayload{Transaction: transaction, Nonce: nonce}, nil
}

// DecodeTransaction decodes a base64 signed Conway transaction.
func DecodeTransaction(transactionBase64 string) (*DecodedTransaction, error) {
	txBytes, err := DecodeTransactionBytes(transactionBase64)
	if err != nil {
		return nil, err
	}
	return DecodeTransactionCBOR(txBytes)
}

// DecodeTransactionCBOR decodes signed Conway transaction bytes.
func DecodeTransactionCBOR(txBytes []byte) (*DecodedTransaction, error) {
	tx, err := conway.NewConwayTransactionFromCbor(txBytes)
	if err != nil {
		return nil, fmt.Errorf("invalid Conway transaction: %w", err)
	}
	bodyHash := tx.Hash()
	decoded := &DecodedTransaction{
		TxHash:    bodyHash.String(),
		SizeBytes: len(txBytes),
		Bytes:     append([]byte(nil), txBytes...),
		Fee:       tx.Body.TxFee,
		IsValid:   tx.TxIsValid,
	}
	for _, input := range tx.Inputs() {
		decoded.Inputs = append(decoded.Inputs, FormatUtxoRef(input.Id().String(), input.Index()))
	}
	for i := range tx.Body.TxOutputs {
		output, err := decodeOutput(&tx.Body.TxOutputs[i])
		if err != nil {
			return nil, fmt.Errorf("output %d: %w", i, err)
		}
		decoded.Outputs = append(decoded.Outputs, output)
	}
	// Ttl and validity start decode to zero when absent, so presence is read
	// from the body's keys.
	present, err := bodyKeys(tx.Body.Cbor())
	if err != nil {
		return nil, err
	}
	if present[3] {
		ttl := tx.Body.Ttl
		decoded.TTLSlot = &ttl
	}
	if present[8] {
		start := tx.Body.TxValidityIntervalStart
		decoded.ValidityStartSlot = &start
	}
	if id := tx.Body.TxNetworkId; id != nil {
		networkID := int(*id)
		decoded.NetworkID = &networkID
	}
	for _, op := range []struct {
		key  uint64
		name string
	}{{9, "mint"}, {5, "withdrawals"}, {4, "certificates"}, {20, "proposalProcedures"}, {22, "donation"}} {
		if present[op.key] {
			decoded.BalanceChangingOperations = append(decoded.BalanceChangingOperations, op.name)
		}
	}
	for _, field := range []struct {
		key  uint64
		name string
	}{{11, "scriptDataHash"}, {13, "collateral"}, {14, "requiredSigners"}, {16, "collateralReturn"},
		{17, "totalCollateral"}, {18, "referenceInputs"}, {19, "votingProcedures"}, {21, "currentTreasuryValue"}} {
		if present[field.key] {
			decoded.UnverifiedFeatures = append(decoded.UnverifiedFeatures, field.name)
		}
	}
	if decoded.AuxiliaryDataMismatch, err = auxiliaryDataMismatch(txBytes, present[7], tx.Body.TxAuxDataHash); err != nil {
		return nil, err
	}
	decodeWitnesses(decoded, &tx.WitnessSet, bodyHash.Bytes())
	return decoded, nil
}

// auxiliaryDataMismatch compares the body's auxiliary data hash with the
// hash of the auxiliary data the transaction carries.
func auxiliaryDataMismatch(txBytes []byte, hashPresent bool, hash interface{ Bytes() []byte }) (bool, error) {
	var parts []cbor.RawMessage
	if _, err := cbor.Decode(txBytes, &parts); err != nil || len(parts) != 4 {
		return false, errors.New("invalid transaction envelope")
	}
	auxPresent := len(parts[3]) != 1 || parts[3][0] != 0xf6
	if !hashPresent || !auxPresent {
		return hashPresent != auxPresent, nil
	}
	return !bytes.Equal(Blake2b256(parts[3]), hash.Bytes()), nil
}

func decodeWitnesses(d *DecodedTransaction, ws *conway.ConwayTransactionWitnessSet, bodyHash []byte) {
	vkeys := ws.VkeyWitnesses.Items()
	d.SignaturesValid = true
	for _, witness := range vkeys {
		d.VkeyHashes = append(d.VkeyHashes, hex.EncodeToString(Blake2b224(witness.Vkey)))
		if len(witness.Vkey) != ed25519.PublicKeySize || len(witness.Signature) != ed25519.SignatureSize ||
			!ed25519.Verify(witness.Vkey, bodyHash, witness.Signature) {
			d.SignaturesValid = false
		}
	}
	d.VkeyWitnessCount = len(vkeys) + len(ws.BootstrapWitnesses.Items())
	for _, witness := range []struct {
		count int
		name  string
	}{{len(ws.BootstrapWitnesses.Items()), "bootstrapWitnesses"}, {len(ws.WsNativeScripts.Items()), "nativeScripts"},
		{len(ws.WsPlutusV1Scripts.Items()) + len(ws.WsPlutusV2Scripts.Items()) + len(ws.WsPlutusV3Scripts.Items()), "plutusScripts"},
		{len(ws.WsPlutusData.Items()), "witnessDatums"}, {ws.WsRedeemers.Len(), "redeemers"}} {
		if witness.count > 0 {
			d.UnverifiedFeatures = append(d.UnverifiedFeatures, witness.name)
		}
	}
	d.RedeemerCount = ws.WsRedeemers.Len()
	d.ScriptWitnessCount = len(ws.WsNativeScripts.Items()) + len(ws.WsPlutusV1Scripts.Items()) +
		len(ws.WsPlutusV2Scripts.Items()) + len(ws.WsPlutusV3Scripts.Items()) + d.RedeemerCount
}

func decodeOutput(o *babbage.BabbageTransactionOutput) (UtxoOutput, error) {
	value, err := o.OutputAmount.MarshalCBOR()
	if err != nil {
		return UtxoOutput{}, err
	}
	out := UtxoOutput{
		Address:            o.Address().String(),
		Coin:               o.OutputAmount.Amount,
		Assets:             map[string]uint64{},
		SerializedSize:     len(o.Cbor()),
		ValueSize:          len(value),
		NetworkID:          int(o.Address().NetworkId()),
		HasReferenceScript: o.TxOutScriptRef != nil,
	}
	if assets := o.Assets(); assets != nil {
		for _, policy := range assets.Policies() {
			for _, name := range assets.Assets(policy) {
				quantity := assets.Asset(policy, name)
				if quantity == nil || !quantity.IsUint64() {
					return out, errors.New("asset quantity out of range")
				}
				out.Assets[policy.String()+"."+hex.EncodeToString(name)] = quantity.Uint64()
			}
		}
	}
	if datum := o.Datum(); datum != nil {
		out.Datum = hex.EncodeToString(datum.Cbor())
	}
	return out, nil
}

// bodyKeys reports which keys a transaction body map carries.
func bodyKeys(body []byte) (map[uint64]bool, error) {
	var fields map[uint64]cbor.RawMessage
	if _, err := cbor.Decode(body, &fields); err != nil {
		return nil, fmt.Errorf("invalid transaction body: %w", err)
	}
	present := make(map[uint64]bool, len(fields))
	for key := range fields {
		present[key] = true
	}
	return present, nil
}
