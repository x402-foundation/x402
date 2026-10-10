package cardano

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"

	"github.com/fxamacker/cbor/v2"
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
	SerializedSize     int
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
	Outputs                   []UtxoOutput
	VkeyWitnessCount          int
	VkeyHashes                []string
	ScriptWitnessCount        int
	RedeemerCount             int
	SignaturesValid           bool
	IsValid                   bool
	// Bytes are the exact transaction bytes; they are submitted unchanged.
	Bytes []byte
}

// maxTransactionBase64Len is the base64 length of MaxTransactionBytes.
const maxTransactionBase64Len = (MaxTransactionBytes + 2) / 3 * 4

var cborDec = func() cbor.DecMode {
	mode, err := cbor.DecOptions{
		DupMapKey:       cbor.DupMapKeyEnforcedAPF,
		MaxNestedLevels: 64,
	}.DecMode()
	if err != nil {
		panic(err)
	}
	return mode
}()

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
	var parts []cbor.RawMessage
	if err := decodeExact(txBytes, &parts); err != nil {
		return nil, fmt.Errorf("transaction is not a CBOR array: %w", err)
	}
	if len(parts) != 4 {
		return nil, fmt.Errorf("transaction must have 4 elements, got %d", len(parts))
	}
	bodyHash := Blake2b256(parts[0])
	decoded := &DecodedTransaction{
		TxHash:    hex.EncodeToString(bodyHash),
		SizeBytes: len(txBytes),
		Bytes:     append([]byte(nil), txBytes...),
	}
	if err := decoded.decodeBody(parts[0]); err != nil {
		return nil, err
	}
	if err := decoded.decodeWitnesses(parts[1], bodyHash); err != nil {
		return nil, err
	}
	if err := cborDec.Unmarshal(parts[2], &decoded.IsValid); err != nil {
		return nil, fmt.Errorf("invalid is_valid flag: %w", err)
	}
	return decoded, nil
}

func (d *DecodedTransaction) decodeBody(raw []byte) error {
	var body map[uint64]cbor.RawMessage
	if err := cborDec.Unmarshal(raw, &body); err != nil {
		return fmt.Errorf("invalid transaction body: %w", err)
	}
	inputs, err := decodeSet(body[0])
	if err != nil {
		return fmt.Errorf("invalid inputs: %w", err)
	}
	for _, rawInput := range inputs {
		var input struct {
			_     struct{} `cbor:",toarray"`
			TxID  []byte
			Index uint64
		}
		if err := cborDec.Unmarshal(rawInput, &input); err != nil || len(input.TxID) != 32 || input.Index > math.MaxUint32 {
			return errors.New("invalid transaction input")
		}
		d.Inputs = append(d.Inputs, FormatUtxoRef(hex.EncodeToString(input.TxID), uint32(input.Index)))
	}
	var outputs []cbor.RawMessage
	if err := cborDec.Unmarshal(body[1], &outputs); err != nil {
		return fmt.Errorf("invalid outputs: %w", err)
	}
	for _, rawOutput := range outputs {
		output, err := decodeOutput(rawOutput)
		if err != nil {
			return err
		}
		d.Outputs = append(d.Outputs, output)
	}
	if err := cborDec.Unmarshal(body[2], &d.Fee); err != nil {
		return fmt.Errorf("invalid fee: %w", err)
	}
	if d.TTLSlot, err = optionalUint(body, 3); err != nil {
		return fmt.Errorf("invalid ttl: %w", err)
	}
	if d.ValidityStartSlot, err = optionalUint(body, 8); err != nil {
		return fmt.Errorf("invalid validity start: %w", err)
	}
	if rawID, ok := body[15]; ok {
		var id int
		if err := cborDec.Unmarshal(rawID, &id); err != nil {
			return fmt.Errorf("invalid network id: %w", err)
		}
		d.NetworkID = &id
	}
	for _, op := range []struct {
		key  uint64
		name string
	}{{9, "mint"}, {5, "withdrawals"}, {4, "certificates"}, {20, "proposalProcedures"}, {22, "donation"}} {
		if _, ok := body[op.key]; ok {
			d.BalanceChangingOperations = append(d.BalanceChangingOperations, op.name)
		}
	}
	return nil
}

func (d *DecodedTransaction) decodeWitnesses(raw []byte, bodyHash []byte) error {
	var ws map[uint64]cbor.RawMessage
	if err := cborDec.Unmarshal(raw, &ws); err != nil {
		return fmt.Errorf("invalid witness set: %w", err)
	}
	vkeys, err := decodeSet(ws[0])
	if err != nil {
		return fmt.Errorf("invalid vkey witnesses: %w", err)
	}
	d.SignaturesValid = true
	for _, rawWitness := range vkeys {
		var witness struct {
			_         struct{} `cbor:",toarray"`
			Vkey      []byte
			Signature []byte
		}
		if err := cborDec.Unmarshal(rawWitness, &witness); err != nil {
			return errors.New("invalid vkey witness")
		}
		d.VkeyHashes = append(d.VkeyHashes, hex.EncodeToString(Blake2b224(witness.Vkey)))
		if len(witness.Vkey) != ed25519.PublicKeySize || len(witness.Signature) != ed25519.SignatureSize ||
			!ed25519.Verify(witness.Vkey, bodyHash, witness.Signature) {
			d.SignaturesValid = false
		}
	}
	bootstrap, err := decodeSet(ws[2])
	if err != nil {
		return fmt.Errorf("invalid bootstrap witnesses: %w", err)
	}
	d.VkeyWitnessCount = len(vkeys) + len(bootstrap)
	for _, key := range []uint64{1, 3, 6, 7} {
		scripts, err := decodeSet(ws[key])
		if err != nil {
			return fmt.Errorf("invalid script witnesses: %w", err)
		}
		d.ScriptWitnessCount += len(scripts)
	}
	if rawRedeemers, ok := ws[5]; ok {
		count, err := containerLength(rawRedeemers)
		if err != nil {
			return fmt.Errorf("invalid redeemers: %w", err)
		}
		d.RedeemerCount = count
	}
	d.ScriptWitnessCount += d.RedeemerCount
	return nil
}

func decodeOutput(raw []byte) (UtxoOutput, error) {
	out := UtxoOutput{SerializedSize: len(raw), Assets: map[string]uint64{}}
	var addressBytes []byte
	var value cbor.RawMessage
	if len(raw) > 0 && raw[0]>>5 == 4 {
		var legacy []cbor.RawMessage
		if err := cborDec.Unmarshal(raw, &legacy); err != nil || len(legacy) < 2 || len(legacy) > 3 {
			return out, errors.New("invalid legacy output")
		}
		if err := cborDec.Unmarshal(legacy[0], &addressBytes); err != nil {
			return out, errors.New("invalid output address")
		}
		value = legacy[1]
	} else {
		var fields map[uint64]cbor.RawMessage
		if err := cborDec.Unmarshal(raw, &fields); err != nil {
			return out, fmt.Errorf("invalid output: %w", err)
		}
		if err := cborDec.Unmarshal(fields[0], &addressBytes); err != nil {
			return out, errors.New("invalid output address")
		}
		value = fields[1]
		if rawDatum, ok := fields[2]; ok {
			datum, err := decodeInlineDatum(rawDatum)
			if err != nil {
				return out, err
			}
			out.Datum = datum
		}
		_, out.HasReferenceScript = fields[3]
	}
	address, err := AddressFromBytes(addressBytes)
	if err != nil {
		return out, fmt.Errorf("invalid output address: %w", err)
	}
	out.Address = address
	if err := decodeValue(value, &out); err != nil {
		return out, err
	}
	return out, nil
}

func decodeValue(raw []byte, out *UtxoOutput) error {
	if cborDec.Unmarshal(raw, &out.Coin) == nil {
		return nil
	}
	var value struct {
		_          struct{} `cbor:",toarray"`
		Coin       uint64
		MultiAsset map[cbor.ByteString]map[cbor.ByteString]uint64
	}
	if err := cborDec.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("invalid output value: %w", err)
	}
	out.Coin = value.Coin
	for policy, names := range value.MultiAsset {
		for name, quantity := range names {
			out.Assets[hex.EncodeToString([]byte(policy))+"."+hex.EncodeToString([]byte(name))] = quantity
		}
	}
	return nil
}

func decodeInlineDatum(raw []byte) (string, error) {
	var option []cbor.RawMessage
	if err := cborDec.Unmarshal(raw, &option); err != nil || len(option) != 2 {
		return "", errors.New("invalid datum option")
	}
	var kind uint64
	if err := cborDec.Unmarshal(option[0], &kind); err != nil {
		return "", errors.New("invalid datum option")
	}
	if kind != 1 {
		return "", nil
	}
	var tag cbor.RawTag
	if err := cborDec.Unmarshal(option[1], &tag); err != nil || tag.Number != 24 {
		return "", errors.New("inline datum must be tag 24")
	}
	var datum []byte
	if err := cborDec.Unmarshal(tag.Content, &datum); err != nil {
		return "", errors.New("invalid inline datum")
	}
	return hex.EncodeToString(datum), nil
}

// decodeSet accepts a plain array or a tag-258 set; nil input yields no items.
func decodeSet(raw []byte) ([]cbor.RawMessage, error) {
	if raw == nil {
		return nil, nil
	}
	if bytes.HasPrefix(raw, []byte{0xd9, 0x01, 0x02}) {
		raw = raw[3:]
	}
	var items []cbor.RawMessage
	if err := cborDec.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// containerLength counts the items of a CBOR array or the pairs of a CBOR map.
func containerLength(raw []byte) (int, error) {
	var items []cbor.RawMessage
	if cborDec.Unmarshal(raw, &items) == nil {
		return len(items), nil
	}
	if len(raw) == 0 || raw[0]>>5 != 5 {
		return 0, errors.New("expected an array or map")
	}
	if err := cborDec.Wellformed(raw); err != nil {
		return 0, err
	}
	info := raw[0] & 0x1f
	switch {
	case info < 24:
		return int(info), nil
	case info == 31:
		count, offset := 0, 1
		for raw[offset] != 0xff {
			for i := 0; i < 2; i++ {
				var item cbor.RawMessage
				rest, err := cborDec.UnmarshalFirst(raw[offset:], &item)
				if err != nil {
					return 0, err
				}
				offset = len(raw) - len(rest)
			}
			count++
		}
		return count, nil
	case info <= 27:
		width := 1 << (info - 24)
		var n uint64
		for _, b := range raw[1 : 1+width] {
			n = n<<8 | uint64(b)
		}
		if n > math.MaxInt32 {
			return 0, errors.New("map too large")
		}
		return int(n), nil
	}
	return 0, errors.New("invalid map header")
}

func optionalUint(m map[uint64]cbor.RawMessage, key uint64) (*uint64, error) {
	raw, ok := m[key]
	if !ok {
		return nil, nil
	}
	var v uint64
	if err := cborDec.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// decodeExact rejects trailing bytes after the top-level item.
func decodeExact(data []byte, v interface{}) error {
	rest, err := cborDec.UnmarshalFirst(data, v)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return errors.New("trailing bytes after CBOR item")
	}
	return nil
}
