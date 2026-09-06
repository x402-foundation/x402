package svm

import (
	"crypto/sha256"
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
	if strings.Contains(network, ":") {
		switch network {
		case SolanaMainnetCAIP2, SolanaDevnetCAIP2, SolanaTestnetCAIP2:
			return network, nil
		default:
			return "", fmt.Errorf("unsupported Solana network: %s", network)
		}
	}

	caip2Network, ok := V1ToV2NetworkMap[network]
	if !ok {
		return "", fmt.Errorf("unsupported Solana network: %s", network)
	}

	return caip2Network, nil
}

// GetNetworkConfig returns transport endpoints for a supported Solana network.
func GetNetworkConfig(network string) (*NetworkConfig, error) {
	caip2Network, err := NormalizeNetwork(network)
	if err != nil {
		return nil, err
	}

	config, ok := NetworkConfigs[caip2Network]
	if !ok {
		return nil, fmt.Errorf("no configuration for network: %s", network)
	}
	return &config, nil
}

// GetAssetInfo returns information about an asset on a network
func GetAssetInfo(network string, assetSymbolOrAddress string) (*AssetInfo, error) {
	if found := FindDefaultAsset(assetSymbolOrAddress, network); found != nil {
		return defaultAssetToAssetInfo(found), nil
	}

	// Check if it's a valid Solana address (mint address)
	if ValidateSolanaAddress(assetSymbolOrAddress) {
		// Unknown token - return basic info with default decimals
		return &AssetInfo{
			Address:  assetSymbolOrAddress,
			Symbol:   "UNKNOWN",
			Decimals: 9, // Solana default decimals
		}, nil
	}

	info, err := GetDefaultAsset(network, "")
	if err != nil {
		return nil, err
	}
	return defaultAssetToAssetInfo(info), nil
}

// stablecoinNetworkKey maps a network identifier to its mint lookup key.
func stablecoinNetworkKey(network string) (string, error) {
	caip2Network, err := NormalizeNetwork(network)
	if err != nil {
		return "", err
	}

	switch caip2Network {
	case SolanaMainnetCAIP2:
		return networkKeyMainnet, nil
	case SolanaDevnetCAIP2:
		return networkKeyDevnet, nil
	case SolanaTestnetCAIP2:
		return networkKeyTestnet, nil
	default:
		return "", fmt.Errorf("unsupported network: %s", network)
	}
}

// GetStablecoinAddress returns the mint for a supported stablecoin on a network.
// Stablecoins without a devnet/testnet mint fall back to their mainnet mint.
func GetStablecoinAddress(symbol string, network string) (string, error) {
	key, err := stablecoinNetworkKey(network)
	if err != nil {
		return "", err
	}

	mints, ok := StablecoinMints[strings.ToUpper(symbol)]
	if !ok {
		return "", fmt.Errorf("unsupported stablecoin: %s", symbol)
	}
	if address, ok := mints[key]; ok {
		return address, nil
	}
	if address, ok := mints[networkKeyMainnet]; ok {
		return address, nil
	}
	return "", fmt.Errorf("no %s address configured for network: %s", symbol, network)
}

// ResolveStablecoinMint resolves a stablecoin symbol to a mint address. SOL
// returns false, and unrecognized values are returned unchanged.
func ResolveStablecoinMint(currency string, network string) (string, bool) {
	normalized := strings.ToUpper(currency)
	if normalized == "SOL" {
		return "", false
	}
	if _, ok := StablecoinMints[normalized]; ok {
		address, err := GetStablecoinAddress(normalized, network)
		if err != nil {
			return currency, true
		}
		return address, true
	}
	return currency, true
}

// GetStablecoinSymbol returns the supported stablecoin symbol for a symbol or a
// known mint address.
func GetStablecoinSymbol(currency string) (string, bool) {
	normalized := strings.ToUpper(currency)
	if _, ok := StablecoinMints[normalized]; ok {
		return normalized, true
	}

	for symbol, mints := range StablecoinMints {
		for _, mint := range mints {
			if mint == currency {
				return symbol, true
			}
		}
	}
	return "", false
}

// GetStablecoinTokenProgram returns the token program owning a supported
// stablecoin's mint. Unrecognized values default to SPL Token, whose mints
// cannot be told apart from unknown ones without an RPC round-trip.
func GetStablecoinTokenProgram(currency string, network string) string {
	resolved, ok := ResolveStablecoinMint(currency, network)
	if !ok {
		resolved = currency
	}
	symbol, ok := GetStablecoinSymbol(resolved)
	if !ok {
		return TokenProgramAddress
	}
	if program, ok := StablecoinTokenPrograms[symbol]; ok {
		return program
	}
	return TokenProgramAddress
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

// MessageHash returns a stable, immutable cache key for a transaction by hashing its
// message bytes. The fee-payer signature (slot 0) is mutable — the facilitator
// overwrites it before broadcast — so keying on the full wire bytes would let an
// attacker bypass deduplication by randomizing those bytes. The message is what
// every signer commits to, so its hash uniquely and immutably identifies a payment.
func MessageHash(tx *solana.Transaction) (string, error) {
	msgBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return "", fmt.Errorf("failed to serialize transaction message: %w", err)
	}
	hash := sha256.Sum256(msgBytes)
	return base64.StdEncoding.EncodeToString(hash[:]), nil
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
		programID, err := tx.Message.Program(inst.ProgramIDIndex)
		if err != nil {
			continue
		}

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
