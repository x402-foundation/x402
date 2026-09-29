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
	MaxComputeUnits                        *uint32
	MaxRequiredSignatures                  *uint8
}

// ExactSvmScheme implements the SchemeNetworkFacilitator interface for SVM (Solana) exact payments (V2)
type ExactSvmScheme struct {
	signer          svm.FacilitatorSvmSigner
	settlementCache *svm.SettlementCache
	pendingStore    x402.PendingSettlementStore
	config          Config
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
		signer:          signer,
		settlementCache: cache,
		pendingStore:    x402.NewInMemoryPendingSettlementStore(),
		config:          cfg,
	}
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
		"feePayer": addresses[randomIndex].String(),
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
	tx, err := svm.DecodeTransaction(solanaPayload.Transaction)
	if err != nil {
		return nil, x402.NewVerifyError(ErrTransactionCouldNotBeDecoded, "", err.Error())
	}

	if f.config.MaxRequiredSignatures != nil && tx.Message.Header.NumRequiredSignatures > *f.config.MaxRequiredSignatures {
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

	if f.config.EnableSmartWalletVerification && isLayoutRecoverable(staticErr) {
		if err := f.assertSmartWalletAllowlist(tx); err != nil {
			return nil, err
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

func isLayoutRecoverable(err error) bool {
	var ve *x402.VerifyError
	reason := err.Error()
	if errors.As(err, &ve) {
		reason = ve.InvalidReason
	}
	switch reason {
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
	// Allow 3-7 instructions:
	// - 3 instructions: ComputeLimit + ComputePrice + TransferChecked
	// - 4 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse or Memo
	// - 5 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse or Memo
	// - 6 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse + Memo
	// - 7 instructions: + a third wallet-injected Lighthouse (Phantom, see #2097)
	// See: https://github.com/x402-foundation/x402/issues/828
	//  and: https://github.com/x402-foundation/x402/issues/2097
	numInstructions := len(tx.Message.Instructions)
	if numInstructions < 3 || numInstructions > 7 {
		return x402.NewVerifyError(ErrTransactionInstructionsLength, "", fmt.Sprintf("transaction instructions length mismatch: %d < 3 or %d > 7", numInstructions, numInstructions))
	}

	// Step 3: Verify Compute Budget Instructions
	if err := f.verifyComputeLimitInstruction(tx, tx.Message.Instructions[0]); err != nil {
		return x402.NewVerifyError(err.Error(), "", err.Error())
	}

	if err := f.verifyComputePriceInstruction(tx, tx.Message.Instructions[1]); err != nil {
		return x402.NewVerifyError(err.Error(), "", err.Error())
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
	if err := f.verifyTransferInstruction(tx, tx.Message.Instructions[2], reqStruct, signerAddressStrs); err != nil {
		return x402.NewVerifyError(err.Error(), payer, err.Error())
	}

	// Step 5: Verify optional instructions (if present)
	// Allowed optional programs: Lighthouse (wallet protection) and Memo (uniqueness)
	if numInstructions >= 4 {
		lighthousePubkey := solana.MustPublicKeyFromBase58(svm.LighthouseProgramAddress)
		memoPubkey := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
		optionalInstructions := tx.Message.Instructions[3:]
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
	if err := f.signer.SimulateTransaction(ctx, tx, string(requirements.Network)); err != nil {
		return x402.NewVerifyError(ErrTransactionSimulationFailed, payer, err.Error())
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
	tx, err := svm.DecodeTransaction(solanaPayload.Transaction)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, "", network, "", err.Error())
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

	// Wait for confirmation
	if err := f.signer.ConfirmTransaction(ctx, signature, string(requirements.Network)); err != nil {
		// Broadcast succeeded but confirmation couldn't be observed in time.
		// Non-terminal: leave the dedup lock in place (a fresh broadcast would
		// risk double-sending) and record the signature so a retry reconciles
		// via the pending-settlement fast path above instead of re-verifying
		// and re-sending.
		return nil, svm.RecordPendingOrTerminal(ctx, f.pendingStore, txKey, signature.String(), result.response.Payer, network, ErrTransactionFailed, err)
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

func hasStaticTransferLayout(tx *solana.Transaction) bool {
	n := len(tx.Message.Instructions)
	if n < 3 || n > 7 {
		return false
	}
	transfer := tx.Message.Instructions[2]
	programID, err := tx.Message.Program(transfer.ProgramIDIndex)
	if err != nil {
		return false
	}
	if !isTokenProgram(programID) {
		return false
	}
	return len(transfer.Data) >= 10 && transfer.Data[0] == ixTokenTransferChecked
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
		return nil, svm.RecordPendingOrTerminal(ctx, f.pendingStore, txKey, sigStr, payer, network, ErrTransactionFailed, err)
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
	if f.config.MaxComputeUnits != nil && units > *f.config.MaxComputeUnits {
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

// verifyTransferInstruction verifies the transfer instruction
func (f *ExactSvmScheme) verifyTransferInstruction(
	tx *solana.Transaction,
	inst solana.CompiledInstruction,
	requirements x402.PaymentRequirements,
	signerAddresses []string,
) error {
	progID, err := tx.Message.Program(inst.ProgramIDIndex)
	if err != nil {
		return errors.New(ErrNoTransferInstruction)
	}

	// Must be Token Program or Token-2022 Program
	if progID != solana.TokenProgramID && progID != solana.Token2022ProgramID {
		return errors.New(ErrNoTransferInstruction)
	}

	accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
	if err != nil {
		return errors.New(ErrNoTransferInstruction)
	}

	if len(accounts) < 4 {
		return errors.New(ErrNoTransferInstruction)
	}

	decoded, err := token.DecodeInstruction(accounts, inst.Data)
	if err != nil {
		return errors.New(ErrNoTransferInstruction)
	}

	transferChecked, ok := decoded.Impl.(*token.TransferChecked)
	if !ok {
		return errors.New(ErrNoTransferInstruction)
	}

	// SECURITY: Verify that the facilitator's signers are not transferring their own funds
	// Prevent facilitator from signing away their own tokens
	authorityAddr := accounts[3].PublicKey.String() // TransferChecked: [source, mint, destination, authority, ...]
	for _, signerAddr := range signerAddresses {
		if authorityAddr == signerAddr {
			return errors.New(ErrFeePayerTransferringFunds)
		}
	}

	// Verify mint address
	mintAddr := accounts[1].PublicKey.String()
	if mintAddr != requirements.Asset {
		return errors.New(ErrMintMismatch)
	}

	// Verify destination ATA
	payToPubkey, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return errors.New(ErrRecipientMismatch)
	}

	mintPubkey, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return errors.New(ErrMintMismatch)
	}

	expectedDestATA, err := findATA(payToPubkey, mintPubkey, progID)
	if err != nil {
		return errors.New(ErrRecipientMismatch)
	}

	destATA := transferChecked.GetDestinationAccount().PublicKey
	if destATA.String() != expectedDestATA.String() {
		return errors.New(ErrRecipientMismatch)
	}

	// Verify amount
	requiredAmount, err := strconv.ParseUint(requirements.Amount, 10, 64)
	if err != nil {
		return errors.New(ErrAmountMismatch)
	}

	if *transferChecked.Amount != requiredAmount {
		return errors.New(ErrAmountMismatch)
	}

	return nil
}
