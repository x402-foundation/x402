package buildercode

import (
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// ERC-8021 Schema 2 suffix format:
//
//	[cbor_data (variable)] [suffix_data_length (2 bytes)] [schema_id = 0x02 (1 byte)] [ERC-8021 marker (16 bytes)]
//
// The CBOR payload uses single-letter keys: "a" (app code, string), "w"
// (wallet code, string), and "s" (service codes, string array).

// encodeCborMajorType encodes a CBOR major type with an argument value.
//
// CBOR encoding rules:
//   - 0-23: single byte (major type << 5 | value)
//   - 24-255: two bytes (major type << 5 | 24, value)
//   - 256-65535: three bytes (major type << 5 | 25, value high, value low)
func encodeCborMajorType(majorType, value int) ([]byte, error) {
	mt := byte(majorType << 5)

	switch {
	case value <= 23:
		return []byte{mt | byte(value)}, nil
	case value <= 0xff:
		return []byte{mt | 24, byte(value)}, nil
	case value <= 0xffff:
		return []byte{mt | 25, byte(value >> 8), byte(value)}, nil
	default:
		return nil, fmt.Errorf("CBOR value too large: %d", value)
	}
}

// encodeCborString encodes a CBOR text string (major type 3).
func encodeCborString(value string) ([]byte, error) {
	header, err := encodeCborMajorType(3, len(value))
	if err != nil {
		return nil, err
	}
	return append(header, value...), nil
}

// encodeCborArray encodes a CBOR array of text strings (major type 4).
func encodeCborArray(values []string) ([]byte, error) {
	result, err := encodeCborMajorType(4, len(values))
	if err != nil {
		return nil, err
	}
	for _, v := range values {
		encoded, err := encodeCborString(v)
		if err != nil {
			return nil, err
		}
		result = append(result, encoded...)
	}
	return result, nil
}

// encodeCborMap encodes a minimal CBOR map (major type 5) from builder code data,
// emitting only the fields that are set in field order a, w, s.
func encodeCborMap(data BuilderCodeExtensionData) ([]byte, error) {
	var entries []byte
	mapSize := 0

	for _, field := range []struct {
		key   string
		value string
	}{{"a", data.A}, {"w", data.W}} {
		if field.value == "" {
			continue
		}
		mapSize++
		key, err := encodeCborString(field.key)
		if err != nil {
			return nil, err
		}
		value, err := encodeCborString(field.value)
		if err != nil {
			return nil, err
		}
		entries = append(entries, key...)
		entries = append(entries, value...)
	}

	if len(data.S) > 0 {
		mapSize++
		key, err := encodeCborString("s")
		if err != nil {
			return nil, err
		}
		value, err := encodeCborArray(data.S)
		if err != nil {
			return nil, err
		}
		entries = append(entries, key...)
		entries = append(entries, value...)
	}

	header, err := encodeCborMajorType(5, mapSize)
	if err != nil {
		return nil, err
	}
	return append(header, entries...), nil
}

// EncodeBuilderCodeSuffix builds a complete ERC-8021 Schema 2 data suffix from
// builder code data. The returned bytes are ready to append to settlement
// calldata. Format: [cbor_data][suffix_data_length (2 bytes)][schema_id (1 byte)][marker (16 bytes)].
func EncodeBuilderCodeSuffix(data BuilderCodeExtensionData) ([]byte, error) {
	cborBytes, err := encodeCborMap(data)
	if err != nil {
		return nil, err
	}
	cborLength := len(cborBytes)

	markerBytes, err := hex.DecodeString(ERC_8021_MARKER)
	if err != nil {
		return nil, err
	}

	suffix := make([]byte, 0, cborLength+2+1+len(markerBytes))
	suffix = append(suffix, cborBytes...)
	suffix = append(suffix, byte(cborLength>>8), byte(cborLength))
	suffix = append(suffix, SCHEMA_2_ID)
	suffix = append(suffix, markerBytes...)
	return suffix, nil
}

// ParseBuilderCodeSuffixFromCalldata parses ERC-8021 Schema 2 builder code
// attribution from settlement calldata (hex, with or without a 0x prefix).
// The second return value reports whether a valid suffix was found.
func ParseBuilderCodeSuffixFromCalldata(calldata string) (*BuilderCodeExtensionData, bool) {
	h := strings.TrimPrefix(calldata, "0x")
	markerPos := strings.LastIndex(h, ERC_8021_MARKER)
	if markerPos < 6 {
		return nil, false
	}

	if parseHexInt(h[markerPos-2:markerPos]) != SCHEMA_2_ID {
		return nil, false
	}

	cborLength := parseHexInt(h[markerPos-6 : markerPos-2])
	suffixStart := markerPos - 6 - cborLength*2
	if suffixStart < 0 || suffixStart+(cborLength+19)*2 != len(h) {
		return nil, false
	}

	bytes, err := hex.DecodeString(h[suffixStart : markerPos-6])
	if err != nil {
		return nil, false
	}
	return parseCborMap(bytes)
}

// parseHexInt parses a hex substring into an int, returning -1 on failure.
func parseHexInt(s string) int {
	v, err := strconv.ParseInt(s, 16, 0)
	if err != nil {
		return -1
	}
	return int(v)
}

// parseCborMap decodes the CBOR map portion of a builder-code suffix into
// BuilderCodeExtensionData
func parseCborMap(bytes []byte) (*BuilderCodeExtensionData, bool) {
	o := 0

	if len(bytes) == 0 || bytes[o]>>5 != 5 {
		return nil, false
	}

	mapSize, ok := readCborLength(bytes, &o)
	if !ok {
		return nil, false
	}

	result := &BuilderCodeExtensionData{}
	for entry := 0; entry < mapSize; entry++ {
		if o >= len(bytes) || bytes[o]>>5 != 3 {
			return nil, false
		}
		keyLen, ok := readCborLength(bytes, &o)
		if !ok || o+keyLen > len(bytes) {
			return nil, false
		}
		key := string(bytes[o : o+keyLen])
		o += keyLen

		switch key {
		case "a", "w":
			if o >= len(bytes) || bytes[o]>>5 != 3 {
				return nil, false
			}
			valueLen, ok := readCborLength(bytes, &o)
			if !ok || o+valueLen > len(bytes) {
				return nil, false
			}
			value := string(bytes[o : o+valueLen])
			o += valueLen
			if key == "a" {
				result.A = value
			} else {
				result.W = value
			}
		case "s":
			if o >= len(bytes) || bytes[o]>>5 != 4 {
				return nil, false
			}
			arraySize, ok := readCborLength(bytes, &o)
			if !ok {
				return nil, false
			}
			codes, ok := readServiceCodeArray(bytes, &o, arraySize)
			if !ok {
				return nil, false
			}
			if len(codes) > 0 {
				result.S = codes
			}
		default:
			return nil, false
		}
	}

	return result, true
}

// readCborLength reads a CBOR length/size argument (inline <=23 or one extra
// byte for 24), advancing o. Returns false for unsupported encodings.
func readCborLength(bytes []byte, o *int) (int, bool) {
	if *o >= len(bytes) {
		return 0, false
	}
	info := int(bytes[*o] & 0x1f)
	*o++
	if info <= 23 {
		return info, true
	}
	if info == 24 {
		if *o >= len(bytes) {
			return 0, false
		}
		v := int(bytes[*o])
		*o++
		return v, true
	}
	return 0, false
}

// readServiceCodeArray reads arraySize CBOR text strings, returning every
// decoded entry and advancing o past all of them.
func readServiceCodeArray(bytes []byte, o *int, arraySize int) ([]string, bool) {
	codes := make([]string, 0, arraySize)
	for i := 0; i < arraySize; i++ {
		if *o >= len(bytes) || bytes[*o]>>5 != 3 {
			return nil, false
		}
		itemLen, ok := readCborLength(bytes, o)
		if !ok || *o+itemLen > len(bytes) {
			return nil, false
		}
		codes = append(codes, string(bytes[*o:*o+itemLen]))
		*o += itemLen
	}
	return codes, true
}
