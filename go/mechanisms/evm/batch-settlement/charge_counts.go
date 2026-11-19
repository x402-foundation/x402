package batchsettlement

import "math/big"

// ChargeCountsMetadataKey is the key of the charge-count array inside the ERC-8021 `m` field.
//
// m = { "x402ChargeCounts": [c0, c1, ...] } has one unsigned integer per claim row, across all
// claim / claimWithSignature legs in call order. ci is the unattested chargeCount delta for that
// row, not a lifetime total.
//
// This only reuses the ERC-8021 / builder-code metadata format as a carrier. No builder code is
// needed, and the metadata composes with w / a / s in the same suffix. The suffix itself is built
// by evm.ResolveDataSuffix from the metadata returned here.
const ChargeCountsMetadataKey = "x402ChargeCounts"

// ChargeCountsMetadata builds the `m` metadata for a claim transaction: one unattested delta per
// claim row, in call order. It returns nil when there are no claim rows.
func ChargeCountsMetadata(counts []uint64) map[string]any {
	if len(counts) == 0 {
		return nil
	}
	return map[string]any{ChargeCountsMetadataKey: append([]uint64{}, counts...)}
}

// ParseChargeCountsMetadata reads the charge counts from a parsed ERC-8021 `m` field.
// It accepts the values the builder-code CBOR parser returns (an array of uint64) and plain
// non-negative integers. Nil means the key is absent or malformed; an empty array yields an
// empty, non-nil slice.
func ParseChargeCountsMetadata(metadata map[string]any) []uint64 {
	value, ok := metadata[ChargeCountsMetadataKey]
	if !ok {
		return nil
	}
	switch items := value.(type) {
	case []uint64:
		return append([]uint64{}, items...)
	case []any:
		out := make([]uint64, 0, len(items))
		for _, item := range items {
			count, ok := metadataCount(item)
			if !ok {
				return nil
			}
			out = append(out, count)
		}
		return out
	default:
		return nil
	}
}

func metadataCount(item any) (uint64, bool) {
	switch n := item.(type) {
	case uint64:
		return n, true
	case uint:
		return uint64(n), true
	case int:
		if n < 0 {
			return 0, false
		}
		return uint64(n), true
	case *big.Int:
		if n == nil || !n.IsUint64() {
			return 0, false
		}
		return n.Uint64(), true
	default:
		return 0, false
	}
}
