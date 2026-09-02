package evm

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// IsValidTxHash reports whether a signer-supplied hash is usable for a receipt wait: 0x
// followed by 64 hex digits, and non-zero. The all-zero hash reconciles to nothing, so a
// signer reporting success with a placeholder fails terminally instead of as pending.
func IsValidTxHash(hash string) bool {
	if len(hash) != 66 || !strings.HasPrefix(hash, "0x") {
		return false
	}
	bytes, err := hex.DecodeString(hash[2:])
	if err != nil {
		return false
	}
	for _, b := range bytes {
		if b != 0 {
			return true
		}
	}
	return false
}

// FinalHashFromTwoRequestSend returns the last hash from a two-request
// extension-signer broadcast (e.g. approve + settle/deposit). Conforming
// signers return one hash (atomic bundle) or two (sequential); any other
// count means a partial execution.
func FinalHashFromTwoRequestSend(txHashes []string) (string, bool) {
	if len(txHashes) != 1 && len(txHashes) != 2 {
		return "", false
	}
	return txHashes[len(txHashes)-1], true
}

// MaxErrorMessageLength matches the truncation length used by the Python and TypeScript SDKs.
const MaxErrorMessageLength = 500

// TruncateErrorMessage bounds raw error text (e.g. from an RPC client) before it is placed
// in a settle/verify ErrorMessage. RPC/transport errors can carry node URLs, request bodies,
// or other verbose data that should not be echoed to callers unbounded. Truncation counts
// runes so a multi-byte UTF-8 rune is never cut in half.
func TruncateErrorMessage(msg string) string {
	runes := []rune(msg)
	if len(runes) <= MaxErrorMessageLength {
		return msg
	}
	return string(runes[:MaxErrorMessageLength])
}

// InvalidBroadcastHashError builds a terminal SettleError for a signer that reports success
// without a usable transaction hash. settlement_pending is only meaningful with a broadcast
// hash to reconcile against, so this case is always terminal, never ErrSettlementPending.
func InvalidBroadcastHashError(reason string, payer string, network x402.Network, txHash string) error {
	return x402.NewSettleError(reason, payer, network, "",
		fmt.Sprintf("signer returned an invalid transaction hash: %q", txHash))
}

// receiptWaiter is the signer capability required to confirm a broadcast transaction.
type receiptWaiter interface {
	WaitForTransactionReceipt(ctx context.Context, txHash string) (*TransactionReceipt, error)
}

// WaitForSettleReceipt waits for a broadcast settlement receipt.
// Invalid hashes and reverted receipts are terminal; receipt-wait failures return
// ErrSettlementPending with the broadcast hash preserved.
func WaitForSettleReceipt(
	ctx context.Context,
	signer receiptWaiter,
	txHash string,
	payer string,
	network x402.Network,
	invalidHashReason string,
	revertedReason string,
) (*TransactionReceipt, error) {
	if !IsValidTxHash(txHash) {
		return nil, InvalidBroadcastHashError(invalidHashReason, payer, network, txHash)
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrSettlementPending, payer, network, txHash,
			TruncateErrorMessage(err.Error()))
	}
	if receipt.Status != TxStatusSuccess {
		return nil, x402.NewSettleError(revertedReason, payer, network, txHash, "")
	}
	return receipt, nil
}

// WaitForSettleReceiptWithPendingStore wraps WaitForSettleReceipt with the
// PendingSettlementStore bookkeeping shared by every EVM settle path that
// supports settlement_pending reconciliation: on a wait failure, record
// txHash under pendingKey so a subsequent settle attempt for the same
// payload can reconcile against it instead of re-broadcasting; on success,
// clear any stale entry. store may be nil and pendingKey may be "" — either
// disables the bookkeeping while still waiting for the receipt.
//
// Mirrors the TypeScript SDK's withPendingSettlementStore and the Python
// SDK's wait_for_receipt_and_build_response. Used directly by Permit2
// (exact + upto) and batch-settlement deposit; EIP-3009 wraps this to add a
// post-receipt Transfer-event check (see awaitEIP3009Settlement in
// exact/facilitator/eip3009.go), since a confirmed-but-mismatched receipt
// must clear the pending entry (terminal), not set it.
func WaitForSettleReceiptWithPendingStore(
	ctx context.Context,
	store x402.PendingSettlementStore,
	pendingKey string,
	signer receiptWaiter,
	txHash string,
	payer string,
	network x402.Network,
	invalidHashReason string,
	revertedReason string,
) (*TransactionReceipt, error) {
	// An invalid hash means nothing usable was ever broadcast: clear any stale
	// entry instead of caching the garbage hash. Checked here (rather than
	// relying on WaitForSettleReceipt) to distinguish this from a genuine
	// wait failure below.
	if !IsValidTxHash(txHash) {
		if store != nil && pendingKey != "" {
			_ = store.Delete(ctx, pendingKey)
		}
		return nil, InvalidBroadcastHashError(invalidHashReason, payer, network, txHash)
	}

	receipt, err := WaitForSettleReceipt(ctx, signer, txHash, payer, network, invalidHashReason, revertedReason)
	if err != nil {
		// Only a receipt-wait failure (settlement_pending) is safe to cache for
		// reconciliation. A reverted receipt is terminal and must not be cached —
		// otherwise it lingers as a false "pending" entry until TTL expiry.
		var se *x402.SettleError
		if store != nil && pendingKey != "" && errors.As(err, &se) && se.ErrorReason == ErrSettlementPending {
			if setErr := store.Set(ctx, pendingKey, txHash); setErr != nil {
				// Can't guarantee a later retry will find this to reconcile
				// against — a blind retry could re-verify/re-broadcast and
				// double-send. Downgrade to the terminal reason, preserving the
				// transaction hash for manual reconciliation.
				return nil, x402.NewSettleError(revertedReason, payer, network, txHash,
					fmt.Sprintf("settlement_pending, but failed to persist for retry: %s", setErr.Error()))
			}
		}
		return nil, err
	}
	if store != nil && pendingKey != "" {
		// Best-effort: a failed delete only leaves a stale entry that expires
		// via TTL. The receipt is already confirmed and must still be returned.
		_ = store.Delete(ctx, pendingKey)
	}
	return receipt, nil
}

// GetEvmChainId returns the chain ID for a given CAIP-2 network identifier (eip155:CHAIN_ID).
func GetEvmChainId(network string) (*big.Int, error) {
	if strings.HasPrefix(network, "eip155:") {
		chainIdStr := strings.TrimPrefix(network, "eip155:")
		chainId, ok := new(big.Int).SetString(chainIdStr, 10)
		if ok {
			return chainId, nil
		}
	}

	return nil, fmt.Errorf("unsupported network: %s (expected eip155:CHAIN_ID)", network)
}

// CreateNonce generates a random 32-byte nonce for EIP-3009
func CreateNonce() (string, error) {
	nonce := make([]byte, 32)
	_, err := rand.Read(nonce)
	if err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}
	return "0x" + hex.EncodeToString(nonce), nil
}

// CreatePermit2Nonce generates a random 256-bit nonce for Permit2.
// Permit2 uses uint256 nonces (not bytes32 like EIP-3009).
func CreatePermit2Nonce() (string, error) {
	nonce := make([]byte, 32)
	_, err := rand.Read(nonce)
	if err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}
	// Convert to uint256 string representation
	nonceInt := new(big.Int).SetBytes(nonce)
	return nonceInt.String(), nil
}

// MaxUint256 returns the maximum value for uint256 (used for unlimited approval).
func MaxUint256() *big.Int {
	max := new(big.Int)
	max.Exp(big.NewInt(2), big.NewInt(256), nil)
	max.Sub(max, big.NewInt(1))
	return max
}

// NormalizeAddress ensures an Ethereum address is in the correct format
func NormalizeAddress(address string) string {
	// Remove 0x prefix if present
	addr := strings.TrimPrefix(strings.ToLower(address), "0x")

	// Add 0x prefix back
	return "0x" + addr
}

// IsValidAddress checks if a string is a valid Ethereum address
func IsValidAddress(address string) bool {
	// Remove 0x prefix if present
	addr := strings.TrimPrefix(address, "0x")

	// Check length (40 hex characters)
	if len(addr) != 40 {
		return false
	}

	// Check if all characters are valid hex
	_, err := hex.DecodeString(addr)
	return err == nil
}

// ParseAmount converts a decimal string amount to wei based on token decimals
func ParseAmount(amount string, decimals int) (*big.Int, error) {
	// Parse the decimal amount
	parts := strings.Split(amount, ".")
	if len(parts) > 2 {
		return nil, fmt.Errorf("invalid amount format: %s", amount)
	}

	// Parse integer part
	intPart, ok := new(big.Int).SetString(parts[0], 10)
	if !ok {
		return nil, fmt.Errorf("invalid integer part: %s", parts[0])
	}

	// Handle decimal part
	decPart := new(big.Int)
	if len(parts) == 2 && parts[1] != "" {
		// Pad or truncate decimal part to match token decimals
		decStr := parts[1]
		if len(decStr) > decimals {
			decStr = decStr[:decimals]
		} else {
			decStr += strings.Repeat("0", decimals-len(decStr))
		}

		decPart, ok = new(big.Int).SetString(decStr, 10)
		if !ok {
			return nil, fmt.Errorf("invalid decimal part: %s", parts[1])
		}
	}

	// Calculate total in smallest unit
	multiplier := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	result := new(big.Int).Mul(intPart, multiplier)
	result.Add(result, decPart)

	return result, nil
}

// FormatAmount converts an amount in wei to a decimal string
func FormatAmount(amount *big.Int, decimals int) string {
	if amount == nil {
		return "0"
	}

	divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	quotient, remainder := new(big.Int).DivMod(amount, divisor, new(big.Int))

	// Format the decimal part with leading zeros
	decStr := remainder.String()
	if len(decStr) < decimals {
		decStr = strings.Repeat("0", decimals-len(decStr)) + decStr
	}

	// Remove trailing zeros
	decStr = strings.TrimRight(decStr, "0")

	if decStr == "" {
		return quotient.String()
	}

	return quotient.String() + "." + decStr
}

// GetAssetInfo returns information about an asset on a network.
// If assetSymbolOrAddress is a valid address, returns info for that specific token.
// If assetSymbolOrAddress is empty or a symbol, attempts to use the network's default asset.
//
// Args:
//   - network: The network identifier
//   - assetSymbolOrAddress: Either an asset address (0x...) or empty for default
//
// Returns:
//   - AssetInfo for the requested asset
//   - Error if default asset is requested but not configured for this network
func GetAssetInfo(network string, assetSymbolOrAddress string) (*AssetInfo, error) {
	if found := FindDefaultAsset(assetSymbolOrAddress, network); found != nil {
		return defaultAssetToAssetInfo(found), nil
	}

	// Check if it's an explicit address - works for ANY network
	if IsValidAddress(assetSymbolOrAddress) {
		normalizedAddr := NormalizeAddress(assetSymbolOrAddress)

		// Unknown token - return basic info (works for any EVM network)
		return &AssetInfo{
			Address:  normalizedAddr,
			Name:     "Unknown Token",
			Version:  "1",
			Decimals: 18, // Default to 18 decimals for unknown tokens
		}, nil
	}

	// Not an explicit address - need the network's default asset
	info, err := GetDefaultAsset(network, "")
	if err != nil {
		return nil, fmt.Errorf("no default asset configured for network %s; specify an explicit asset address or register a money parser", network)
	}
	return defaultAssetToAssetInfo(info), nil
}

// CreateValidityWindow creates valid after/before timestamps
func CreateValidityWindow(duration time.Duration) (validAfter, validBefore *big.Int) {
	now := time.Now().Unix()
	validAfter = big.NewInt(0)
	validBefore = big.NewInt(now + int64(duration.Seconds()))
	return validAfter, validBefore
}

// HexToBytes converts a hex string to bytes
func HexToBytes(hexStr string) ([]byte, error) {
	// Remove 0x prefix if present
	cleaned := strings.TrimPrefix(hexStr, "0x")
	return hex.DecodeString(cleaned)
}

// BytesToHex converts bytes to a hex string with 0x prefix
func BytesToHex(data []byte) string {
	return "0x" + hex.EncodeToString(data)
}

// ValidateAssetIsContract checks whether the payment asset is a deployed contract.
// Returns (ErrAssetNotDeployedContract, nil) for an EOA/empty address,
// ("", nil) for a deployed contract, or ("", err) if eth_getCode itself fails.
func ValidateAssetIsContract(ctx context.Context, signer FacilitatorEvmSigner, asset string) (string, error) {
	code, err := signer.GetCode(ctx, NormalizeAddress(asset))
	if err != nil {
		return "", fmt.Errorf("failed to check whether asset is a contract: %w", err)
	}
	if len(code) == 0 {
		return ErrAssetNotDeployedContract, nil
	}
	return "", nil
}
