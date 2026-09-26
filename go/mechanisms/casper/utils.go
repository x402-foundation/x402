package casper

import (
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/make-software/casper-go-sdk/v2/types/keypair"
	x402 "github.com/x402-foundation/x402/go/v2"
)

var addressHashRegex = regexp.MustCompile(`^(00|01)[0-9a-fA-F]{64}$`)
var contractPackageHashRegex = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func GetNetworkConfig(network string) (*NetworkConfig, error) {
	cfg, ok := NetworkConfigs[network]
	if !ok {
		return nil, fmt.Errorf("unsupported Casper network: %s", network)
	}

	return &cfg, nil
}

func ChainNameFromNetwork(network string) string {
	parts := strings.SplitN(network, ":", 2)
	if len(parts) == 2 {
		return parts[1]
	}

	return network
}

func IsValidAddress(s string) bool {
	return addressHashRegex.MatchString(s)
}

func IsValidContractPackageHash(s string) bool {
	return contractPackageHashRegex.MatchString(s)
}

func DecodeContractPackageHash(hexStr string) ([32]byte, error) {
	var result [32]byte
	if len(hexStr) != 64 {
		return result, fmt.Errorf("contract_package_hash must be 64 hex chars, got %d", len(hexStr))
	}

	b, err := hex.DecodeString(hexStr)
	if err != nil {
		return result, fmt.Errorf("invalid hex in contract_package_hash: %w", err)
	}

	copy(result[:], b)
	return result, nil
}

// GetAssetInfo returns registered asset metadata. An empty asset selects the
// network default; an unknown explicit asset must not inherit another token's metadata.
func GetAssetInfo(network string, asset string) (*AssetInfo, error) {
	if found := FindDefaultAsset(asset, network); found != nil {
		return defaultAssetToAssetInfo(found), nil
	}
	if asset != "" {
		return nil, fmt.Errorf("unknown asset %s on network %s", asset, network)
	}

	info, err := GetDefaultAsset(network, "")
	if err != nil {
		return nil, err
	}
	return defaultAssetToAssetInfo(info), nil
}

// ParseAmount converts a decimal amount to uint64 atomic units, rejecting
// fractional atomic units and overflow. U256 amounts should use atomic strings.
func ParseAmount(amount string, decimals int) (uint64, error) {
	amount = strings.TrimSpace(amount)
	if decimals < 0 || decimals > 255 {
		return 0, fmt.Errorf("token decimals must be between 0 and 255")
	}
	if _, fraction, _ := strings.Cut(amount, "."); len(strings.TrimRight(fraction, "0")) > decimals {
		return 0, fmt.Errorf("amount requires fractional atomic units")
	}
	atomic, err := x402.ConvertToTokenAmount(amount, decimals)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(atomic, 10, 64)
}

// FormatAmount converts an amount in smallest units to a decimal string
func FormatAmount(amount uint64, decimals int) string {
	if amount == 0 {
		return "0"
	}

	divisor := uint64(math.Pow10(decimals))
	quotient := amount / divisor
	remainder := amount % divisor

	// Format the decimal part with leading zeros
	decStr := fmt.Sprintf("%0*d", decimals, remainder)

	// Remove trailing zeros
	decStr = strings.TrimRight(decStr, "0")

	if decStr == "" {
		return fmt.Sprintf("%d", quotient)
	}

	return fmt.Sprintf("%d.%s", quotient, decStr)
}

// ValidateSignatureFormat checks Casper's algorithm tag and requires canonical
// secp256k1 scalars: 0 < r < n and 0 < s <= n/2. Cryptographic verification must
// follow this check. Ed25519 signatures have their own encoding rules.
func ValidateSignatureFormat(signature [65]byte) error {
	switch signature[0] {
	case byte(keypair.ED25519):
		return nil
	case byte(keypair.SECP256K1):
		var r, s secp256k1.ModNScalar
		// SetByteSlice reduces values modulo n, so overflow must cause rejection.
		if r.SetByteSlice(signature[1:33]) || r.IsZero() {
			return fmt.Errorf("invalid secp256k1 signature r scalar")
		}
		if s.SetByteSlice(signature[33:]) || s.IsZero() {
			return fmt.Errorf("invalid secp256k1 signature s scalar")
		}
		if s.IsOverHalfOrder() {
			return fmt.Errorf("secp256k1 signature must use low-s")
		}
		return nil
	default:
		return fmt.Errorf("unsupported Casper signature algorithm tag %#x", signature[0])
	}
}
