package batchsettlement

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Canonical bytes32 channel id: 0x followed by exactly 64 hex digits.
var channelIDRe = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

var channelSaltHexRe = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)

var (
	uint96Mask  = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 96), big.NewInt(1))
	maxUint256  = new(big.Int).Lsh(big.NewInt(1), 256)
	maxSafeInt  = int64(1<<53 - 1)
	zeroAddress = common.HexToAddress("0x0000000000000000000000000000000000000000")
)

// CachedChannelOnchain is the onchain snapshot needed to accept an EOA voucher
// from cache. Kept here so the root package does not import storage.
type CachedChannelOnchain struct {
	ChannelId           string
	Balance             string
	TotalClaimed        string
	WithdrawRequestedAt int
	RefundNonce         int
	OnchainSyncedAt     int64
}

// ComputeChannelId computes the chain-bound channel ID from a ChannelConfig
// via EIP-712 hashTypedData. The networkOrChainID argument may be either a
// CAIP-2 network identifier (e.g. "eip155:84532") or a numeric chain id as
// a *big.Int.
func ComputeChannelId(config ChannelConfig, networkOrChainID interface{}) (string, error) {
	chainID, err := resolveChainID(networkOrChainID)
	if err != nil {
		return "", err
	}

	saltBytes, err := hexToBytes32(config.Salt)
	if err != nil {
		return "", fmt.Errorf("invalid salt: %w", err)
	}

	message := map[string]interface{}{
		"payer":              common.HexToAddress(config.Payer).Hex(),
		"payerAuthorizer":    common.HexToAddress(config.PayerAuthorizer).Hex(),
		"receiver":           common.HexToAddress(config.Receiver).Hex(),
		"receiverAuthorizer": common.HexToAddress(config.ReceiverAuthorizer).Hex(),
		"token":              common.HexToAddress(config.Token).Hex(),
		"withdrawDelay":      big.NewInt(int64(config.WithdrawDelay)),
		"salt":               saltBytes[:],
	}

	hash, err := evm.HashTypedData(
		GetBatchSettlementEip712Domain(chainID),
		ChannelConfigTypes,
		"ChannelConfig",
		message,
	)
	if err != nil {
		return "", fmt.Errorf("failed to hash channel config: %w", err)
	}
	return fmt.Sprintf("0x%x", hash), nil
}

// resolveChainID accepts either a CAIP-2 network string (e.g. "eip155:84532"),
// a numeric chain id (*big.Int, int, int64, uint64), or anything that
// converts via fmt.Sprint to a CAIP-2 string.
func resolveChainID(networkOrChainID interface{}) (*big.Int, error) {
	switch v := networkOrChainID.(type) {
	case nil:
		return nil, fmt.Errorf("networkOrChainID is required")
	case string:
		return evm.GetEvmChainId(v)
	case *big.Int:
		if v == nil {
			return nil, fmt.Errorf("networkOrChainID is required")
		}
		return new(big.Int).Set(v), nil
	case int:
		return big.NewInt(int64(v)), nil
	case int64:
		return big.NewInt(v), nil
	case uint64:
		return new(big.Int).SetUint64(v), nil
	default:
		return nil, fmt.Errorf("unsupported networkOrChainID type %T", networkOrChainID)
	}
}

// IsCanonicalChannelId reports whether value is a canonical bytes32 channel id
// (`0x` + exactly 64 hex digits). Mixed-case hex is accepted.
func IsCanonicalChannelId(value string) bool {
	return channelIDRe.MatchString(value)
}

// NormalizeChannelId validates canonical bytes32 form and returns lowercase.
// The error message is the stable ErrInvalidChannelId code only — untrusted
// input is never echoed.
func NormalizeChannelId(channelId string) (string, error) {
	if !IsCanonicalChannelId(channelId) {
		return "", errors.New(ErrInvalidChannelId)
	}
	return strings.ToLower(channelId), nil
}

// ChannelIdBindingError binds a claimed channel id to a channel config and network.
// Returns ErrInvalidChannelId or ErrChannelIdMismatch, or "" when the binding is valid.
func ChannelIdBindingError(config ChannelConfig, claimedChannelId string, networkOrChainId interface{}) string {
	if !IsCanonicalChannelId(claimedChannelId) {
		return ErrInvalidChannelId
	}
	computed, err := ComputeChannelId(config, networkOrChainId)
	if err != nil || !strings.EqualFold(computed, claimedChannelId) {
		return ErrChannelIdMismatch
	}
	return ""
}

// GetBatchSettlementEip712Domain returns the EIP-712 domain for the
// batch-settlement contract on the given chain.
func GetBatchSettlementEip712Domain(chainID *big.Int) evm.TypedDataDomain {
	return evm.TypedDataDomain{
		Name:              BatchSettlementDomain.Name,
		Version:           BatchSettlementDomain.Version,
		ChainID:           chainID,
		VerifyingContract: common.HexToAddress(BatchSettlementAddress).Hex(),
	}
}

// hexToBytes32 converts a hex string to a [32]byte array.
func hexToBytes32(value string) ([32]byte, error) {
	var result [32]byte
	value = strings.TrimPrefix(strings.TrimPrefix(value, "0x"), "0X")
	if len(value) > 64 {
		return result, fmt.Errorf("hex string too long for bytes32: %s", value)
	}
	// Left-pad with zeros
	value = strings.Repeat("0", 64-len(value)) + value
	b := common.FromHex("0x" + value)
	copy(result[:], b)
	return result, nil
}

type channelSaltKind int

const (
	channelSaltDefault channelSaltKind = iota
	channelSaltIndex
	channelSaltHex
	channelSaltBigInt
)

// ChannelSalt is a channel discriminator. Prefer a small index; bytes32 hex is
// also supported. The zero value selects the default zero salt.
type ChannelSalt struct {
	kind  channelSaltKind
	index uint64
	hex   string
	big   *big.Int
}

// ChannelSaltIndex returns a salt from a non-negative channel index.
func ChannelSaltIndex(index uint64) ChannelSalt {
	return ChannelSalt{kind: channelSaltIndex, index: index}
}

// ChannelSaltHex returns a salt from a 0x-prefixed hex value (short or bytes32).
func ChannelSaltHex(hex string) ChannelSalt {
	return ChannelSalt{kind: channelSaltHex, hex: hex}
}

// ChannelSaltBigInt returns a salt from a non-negative integer that fits in 32 bytes.
func ChannelSaltBigInt(n *big.Int) ChannelSalt {
	return ChannelSalt{kind: channelSaltBigInt, big: n}
}

// IsDefault reports whether the salt was omitted (default zero bytes32).
func (s ChannelSalt) IsDefault() bool {
	return s.kind == channelSaltDefault
}

// Equal reports whether two salts specify the same discriminator.
func (s ChannelSalt) Equal(o ChannelSalt) bool {
	if s.kind != o.kind {
		return false
	}
	switch s.kind {
	case channelSaltDefault:
		return true
	case channelSaltIndex:
		return s.index == o.index
	case channelSaltHex:
		return s.hex == o.hex
	case channelSaltBigInt:
		if s.big == nil || o.big == nil {
			return s.big == o.big
		}
		return s.big.Cmp(o.big) == 0
	default:
		var never = s.kind
		_ = never
		return false
	}
}

// Normalize left-pads the salt to bytes32.
func (s ChannelSalt) Normalize() (string, error) {
	switch s.kind {
	case channelSaltDefault:
		return padBigToBytes32(big.NewInt(0)), nil
	case channelSaltIndex:
		if s.index > uint64(maxSafeInt) {
			return "", fmt.Errorf("salt must be a non-negative safe integer")
		}
		return padBigToBytes32(new(big.Int).SetUint64(s.index)), nil
	case channelSaltHex:
		return normalizeChannelSaltHex(s.hex)
	case channelSaltBigInt:
		return normalizeChannelSaltBigInt(s.big)
	default:
		var never = s.kind
		_ = never
		return "", fmt.Errorf("invalid channel salt")
	}
}

// ParseChannelSalt normalizes a caller-supplied channel salt string to bytes32.
//
// Accepted forms (whitespace is trimmed):
//   - "" (or the zero bytes32) selects the default zero salt.
//   - "0x…" / "0X…" hex (short or full bytes32).
//   - Decimal channel index ("0", "1", "42", …), must be a non-negative safe integer.
//
// Decimal strings exist so env vars like CHANNEL_SALT=1 pass straight through
// without caller-side parsing.
func ParseChannelSalt(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return padBigToBytes32(big.NewInt(0)), nil
	}
	if strings.HasPrefix(strings.ToLower(s), "0x") {
		return normalizeChannelSaltHex(s)
	}
	if n, err := strconv.ParseUint(s, 10, 64); err == nil {
		if n > uint64(maxSafeInt) {
			return "", fmt.Errorf("salt must be a non-negative safe integer")
		}
		return padBigToBytes32(new(big.Int).SetUint64(n)), nil
	}
	return "", fmt.Errorf("salt must be a 0x-prefixed hex value or decimal channel index")
}

// NormalizeChannelSalt left-pads a channel salt to bytes32. Accepts a
// non-negative safe integer, a *big.Int that fits in 32 bytes, or 0x-hex.
func NormalizeChannelSalt(salt interface{}) (string, error) {
	switch v := salt.(type) {
	case int:
		if v < 0 || int64(v) > maxSafeInt {
			return "", fmt.Errorf("salt must be a non-negative safe integer")
		}
		return padBigToBytes32(big.NewInt(int64(v))), nil
	case int64:
		if v < 0 || v > maxSafeInt {
			return "", fmt.Errorf("salt must be a non-negative safe integer")
		}
		return padBigToBytes32(big.NewInt(v)), nil
	case uint64:
		if v > uint64(maxSafeInt) {
			return "", fmt.Errorf("salt must be a non-negative safe integer")
		}
		return padBigToBytes32(new(big.Int).SetUint64(v)), nil
	case float64:
		return "", fmt.Errorf("salt must be a non-negative safe integer")
	case *big.Int:
		return normalizeChannelSaltBigInt(v)
	case string:
		return normalizeChannelSaltHex(v)
	case ChannelSalt:
		return v.Normalize()
	default:
		return "", fmt.Errorf("salt must be a 0x-prefixed hex value")
	}
}

func normalizeChannelSaltHex(v string) (string, error) {
	if !channelSaltHexRe.MatchString(v) && !strings.HasPrefix(v, "0X") {
		return "", fmt.Errorf("salt must be a 0x-prefixed hex value")
	}
	if strings.HasPrefix(v, "0X") && !channelSaltHexRe.MatchString("0x"+v[2:]) {
		return "", fmt.Errorf("salt must be a 0x-prefixed hex value")
	}
	n, ok := new(big.Int).SetString(strings.TrimPrefix(strings.TrimPrefix(v, "0x"), "0X"), 16)
	if !ok || n.Cmp(maxUint256) >= 0 {
		return "", fmt.Errorf("salt must fit in 32 bytes")
	}
	return padBigToBytes32(n), nil
}

func normalizeChannelSaltBigInt(v *big.Int) (string, error) {
	if v == nil || v.Sign() < 0 || v.Cmp(maxUint256) >= 0 {
		return "", fmt.Errorf("salt must be a non-negative integer that fits in 32 bytes")
	}
	return padBigToBytes32(v), nil
}

func padBigToBytes32(n *big.Int) string {
	return "0x" + fmt.Sprintf("%064x", n)
}

// PackRefundAuthorizerSalt packs ChannelConfig.salt as bytes12(entropy) || bytes20(refundAuthorizer).
func PackRefundAuthorizerSalt(entropy, refundAuthorizer string) (string, error) {
	padded, err := hexToBytes32(entropy)
	if err != nil {
		return "", err
	}
	var entropy12 []byte
	if new(big.Int).SetBytes(padded[:12]).Sign() == 0 {
		low96 := new(big.Int).And(new(big.Int).SetBytes(padded[:]), uint96Mask)
		entropy12 = low96.FillBytes(make([]byte, 12))
	} else {
		entropy12 = padded[:12]
	}
	out := append(append([]byte{}, entropy12...), common.HexToAddress(refundAuthorizer).Bytes()...)
	return "0x" + hex.EncodeToString(out), nil
}

// UnpackRefundAuthorizer reads the refund-authorizer address from a packed salt.
func UnpackRefundAuthorizer(salt string) string {
	padded, err := hexToBytes32(salt)
	if err != nil {
		return common.Address{}.Hex()
	}
	return common.BytesToAddress(padded[12:]).Hex()
}

// VerifyEoaVoucherSignature verifies an EOA voucher via ecrecover, matching
// x402BatchSettlement._processVoucherClaim. It does not need a channel row.
func VerifyEoaVoucherSignature(raw *BatchSettlementVoucherPayload, network string) bool {
	if raw == nil {
		return false
	}
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		return false
	}
	maxClaimable, ok := new(big.Int).SetString(raw.Voucher.MaxClaimableAmount, 10)
	if !ok {
		return false
	}
	hash, err := evm.HashTypedData(
		GetBatchSettlementEip712Domain(chainID),
		VoucherTypes,
		"Voucher",
		map[string]interface{}{
			"channelId":          raw.Voucher.ChannelId,
			"maxClaimableAmount": maxClaimable,
		},
	)
	if err != nil {
		return false
	}
	ok, err = evm.VerifyEOASignature(
		hash, common.FromHex(raw.Voucher.Signature), common.HexToAddress(raw.ChannelConfig.PayerAuthorizer),
	)
	return err == nil && ok
}

// ValidateChannelConfig checks that a ChannelConfig is consistent with the
// claimed channelId and the server's PaymentRequirements. Returns an error
// code, or "" when the config is valid.
func ValidateChannelConfig(config ChannelConfig, channelId string, requirements types.PaymentRequirements) string {
	computed, err := ComputeChannelId(config, requirements.Network)
	if err != nil || !strings.EqualFold(computed, channelId) {
		return ErrChannelIdMismatch
	}
	if common.HexToAddress(config.Receiver) != common.HexToAddress(requirements.PayTo) {
		return ErrReceiverMismatch
	}

	var extra map[string]interface{}
	if requirements.Extra != nil {
		extra = requirements.Extra
	}
	requiredAuthorizer, _ := extra["receiverAuthorizer"].(string)
	if requiredAuthorizer == "" ||
		common.HexToAddress(requiredAuthorizer) == zeroAddress ||
		common.HexToAddress(config.ReceiverAuthorizer) != common.HexToAddress(requiredAuthorizer) {
		return ErrReceiverAuthorizerMismatch
	}

	if common.HexToAddress(config.Token) != common.HexToAddress(requirements.Asset) {
		return ErrTokenMismatch
	}

	if raw, ok := extra["withdrawDelay"]; ok && raw != nil {
		delay, coerced := ExtraInt(raw)
		if !coerced || config.WithdrawDelay != delay {
			return ErrWithdrawDelayMismatch
		}
	}

	if config.WithdrawDelay < MinWithdrawDelay || config.WithdrawDelay > MaxWithdrawDelay {
		return ErrWithdrawDelayOutOfRange
	}
	return ""
}

// EvaluateVoucherAgainstCachedState accepts or rejects an EOA voucher against
// cached onchain fields when those fields are still fresh. Signature is the
// caller's responsibility. Returns nil to fall back to full verify.
func EvaluateVoucherAgainstCachedState(
	raw *BatchSettlementVoucherPayload,
	requirements types.PaymentRequirements,
	channel *CachedChannelOnchain,
	now int64,
	ttlMs int64,
) *x402.VerifyResponse {
	if raw == nil || channel == nil || !IsOnchainStateFresh(*channel, ttlMs, now) {
		return nil
	}
	if common.HexToAddress(raw.ChannelConfig.PayerAuthorizer) == zeroAddress {
		return nil
	}

	payer := raw.ChannelConfig.Payer
	if configErr := ValidateChannelConfig(raw.ChannelConfig, raw.Voucher.ChannelId, requirements); configErr != "" {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: configErr, Payer: payer}
	}

	if !strings.EqualFold(raw.Voucher.ChannelId, channel.ChannelId) {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrChannelIdMismatch, Payer: payer}
	}

	maxClaimable, ok := new(big.Int).SetString(raw.Voucher.MaxClaimableAmount, 10)
	if !ok {
		return nil
	}
	balance, _ := new(big.Int).SetString(channel.Balance, 10)
	if balance == nil {
		balance = big.NewInt(0)
	}
	if maxClaimable.Cmp(balance) > 0 {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrCumulativeExceedsBalance, Payer: payer}
	}
	totalClaimed, _ := new(big.Int).SetString(channel.TotalClaimed, 10)
	if totalClaimed == nil {
		totalClaimed = big.NewInt(0)
	}
	if maxClaimable.Cmp(totalClaimed) <= 0 {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrCumulativeBelowClaimed, Payer: payer}
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   payer,
		Extra: map[string]interface{}{
			"channelId":           raw.Voucher.ChannelId,
			"balance":             channel.Balance,
			"totalClaimed":        channel.TotalClaimed,
			"withdrawRequestedAt": channel.WithdrawRequestedAt,
			"refundNonce":         fmt.Sprintf("%d", channel.RefundNonce),
		},
	}
}

// IsOnchainStateFresh reports whether cached onchain fields are still within ttlMs.
// ttlMs <= 0 disables the cache. OnchainSyncedAt == 0 means the row was never synced.
func IsOnchainStateFresh(channel CachedChannelOnchain, ttlMs int64, now int64) bool {
	if ttlMs <= 0 {
		return false
	}
	return channel.OnchainSyncedAt != 0 && now-channel.OnchainSyncedAt <= ttlMs
}
