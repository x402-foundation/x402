package hedera

import (
	"encoding/base64"
	"fmt"
	"math/big"
	"regexp"
	"strings"

	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
)

var entityIDPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// IsValidEntityID reports whether s looks like shard.realm.num.
func IsValidEntityID(entityID string) bool {
	return entityIDPattern.MatchString(strings.TrimSpace(entityID))
}

// IsSupportedNetwork reports whether network is a known Hedera CAIP-2 id.
func IsSupportedNetwork(network string) bool {
	return network == HederaMainnetCAIP2 || network == HederaTestnetCAIP2
}

// IsHbarAsset reports whether asset is native HBAR.
func IsHbarAsset(asset string) bool {
	return asset == HBARAssetID
}

// IsValidAsset reports whether asset is HBAR or an HTS entity id.
func IsValidAsset(asset string) bool {
	return IsHbarAsset(asset) || IsValidEntityID(asset)
}

// AssertSupportedNetwork returns an error if network is unsupported.
func AssertSupportedNetwork(network string) error {
	if !IsSupportedNetwork(network) {
		return fmt.Errorf("unsupported Hedera network: %s", network)
	}
	return nil
}

// GetNetworkConfig returns the built-in config for a CAIP-2 network.
func GetNetworkConfig(network string) (NetworkConfig, error) {
	cfg, ok := NetworkConfigs[network]
	if !ok {
		return NetworkConfig{}, fmt.Errorf("unsupported Hedera network: %s", network)
	}
	return cfg, nil
}

// AssetTransferMethod returns extra.assetTransferMethod, defaulting to cryptoTransfer
// when absent. ok is false when the field is present but not a string.
func AssetTransferMethod(extra map[string]interface{}) (method string, ok bool) {
	raw, present := extra["assetTransferMethod"]
	if !present {
		return AssetTransferMethodCryptoTransfer, true
	}
	method, ok = raw.(string)
	return method, ok
}

// ExtractTransaction returns the base64 transaction field from a payment payload body.
func ExtractTransaction(payload map[string]interface{}) (string, error) {
	if payload == nil {
		return "", fmt.Errorf("missing payload")
	}
	raw, ok := payload["transaction"]
	if !ok {
		return "", fmt.Errorf("missing transaction")
	}
	s, ok := raw.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return "", fmt.Errorf("invalid transaction")
	}
	return s, nil
}

func normalizeAccountID(accountIDOrAlias string) string {
	id, err := hiero.AccountIDFromString(accountIDOrAlias)
	if err != nil {
		return accountIDOrAlias
	}
	return id.String()
}

// AccountIDsEqual reports whether two account ids / aliases refer to the same entity.
func AccountIDsEqual(left, right string) bool {
	return normalizeAccountID(left) == normalizeAccountID(right)
}

func accountIDsEqual(left, right string) bool {
	return AccountIDsEqual(left, right)
}

// SumTransfers returns the net sum of transfer amounts.
func SumTransfers(transfers []TransferEntry) *big.Int {
	sum := big.NewInt(0)
	for _, entry := range transfers {
		n, ok := new(big.Int).SetString(entry.Amount, 10)
		if !ok {
			continue
		}
		sum.Add(sum, n)
	}
	return sum
}

// GetPositiveReceivers returns account IDs with a positive net transfer.
func GetPositiveReceivers(transfers []TransferEntry) []string {
	net := map[string]*big.Int{}
	for _, entry := range transfers {
		n, ok := new(big.Int).SetString(entry.Amount, 10)
		if !ok {
			continue
		}
		cur, exists := net[entry.AccountID]
		if !exists {
			cur = big.NewInt(0)
			net[entry.AccountID] = cur
		}
		cur.Add(cur, n)
	}
	var out []string
	for accountID, value := range net {
		if value.Sign() > 0 {
			out = append(out, accountID)
		}
	}
	return out
}

// HasNegativeTransfer reports whether accountID has any negative transfer entry.
func HasNegativeTransfer(transfers []TransferEntry, accountID string) bool {
	for _, entry := range transfers {
		if !accountIDsEqual(entry.AccountID, accountID) {
			continue
		}
		n, ok := new(big.Int).SetString(entry.Amount, 10)
		if ok && n.Sign() < 0 {
			return true
		}
	}
	return false
}

// InspectTransaction decodes a base64 Hedera transaction for verification.
func InspectTransaction(transactionBase64 string) (InspectedTransaction, error) {
	return inspectTransaction(transactionBase64)
}

func inspectTransaction(transactionBase64 string) (InspectedTransaction, error) {
	raw, err := base64.StdEncoding.DecodeString(transactionBase64)
	if err != nil {
		return InspectedTransaction{}, fmt.Errorf("decode transaction: %w", err)
	}
	if _, err := decodeAndValidateTransactionVariants(raw); err != nil {
		return InspectedTransaction{}, err
	}
	txIface, err := hiero.TransactionFromBytes(raw)
	if err != nil {
		return InspectedTransaction{}, fmt.Errorf("parse transaction: %w", err)
	}

	transfer, ok := txIface.(hiero.TransferTransaction)
	if !ok {
		if ptr, okPtr := txIface.(*hiero.TransferTransaction); okPtr {
			transfer = *ptr
			ok = true
		}
	}
	if !ok {
		txID, _ := hiero.TransactionGetTransactionID(txIface)
		account := ""
		if txID.AccountID != nil {
			account = txID.AccountID.String()
		}
		return InspectedTransaction{
			TransactionType:      fmt.Sprintf("%T", txIface),
			TransactionID:        txID.String(),
			TransactionIDAccount: account,
			HasNonTransferOps:    true,
			TokenTransfers:       map[string][]TransferEntry{},
		}, nil
	}

	txID := transfer.GetTransactionID()
	account := ""
	if txID.AccountID != nil {
		account = txID.AccountID.String()
	}
	if txID.String() == "" || account == "" {
		return InspectedTransaction{}, fmt.Errorf("invalid_hedera_transaction_metadata")
	}

	hbarTransfers := normalizeHbarTransfers(transfer.GetHbarTransfers())
	tokenTransfers := normalizeTokenTransfers(transfer.GetTokenTransfers())
	hasNonTransfer := len(transfer.GetNftTransfers()) > 0

	return InspectedTransaction{
		TransactionType:      "TransferTransaction",
		TransactionID:        txID.String(),
		TransactionIDAccount: account,
		HasNonTransferOps:    hasNonTransfer,
		HbarTransfers:        hbarTransfers,
		TokenTransfers:       tokenTransfers,
	}, nil
}

func normalizeHbarTransfers(transfers map[hiero.AccountID]hiero.Hbar) []TransferEntry {
	out := make([]TransferEntry, 0, len(transfers))
	for accountID, amount := range transfers {
		out = append(out, TransferEntry{
			AccountID: accountID.String(),
			Amount:    fmt.Sprintf("%d", amount.AsTinybar()),
		})
	}
	return out
}

func normalizeTokenTransfers(transfers map[hiero.TokenID][]hiero.TokenTransfer) map[string][]TransferEntry {
	out := make(map[string][]TransferEntry, len(transfers))
	for tokenID, list := range transfers {
		entries := make([]TransferEntry, 0, len(list))
		for _, transfer := range list {
			entries = append(entries, TransferEntry{
				AccountID: transfer.AccountID.String(),
				Amount:    fmt.Sprintf("%d", transfer.Amount),
			})
		}
		out[tokenID.String()] = entries
	}
	return out
}

// AssetTransfers returns the transfer list for asset from an inspected transaction.
func AssetTransfers(inspected InspectedTransaction, asset string) ([]TransferEntry, error) {
	if IsHbarAsset(asset) {
		if len(inspected.TokenTransfers) > 0 {
			return nil, fmt.Errorf("unexpected token transfers for HBAR payment")
		}
		return inspected.HbarTransfers, nil
	}
	if len(inspected.TokenTransfers) != 1 {
		return nil, fmt.Errorf("expected exactly one token transfer list")
	}
	list, ok := inspected.TokenTransfers[asset]
	if !ok {
		return nil, fmt.Errorf("token asset mismatch")
	}
	return list, nil
}

// InferPayers returns net-debiting accounts and their absolute debit amounts.
func InferPayers(transfers []TransferEntry) []DebitedPayer {
	debited := map[string]*big.Int{}
	for _, entry := range transfers {
		n, ok := new(big.Int).SetString(entry.Amount, 10)
		if !ok || n.Sign() >= 0 {
			continue
		}
		cur, exists := debited[entry.AccountID]
		if !exists {
			cur = big.NewInt(0)
			debited[entry.AccountID] = cur
		}
		cur.Add(cur, n)
	}
	out := make([]DebitedPayer, 0, len(debited))
	for accountID, amount := range debited {
		out = append(out, DebitedPayer{
			AccountID: accountID,
			Amount:    new(big.Int).Neg(amount).String(),
		})
	}
	return out
}

// ParsePositiveAmount parses a non-empty decimal integer amount string.
func ParsePositiveAmount(amount string) (*big.Int, error) {
	n, ok := new(big.Int).SetString(strings.TrimSpace(amount), 10)
	if !ok {
		return nil, fmt.Errorf("invalid amount")
	}
	if n.Sign() <= 0 {
		return nil, fmt.Errorf("amount must be greater than zero")
	}
	return n, nil
}

func mirrorURLForNetwork(network, override string) (string, error) {
	cfg, err := GetNetworkConfig(network)
	if err != nil {
		return "", err
	}
	if override != "" {
		return strings.TrimRight(override, "/"), nil
	}
	return cfg.MirrorURL, nil
}

// ParsePrivateKey parses Hedera private keys with ECDSA preference for 32-byte hex.
func ParsePrivateKey(raw string) (hiero.PrivateKey, error) {
	raw = strings.TrimSpace(raw)
	hexKey := strings.TrimPrefix(strings.TrimPrefix(raw, "0x"), "0X")
	// 32-byte hex is ambiguous: FromString defaults to ED25519, but Hedera
	// x402 wallets (and EVM aliases) use ECDSA secp256k1 — prefer ECDSA.
	if len(hexKey) == 64 {
		if key, err := hiero.PrivateKeyFromStringECDSA(hexKey); err == nil {
			return key, nil
		}
	}
	if key, err := hiero.PrivateKeyFromStringECDSA(raw); err == nil {
		return key, nil
	}
	if key, err := hiero.PrivateKeyFromStringEd25519(raw); err == nil {
		return key, nil
	}
	if key, err := hiero.PrivateKeyFromString(raw); err == nil {
		return key, nil
	}
	if key, err := hiero.PrivateKeyFromStringECDSA(hexKey); err == nil {
		return key, nil
	}
	return hiero.PrivateKey{}, fmt.Errorf("unsupported private key encoding")
}

func newSDKClient(network string) (*hiero.Client, error) {
	switch network {
	case HederaMainnetCAIP2:
		return hiero.ClientForMainnet(), nil
	case HederaTestnetCAIP2:
		return hiero.ClientForTestnet(), nil
	default:
		return nil, fmt.Errorf("unsupported hedera network %q", network)
	}
}

func asTransferTransaction(txIface hiero.TransactionInterface) (hiero.TransferTransaction, bool) {
	switch t := txIface.(type) {
	case hiero.TransferTransaction:
		return t, true
	case *hiero.TransferTransaction:
		if t == nil {
			return hiero.TransferTransaction{}, false
		}
		return *t, true
	default:
		return hiero.TransferTransaction{}, false
	}
}

// ParseAmount converts a decimal string to the smallest token unit.
func ParseAmount(amount string, decimals int) (*big.Int, error) {
	parts := strings.Split(amount, ".")
	if len(parts) > 2 {
		return nil, fmt.Errorf("invalid amount format: %s", amount)
	}
	intPart, ok := new(big.Int).SetString(parts[0], 10)
	if !ok {
		return nil, fmt.Errorf("invalid integer part: %s", parts[0])
	}
	decPart := new(big.Int)
	if len(parts) == 2 && parts[1] != "" {
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
	multiplier := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	result := new(big.Int).Mul(intPart, multiplier)
	result.Add(result, decPart)
	return result, nil
}
