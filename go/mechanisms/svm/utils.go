package svm

import (
	"encoding/base64"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
)

var (
	// Solana address regex (base58, 32-44 characters)
	solanaAddressRegex = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{32,44}$`)
)

// NormalizeNetwork converts V1 network names to CAIP-2 format
func NormalizeNetwork(network string) (string, error) {
	// If it's already CAIP-2 format (contains ":"), validate it's supported
	if strings.Contains(network, ":") {
		if _, ok := NetworkConfigs[network]; ok {
			return network, nil
		}
		return "", fmt.Errorf("unsupported Solana network: %s", network)
	}

	// Otherwise, it's a V1 network name, convert to CAIP-2
	caip2Network, ok := V1ToV2NetworkMap[network]
	if !ok {
		return "", fmt.Errorf("unsupported Solana network: %s", network)
	}

	return caip2Network, nil
}

// GetNetworkConfig returns the configuration for a network
func GetNetworkConfig(network string) (*NetworkConfig, error) {
	// Normalize to CAIP-2
	caip2Network, err := NormalizeNetwork(network)
	if err != nil {
		return nil, err
	}

	config, ok := NetworkConfigs[caip2Network]
	if !ok {
		return nil, fmt.Errorf("network configuration not found: %s", network)
	}

	return &config, nil
}

// GetAssetInfo returns information about an asset on a network
func GetAssetInfo(network string, assetSymbolOrAddress string) (*AssetInfo, error) {
	config, err := GetNetworkConfig(network)
	if err != nil {
		return nil, err
	}

	// Check if it's a valid Solana address (mint address)
	if ValidateSolanaAddress(assetSymbolOrAddress) {
		// Check if it matches the default asset
		if assetSymbolOrAddress == config.DefaultAsset.Address {
			return &config.DefaultAsset, nil
		}

		// Unknown token - return basic info with default decimals
		return &AssetInfo{
			Address:  assetSymbolOrAddress,
			Symbol:   "UNKNOWN",
			Decimals: 9, // Solana default decimals
		}, nil
	}

	// Default to the network's default asset
	return &config.DefaultAsset, nil
}

// ValidateSolanaAddress checks if a string is a valid Solana address
func ValidateSolanaAddress(address string) bool {
	if !solanaAddressRegex.MatchString(address) {
		return false
	}

	// Try to parse as PublicKey
	_, err := solana.PublicKeyFromBase58(address)
	return err == nil
}

// ParseAmount converts a decimal string amount to token smallest units
func ParseAmount(amount string, decimals int) (uint64, error) {
	// Remove any whitespace
	amount = strings.TrimSpace(amount)

	// Parse the decimal amount
	parts := strings.Split(amount, ".")
	if len(parts) > 2 {
		return 0, fmt.Errorf("invalid amount format: %s", amount)
	}

	// Parse integer part
	intPart, err := strconv.ParseUint(parts[0], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid integer part: %s", parts[0])
	}

	// Handle decimal part
	decPart := uint64(0)
	if len(parts) == 2 && parts[1] != "" {
		// Pad or truncate decimal part to match token decimals
		decStr := parts[1]
		if len(decStr) > decimals {
			decStr = decStr[:decimals]
		} else {
			decStr += strings.Repeat("0", decimals-len(decStr))
		}

		decPart, err = strconv.ParseUint(decStr, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid decimal part: %s", parts[1])
		}
	}

	// Calculate total in smallest unit
	multiplier := uint64(math.Pow10(decimals))
	result := intPart*multiplier + decPart

	return result, nil
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

// DecodeTransaction decodes a base64 encoded Solana transaction
func DecodeTransaction(base64Tx string) (*solana.Transaction, error) {
	// Decode base64
	txBytes, err := base64.StdEncoding.DecodeString(base64Tx)
	if err != nil {
		return nil, fmt.Errorf("failed to decode base64 transaction: %w", err)
	}

	// Deserialize transaction
	tx, err := solana.TransactionFromDecoder(bin.NewBinDecoder(txBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to deserialize transaction: %w", err)
	}

	return tx, nil
}

// GetTokenPayerFromTransaction extracts the token payer (owner) address from a transaction
// This looks for the TransferChecked instruction and returns the owner/authority address
func GetTokenPayerFromTransaction(tx *solana.Transaction) (string, error) {
	if tx == nil || tx.Message.Instructions == nil {
		return "", fmt.Errorf("invalid transaction: nil transaction or instructions")
	}

	// Iterate through instructions to find TransferChecked
	for _, inst := range tx.Message.Instructions {
		programID := tx.Message.AccountKeys[inst.ProgramIDIndex]

		// Check if this is a token program instruction
		if programID == solana.TokenProgramID || programID == solana.Token2022ProgramID {
			// Decode the instruction
			accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
			if err != nil {
				continue
			}

			decoded, err := token.DecodeInstruction(accounts, inst.Data)
			if err != nil {
				continue
			}

			// Check if it's a TransferChecked instruction
			if _, ok := decoded.Impl.(*token.TransferChecked); ok {
				// The owner/authority is the 4th account (index 3)
				if len(accounts) >= 4 {
					return accounts[3].PublicKey.String(), nil
				}
			}
		}
	}

	return "", fmt.Errorf("no TransferChecked instruction found in transaction")
}

// EncodeTransaction encodes a Solana transaction to base64
func EncodeTransaction(tx *solana.Transaction) (string, error) {
	// Serialize transaction
	txBytes, err := tx.MarshalBinary()
	if err != nil {
		return "", fmt.Errorf("failed to serialize transaction: %w", err)
	}

	// Encode to base64
	return base64.StdEncoding.EncodeToString(txBytes), nil
}
