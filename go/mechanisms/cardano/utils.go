package cardano

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// NormalizeNetwork maps CIP-34 aliases to canonical identifiers; other values pass through.
func NormalizeNetwork(network string) string {
	if canonical, ok := networkAliases[network]; ok {
		return canonical
	}
	return network
}

// IsCardanoNetwork reports whether network (or its alias) is a supported Cardano network.
func IsCardanoNetwork(network string) bool {
	switch NormalizeNetwork(network) {
	case CardanoMainnetCAIP2, CardanoPreprodCAIP2, CardanoPreviewCAIP2:
		return true
	}
	return false
}

// NetworkID returns the ledger network id for network.
func NetworkID(network string) (int, error) {
	switch NormalizeNetwork(network) {
	case CardanoMainnetCAIP2:
		return NetworkIDMainnet, nil
	case CardanoPreprodCAIP2, CardanoPreviewCAIP2:
		return NetworkIDTestnet, nil
	}
	return 0, fmt.Errorf("unsupported Cardano network: %s", network)
}

// IsCanonicalAsset reports whether asset uses the lowercase wire form.
func IsCanonicalAsset(asset string) bool { return canonicalAssetRegex.MatchString(asset) }

// IsPositiveCanonicalAmount reports whether amount is a positive base-10 integer without leading zeros.
func IsPositiveCanonicalAmount(amount string) bool { return positiveAmountRegex.MatchString(amount) }

// IsAddress reports whether address looks like a Shelley bech32 address.
func IsAddress(address string) bool { return addressRegex.MatchString(address) }

// ParseAssetUnit splits an asset unit into policy id and asset name (both lowercase).
// Lovelace yields empty strings.
func ParseAssetUnit(asset string) (policyID string, assetNameHex string, err error) {
	if !assetRegex.MatchString(asset) {
		return "", "", fmt.Errorf("invalid Cardano asset unit: %s", asset)
	}
	if strings.EqualFold(asset, LovelaceAsset) {
		return "", "", nil
	}
	policyID, assetNameHex, _ = strings.Cut(asset, ".")
	return strings.ToLower(policyID), strings.ToLower(assetNameHex), nil
}

// ParseUtxoRef parses txHash#index; the hash is returned lowercase.
func ParseUtxoRef(ref string) (txHash string, index uint32, err error) {
	if !utxoRefRegex.MatchString(ref) {
		return "", 0, fmt.Errorf("invalid Cardano UTxO reference: %s", ref)
	}
	hash, indexStr, _ := strings.Cut(ref, "#")
	parsed, err := strconv.ParseUint(indexStr, 10, 32)
	if err != nil {
		return "", 0, fmt.Errorf("invalid Cardano UTxO reference: %s", ref)
	}
	return strings.ToLower(hash), uint32(parsed), nil
}

// FormatUtxoRef formats a UTxO reference in the canonical lowercase form.
func FormatUtxoRef(txHash string, index uint32) string {
	return strings.ToLower(txHash) + "#" + strconv.FormatUint(uint64(index), 10)
}

// MinUtxoLovelace is the ledger minimum for an output of serializedSize bytes.
func MinUtxoLovelace(serializedSize int, coinsPerUtxoByte uint64) uint64 {
	return uint64(MinUtxoOverheadBytes+serializedSize) * coinsPerUtxoByte
}

type slotConfig struct {
	zeroTimeMs int64
	zeroSlot   int64
	slotLength int64
}

var slotConfigs = map[string]slotConfig{
	CardanoMainnetCAIP2: {zeroTimeMs: 1596059091000, zeroSlot: 4492800, slotLength: 1000},
	CardanoPreprodCAIP2: {zeroTimeMs: 1655769600000, zeroSlot: 86400, slotLength: 1000},
	CardanoPreviewCAIP2: {zeroTimeMs: 1666656000000, zeroSlot: 0, slotLength: 1000},
}

// SlotToPosixMs converts an absolute Shelley-era slot to POSIX milliseconds.
// Slots whose time would overflow int64 are rejected rather than wrapped.
func SlotToPosixMs(network string, slot uint64) (int64, error) {
	cfg, ok := slotConfigs[NormalizeNetwork(network)]
	if !ok {
		return 0, fmt.Errorf("no slot config for network: %s", network)
	}
	if slot > uint64((math.MaxInt64-cfg.zeroTimeMs)/cfg.slotLength+cfg.zeroSlot) {
		return 0, fmt.Errorf("slot %d is beyond the representable time range", slot)
	}
	return cfg.zeroTimeMs + (int64(slot)-cfg.zeroSlot)*cfg.slotLength, nil
}

// PosixMsToSlot converts POSIX milliseconds to the slot containing that instant.
func PosixMsToSlot(network string, posixMs int64) (uint64, error) {
	cfg, ok := slotConfigs[NormalizeNetwork(network)]
	if !ok {
		return 0, fmt.Errorf("no slot config for network: %s", network)
	}
	slot := cfg.zeroSlot + (posixMs-cfg.zeroTimeMs)/cfg.slotLength
	if slot < 0 {
		return 0, fmt.Errorf("time %d precedes the slot origin of %s", posixMs, network)
	}
	return uint64(slot), nil
}
