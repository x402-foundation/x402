// Package upto holds the fields shared by the SVM `upto` client, server, and
// facilitator roles: the payment-channel configuration derived from the x402
// payment requirements.
package upto

import (
	"errors"
	"fmt"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Commitment policy for SVM `upto`. Both SDKs read each class at the same level,
// so a Go and a TypeScript facilitator judge the same channel identically.
const (
	// StateCommitment reads account state the caller must act on. Opens are
	// confirmed at this level, and the RPC default (`finalized`) lags a fresh
	// open by seconds, reporting a live channel as missing.
	StateCommitment = rpc.CommitmentConfirmed

	// SlotCommitment reads the slot used as an `openSlot` anchor. Clients pin
	// `openSlot` at this level to keep `openSlot <= clock.slot` when the open
	// lands, so verify and the reclaim gate must judge it in the same frame.
	SlotCommitment = rpc.CommitmentFinalized

	// BlockhashCommitment reads transaction-lifetime blockhashes. A finalized
	// hash cannot be dropped by a fork before the transaction lands.
	BlockhashCommitment = rpc.CommitmentFinalized
)

// Extra field names carried in PaymentRequirements.Extra for SVM `upto`.
const (
	ExtraFeePayer             = "feePayer"
	ExtraReceiverAuthorizer   = "receiverAuthorizer"
	ExtraWithdrawDelay        = "withdrawDelay"
	ExtraTokenProgram         = "tokenProgram"
	ExtraMemo                 = "memo"
	ExtraValidAfter           = "validAfter"
	ExtraRecentBlockhash      = "recentBlockhash"
	ExtraLastValidBlockHeight = "lastValidBlockHeight"
	ExtraRecentSlot           = "recentSlot"
)

// PaymentChannelConfig holds the payment-channel fields resolved from SVM
// `upto` payment requirements.
type PaymentChannelConfig struct {
	// FeePayer is the transaction fee payer, channel rent payer, and zero-share channel payee.
	FeePayer string
	// ReceiverAuthorizer is the server hot key authorized to sign vouchers.
	ReceiverAuthorizer string
	// WithdrawDelay is the forced-close grace period in seconds.
	WithdrawDelay uint32
	// Splits are the distribution recipients sealed into open and replayed at distribute.
	Splits []paymentchannels.Split
}

// ResolvePaymentChannelConfig resolves and validates the SVM `upto`
// payment-channel fields from the payment requirements.
//
// The payee seat is held by the facilitator (feePayer) with a zero implicit
// remainder, so the distribution must always assign 100% to payTo explicitly.
func ResolvePaymentChannelConfig(requirements types.PaymentRequirements) (*PaymentChannelConfig, error) {
	feePayer, ok := requirements.Extra[ExtraFeePayer].(string)
	if !ok || feePayer == "" {
		return nil, errors.New("feePayer must be a non-empty string")
	}

	receiverAuthorizer, ok := requirements.Extra[ExtraReceiverAuthorizer].(string)
	if !ok || receiverAuthorizer == "" {
		return nil, errors.New("receiverAuthorizer must be a non-empty string")
	}

	withdrawDelay, err := ParseWithdrawDelay(requirements.Extra[ExtraWithdrawDelay])
	if err != nil {
		return nil, err
	}

	return &PaymentChannelConfig{
		FeePayer:           feePayer,
		ReceiverAuthorizer: receiverAuthorizer,
		WithdrawDelay:      withdrawDelay,
		Splits: []paymentchannels.Split{
			{Recipient: requirements.PayTo, BPS: paymentchannels.BasisPointsDenominator},
		},
	}, nil
}

// NewRPCClient dials the configured endpoint, falling back to the network's
// default when no override is set.
func NewRPCClient(network, rpcURL string) (*rpc.Client, error) {
	if rpcURL != "" {
		return rpc.New(rpcURL), nil
	}
	config, err := svm.GetNetworkConfig(network)
	if err != nil {
		return nil, err
	}
	return rpc.New(config.RPCURL), nil
}

// ParseTokenProgramHint reads and validates `extra.tokenProgram`. The second
// return value reports whether the challenge carried a hint at all, letting
// callers pick their own fallback.
//
// A present-but-non-string value is a broken challenge and errors, rather
// than being silently treated as absent and masking the malformed input.
func ParseTokenProgramHint(extra map[string]interface{}) (solana.PublicKey, bool, error) {
	raw, present := extra[ExtraTokenProgram]
	if !present || raw == nil || raw == "" {
		return solana.PublicKey{}, false, nil
	}
	hint, ok := raw.(string)
	if !ok {
		return solana.PublicKey{}, true, fmt.Errorf("tokenProgram %v is not a valid base58 address", raw)
	}

	tokenProgram, err := solana.PublicKeyFromBase58(hint)
	if err != nil {
		return solana.PublicKey{}, true, fmt.Errorf("tokenProgram is not a valid base58 address: %w", err)
	}
	if tokenProgram != solana.TokenProgramID && tokenProgram != solana.Token2022ProgramID {
		return solana.PublicKey{}, true, fmt.Errorf("tokenProgram %s is not a supported SPL token program", tokenProgram)
	}
	return tokenProgram, true, nil
}

// ResolveTokenProgram resolves the SPL token program owning the requirement's
// mint. The challenge hint wins; otherwise the registry answers, so a Token-2022
// stablecoin is not mistaken for a legacy SPL Token one.
func ResolveTokenProgram(requirements types.PaymentRequirements) (solana.PublicKey, error) {
	tokenProgram, hinted, err := ParseTokenProgramHint(requirements.Extra)
	if err != nil {
		return solana.PublicKey{}, err
	}
	if hinted {
		return tokenProgram, nil
	}

	registered := svm.GetStablecoinTokenProgram(requirements.Asset, string(requirements.Network))
	return solana.PublicKeyFromBase58(registered)
}

// ParseWithdrawDelay reads the grace period from an extra value. JSON numbers
// decode as float64, so integer-valued floats are accepted and fractional or
// non-positive values are rejected.
func ParseWithdrawDelay(value interface{}) (uint32, error) {
	invalid := errors.New("withdrawDelay must be an integer greater than zero")

	var seconds float64
	switch typed := value.(type) {
	case float64:
		seconds = typed
	case int:
		seconds = float64(typed)
	case int64:
		seconds = float64(typed)
	case uint32:
		seconds = float64(typed)
	default:
		return 0, invalid
	}

	if seconds <= 0 || seconds != float64(uint32(seconds)) {
		return 0, invalid
	}
	return uint32(seconds), nil
}

// ParseExtraMemo reads the optional seller memo (extra.memo). A non-empty
// string is a requirement: the client emits exactly that memo and the
// facilitator demands a match. Missing, empty, or non-string is unset, so the
// client falls back to a random nonce and the facilitator does not check it.
// Both roles resolve through here, which keeps them from disagreeing on
// whether a memo was requested.
func ParseExtraMemo(value interface{}) *string {
	memo, ok := value.(string)
	if !ok || memo == "" {
		return nil
	}
	return &memo
}

// ParseExtraUint64 reads an optional decimal u64 hint (recentSlot,
// lastValidBlockHeight) from an extra value. Missing hints return false.
func ParseExtraUint64(value interface{}) (uint64, bool) {
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
