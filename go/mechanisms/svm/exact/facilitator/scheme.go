package facilitator

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
	"sync"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Config is the optional configuration of the SVM exact facilitator.
type Config struct {
	SettlementCache                        *svm.SettlementCache
	EnableSmartWalletVerification          bool
	SmartWalletMaxComputeUnits             *uint32
	SmartWalletMaxPriorityFeeMicroLamports *uint64
	SmartWalletAllowedPrograms             []string
	MaxPriorityFeeMicroLamports            *uint64
	// MaxComputeUnits caps the compute unit limit on the static path, for a
	// version-0 SetComputeUnitLimit and a version-1 header computeUnitLimit
	// alike. Nil uses DefaultMaxComputeUnits (400,000, the reference default
	// of scheme_exact_svm.md §2.2.1); while nil, a smart-wallet transaction
	// above it is judged by Path 2 against SmartWalletMaxComputeUnits instead.
	// Setting it makes it a hard ceiling for both paths.
	MaxComputeUnits *uint32
	// MaxRequiredSignatures caps the required signatures. A payment needs
	// exactly two (client and fee payer) and MUST NOT require another signer
	// (§2.1.4). Nil uses DefaultMaxRequiredSignatures (2). It is checked before
	// path dispatch, so it also bounds smart-wallet transactions: a threshold
	// multisig whose members co-sign the payment transaction needs it raised.
	MaxRequiredSignatures *uint8
	// TransactionVersions is the set of message versions this facilitator
	// accepts and advertises as extra.transactionVersions. Any other version
	// is rejected with unsupported_transaction_version before any instruction
	// is inspected; legacy is accepted exactly when 0 is. Nil means [0, 1].
	TransactionVersions []int
}

// DefaultMaxComputeUnits is the static-path compute unit ceiling when
// Config.MaxComputeUnits is unset (scheme_exact_svm.md §2.2.1 reference default).
const DefaultMaxComputeUnits uint32 = 400_000

// DefaultMaxRequiredSignatures is the required-signature ceiling when
// Config.MaxRequiredSignatures is unset: the client and the fee payer.
const DefaultMaxRequiredSignatures uint8 = 2

// accountInfoReader is the optional signer cap used to explain a failed simulation.
// Exact-only signers omit it, so a missing method keeps the original failure.
type accountInfoReader interface {
	GetAccountInfo(
		ctx context.Context,
		account solana.PublicKey,
		network string,
		opts *rpc.GetAccountInfoOpts,
	) (*rpc.GetAccountInfoResult, error)
}

// ExactSvmScheme implements the SchemeNetworkFacilitator interface for SVM (Solana) exact payments (V2)
type ExactSvmScheme struct {
	signer              svm.FacilitatorSvmSigner
	settlementCache     *svm.SettlementCache
	pendingStore        x402.PendingSettlementStore
	config              Config
	transactionVersions []int
}

type verifyResult struct {
	response        *x402.VerifyResponse
	tx              *solana.Transaction
	smartWallet     bool
	matchedTransfer *transferCheckedInfo
}

// NewExactSvmScheme creates a new ExactSvmScheme.
//
// Panics on a misconfiguration the facilitator could otherwise only discover
// mid-payment. Operators learn about an unusable limit at startup, as they do in
// the TypeScript SDK. A zero compute-unit or signature ceiling means unset and
// takes the documented default.
func NewExactSvmScheme(signer svm.FacilitatorSvmSigner, config ...*Config) *ExactSvmScheme {
	cfg := Config{}
	if len(config) > 0 && config[0] != nil {
		cfg = *config[0]
	}
	if cfg.MaxComputeUnits != nil {
		assertPositive("maxComputeUnits", int64(*cfg.MaxComputeUnits))
	}
	if cfg.MaxRequiredSignatures != nil {
		assertPositive("maxRequiredSignatures", int64(*cfg.MaxRequiredSignatures))
	}
	if cfg.SmartWalletMaxComputeUnits != nil {
		assertPositive("smartWalletMaxComputeUnits", int64(*cfg.SmartWalletMaxComputeUnits))
	}
	transactionVersions, err := svm.NormalizeAcceptedTransactionVersions(cfg.TransactionVersions)
	if err != nil {
		panic("exact svm facilitator: " + err.Error())
	}

	cache := cfg.SettlementCache
	if cache == nil {
		cache = svm.NewSettlementCache()
	}

	if cfg.EnableSmartWalletVerification {
		if _, ok := signer.(svm.SmartWalletRPCCapabilities); !ok {
			panic("exact svm facilitator: enableSmartWalletVerification requires SmartWalletRPCCapabilities on the signer")
		}
	}

	return &ExactSvmScheme{
		signer:              signer,
		settlementCache:     cache,
		pendingStore:        x402.NewInMemoryPendingSettlementStore(),
		config:              cfg,
		transactionVersions: transactionVersions,
	}
}

// maxComputeUnits is the configured static-path compute unit ceiling, or
// DefaultMaxComputeUnits.
func (f *ExactSvmScheme) maxComputeUnits() uint32 {
	if f.config.MaxComputeUnits != nil {
		return *f.config.MaxComputeUnits
	}
	return DefaultMaxComputeUnits
}

// maxRequiredSignatures is the configured required-signature ceiling, or
// DefaultMaxRequiredSignatures.
func (f *ExactSvmScheme) maxRequiredSignatures() uint8 {
	if f.config.MaxRequiredSignatures != nil {
		return *f.config.MaxRequiredSignatures
	}
	return DefaultMaxRequiredSignatures
}

func assertPositive(name string, value int64) {
	if value < 1 {
		panic(fmt.Sprintf("exact svm facilitator: %s must be >= 1, received %d", name, value))
	}
}

// SetPendingSettlementStore overrides the default in-memory PendingSettlementStore
// used to reconcile a transaction that broadcast successfully but whose
// confirmation wait timed out (settlement_pending). A nil store is a no-op.
func (f *ExactSvmScheme) SetPendingSettlementStore(store x402.PendingSettlementStore) {
	if store != nil {
		f.pendingStore = store
	}
}

// Scheme returns the scheme identifier
func (f *ExactSvmScheme) Scheme() string {
	return svm.SchemeExact
}

// CaipFamily returns the CAIP family pattern this facilitator supports
func (f *ExactSvmScheme) CaipFamily() string {
	return "solana:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// For SVM, this includes a randomly selected fee payer address.
// Random selection distributes load across multiple signers.
func (f *ExactSvmScheme) GetExtra(network x402.Network) map[string]interface{} {
	addresses := f.signer.GetAddresses(context.Background(), string(network))

	// Randomly select from available addresses to distribute load
	randomIndex := rand.IntN(len(addresses))

	extra := map[string]interface{}{
		"feePayer":                   addresses[randomIndex].String(),
		svm.ExtraTransactionVersions: append([]int(nil), f.transactionVersions...),
	}
	if f.config.EnableSmartWalletVerification {
		extra["features"] = map[string]interface{}{
			"smartWalletSupported": true,
		}
	}
	return extra
}

// GetSigners returns signer addresses used by this facilitator.
// For SVM, returns all available fee payer addresses for the given network.
func publicKeysToStrings(addresses []solana.PublicKey) []string {
	result := make([]string, len(addresses))
	for i, addr := range addresses {
		result[i] = addr.String()
	}
	return result
}

// GetSigners returns signer addresses used by this facilitator.
// For SVM, returns all available fee payer addresses for the given network.
func (f *ExactSvmScheme) GetSigners(network x402.Network) []string {
	return publicKeysToStrings(f.signer.GetAddresses(context.Background(), string(network)))
}

// Verify verifies a V2 payment payload against requirements
func (f *ExactSvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	_ *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	result, err := f.verify(ctx, payload, requirements)
	if err != nil {
		return nil, err
	}
	return result.response, nil
}

func (f *ExactSvmScheme) verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*verifyResult, error) {
	network := x402.Network(requirements.Network)

	// Step 1: Validate Payment Requirements
	if payload.Accepted.Scheme != svm.SchemeExact || requirements.Scheme != svm.SchemeExact {
		return nil, x402.NewVerifyError(ErrUnsupportedScheme, "", fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}

	// V2: Network matching - validate payload network matches requirements
	if string(payload.Accepted.Network) != string(requirements.Network) {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, "", fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}

	if requirements.Extra == nil || requirements.Extra["feePayer"] == nil {
		return nil, x402.NewVerifyError(ErrMissingFeePayer, "", "missing feePayer")
	}

	feePayerStr, ok := requirements.Extra["feePayer"].(string)
	if !ok {
		return nil, x402.NewVerifyError(ErrMissingFeePayer, "", fmt.Sprintf("invalid feePayer: %v", requirements.Extra["feePayer"]))
	}

	// Verify that the requested feePayer is managed by this facilitator
	signerAddresses := f.signer.GetAddresses(ctx, string(network))
	signerAddressStrs := make([]string, len(signerAddresses))
	for i, addr := range signerAddresses {
		signerAddressStrs[i] = addr.String()
	}

	feePayerManaged := false
	for _, addr := range signerAddressStrs {
		if addr == feePayerStr {
			feePayerManaged = true
			break
		}
	}
	if !feePayerManaged {
		return nil, x402.NewVerifyError(ErrFeePayerNotManaged, "", fmt.Sprintf("feePayer not managed: %s", feePayerStr))
	}

	// Parse payload
	solanaPayload, err := svm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayloadTransaction, "", err.Error())
	}

	// Step 2: Parse and Validate Transaction Structure
	// Read the version from the raw bytes first so a newer wire format is
	// reported as unsupported however the installed decoder handles it.
	if wireVersion, ok := svm.PeekWireTransactionVersion(solanaPayload.Transaction); ok && !svm.IsAcceptedWireTransactionVersionIn(wireVersion, f.transactionVersions) {
		return nil, x402.NewVerifyError(ErrUnsupportedTransactionVersion, "", fmt.Sprintf("unsupported transaction message version %d", wireVersion))
	}
	tx, err := svm.DecodeTransaction(solanaPayload.Transaction)
	if err != nil {
		return nil, x402.NewVerifyError(ErrTransactionCouldNotBeDecoded, "", err.Error())
	}

	// Message version gate, before any signature or instruction check: every
	// check below reads its sponsorship policy from version-specific structure.
	if !svm.IsAcceptedTransactionVersionIn(tx.Message.GetVersion(), f.transactionVersions) {
		return nil, x402.NewVerifyError(ErrUnsupportedTransactionVersion, "", fmt.Sprintf("unsupported transaction message version %d", svm.WireTransactionVersion(tx.Message.GetVersion())))
	}

	// Size limit of the message version (§1.5): 1232 bytes for legacy and
	// version 0, 4096 for version 1. The decoder accepts larger payloads.
	if size, limit, exceeded := svm.TransactionSizeExceeded(solanaPayload.Transaction, tx.Message.GetVersion()); exceeded {
		return nil, x402.NewVerifyError(ErrTransactionSizeExceeded, "", fmt.Sprintf("transaction is %d bytes, above the %d-byte limit", size, limit))
	}

	if tx.Message.Header.NumRequiredSignatures > f.maxRequiredSignatures() {
		return nil, x402.NewVerifyError(ErrExcessiveSigners, "", ErrExcessiveSigners)
	}

	if err := VerifyRequiredSignatures(tx, feePayerStr); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	if err := f.resolveLookups(ctx, tx, string(requirements.Network)); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	staticErr := f.verifyStaticPath(ctx, tx, requirements, signerAddressStrs)
	if staticErr == nil {
		payer, _ := svm.GetTokenPayerFromTransaction(tx)
		return &verifyResult{
			response: &x402.VerifyResponse{IsValid: true, Payer: payer},
			tx:       tx,
		}, nil
	}

	// Under the default static compute-unit cap (MaxComputeUnits nil), a smart
	// wallet's compute units are the business of SmartWalletMaxComputeUnits: a
	// cap failure falls through to Path 2 too, but only for a transaction that
	// invokes allowlisted wallet programs; otherwise the static reason stands.
	defaultCapExceeded := f.config.MaxComputeUnits == nil && verifyReason(staticErr) == ErrComputeLimitInstructionTooHigh
	if f.config.EnableSmartWalletVerification && (defaultCapExceeded || isLayoutRecoverable(staticErr)) {
		if err := f.assertSmartWalletAllowlist(tx); err != nil {
			if defaultCapExceeded {
				return nil, staticErr
			}
			return nil, err
		}
		if defaultCapExceeded && !invokesWalletProgram(tx) {
			return nil, staticErr
		}
		feePayer, err := solana.PublicKeyFromBase58(feePayerStr)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidFeePayer, "", err.Error())
		}
		caps := f.signer.(svm.SmartWalletRPCCapabilities)
		maxCU := defaultSmartWalletMaxComputeUnits
		if f.config.SmartWalletMaxComputeUnits != nil {
			maxCU = *f.config.SmartWalletMaxComputeUnits
		}
		maxPriorityFee := defaultSmartWalletMaxPriorityFeeMicroLamports
		if f.config.SmartWalletMaxPriorityFeeMicroLamports != nil {
			maxPriorityFee = *f.config.SmartWalletMaxPriorityFeeMicroLamports
		}
		matched, err := verifySmartWalletTransaction(
			ctx, tx, requirements, caps, feePayer, signerAddressStrs, maxCU, maxPriorityFee,
		)
		if err != nil {
			return nil, err
		}
		return &verifyResult{
			response:        &x402.VerifyResponse{IsValid: true, Payer: matched.authority.String()},
			tx:              tx,
			smartWallet:     true,
			matchedTransfer: matched,
		}, nil
	}

	return nil, staticErr
}

// verifyReason is the invalid reason an error carries.
func verifyReason(err error) string {
	var ve *x402.VerifyError
	if errors.As(err, &ve) {
		return ve.InvalidReason
	}
	return err.Error()
}

// invokesWalletProgram reports whether a top-level instruction invokes a
// program other than ComputeBudget and Memo.
func invokesWalletProgram(tx *solana.Transaction) bool {
	memoPubkey := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	for _, ix := range tx.Message.Instructions {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		if err == nil && !programID.Equals(solana.ComputeBudget) && !programID.Equals(memoPubkey) {
			return true
		}
	}
	return false
}

func isLayoutRecoverable(err error) bool {
	switch verifyReason(err) {
	case ErrTransactionInstructionsLength,
		ErrNoTransferInstruction,
		ErrUnknownFourthInstruction,
		ErrUnknownFifthInstruction,
		ErrUnknownSixthInstruction,
		ErrUnknownOptionalInstruction,
		ErrComputeLimitInstruction,
		ErrComputePriceInstruction:
		return true
	default:
		return false
	}
}

func (f *ExactSvmScheme) assertSmartWalletAllowlist(tx *solana.Transaction) error {
	allowed := defaultSmartWalletAllowedPrograms
	if len(f.config.SmartWalletAllowedPrograms) > 0 {
		allowed = f.config.SmartWalletAllowedPrograms
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, program := range allowed {
		allowedSet[program] = struct{}{}
	}
	memoPubkey := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	for _, ix := range tx.Message.Instructions {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		if err != nil {
			return x402.NewVerifyError(ErrSmartWalletProgramNotAllowed, "", err.Error())
		}
		if programID.Equals(solana.ComputeBudget) || programID.Equals(memoPubkey) {
			continue
		}
		if _, ok := allowedSet[programID.String()]; !ok {
			return x402.NewVerifyError(
				fmt.Sprintf("%s: %s", ErrSmartWalletProgramNotAllowed, programID),
				"",
				programID.String(),
			)
		}
	}
	return nil
}

func (f *ExactSvmScheme) resolveLookups(ctx context.Context, tx *solana.Transaction, network string) error {
	lookups := tx.Message.GetAddressTableLookups()
	if len(lookups) == 0 {
		return nil
	}
	caps, ok := f.signer.(svm.SmartWalletRPCCapabilities)
	if !ok {
		return fmt.Errorf("%s: transaction uses Address Lookup Tables but signer does not implement SmartWalletRPCCapabilities",
			ErrSmartWalletAltResolutionUnavailable)
	}
	tables := make([]solana.PublicKey, len(lookups))
	for i, lookup := range lookups {
		tables[i] = lookup.AccountKey
	}
	resolved, err := caps.FetchAddressLookupTables(ctx, tables, network)
	if err != nil {
		return err
	}
	if err := tx.Message.SetAddressTables(resolved); err != nil {
		return err
	}
	return tx.Message.ResolveLookups()
}

func (f *ExactSvmScheme) verifyStaticPath(
	ctx context.Context,
	tx *solana.Transaction,
	requirements types.PaymentRequirements,
	signerAddressStrs []string,
) error {
	// Legacy and version 0 allow 3-7 instructions:
	// - 3 instructions: ComputeLimit + ComputePrice + TransferChecked
	// - 4 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse or Memo
	// - 5 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse or Memo
	// - 6 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse + Memo
	// - 7 instructions: + a third wallet-injected Lighthouse (Phantom, see #2097)
	// See: https://github.com/x402-foundation/x402/issues/828
	//  and: https://github.com/x402-foundation/x402/issues/2097
	// Version 1 carries the compute budget in its message config, so the same
	// layout starts at the TransferChecked: 1-5 instructions.
	transferIndex := staticTransferIndex(tx)
	numInstructions := len(tx.Message.Instructions)
	minInstructions, maxInstructions := transferIndex+1, transferIndex+5
	if numInstructions < minInstructions || numInstructions > maxInstructions {
		return x402.NewVerifyError(ErrTransactionInstructionsLength, "", fmt.Sprintf("transaction instructions length mismatch: %d < %d or %d > %d", numInstructions, minInstructions, numInstructions, maxInstructions))
	}

	// Step 3: Verify the compute budget
	if transferIndex == 0 {
		if err := f.verifyTransactionV1Config(tx); err != nil {
			return x402.NewVerifyError(err.Error(), "", err.Error())
		}
	} else {
		if err := f.verifyComputeLimitInstruction(tx, tx.Message.Instructions[0]); err != nil {
			return x402.NewVerifyError(err.Error(), "", err.Error())
		}

		if err := f.verifyComputePriceInstruction(tx, tx.Message.Instructions[1]); err != nil {
			return x402.NewVerifyError(err.Error(), "", err.Error())
		}
	}

	// Extract payer from transaction
	payer, err := svm.GetTokenPayerFromTransaction(tx)
	if err != nil {
		return x402.NewVerifyError(ErrNoTransferInstruction, payer, err.Error())
	}

	// V2: payload.Accepted.Network is already validated by scheme lookup
	// Network matching is implicit - facilitator was selected based on requirements.Network

	// Convert requirements to old struct format for helper methods
	reqStruct := x402.PaymentRequirements{
		Scheme:  requirements.Scheme,
		Network: requirements.Network,
		Asset:   requirements.Asset,
		Amount:  requirements.Amount,
		PayTo:   requirements.PayTo,
		Extra:   requirements.Extra,
	}

	// Step 4: Verify Transfer Instruction
	transfer, err := f.verifyTransferInstruction(tx, tx.Message.Instructions[transferIndex], reqStruct, signerAddressStrs)
	if err != nil {
		return x402.NewVerifyError(err.Error(), payer, err.Error())
	}

	// Step 5: Verify optional instructions (if present)
	// Allowed optional programs: Lighthouse (wallet protection) and Memo (uniqueness)
	if numInstructions > transferIndex+1 {
		lighthousePubkey := solana.MustPublicKeyFromBase58(svm.LighthouseProgramAddress)
		memoPubkey := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
		optionalInstructions := tx.Message.Instructions[transferIndex+1:]
		invalidReasons := []string{
			ErrUnknownFourthInstruction,
			ErrUnknownFifthInstruction,
			ErrUnknownSixthInstruction,
			ErrUnknownSeventhInstruction,
		}

		for i, instruction := range optionalInstructions {
			progID, progErr := tx.Message.Program(instruction.ProgramIDIndex)
			if progErr != nil {
				reason := ErrUnknownOptionalInstruction
				if i < len(invalidReasons) {
					reason = invalidReasons[i]
				}
				return x402.NewVerifyError(reason, payer, progErr.Error())
			}
			if progID.Equals(lighthousePubkey) || progID.Equals(memoPubkey) {
				continue
			}

			reason := ErrUnknownOptionalInstruction
			if i < len(invalidReasons) {
				reason = invalidReasons[i]
			}

			return x402.NewVerifyError(reason, payer, fmt.Sprintf("unknown optional instruction: %s", progID.String()))
		}

		// Step 5b: Verify memo content matches extra.memo when present
		if expectedMemo, ok := requirements.Extra["memo"].(string); ok && expectedMemo != "" {
			var memoCount int
			var actualMemoData []byte
			for _, instruction := range optionalInstructions {
				progID, progErr := tx.Message.Program(instruction.ProgramIDIndex)
				if progErr != nil {
					continue
				}
				if progID.Equals(memoPubkey) {
					memoCount++
					actualMemoData = instruction.Data
				}
			}
			if memoCount != 1 {
				return x402.NewVerifyError(ErrMemoCount, payer, "expected exactly one memo instruction when extra.memo is present")
			}
			if string(actualMemoData) != expectedMemo {
				return x402.NewVerifyError(ErrMemoMismatch, payer, "memo data does not match extra.memo")
			}
		}
	}

	// Step 6: Simulate Transaction
	// CRITICAL: Simulation proves transaction will succeed (catches insufficient balance, invalid accounts, etc)
	// Signatures are verified locally; the fee-payer slot is unsigned until settle.
	if err := f.signer.SimulateTransaction(ctx, tx, string(requirements.Network), nil); err != nil {
		failure := x402.NewVerifyError(ErrTransactionSimulationFailed, payer, err.Error())
		reader, ok := f.signer.(accountInfoReader)
		if !ok {
			return failure
		}
		destination := transfer.destination
		program := transfer.programID
		account, readErr := reader.GetAccountInfo(ctx, destination, string(requirements.Network), &rpc.GetAccountInfoOpts{
			Commitment: rpc.CommitmentConfirmed,
		})
		switch {
		case errors.Is(readErr, rpc.ErrNotFound) || (readErr == nil && account != nil && account.Value == nil):
			failure.InvalidReason = ErrRecipientATAMissing
			failure.InvalidMessage = fmt.Sprintf("%s; recipient ATA %s was not found during diagnostic lookup", err.Error(), destination)
		case readErr == nil && account != nil && account.Value != nil && account.Value.Owner != program:
			failure.InvalidReason = ErrRecipientATAWrongProgramOwner
			failure.InvalidMessage = fmt.Sprintf("%s; recipient ATA %s has program owner %s, expected %s", err.Error(), destination, account.Value.Owner, program)
		}
		return failure
	}

	return nil
}

// Settle settles a payment by submitting the transaction (V2)
// Ensures the correct signer is used based on the feePayer specified in requirements.
func (f *ExactSvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	// Parse and decode the transaction up front (no RPC calls) so we can key
	// the PendingSettlementStore on the message hash before doing any
	// verify/sign/send work.
	solanaPayload, err := svm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, "", network, "", err.Error())
	}
	if wireVersion, ok := svm.PeekWireTransactionVersion(solanaPayload.Transaction); ok && !svm.IsAcceptedWireTransactionVersionIn(wireVersion, f.transactionVersions) {
		return nil, x402.NewSettleError(ErrUnsupportedTransactionVersion, "", network, "", fmt.Sprintf("unsupported transaction message version %d", wireVersion))
	}
	tx, err := svm.DecodeTransaction(solanaPayload.Transaction)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, "", network, "", err.Error())
	}
	if !svm.IsAcceptedTransactionVersionIn(tx.Message.GetVersion(), f.transactionVersions) {
		return nil, x402.NewSettleError(ErrUnsupportedTransactionVersion, "", network, "", fmt.Sprintf("unsupported transaction message version %d", svm.WireTransactionVersion(tx.Message.GetVersion())))
	}
	// Keyed on message hash (immune to mutable fee-payer sig at slot 0); shared
	// by the duplicate-settlement check and the PendingSettlementStore below.
	txKey, err := svm.MessageHash(tx)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, "", network, "", err.Error())
	}

	// Pending-settlement fast path: a prior settle for this exact transaction
	// broadcast successfully but its ConfirmTransaction wait failed. Reconcile
	// against the already-broadcast signature instead of re-verifying and
	// re-sending: Solana transactions embed a recent blockhash that expires
	// (so a resend can fail even when the original is still perfectly valid),
	// and if the original actually did land, a second verify's balance-based
	// simulation could now spuriously fail (funds already moved).
	if f.pendingStore != nil {
		if sigStr, hit, _ := f.pendingStore.Get(ctx, txKey); hit {
			// Remove before reconciling (rather than after) so a concurrent
			// retry of the same payload misses here instead of also
			// reconciling: it falls through to the settlementCache dedup check
			// below, which independently rejects it as a duplicate.
			_ = f.pendingStore.Delete(ctx, txKey)
			// Best-effort payer for the response; a decode failure here doesn't
			// block reconciliation (the payload already broadcast successfully).
			payer, _ := svm.GetTokenPayerFromTransaction(tx)
			isSmartWallet := f.config.EnableSmartWalletVerification && !hasStaticTransferLayout(tx)
			return f.reconcilePendingSettlement(ctx, txKey, sigStr, payer, network, string(requirements.Network), isSmartWallet, requirements)
		}
	}

	// Duplicate settlement check keyed on message hash.
	if f.settlementCache.IsDuplicate(txKey) {
		payer, _ := svm.GetTokenPayerFromTransaction(tx)
		return nil, x402.NewSettleError(ErrDuplicateSettlement, payer, network, "", "duplicate transaction")
	}

	// Everything below until a successful broadcast is a terminal, never-broadcast
	// failure and must release the dedup lock just claimed above — otherwise a
	// legitimate retry of the same payload is wrongly rejected as a duplicate for
	// the rest of the SettlementTTL window. releaseLock is turned off once the
	// transaction is actually broadcast, since a confirmation timeout after that
	// point must keep the lock held (see ConfirmTransaction below).
	releaseLock := true
	defer func() {
		if releaseLock {
			f.settlementCache.Delete(txKey)
		}
	}()

	// First verify the payment
	result, err := f.verify(ctx, payload, requirements)
	if err != nil {
		// Convert VerifyError to SettleError
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	feePayerStr, ok := requirements.Extra["feePayer"].(string)
	if !ok {
		return nil, x402.NewSettleError(ErrMissingFeePayer, result.response.Payer, network, "", "")
	}

	expectedFeePayer, err := solana.PublicKeyFromBase58(feePayerStr)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidFeePayer, result.response.Payer, network, "", err.Error())
	}

	var (
		signErr       error
		preBalance    uint64
		hasPreBalance bool
	)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Sign with the feePayer's signer
		signErr = f.signer.SignTransaction(ctx, tx, expectedFeePayer, string(requirements.Network))
	}()
	if result.smartWallet && result.matchedTransfer != nil {
		if caps, ok := f.signer.(svm.SmartWalletRPCCapabilities); ok {
			wg.Add(1)
			dest := result.matchedTransfer.destination
			go func() {
				defer wg.Done()
				b, exists, balErr := caps.GetTokenAccountBalance(ctx, dest, string(requirements.Network))
				if balErr == nil && exists {
					preBalance = b
					hasPreBalance = true
				}
			}()
		}
	}
	wg.Wait()
	if signErr != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, result.response.Payer, network, "", signErr.Error())
	}

	// Send transaction to network
	signature, err := f.signer.SendTransaction(ctx, tx, string(requirements.Network))
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, result.response.Payer, network, "", err.Error())
	}
	releaseLock = false

	// Wait for confirmation. releaseLock stays false: the signature was broadcast.
	if err := f.signer.ConfirmTransaction(ctx, signature, string(requirements.Network)); err != nil {
		return nil, f.finishUnconfirmed(ctx, txKey, signature.String(), result.response.Payer, network, err)
	}
	if f.pendingStore != nil {
		_ = f.pendingStore.Delete(ctx, txKey)
	}

	if result.smartWallet {
		caps, ok := f.signer.(svm.SmartWalletRPCCapabilities)
		if !ok || !f.postSettlementVerified(ctx, caps, signature, string(requirements.Network), requirements, result, preBalance, hasPreBalance) {
			return nil, x402.NewSettleError(ErrPostSettlementTransferNotConfirmed, result.response.Payer, network, signature.String(), ErrPostSettlementTransferNotConfirmed)
		}
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: signature.String(),
		Network:     network,
		Payer:       result.response.Payer,
	}, nil
}

func (f *ExactSvmScheme) postSettlementVerified(
	ctx context.Context,
	caps svm.SmartWalletRPCCapabilities,
	signature solana.Signature,
	network string,
	requirements types.PaymentRequirements,
	result *verifyResult,
	preBalance uint64,
	hasPreBalance bool,
) bool {
	var balanceBefore *uint64
	if hasPreBalance {
		balanceBefore = &preBalance
	}
	var knownATA *solana.PublicKey
	if result.matchedTransfer != nil {
		dest := result.matchedTransfer.destination
		knownATA = &dest
	}
	return verifyPostSettlement(ctx, caps, signature, network, requirements, publicKeysToStrings(f.signer.GetAddresses(ctx, network)), balanceBefore, knownATA)
}

// staticTransferIndex is the Path 1 position of the TransferChecked: after the
// two ComputeBudget instructions on legacy and version 0, first on version 1.
func staticTransferIndex(tx *solana.Transaction) int {
	if tx.Message.GetVersion() == solana.MessageVersionV1 {
		return 0
	}
	return 2
}

func hasStaticTransferLayout(tx *solana.Transaction) bool {
	n := len(tx.Message.Instructions)
	transferIndex := staticTransferIndex(tx)
	if n < transferIndex+1 || n > transferIndex+5 {
		return false
	}
	transfer := tx.Message.Instructions[transferIndex]
	programID, err := tx.Message.Program(transfer.ProgramIDIndex)
	if err != nil {
		return false
	}
	if !isTokenProgram(programID) {
		return false
	}
	return len(transfer.Data) >= 10 && transfer.Data[0] == ixTokenTransferChecked
}

// finishUnconfirmed classifies a confirmation error after a successful broadcast.
//
// A TransactionOnchainFailureError means the status double, or a live node,
// observed a confirmed or finalized execution failure. That is terminal: the
// signature stays on the settle error, any pending record is removed so a
// restart cannot report settlement_pending, and the dedup lock is held so
// this process does not send the same payload again.
//
// Timeout, transport failure, a missing or malformed status, and every other
// error that is not that typed failure stay settlement_pending. The signature
// is stored so a later attempt reconciles the same broadcast.
func (f *ExactSvmScheme) finishUnconfirmed(
	ctx context.Context,
	txKey string,
	sigStr string,
	payer string,
	network x402.Network,
	waitErr error,
) error {
	var onchain *svm.TransactionOnchainFailureError
	if errors.As(waitErr, &onchain) {
		if f.pendingStore != nil {
			_ = f.pendingStore.Delete(ctx, txKey)
		}
		// IsDuplicate records the key when this process has not claimed it yet
		// (a restarted reconciler). A key already held from the first broadcast
		// stays held. Either way a same-payload retry does not send again.
		_ = f.settlementCache.IsDuplicate(txKey)
		return x402.NewSettleError(ErrTransactionFailed, payer, network, sigStr, onchain.Error())
	}
	return svm.RecordPendingOrTerminal(ctx, f.pendingStore, txKey, sigStr, payer, network, ErrTransactionFailed, waitErr)
}

// reconcilePendingSettlement handles a PendingSettlementStore cache hit: a
// prior Settle call for this transaction (keyed by txKey, the message hash)
// already broadcast sigStr but couldn't confirm it before returning
// settlement_pending. It re-awaits confirmation of that same signature rather
// than re-verifying/re-signing/re-sending — see the fast-path comment in
// Settle for why re-sending is unsafe here.
func (f *ExactSvmScheme) reconcilePendingSettlement(
	ctx context.Context,
	txKey string,
	sigStr string,
	payer string,
	network x402.Network,
	networkStr string,
	isSmartWallet bool,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	signature, err := solana.SignatureFromBase58(sigStr)
	if err != nil {
		// Malformed cache entry — drop it so future attempts fall through to
		// the normal broadcast path instead of getting stuck.
		_ = f.pendingStore.Delete(ctx, txKey)
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, payer, network, "", err.Error())
	}

	if err := f.signer.ConfirmTransaction(ctx, signature, networkStr); err != nil {
		return nil, f.finishUnconfirmed(ctx, txKey, sigStr, payer, network, err)
	}
	_ = f.pendingStore.Delete(ctx, txKey)

	if isSmartWallet {
		caps, ok := f.signer.(svm.SmartWalletRPCCapabilities)
		if !ok || !verifyPostSettlement(ctx, caps, signature, networkStr, requirements, publicKeysToStrings(f.signer.GetAddresses(ctx, networkStr)), nil, nil) {
			return nil, x402.NewSettleError(ErrPostSettlementTransferNotConfirmed, payer, network, sigStr, ErrPostSettlementTransferNotConfirmed)
		}
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: sigStr,
		Network:     network,
		Payer:       payer,
	}, nil
}

// verifyTransactionV1Config applies the Path 1 compute caps to a version-1
// message config (SIMD-0385), which replaces the ComputeBudget instructions.
func (f *ExactSvmScheme) verifyTransactionV1Config(tx *solana.Transaction) error {
	maxComputeUnits := f.maxComputeUnits()
	maxPrice := uint64(svm.MaxComputeUnitPriceMicrolamports)
	if f.config.MaxPriorityFeeMicroLamports != nil {
		maxPrice = *f.config.MaxPriorityFeeMicroLamports
	}
	return staticV1ConfigError(svm.ValidateTransactionV1Config(&tx.Message, maxComputeUnits, maxPrice))
}

// staticV1ConfigError maps a version-1 config violation to the Path 1 reason
// codes the same rule carries on legacy and version 0.
func staticV1ConfigError(violation svm.TransactionV1ConfigViolation) error {
	switch violation {
	case svm.TransactionV1ConfigOK:
		return nil
	case svm.TransactionV1ComputeBudgetInstruction:
		return errors.New(ErrTransactionV1ComputeBudgetIx)
	case svm.TransactionV1HeapSize:
		return errors.New(ErrTransactionV1HeapSize)
	case svm.TransactionV1ComputeUnitLimitMissing:
		return errors.New(ErrComputeLimitInstruction)
	case svm.TransactionV1ComputeUnitLimitTooHigh:
		return errors.New(ErrComputeLimitInstructionTooHigh)
	case svm.TransactionV1LoadedAccountsDataSizeLimitMissing:
		return errors.New(ErrLoadedAccountsDataSizeLimitMissing)
	default:
		return errors.New(ErrComputePriceInstructionTooHigh)
	}
}

// verifyComputeLimitInstruction verifies the compute unit limit instruction
func (f *ExactSvmScheme) verifyComputeLimitInstruction(tx *solana.Transaction, inst solana.CompiledInstruction) error {
	progID, err := tx.Message.Program(inst.ProgramIDIndex)
	if err != nil || !progID.Equals(solana.ComputeBudget) {
		return errors.New(ErrComputeLimitInstruction)
	}

	// Check discriminator (should be 2 for SetComputeUnitLimit)
	if len(inst.Data) < 5 || inst.Data[0] != ixSetComputeUnitLimit {
		return errors.New(ErrComputeLimitInstruction)
	}

	units := binary.LittleEndian.Uint32(inst.Data[1:5])
	if units > f.maxComputeUnits() {
		return errors.New(ErrComputeLimitInstructionTooHigh)
	}

	return nil
}

// verifyComputePriceInstruction verifies the compute unit price instruction
func (f *ExactSvmScheme) verifyComputePriceInstruction(tx *solana.Transaction, inst solana.CompiledInstruction) error {
	progID, err := tx.Message.Program(inst.ProgramIDIndex)
	if err != nil || !progID.Equals(solana.ComputeBudget) {
		return errors.New(ErrComputePriceInstruction)
	}

	// Check discriminator (should be 3 for SetComputeUnitPrice)
	if len(inst.Data) < 9 || inst.Data[0] != ixSetComputeUnitPrice {
		return errors.New(ErrComputePriceInstruction)
	}

	// Decode to get microLamports
	microLamports := binary.LittleEndian.Uint64(inst.Data[1:9])
	max := uint64(svm.MaxComputeUnitPriceMicrolamports)
	if f.config.MaxPriorityFeeMicroLamports != nil {
		max = *f.config.MaxPriorityFeeMicroLamports
	}
	// Check if it's SetComputeUnitPrice and validate the price
	if microLamports > max {
		// Check if price exceeds maximum (5 lamports per compute unit = 5,000,000 microlamports)
		return errors.New(ErrComputePriceInstructionTooHigh)
	}

	return nil
}

// verifyTransferInstruction returns the validated transfer details.
func (f *ExactSvmScheme) verifyTransferInstruction(
	tx *solana.Transaction,
	inst solana.CompiledInstruction,
	requirements x402.PaymentRequirements,
	signerAddresses []string,
) (*transferCheckedInfo, error) {
	progID, err := tx.Message.Program(inst.ProgramIDIndex)
	if err != nil {
		return nil, errors.New(ErrNoTransferInstruction)
	}

	// Must be Token Program or Token-2022 Program
	if progID != solana.TokenProgramID && progID != solana.Token2022ProgramID {
		return nil, errors.New(ErrNoTransferInstruction)
	}

	accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
	if err != nil {
		return nil, errors.New(ErrNoTransferInstruction)
	}

	if len(accounts) < 4 {
		return nil, errors.New(ErrNoTransferInstruction)
	}

	decoded, err := token.DecodeInstruction(accounts, inst.Data)
	if err != nil {
		return nil, errors.New(ErrNoTransferInstruction)
	}

	transferChecked, ok := decoded.Impl.(*token.TransferChecked)
	if !ok {
		return nil, errors.New(ErrNoTransferInstruction)
	}

	// SECURITY: Verify that the facilitator's signers are not transferring their own funds
	// Prevent facilitator from signing away their own tokens
	authorityAddr := accounts[3].PublicKey.String() // TransferChecked: [source, mint, destination, authority, ...]
	for _, signerAddr := range signerAddresses {
		if authorityAddr == signerAddr {
			return nil, errors.New(ErrFeePayerTransferringFunds)
		}
	}

	// Verify mint address
	mintAddr := accounts[1].PublicKey.String()
	if mintAddr != requirements.Asset {
		return nil, errors.New(ErrMintMismatch)
	}

	// Verify destination ATA
	payToPubkey, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return nil, errors.New(ErrRecipientMismatch)
	}

	mintPubkey, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return nil, errors.New(ErrMintMismatch)
	}

	expectedDestATA, err := findATA(payToPubkey, mintPubkey, progID)
	if err != nil {
		return nil, errors.New(ErrRecipientMismatch)
	}

	destATA := transferChecked.GetDestinationAccount().PublicKey
	if destATA.String() != expectedDestATA.String() {
		return nil, errors.New(ErrRecipientMismatch)
	}

	// Verify amount
	requiredAmount, err := strconv.ParseUint(requirements.Amount, 10, 64)
	if err != nil {
		return nil, errors.New(ErrAmountMismatch)
	}

	if *transferChecked.Amount != requiredAmount {
		return nil, errors.New(ErrAmountMismatch)
	}

	return &transferCheckedInfo{
		programID:   progID,
		amount:      *transferChecked.Amount,
		mint:        mintPubkey,
		destination: destATA,
		authority:   accounts[3].PublicKey,
	}, nil
}
