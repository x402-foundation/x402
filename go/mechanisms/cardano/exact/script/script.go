// Package script implements the Cardano script assetTransferMethod: deriving the
// script address implied by extra.script/parameters and attaching extra.datum.
package script

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"

	"github.com/blinklabs-io/plutigo/data"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// Descriptor is an inline script in extra.script.
type Descriptor struct {
	Type string `json:"type"`
	Code string `json:"code"`
}

// Parameter is one typed script parameter in extra.parameters.
type Parameter struct {
	Type  string      `json:"type"`
	Value interface{} `json:"value"`
}

// Extra is the script method's view of requirements.extra.
type Extra struct {
	ScriptHash string               `json:"scriptHash,omitempty"`
	Script     *Descriptor          `json:"script,omitempty"`
	Parameters map[string]Parameter `json:"parameters,omitempty"`
	Datum      *string              `json:"datum,omitempty"`
}

// ParseExtra reads the script fields from requirements.extra.
func ParseExtra(extra map[string]interface{}) (Extra, error) {
	raw, err := json.Marshal(extra)
	if err != nil {
		return Extra{}, err
	}
	var parsed Extra
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Extra{}, fmt.Errorf("invalid script extra: %w", err)
	}
	return parsed, nil
}

var (
	scriptHashRegex = regexp.MustCompile(`^[0-9a-f]{56}$`)
	evenHexRegex    = regexp.MustCompile(`^(?:[0-9a-f]{2})+$`)
	bytesHexRegex   = regexp.MustCompile(`^(?:[0-9a-f]{2})*$`)
	integerRegex    = regexp.MustCompile(`^(?:0|[1-9]\d*|-[1-9]\d*)$`)
)

var languageTags = map[string]byte{"plutusV1": 0x01, "plutusV2": 0x02, "plutusV3": 0x03}

// AddressMatches reports whether payTo is a script address whose payment
// credential equals the hash implied by extra.
func AddressMatches(extra Extra, payTo string) bool {
	credential, err := cardano.PaymentCredential(payTo)
	if err != nil || !credential.IsScript {
		return false
	}
	expected, err := DeriveScriptHash(extra)
	return err == nil && expected == credential.HashHex()
}

// DeriveScriptHash returns the script hash implied by extra. Inline code wins
// over scriptHash; parameters are applied in key order: integer-like keys
// ascending first, as JavaScript orders object keys, then the rest sorted.
// JavaScript applies the rest in insertion order, which Go core's map-typed
// extra does not preserve, so named keys interoperate only when listed
// alphabetically; otherwise the derived address mismatches and the payment is
// refused, never misdirected. Go servers emit keys alphabetically.
func DeriveScriptHash(extra Extra) (string, error) {
	if extra.Script != nil && extra.Script.Code != "" {
		tag, ok := languageTags[extra.Script.Type]
		if !ok {
			return "", fmt.Errorf("unsupported Cardano script type: %s", extra.Script.Type)
		}
		if !evenHexRegex.MatchString(extra.Script.Code) || len(extra.Script.Code)/2 > cardano.MaxScriptBytes {
			return "", errors.New("cardano script code is invalid or exceeds the byte limit")
		}
		params, err := parameterData(extra.Parameters)
		if err != nil {
			return "", err
		}
		code, _ := hex.DecodeString(extra.Script.Code)
		applied, err := ApplyParams(code, params)
		if err != nil {
			return "", err
		}
		return hex.EncodeToString(cardano.Blake2b224(append([]byte{tag}, applied...))), nil
	}
	if extra.ScriptHash != "" {
		if !scriptHashRegex.MatchString(extra.ScriptHash) {
			return "", errors.New("cardano scriptHash must be 28-byte lowercase hex")
		}
		return extra.ScriptHash, nil
	}
	return "", errors.New("cardano script payment requires either `script` or `scriptHash`")
}

func parameterData(params map[string]Parameter) ([]data.PlutusData, error) {
	if len(params) > cardano.MaxScriptParameters {
		return nil, errors.New("cardano script has too many parameters")
	}
	names := make([]string, 0, len(params))
	for name := range params {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return jsKeyLess(names[i], names[j]) })
	out := make([]data.PlutusData, 0, len(names))
	total := 0
	for _, name := range names {
		pd, size, err := toPlutusData(params[name])
		if err != nil {
			return nil, err
		}
		total += len(name) + size
		if total > cardano.MaxScriptParameterBytes {
			return nil, errors.New("cardano script parameters exceed the byte limit")
		}
		out = append(out, pd)
	}
	return out, nil
}

// jsKeyLess orders keys like JavaScript property enumeration for integer-like
// keys (ascending numerically, first); other keys sort lexicographically.
func jsKeyLess(a, b string) bool {
	ai, aIndex := arrayIndex(a)
	bi, bIndex := arrayIndex(b)
	switch {
	case aIndex && bIndex:
		return ai < bi
	case aIndex != bIndex:
		return aIndex
	}
	return a < b
}

func arrayIndex(key string) (uint64, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 32)
	return n, err == nil && n < math.MaxUint32
}

func toPlutusData(param Parameter) (data.PlutusData, int, error) {
	switch param.Type {
	case "bytes":
		s, ok := param.Value.(string)
		if !ok || !bytesHexRegex.MatchString(s) {
			return nil, 0, errors.New("cardano bytes parameter must be lowercase even-length hex")
		}
		b, _ := hex.DecodeString(s)
		return data.NewByteString(b), len(b), nil
	case "string":
		s, ok := param.Value.(string)
		if !ok {
			return nil, 0, errors.New("cardano string parameter must carry a string")
		}
		return data.NewByteString([]byte(s)), len(s), nil
	case "bigint", "integer":
		n, digits, err := integerParameter(param.Value)
		if err != nil {
			return nil, 0, err
		}
		return data.NewInteger(n), digits, nil
	case "boolean":
		b, ok := param.Value.(bool)
		if !ok {
			return nil, 0, errors.New("cardano boolean parameter must carry a boolean")
		}
		tag := uint(0)
		if b {
			tag = 1
		}
		return data.NewConstr(tag), 1, nil
	}
	return nil, 0, fmt.Errorf("unsupported Cardano script parameter type: %s", param.Type)
}

func integerParameter(value interface{}) (*big.Int, int, error) {
	var text string
	switch v := value.(type) {
	case float64:
		if v != math.Trunc(v) || math.Abs(v) > 1<<53-1 {
			return nil, 0, errors.New("cardano integer parameter must be a safe integer")
		}
		text = strconv.FormatFloat(v, 'f', 0, 64)
	case json.Number:
		text = v.String()
	case string:
		text = v
	default:
		return nil, 0, errors.New("cardano integer parameter must use canonical decimal syntax")
	}
	if !integerRegex.MatchString(text) {
		return nil, 0, errors.New("cardano integer parameter must use canonical decimal syntax")
	}
	digits := len(text)
	if text[0] == '-' {
		digits--
	}
	if digits > 128 {
		return nil, 0, errors.New("cardano integer parameter exceeds the digit limit")
	}
	n, _ := new(big.Int).SetString(text, 10)
	return n, digits, nil
}

// InlineDatum validates extra.datum and returns its CanonicalDatum encoding,
// or nil when absent.
func InlineDatum(extra Extra) ([]byte, error) {
	if extra.Datum == nil {
		return nil, nil
	}
	datum := *extra.Datum
	if datum == "" || len(datum)%2 != 0 || len(datum)/2 > cardano.MaxDatumBytes {
		return nil, errors.New(`cardano script payment "datum" must be non-empty CBOR hex`)
	}
	raw, err := hex.DecodeString(datum)
	if err != nil {
		return nil, errors.New(`cardano script payment "datum" is not valid CBOR hex`)
	}
	return CanonicalDatum(raw)
}

// CanonicalDatum re-encodes Plutus data the way the TypeScript SDK attaches
// it (Aiken style: indefinite non-empty constructors, lists and maps; byte
// strings over 64 bytes chunked). The TypeScript facilitator re-encodes the
// transaction before submitting, so other encodings would change its id.
func CanonicalDatum(raw []byte) ([]byte, error) {
	decoded, err := data.Decode(raw)
	if err != nil {
		return nil, fmt.Errorf(`cardano script payment "datum" is not valid CBOR hex: %w`, err)
	}
	var out []byte
	if err := appendCanonical(&out, decoded); err != nil {
		return nil, err
	}
	return out, nil
}

func appendCanonical(out *[]byte, pd data.PlutusData) error {
	switch v := pd.(type) {
	case *data.Constr:
		switch {
		case v.Tag <= 6:
			*out = appendHead(*out, 6, 121+uint64(v.Tag))
		case v.Tag <= 127:
			*out = appendHead(*out, 6, 1280+uint64(v.Tag-7))
		default:
			*out = appendHead(*out, 6, 102)
			*out = append(*out, 0x9f)
			*out = appendHead(*out, 0, uint64(v.Tag))
			defer func() { *out = append(*out, 0xff) }()
		}
		return appendItems(out, v.Fields, 0x80, 0x9f)
	case *data.List:
		return appendItems(out, v.Items, 0x80, 0x9f)
	case *data.Map:
		if len(v.Pairs) == 0 {
			*out = append(*out, 0xa0)
			return nil
		}
		*out = append(*out, 0xbf)
		for _, p := range v.Pairs {
			if err := appendCanonical(out, p[0]); err != nil {
				return err
			}
			if err := appendCanonical(out, p[1]); err != nil {
				return err
			}
		}
		*out = append(*out, 0xff)
		return nil
	}
	encoded, err := data.Encode(pd)
	if err != nil {
		return err
	}
	*out = append(*out, encoded...)
	return nil
}

func appendItems(out *[]byte, items []data.PlutusData, empty, indefinite byte) error {
	if len(items) == 0 {
		*out = append(*out, empty)
		return nil
	}
	*out = append(*out, indefinite)
	for _, item := range items {
		if err := appendCanonical(out, item); err != nil {
			return err
		}
	}
	*out = append(*out, 0xff)
	return nil
}

// appendHead writes a CBOR head with the smallest argument encoding.
func appendHead(out []byte, major byte, n uint64) []byte {
	m := major << 5
	switch {
	case n < 24:
		return append(out, m|byte(n))
	case n <= 0xff:
		return append(out, m|24, byte(n))
	case n <= 0xffff:
		return append(out, m|25, byte(n>>8), byte(n))
	case n <= 0xffffffff:
		return append(out, m|26, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	return append(out, m|27, byte(n>>56), byte(n>>48), byte(n>>40), byte(n>>32), byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}
