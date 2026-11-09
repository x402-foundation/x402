package svm

import (
	"encoding/base64"
	"fmt"
	"math"
	"math/big"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
)

const (
	// DefaultLoadedAccountsDataSizeLimit is the loadedAccountsDataSizeLimit a
	// version-1 transaction built by this SDK requests (4 MiB). The runtime
	// charges the program-data account of every invoked upgradeable program
	// against this budget, and mainnet Token-2022 program data alone is
	// ~1.32 MiB.
	DefaultLoadedAccountsDataSizeLimit uint32 = 4_194_304

	// MaxTransactionSizeLegacy is the serialized size limit of a legacy or
	// version-0 transaction.
	MaxTransactionSizeLegacy = 1232

	// MaxTransactionSizeV1 is the serialized size limit of a version-1
	// transaction (SIMD-0385).
	MaxTransactionSizeV1 = solana.MaxTransactionSizeV1
)

// MaxTransactionSize returns the serialized size limit for a message version.
func MaxTransactionSize(version solana.MessageVersion) int {
	if version == solana.MessageVersionV1 {
		return MaxTransactionSizeV1
	}
	return MaxTransactionSizeLegacy
}

// TransactionSizeExceeded reports whether a base64 wire transaction exceeds
// the serialized size limit of its message version (legacy is policed as
// version 0). Verifiers call it after the version gate: the decoder accepts an
// oversized transaction, but the network would drop it after the sponsor
// co-signed it. It returns the size and the limit.
func TransactionSizeExceeded(base64Tx string, version solana.MessageVersion) (int, int, bool) {
	size := base64.StdEncoding.DecodedLen(len(base64Tx))
	if raw, err := base64.StdEncoding.DecodeString(base64Tx); err == nil {
		size = len(raw)
	}
	limit := MaxTransactionSize(version)
	return size, limit, size > limit
}

// PeekWireTransactionVersion reads a wire transaction's message version from
// its raw bytes, without trusting the SDK decoder. Legacy and version-0
// transactions start with the compact-u16 signature count (below 0x80 within
// the size limit), then the signatures, then the message whose first byte
// carries the version prefix when its high bit is set. Version 1 puts the
// message first, so its first byte is the version byte itself (0x81).
//
// It returns the wire version (0, 1, ...) or -1 for legacy, and false when the
// bytes are too short to tell.
func PeekWireTransactionVersion(base64Tx string) (int, bool) {
	raw, err := base64.StdEncoding.DecodeString(base64Tx)
	if err != nil || len(raw) == 0 {
		return 0, false
	}
	if raw[0]&0x80 != 0 {
		return int(raw[0] & 0x7f), true
	}
	prefixOffset := 1 + 64*int(raw[0])
	if prefixOffset >= len(raw) {
		return 0, false
	}
	prefix := raw[prefixOffset]
	if prefix&0x80 != 0 {
		return int(prefix & 0x7f), true
	}
	return -1, true
}

// IsAcceptedWireTransactionVersion reports whether a version returned by
// PeekWireTransactionVersion is one the SVM verifiers accept.
func IsAcceptedWireTransactionVersion(version int) bool {
	return version == -1 || version == 0 || version == 1
}

// IsAcceptedWireTransactionVersionIn reports whether a wire version (-1 for
// legacy) is in a facilitator's accepted set of 0 and/or 1. A legacy message
// is policed as version 0: it is accepted exactly when version 0 is. A nil or
// empty set means AdvertisedTransactionVersions.
func IsAcceptedWireTransactionVersionIn(version int, accepted []int) bool {
	if !IsAcceptedWireTransactionVersion(version) {
		return false
	}
	if len(accepted) == 0 {
		accepted = AdvertisedTransactionVersions
	}
	if version == -1 {
		version = 0
	}
	for _, candidate := range accepted {
		if candidate == version {
			return true
		}
	}
	return false
}

// IsAcceptedTransactionVersionIn is IsAcceptedWireTransactionVersionIn for a
// decoded message version.
func IsAcceptedTransactionVersionIn(version solana.MessageVersion, accepted []int) bool {
	return IsAcceptedTransactionVersion(version) &&
		IsAcceptedWireTransactionVersionIn(WireTransactionVersion(version), accepted)
}

// NormalizeAcceptedTransactionVersions validates a facilitator's
// TransactionVersions option: the message versions it accepts and advertises
// as extra.transactionVersions. A nil slice means AdvertisedTransactionVersions;
// otherwise it must be a non-empty list of 0 and/or 1, returned deduplicated
// and ascending.
func NormalizeAcceptedTransactionVersions(versions []int) ([]int, error) {
	if versions == nil {
		return append([]int(nil), AdvertisedTransactionVersions...), nil
	}
	seen := [2]bool{}
	for _, version := range versions {
		if version != 0 && version != 1 {
			return nil, fmt.Errorf("transactionVersions must be a non-empty list of 0 and/or 1 (got %v)", versions)
		}
		seen[version] = true
	}
	normalized := make([]int, 0, 2)
	for version, present := range seen {
		if present {
			normalized = append(normalized, version)
		}
	}
	if len(normalized) == 0 {
		return nil, fmt.Errorf("transactionVersions must be a non-empty list of 0 and/or 1 (got %v)", versions)
	}
	return normalized, nil
}

// PriorityFeeLamports converts a compute-unit price into the total priority
// fee a version-1 transaction carries: ceil(microLamports * units / 1e6).
func PriorityFeeLamports(computeUnitLimit uint32, microLamports uint64) (uint64, error) {
	whole := microLamports / 1_000_000
	if computeUnitLimit > 0 && whole > math.MaxUint64/uint64(computeUnitLimit) {
		return 0, fmt.Errorf("priority fee overflows uint64")
	}
	fee := whole * uint64(computeUnitLimit)
	remainder := microLamports % 1_000_000
	fraction := (remainder*uint64(computeUnitLimit) + 999_999) / 1_000_000
	if fee > math.MaxUint64-fraction {
		return 0, fmt.Errorf("priority fee overflows uint64")
	}
	return fee + fraction, nil
}

// TransactionV1ConfigFor builds the inline compute budget of a client-built
// version-1 transaction: the compute-unit limit, the default loaded-account
// data budget, and the priority fee equivalent to priceMicroLamports per
// compute unit (omitted when zero).
func TransactionV1ConfigFor(computeUnitLimit uint32, priceMicroLamports uint64) (solana.TransactionConfig, error) {
	if computeUnitLimit == 0 {
		return solana.TransactionConfig{}, fmt.Errorf("a version-1 transaction must set computeUnitLimit")
	}
	config := solana.TransactionConfig{}.
		WithComputeUnitLimit(computeUnitLimit).
		WithLoadedAccountsDataSizeLimit(DefaultLoadedAccountsDataSizeLimit)
	if priceMicroLamports == 0 {
		return config, nil
	}
	fee, err := PriorityFeeLamports(computeUnitLimit, priceMicroLamports)
	if err != nil {
		return solana.TransactionConfig{}, err
	}
	if fee == 0 {
		return config, nil
	}
	return config.WithPriorityFee(fee), nil
}

// BuildClientTransaction builds an unsigned client transaction of the given
// message version. Version 0 prepends SetComputeUnitLimit and
// SetComputeUnitPrice (each omitted when zero); version 1 carries the same
// budget in its TransactionConfig and contains no ComputeBudget instruction.
func BuildClientTransaction(
	version solana.MessageVersion,
	feePayer solana.PublicKey,
	blockhash solana.Hash,
	instructions []solana.Instruction,
	computeUnitLimit uint32,
	priceMicroLamports uint64,
) (*solana.Transaction, error) {
	switch version {
	case solana.MessageVersionV1:
		config, err := TransactionV1ConfigFor(computeUnitLimit, priceMicroLamports)
		if err != nil {
			return nil, err
		}
		return solana.NewTransaction(
			instructions,
			blockhash,
			solana.TransactionPayer(feePayer),
			solana.TransactionV1Config(config),
		)
	case solana.MessageVersionV0:
		var budget []solana.Instruction
		if computeUnitLimit > 0 {
			limitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
				SetUnits(computeUnitLimit).
				ValidateAndBuild()
			if err != nil {
				return nil, fmt.Errorf("failed to build compute limit instruction: %w", err)
			}
			budget = append(budget, limitIx)
		}
		if priceMicroLamports > 0 {
			priceIx, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
				SetMicroLamports(priceMicroLamports).
				ValidateAndBuild()
			if err != nil {
				return nil, fmt.Errorf("failed to build compute price instruction: %w", err)
			}
			budget = append(budget, priceIx)
		}
		return solana.NewTransaction(
			append(budget, instructions...),
			blockhash,
			solana.TransactionPayer(feePayer),
			solana.TransactionMessageVersion(solana.MessageVersionV0),
		)
	default:
		return nil, fmt.Errorf("%s: clients build only transaction versions 0 and 1", ErrUnsupportedTransactionVersion)
	}
}

// TransactionV1ConfigViolation names the first sponsorship rule a version-1
// message config breaks. Each verifier maps it to its own reason code.
type TransactionV1ConfigViolation int

const (
	// TransactionV1ConfigOK means the config satisfies every rule.
	TransactionV1ConfigOK TransactionV1ConfigViolation = iota
	// TransactionV1ComputeBudgetInstruction means a top-level ComputeBudget
	// instruction is present. The runtime ignores it in v1; the x402 sponsor
	// rule rejects it.
	TransactionV1ComputeBudgetInstruction
	// TransactionV1HeapSize means the heap-size bit is set (parity with v0,
	// where RequestHeapFrame is rejected).
	TransactionV1HeapSize
	// TransactionV1ComputeUnitLimitMissing means bit 2 is unset.
	TransactionV1ComputeUnitLimitMissing
	// TransactionV1ComputeUnitLimitTooHigh means computeUnitLimit exceeds the cap.
	TransactionV1ComputeUnitLimitTooHigh
	// TransactionV1LoadedAccountsDataSizeLimitMissing means bit 3 is unset.
	TransactionV1LoadedAccountsDataSizeLimitMissing
	// TransactionV1PriorityFeeTooHigh means priorityFee exceeds cap * computeUnitLimit.
	TransactionV1PriorityFeeTooHigh
)

func (v TransactionV1ConfigViolation) String() string {
	switch v {
	case TransactionV1ConfigOK:
		return "ok"
	case TransactionV1ComputeBudgetInstruction:
		return "version-1 transactions must not contain ComputeBudget instructions"
	case TransactionV1HeapSize:
		return "version-1 heap size request is not permitted"
	case TransactionV1ComputeUnitLimitMissing:
		return "version-1 computeUnitLimit must be set"
	case TransactionV1ComputeUnitLimitTooHigh:
		return "version-1 computeUnitLimit exceeds the sponsor cap"
	case TransactionV1LoadedAccountsDataSizeLimitMissing:
		return "version-1 loadedAccountsDataSizeLimit must be set"
	case TransactionV1PriorityFeeTooHigh:
		return "version-1 priorityFee exceeds the sponsor compute unit price cap"
	default:
		return fmt.Sprintf("unknown version-1 config violation %d", int(v))
	}
}

// ValidateTransactionV1Config checks a version-1 message's inline compute
// budget against a sponsor's caps: no top-level ComputeBudget instruction, no
// heap-size request, computeUnitLimit set and at most maxComputeUnits,
// loadedAccountsDataSizeLimit set, and
// priorityFee * 1_000_000 <= maxPriceMicroLamports * computeUnitLimit,
// evaluated with arbitrary precision so an oversized fee cannot wrap.
// The decoder already rejects a mask with only one priority-fee bit set.
func ValidateTransactionV1Config(message *solana.Message, maxComputeUnits uint32, maxPriceMicroLamports uint64) TransactionV1ConfigViolation {
	for _, ix := range message.Instructions {
		program, err := message.Program(ix.ProgramIDIndex)
		if err == nil && program.Equals(solana.ComputeBudget) {
			return TransactionV1ComputeBudgetInstruction
		}
	}
	config := message.TransactionConfig
	if config.HeapSize != nil {
		return TransactionV1HeapSize
	}
	if config.ComputeUnitLimit == nil {
		return TransactionV1ComputeUnitLimitMissing
	}
	units := *config.ComputeUnitLimit
	if units > maxComputeUnits {
		return TransactionV1ComputeUnitLimitTooHigh
	}
	if config.LoadedAccountsDataSizeLimit == nil {
		return TransactionV1LoadedAccountsDataSizeLimitMissing
	}
	if config.PriorityFee != nil {
		fee := new(big.Int).Mul(new(big.Int).SetUint64(*config.PriorityFee), big.NewInt(1_000_000))
		limit := new(big.Int).Mul(new(big.Int).SetUint64(maxPriceMicroLamports), new(big.Int).SetUint64(uint64(units)))
		if fee.Cmp(limit) > 0 {
			return TransactionV1PriorityFeeTooHigh
		}
	}
	return TransactionV1ConfigOK
}
