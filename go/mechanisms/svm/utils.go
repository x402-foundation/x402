package svm

import (
	"context"
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
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/types"
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

// ErrUnsupportedTransactionVersion is the verify/settle reason returned when a
// client-supplied transaction uses a message version the SVM schemes do not
// accept. Every scheme shares this code so operators see one reason across
// exact, upto and payment-channels regardless of which verifier rejected it.
const ErrUnsupportedTransactionVersion = "unsupported_transaction_version"

// ExtraTransactionVersions is the PaymentRequirements.Extra key (copied by the
// server from the facilitator's /supported extra) that lists the transaction
// message versions the facilitator accepts, in the Wallet Standard
// supportedTransactionVersions vocabulary ("legacy", 0, 1).
const ExtraTransactionVersions = "transactionVersions"

// AdvertisedTransactionVersions is the value facilitators publish as
// extra.transactionVersions in /supported. Only version 0 is advertised:
// legacy messages are still accepted for backward compatibility (see
// IsAcceptedTransactionVersion) but are deprecated and never offered to
// clients, and version 1 (SIMD-0385) is not modelled by this SDK yet.
var AdvertisedTransactionVersions = []int{0}

// ClientSupportedTransactionVersions lists message versions this client can
// construct. Negotiation selects the highest value shared with the
// facilitator's advertised set.
var ClientSupportedTransactionVersions = []int{0}

// IsAcceptedTransactionVersion reports whether a decoded message version is one
// the SVM verifiers know how to police. This is an allowlist of legacy and v0,
// not a comparison against a maximum: every acceptance check derives its
// sponsorship policy from version-specific structure (compute budget arrives as
// ComputeBudget instructions on legacy and v0, but as an inline message config
// on transaction v1), so an unmodelled version must be rejected before any
// instruction-scanning check can pass vacuously.
func IsAcceptedTransactionVersion(version solana.MessageVersion) bool {
	return version == solana.MessageVersionLegacy || version == solana.MessageVersionV0
}

// ResolveTransactionVersion picks the message version a client must build from
// requirements.Extra["transactionVersions"]. It selects the highest version
// shared by the facilitator advertisement and this client's supported-version
// set. An absent field means the facilitator predates advertisement and
// accepts v0.
func ResolveTransactionVersion(extra map[string]interface{}) (solana.MessageVersion, error) {
	raw := interface{}([]int{0})
	if extra != nil {
		if value, ok := extra[ExtraTransactionVersions]; ok {
			raw = value
		}
	}
	var advertised []int
	list, ok := raw.([]interface{})
	if !ok {
		// Typed slices appear when the requirements were built in-process
		// rather than decoded from JSON.
		switch typed := raw.(type) {
		case []int:
			advertised = append(advertised, typed...)
		case []float64:
			for _, v := range typed {
				if v >= 0 && v == float64(int(v)) {
					advertised = append(advertised, int(v))
				}
			}
		default:
			return 0, fmt.Errorf("%s: transactionVersions must be an array, got %T", ErrUnsupportedTransactionVersion, raw)
		}
	} else {
		for _, entry := range list {
			switch v := entry.(type) {
			case float64:
				if v >= 0 && v == float64(int(v)) {
					advertised = append(advertised, int(v))
				}
			case int:
				if v >= 0 {
					advertised = append(advertised, v)
				}
			case int64:
				if v >= 0 && uint64(v) <= uint64(^uint(0)>>1) {
					advertised = append(advertised, int(v))
				}
			}
		}
	}
	selected := -1
	for _, supported := range ClientSupportedTransactionVersions {
		for _, offered := range advertised {
			if supported == offered && supported > selected {
				selected = supported
			}
		}
	}
	if selected >= 0 {
		return solana.MessageVersion(selected + 1), nil
	}
	return 0, fmt.Errorf("%s: facilitator accepts none of the transaction versions this client can build: %v", ErrUnsupportedTransactionVersion, raw)
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

// ResolveBlockhash prefers extra.recentBlockhash. A missing or malformed hint
// is fetched from rpc at finalized commitment.
func ResolveBlockhash(ctx context.Context, rpcClient *rpc.Client, requirements types.PaymentRequirements) (solana.Hash, error) {
	if hint, ok := requirements.Extra["recentBlockhash"].(string); ok && hint != "" {
		if blockhash, err := solana.HashFromBase58(hint); err == nil {
			return blockhash, nil
		}
	}
	latest, err := rpcClient.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return solana.Hash{}, fmt.Errorf("failed to get latest blockhash: %w", err)
	}
	return latest.Value.Blockhash, nil
}

// ResolveOpenSlot prefers extra.recentSlot. A missing or malformed hint is
// fetched from rpc at finalized commitment.
func ResolveOpenSlot(ctx context.Context, rpcClient *rpc.Client, requirements types.PaymentRequirements) (uint64, error) {
	if slot, ok := parseHintUint64(requirements.Extra["recentSlot"]); ok {
		return slot, nil
	}
	slot, err := rpcClient.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return 0, fmt.Errorf("failed to get slot: %w", err)
	}
	return slot, nil
}

func parseHintUint64(value any) (uint64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed < 0 || typed != float64(uint64(typed)) {
			return 0, false
		}
		return uint64(typed), true
	case int:
		if typed < 0 {
			return 0, false
		}
		return uint64(typed), true
	case int64:
		if typed < 0 {
			return 0, false
		}
		return uint64(typed), true
	case uint64:
		return typed, true
	case string:
		parsed, err := strconv.ParseUint(typed, 10, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// CreateRPCClient dials rpcURL, or the network's default endpoint when rpcURL is empty.
func CreateRPCClient(network, rpcURL string) (*rpc.Client, error) {
	if rpcURL != "" {
		return rpc.New(rpcURL), nil
	}
	config, err := GetNetworkConfig(network)
	if err != nil {
		return nil, err
	}
	return rpc.New(config.RPCURL), nil
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
