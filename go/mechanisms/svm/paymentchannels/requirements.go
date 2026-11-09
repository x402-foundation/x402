package paymentchannels

import (
	"errors"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	extraTokenProgram = "tokenProgram"
	extraMemo         = "memo"
)

// ParseTokenProgramHint reads extra.tokenProgram. An absent hint is unset so
// the caller can fall back. A present hint that is not a supported program errors.
func ParseTokenProgramHint(extra map[string]interface{}) (solana.PublicKey, bool, error) {
	raw, present := extra[extraTokenProgram]
	if !present || raw == nil || raw == "" {
		return solana.PublicKey{}, false, nil
	}
	hint, ok := raw.(string)
	if !ok {
		return solana.PublicKey{}, true, fmt.Errorf("tokenProgram %v is not a valid base58 address", raw)
	}
	tokenProgram, err := solana.PublicKeyFromBase58(hint)
	if err != nil {
		return solana.PublicKey{}, true, fmt.Errorf("tokenProgram %s is not a valid base58 address", hint)
	}
	if tokenProgram != solana.TokenProgramID && tokenProgram != solana.Token2022ProgramID {
		return solana.PublicKey{}, true, fmt.Errorf("tokenProgram %s is not a supported SPL token program", tokenProgram)
	}
	return tokenProgram, true, nil
}

// ResolveTokenProgram returns the hinted token program, or the stablecoin
// registry when the hint is absent.
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

// ResolveUptoSvmMemo reads the seller memo from extra.memo. Empty and
// non-string values are unset, so both roles agree on whether a memo was requested.
func ResolveUptoSvmMemo(extra map[string]interface{}) *string {
	memo, ok := extra[extraMemo].(string)
	if !ok || memo == "" {
		return nil
	}
	return &memo
}

// RequireTokenProgramHint is ParseTokenProgramHint with every missing or
// rejected hint returned as invalid. Batch requires the hint; upto treats a
// missing hint as unset.
func RequireTokenProgramHint(extra map[string]interface{}, invalid string) (solana.PublicKey, error) {
	hinted, present, err := ParseTokenProgramHint(extra)
	if err != nil || !present {
		return solana.PublicKey{}, errors.New(invalid)
	}
	return hinted, nil
}
