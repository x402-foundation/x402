package svm

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/types"
)

// Multi-payee split reason codes (scheme_exact_svm.md §5). They live here,
// rather than only in exact/facilitator, so the client and server can report
// them without importing the facilitator. exact/facilitator/errors.go
// re-exports them; the strings match the TypeScript SDK character for
// character.
const (
	ErrSplitsInvalid                 = "invalid_exact_svm_splits_invalid"
	ErrSplitCountExceeded            = "split_count_exceeded"
	ErrSplitAtaCreationNotAuthorized = "split_ata_creation_not_authorized"
	ErrSplitRemainderNotPositive     = "split_remainder_not_positive"
	ErrSplitLegUnmatched             = "split_leg_unmatched"
	ErrSplitUnexpectedTransfer       = "split_unexpected_transfer"
	ErrSplitAuthorityMismatch        = "invalid_exact_svm_payload_split_authority_mismatch"
)

const ixCreateIdempotent = 1

var canonicalAmount = regexp.MustCompile(`^[1-9][0-9]*$`)

// SplitsError is a split rule violation carrying the reason code a
// facilitator reports.
type SplitsError struct {
	Reason  string
	Message string
}

// Error returns "reason: message", or the bare reason when there is no detail.
func (e *SplitsError) Error() string {
	if e.Message == "" {
		return e.Reason
	}
	return e.Reason + ": " + e.Message
}

func splitsErr(reason, format string, args ...interface{}) *SplitsError {
	return &SplitsError{Reason: reason, Message: fmt.Sprintf(format, args...)}
}

// PaymentLeg is one payment leg: the primary remainder to payTo, or one split.
type PaymentLeg struct {
	Owner  solana.PublicKey
	Amount uint64
	// IsPrimary marks the remainder to payTo. The primary leg tolerates
	// overpayment off the static path; split legs never do.
	IsPrimary           bool
	AtaCreationRequired bool
	// Memo is the split's label (§5.1); empty for the primary leg or when absent.
	Memo string
}

// UsesSplitTerms reports whether the requirements use the splits extension,
// through a non-empty extra.splits or a primary marked extra.ataCreationRequired.
func UsesSplitTerms(requirements types.PaymentRequirements) bool {
	if requirements.Extra == nil {
		return false
	}
	if splits, ok := requirements.Extra["splits"]; ok && splits != nil {
		if !isEmptyArray(splits) {
			return true
		}
	}
	required, ok := requirements.Extra["ataCreationRequired"].(bool)
	return ok && required
}

func isEmptyArray(value interface{}) bool {
	switch v := value.(type) {
	case []interface{}:
		return len(v) == 0
	case []map[string]interface{}:
		return len(v) == 0
	}
	normalized, err := normalizeJSON(value)
	if err != nil {
		return false
	}
	arr, ok := normalized.([]interface{})
	return ok && len(arr) == 0
}

// normalizeJSON converts a Go value (for example a typed slice set in code)
// into its generic JSON form so it can be validated like a decoded request.
func normalizeJSON(value interface{}) (interface{}, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func parseSplitAmount(value interface{}, field string) (uint64, error) {
	s, ok := value.(string)
	if !ok || !canonicalAmount.MatchString(s) {
		return 0, splitsErr(ErrSplitsInvalid, "%s must be a positive integer string", field)
	}
	amount, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, splitsErr(ErrSplitsInvalid, "%s exceeds u64", field)
	}
	return amount, nil
}

// ParsePaymentLegs validates extra.splits and extra.ataCreationRequired
// (§5.1, §5.2) and returns the payment legs: the primary remainder first, then
// one leg per split in order. Errors are *SplitsError.
func ParsePaymentLegs(requirements types.PaymentRequirements) ([]PaymentLeg, error) {
	extra := requirements.Extra
	if extra == nil {
		extra = map[string]interface{}{}
	}

	var rawSplits []interface{}
	if value, ok := extra["splits"]; ok && value != nil {
		switch v := value.(type) {
		case []interface{}:
			rawSplits = v
		default:
			normalized, err := normalizeJSON(value)
			arr, isArr := normalized.([]interface{})
			if err != nil || !isArr {
				return nil, splitsErr(ErrSplitsInvalid, "extra.splits must be an array")
			}
			rawSplits = arr
		}
	}
	if len(rawSplits) > MaxSplits {
		return nil, splitsErr(ErrSplitsInvalid, "extra.splits allows at most %d", MaxSplits)
	}
	primaryAtaRequired := false
	if value, ok := extra["ataCreationRequired"]; ok {
		b, isBool := value.(bool)
		if !isBool {
			return nil, splitsErr(ErrSplitsInvalid, "extra.ataCreationRequired must be a boolean")
		}
		primaryAtaRequired = b
	}

	total, err := parseSplitAmount(requirements.Amount, "amount")
	if err != nil {
		return nil, err
	}
	primary, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return nil, splitsErr(ErrSplitsInvalid, "payTo is not a valid address")
	}

	seen := map[solana.PublicKey]struct{}{primary: {}}
	splitLegs := make([]PaymentLeg, 0, len(rawSplits))
	var splitTotal uint64
	for i, raw := range rawSplits {
		field := fmt.Sprintf("extra.splits[%d]", i)
		split, ok := raw.(map[string]interface{})
		if !ok || split == nil {
			return nil, splitsErr(ErrSplitsInvalid, "%s must be an object", field)
		}
		payToStr, ok := split["payTo"].(string)
		if !ok || !ValidateSolanaAddress(payToStr) {
			return nil, splitsErr(ErrSplitsInvalid, "%s.payTo is not a valid address", field)
		}
		payTo := solana.MustPublicKeyFromBase58(payToStr)
		if _, dup := seen[payTo]; dup {
			return nil, splitsErr(ErrSplitsInvalid, "%s.payTo duplicates another recipient", field)
		}
		seen[payTo] = struct{}{}
		amount, err := parseSplitAmount(split["amount"], field+".amount")
		if err != nil {
			return nil, err
		}
		memo := ""
		if value, present := split["memo"]; present {
			s, isString := value.(string)
			if !isString {
				return nil, splitsErr(ErrSplitsInvalid, "%s.memo must be a string", field)
			}
			if len(s) > MaxSplitMemoBytes {
				return nil, splitsErr(ErrSplitsInvalid, "%s.memo exceeds %d bytes", field, MaxSplitMemoBytes)
			}
			memo = s
		}
		ataRequired := false
		if value, present := split["ataCreationRequired"]; present {
			b, isBool := value.(bool)
			if !isBool {
				return nil, splitsErr(ErrSplitsInvalid, "%s.ataCreationRequired must be a boolean", field)
			}
			ataRequired = b
		}
		// Saturate: a sum past u64 is already >= total.
		if splitTotal > math.MaxUint64-amount {
			splitTotal = math.MaxUint64
		} else {
			splitTotal += amount
		}
		splitLegs = append(splitLegs, PaymentLeg{
			Owner:               payTo,
			Amount:              amount,
			AtaCreationRequired: ataRequired,
			Memo:                memo,
		})
	}

	if splitTotal >= total {
		return nil, &SplitsError{Reason: ErrSplitRemainderNotPositive}
	}

	return append([]PaymentLeg{{
		Owner:               primary,
		Amount:              total - splitTotal,
		IsPrimary:           true,
		AtaCreationRequired: primaryAtaRequired,
	}}, splitLegs...), nil
}

// SplitCapabilities are the split capabilities a facilitator advertises in
// its /supported kinds[].extra. Both fail closed: absent means no support (§5.5).
type SplitCapabilities struct {
	MaxSplits            int
	AtaCreationSponsored bool
}

// GetSplitCapabilities reads the split capabilities from a /supported kind's
// extra. A non-integer or absent maxSplits reads as 0, and anything other than
// a literal true ataCreationSponsored reads as false.
func GetSplitCapabilities(extra map[string]interface{}) SplitCapabilities {
	caps := SplitCapabilities{}
	if extra == nil {
		return caps
	}
	if n, ok := integerValue(extra["maxSplits"]); ok && n > 0 {
		if n > MaxSplits {
			n = MaxSplits
		}
		caps.MaxSplits = int(n)
	}
	sponsored, ok := extra["ataCreationSponsored"].(bool)
	caps.AtaCreationSponsored = ok && sponsored
	return caps
}

func integerValue(value interface{}) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int8:
		return int64(v), true
	case int16:
		return int64(v), true
	case int32:
		return int64(v), true
	case int64:
		return v, true
	case uint:
		if uint64(v) > math.MaxInt64 {
			return math.MaxInt64, true
		}
		return int64(v), true
	case uint8:
		return int64(v), true
	case uint16:
		return int64(v), true
	case uint32:
		return int64(v), true
	case uint64:
		if v > math.MaxInt64 {
			return math.MaxInt64, true
		}
		return int64(v), true
	case float32:
		return floatInteger(float64(v))
	case float64:
		return floatInteger(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return n, true
		}
		if f, err := v.Float64(); err == nil {
			return floatInteger(f)
		}
	}
	return 0, false
}

func floatInteger(f float64) (int64, bool) {
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, false
	}
	if f >= math.MaxInt64 {
		return math.MaxInt64, true
	}
	if f <= math.MinInt64 {
		return math.MinInt64, true
	}
	return int64(f), true
}

// AssertWithinCapabilities checks parsed legs against advertised capabilities.
// Errors are *SplitsError.
func AssertWithinCapabilities(legs []PaymentLeg, caps SplitCapabilities) error {
	splitCount := len(legs) - 1
	if splitCount > caps.MaxSplits {
		return splitsErr(ErrSplitCountExceeded, "%d splits, facilitator accepts %d", splitCount, caps.MaxSplits)
	}
	if !caps.AtaCreationSponsored {
		for _, leg := range legs {
			if leg.AtaCreationRequired {
				return splitsErr(ErrSplitAtaCreationNotAuthorized,
					"a recipient is marked ataCreationRequired but the facilitator does not sponsor ATA creation")
			}
		}
	}
	return nil
}

// DeriveATA derives an owner's associated token account for a mint under one
// token program.
func DeriveATA(owner, mint, tokenProgram solana.PublicKey) (solana.PublicKey, error) {
	ata, _, err := solana.FindProgramAddress(
		[][]byte{owner.Bytes(), tokenProgram.Bytes(), mint.Bytes()},
		solana.SPLAssociatedTokenAccountProgramID,
	)
	return ata, err
}

// IsSplTokenProgram reports whether a program is SPL Token or Token-2022.
func IsSplTokenProgram(program solana.PublicKey) bool {
	return program.Equals(solana.TokenProgramID) || program.Equals(solana.Token2022ProgramID)
}

// NewCreateIdempotentInstruction builds an AssociatedTokenProgram
// CreateIdempotent funded by payer.
func NewCreateIdempotentInstruction(payer, ata, owner, mint, tokenProgram solana.PublicKey) solana.Instruction {
	return solana.NewInstruction(
		solana.SPLAssociatedTokenAccountProgramID,
		solana.AccountMetaSlice{
			solana.NewAccountMeta(payer, true, true),
			solana.NewAccountMeta(ata, true, false),
			solana.NewAccountMeta(owner, false, false),
			solana.NewAccountMeta(mint, false, false),
			solana.NewAccountMeta(solana.SystemProgramID, false, false),
			solana.NewAccountMeta(tokenProgram, false, false),
		},
		[]byte{ixCreateIdempotent},
	)
}

// AtaCreationContext is the context ValidateAtaCreation checks an
// ATA-program instruction against.
type AtaCreationContext struct {
	Asset    solana.PublicKey
	FeePayer solana.PublicKey
	// MarkedOwners are the leg owners marked ataCreationRequired.
	MarkedOwners map[solana.PublicKey]struct{}
	// CreatedOwners collects the owners already created in this transaction;
	// ValidateAtaCreation adds to it.
	CreatedOwners map[solana.PublicKey]struct{}
	// TokenProgram is the token program the transfers use, when known.
	TokenProgram *solana.PublicKey
}

// ValidateAtaCreation validates an ATA-program instruction against §5.4 and
// §2.1.1: it must be a CreateIdempotent funded by the fee payer that creates
// the ATA, for the asset, of a recipient marked ataCreationRequired, at most
// once per owner. accounts are the instruction's resolved account keys.
// Errors are *SplitsError with ErrSplitAtaCreationNotAuthorized.
func ValidateAtaCreation(accounts []solana.PublicKey, data []byte, ctx *AtaCreationContext) (solana.PublicKey, solana.PublicKey, error) {
	reject := func(format string, args ...interface{}) (solana.PublicKey, solana.PublicKey, error) {
		return solana.PublicKey{}, solana.PublicKey{}, splitsErr(ErrSplitAtaCreationNotAuthorized, format, args...)
	}
	if len(data) != 1 || data[0] != ixCreateIdempotent {
		return reject("ATA program instruction is not CreateIdempotent")
	}
	if len(accounts) != 6 {
		return reject("CreateIdempotent must have exactly 6 accounts")
	}
	payer, ata, owner, mint, systemProgram, tokenProgram := accounts[0], accounts[1], accounts[2], accounts[3], accounts[4], accounts[5]
	if !payer.Equals(ctx.FeePayer) {
		return reject("CreateIdempotent must be funded by the fee payer")
	}
	if _, ok := ctx.MarkedOwners[owner]; !ok {
		return reject("owner %s is not a recipient marked ataCreationRequired", owner)
	}
	if _, dup := ctx.CreatedOwners[owner]; dup {
		return reject("duplicate CreateIdempotent for owner %s", owner)
	}
	if !mint.Equals(ctx.Asset) {
		return reject("CreateIdempotent mint does not match asset")
	}
	if !systemProgram.Equals(solana.SystemProgramID) || !IsSplTokenProgram(tokenProgram) {
		return reject("CreateIdempotent has unexpected program accounts")
	}
	if ctx.TokenProgram != nil && !tokenProgram.Equals(*ctx.TokenProgram) {
		return reject("CreateIdempotent token program differs from the transfers'")
	}
	expected, err := DeriveATA(owner, ctx.Asset, tokenProgram)
	if err != nil || !ata.Equals(expected) {
		return reject("CreateIdempotent account is not the owner's ATA")
	}
	if ctx.CreatedOwners != nil {
		ctx.CreatedOwners[owner] = struct{}{}
	}
	return owner, tokenProgram, nil
}
