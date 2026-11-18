package buildercode

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// ERC-8021 Schema 2 suffix format:
//
//	[cbor_data (variable)] [suffix_data_length (2 bytes)] [schema_id = 0x02 (1 byte)] [ERC-8021 marker (16 bytes)]
//
// The CBOR payload uses single-letter keys: "a" (app code, string), "w"
// (wallet code, string), "s" (service codes, string array), and "m"
// (facilitator-authored settlement metadata: a map of unsigned integers,
// strings, arrays, and maps).

// encodeCborMajorType encodes a CBOR major type with an argument value.
//
// CBOR encoding rules:
//   - 0-23: single byte (major type << 5 | value)
//   - 24-255: two bytes (major type << 5 | 24, value)
//   - 256-65535: three bytes (major type << 5 | 25, value high, value low)
//   - 65536-2^32-1: five bytes (major type << 5 | 26, 4-byte big-endian value)
//   - 2^32-2^64-1: nine bytes (major type << 5 | 27, 8-byte big-endian value)
func encodeCborMajorType(majorType int, value uint64) ([]byte, error) {
	mt := byte(majorType << 5)

	switch {
	case value <= 23:
		return []byte{mt | byte(value)}, nil
	case value <= math.MaxUint8:
		return []byte{mt | 24, byte(value)}, nil
	case value <= math.MaxUint16:
		return binary.BigEndian.AppendUint16([]byte{mt | 25}, uint16(value)), nil
	case value <= math.MaxUint32:
		return binary.BigEndian.AppendUint32([]byte{mt | 26}, uint32(value)), nil
	default:
		return binary.BigEndian.AppendUint64([]byte{mt | 27}, value), nil
	}
}

// encodeCborString encodes a CBOR text string (major type 3).
func encodeCborString(value string) ([]byte, error) {
	header, err := encodeCborMajorType(3, uint64(len(value)))
	if err != nil {
		return nil, err
	}
	return append(header, value...), nil
}

// encodeCborArray encodes a CBOR array of text strings (major type 4).
func encodeCborArray(values []string) ([]byte, error) {
	result, err := encodeCborMajorType(4, uint64(len(values)))
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
// emitting only the fields that are set in field order a, w, s, m.
func encodeCborMap(data BuilderCodeSuffixData) ([]byte, error) {
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

	if len(data.M) > 0 {
		mapSize++
		key, err := encodeCborString("m")
		if err != nil {
			return nil, err
		}
		value, err := encodeCborValue(data.M)
		if err != nil {
			return nil, err
		}
		entries = append(entries, key...)
		entries = append(entries, value...)
	}

	header, err := encodeCborMajorType(5, uint64(mapSize))
	if err != nil {
		return nil, err
	}
	return append(header, entries...), nil
}

// encodeCborValue encodes a settlement metadata value: an unsigned integer,
// text string, array, or map with text keys. Anything else is rejected.
func encodeCborValue(value any) ([]byte, error) {
	switch v := value.(type) {
	case string:
		return encodeCborString(v)
	case uint64:
		return encodeCborMajorType(0, v)
	case uint:
		return encodeCborMajorType(0, uint64(v))
	case int:
		if v < 0 {
			return nil, fmt.Errorf("CBOR metadata integer must not be negative: %d", v)
		}
		return encodeCborMajorType(0, uint64(v))
	case []any:
		return encodeCborItems(v)
	case []string:
		return encodeCborArray(v)
	case []uint64:
		items := make([]any, len(v))
		for i, item := range v {
			items[i] = item
		}
		return encodeCborItems(items)
	case map[string]any:
		return encodeCborValueMap(v)
	case map[string]uint64:
		entries := make(map[string]any, len(v))
		for key, item := range v {
			entries[key] = item
		}
		return encodeCborValueMap(entries)
	default:
		return nil, fmt.Errorf("unsupported CBOR metadata type %T", value)
	}
}

// encodeCborItems encodes a CBOR array (major type 4) of metadata values.
func encodeCborItems(items []any) ([]byte, error) {
	result, err := encodeCborMajorType(4, uint64(len(items)))
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		encoded, err := encodeCborValue(item)
		if err != nil {
			return nil, err
		}
		result = append(result, encoded...)
	}
	return result, nil
}

// encodeCborValueMap encodes a CBOR map (major type 5) with text keys sorted
// bytewise by their encoded form (RFC 8949 section 4.2.1).
func encodeCborValueMap(entries map[string]any) ([]byte, error) {
	type encodedEntry struct{ key, pair []byte }

	encoded := make([]encodedEntry, 0, len(entries))
	for k, v := range entries {
		key, err := encodeCborString(k)
		if err != nil {
			return nil, err
		}
		value, err := encodeCborValue(v)
		if err != nil {
			return nil, err
		}
		encoded = append(encoded, encodedEntry{key: key, pair: append(append([]byte{}, key...), value...)})
	}
	sort.Slice(encoded, func(i, j int) bool { return string(encoded[i].key) < string(encoded[j].key) })

	result, err := encodeCborMajorType(5, uint64(len(entries)))
	if err != nil {
		return nil, err
	}
	for _, entry := range encoded {
		result = append(result, entry.pair...)
	}
	return result, nil
}

// EncodeBuilderCodeSuffix builds a complete ERC-8021 Schema 2 data suffix from
// builder code data. The returned bytes are ready to append to settlement
// calldata. Format: [cbor_data][suffix_data_length (2 bytes)][schema_id (1 byte)][marker (16 bytes)].
// It returns an error when the CBOR data exceeds the 2-byte suffix_data_length.
func EncodeBuilderCodeSuffix(data BuilderCodeSuffixData) ([]byte, error) {
	cborBytes, err := encodeCborMap(data)
	if err != nil {
		return nil, err
	}
	cborLength := len(cborBytes)
	if cborLength > math.MaxUint16 {
		return nil, fmt.Errorf("builder code CBOR data is %d bytes, maximum is %d", cborLength, math.MaxUint16)
	}

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
func ParseBuilderCodeSuffixFromCalldata(calldata string) (*BuilderCodeSuffixData, bool) {
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
// BuilderCodeSuffixData
func parseCborMap(bytes []byte) (*BuilderCodeSuffixData, bool) {
	o := 0

	if len(bytes) == 0 || bytes[o]>>5 != 5 {
		return nil, false
	}

	mapSize, ok := readCborLength(bytes, &o)
	if !ok {
		return nil, false
	}

	result := &BuilderCodeSuffixData{}
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
		case "m":
			metadata, ok := readCborMap(bytes, &o)
			if !ok {
				return nil, false
			}
			result.M = metadata
		default:
			return nil, false
		}
	}

	return result, true
}

// readCborArgument reads a CBOR item header argument (inline <=23 or 1, 2, 4,
// or 8 extra bytes for info 24 through 27), advancing o. Returns false for
// unsupported encodings.
func readCborArgument(bytes []byte, o *int) (uint64, bool) {
	if *o >= len(bytes) {
		return 0, false
	}
	info := int(bytes[*o] & 0x1f)
	*o++
	if info <= 23 {
		return uint64(info), true
	}
	if info > 27 {
		return 0, false
	}

	width := 1 << (info - 24)
	if *o+width > len(bytes) {
		return 0, false
	}
	var v uint64
	for _, b := range bytes[*o : *o+width] {
		v = v<<8 | uint64(b)
	}
	*o += width
	return v, true
}

// readCborLength reads a CBOR length/size argument, advancing o. Returns false
// for unsupported encodings or a length larger than the remaining bytes, since
// every string byte or array/map element takes at least one byte.
func readCborLength(bytes []byte, o *int) (int, bool) {
	v, ok := readCborArgument(bytes, o)
	if !ok || v > uint64(len(bytes)-*o) {
		return 0, false
	}
	return int(v), true
}

// readCborText reads a CBOR text string (major type 3), advancing o.
func readCborText(bytes []byte, o *int) (string, bool) {
	if *o >= len(bytes) || bytes[*o]>>5 != 3 {
		return "", false
	}
	length, ok := readCborLength(bytes, o)
	if !ok {
		return "", false
	}
	text := string(bytes[*o : *o+length])
	*o += length
	return text, true
}

// readCborValue reads a settlement metadata value, advancing o. Unsigned
// integers are returned as uint64, arrays as []any, and maps as map[string]any.
func readCborValue(bytes []byte, o *int) (any, bool) {
	if *o >= len(bytes) {
		return nil, false
	}

	switch bytes[*o] >> 5 {
	case 0:
		return readCborArgument(bytes, o)
	case 3:
		return readCborText(bytes, o)
	case 4:
		size, ok := readCborLength(bytes, o)
		if !ok {
			return nil, false
		}
		items := make([]any, 0, size)
		for i := 0; i < size; i++ {
			item, ok := readCborValue(bytes, o)
			if !ok {
				return nil, false
			}
			items = append(items, item)
		}
		return items, true
	case 5:
		return readCborMap(bytes, o)
	default:
		return nil, false
	}
}

// readCborMap reads a CBOR map (major type 5) with text keys, advancing o.
func readCborMap(bytes []byte, o *int) (map[string]any, bool) {
	if *o >= len(bytes) || bytes[*o]>>5 != 5 {
		return nil, false
	}
	size, ok := readCborLength(bytes, o)
	if !ok {
		return nil, false
	}

	entries := make(map[string]any, size)
	for i := 0; i < size; i++ {
		key, ok := readCborText(bytes, o)
		if !ok {
			return nil, false
		}
		value, ok := readCborValue(bytes, o)
		if !ok {
			return nil, false
		}
		entries[key] = value
	}
	return entries, true
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
