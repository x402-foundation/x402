package facilitator

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"

	x402 "github.com/x402-foundation/x402/go/v2"
	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	exactv2 "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/facilitator"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ExactSvmSchemeV1 implements the SchemeNetworkFacilitator interface for SVM (Solana) exact payments (V1)
type ExactSvmSchemeV1 struct {
	signer              svm.FacilitatorSvmSigner
	settlementCache     *svm.SettlementCache
	transactionVersions []int
}

// Config configures an ExactSvmSchemeV1.
type Config struct {
	// SettlementCache shares deduplication state across V1 and V2 instances;
	// nil creates a new cache.
	SettlementCache *svm.SettlementCache
	// TransactionVersions is the set of message versions this facilitator
	// accepts and advertises as extra.transactionVersions. Any other version
	// is rejected with unsupported_transaction_version; legacy is accepted
	// exactly when 0 is. Nil means [0, 1]. Narrow it to [0] for a sponsor whose
	// signer or RPC does not yet handle version 1.
	TransactionVersions []int
}

// NewExactSvmSchemeV1 creates a new ExactSvmSchemeV1 accepting versions 0 and 1.
// An optional SettlementCache may be provided to share deduplication state
// across V1 and V2 instances; if nil a new cache is created.
func NewExactSvmSchemeV1(signer svm.FacilitatorSvmSigner, cache ...*svm.SettlementCache) *ExactSvmSchemeV1 {
	cfg := &Config{}
	if len(cache) > 0 {
		cfg.SettlementCache = cache[0]
	}
	return NewExactSvmSchemeV1WithConfig(signer, cfg)
}

// NewExactSvmSchemeV1WithConfig creates a new ExactSvmSchemeV1 from config.
// Panics when TransactionVersions is invalid, so operators learn about it at
// startup.
func NewExactSvmSchemeV1WithConfig(signer svm.FacilitatorSvmSigner, config *Config) *ExactSvmSchemeV1 {
	cfg := Config{}
	if config != nil {
		cfg = *config
	}
	transactionVersions, err := svm.NormalizeAcceptedTransactionVersions(cfg.TransactionVersions)
	if err != nil {
		panic("exact svm v1 facilitator: " + err.Error())
	}
	cache := cfg.SettlementCache
	if cache == nil {
		cache = svm.NewSettlementCache()
	}
	return &ExactSvmSchemeV1{
		signer:              signer,
		settlementCache:     cache,
		transactionVersions: transactionVersions,
	}
}

// Scheme returns the scheme identifier
func (f *ExactSvmSchemeV1) Scheme() string {
	return svm.SchemeExact
}

// CaipFamily returns the CAIP family pattern this facilitator supports
func (f *ExactSvmSchemeV1) CaipFamily() string {
	return "solana:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// For SVM, this includes a randomly selected fee payer address.
// Random selection distributes load across multiple signers.
func (f *ExactSvmSchemeV1) GetExtra(network x402.Network) map[string]interface{} {
	addresses := f.signer.GetAddresses(context.Background(), string(network))

	// Randomly select from available addresses to distribute load
	randomIndex := rand.IntN(len(addresses))

	return map[string]interface{}{
		"feePayer":                   addresses[randomIndex].String(),
		svm.ExtraTransactionVersions: append([]int(nil), f.transactionVersions...),
	}
}

// GetSigners returns signer addresses used by this facilitator.
// For SVM, returns all available fee payer addresses for the given network.
func (f *ExactSvmSchemeV1) GetSigners(network x402.Network) []string {
	addresses := f.signer.GetAddresses(context.Background(), string(network))
	result := make([]string, len(addresses))
	for i, addr := range addresses {
		result[i] = addr.String()
	}
	return result
}

// Verify verifies a V1 payment payload against requirements
func (f *ExactSvmSchemeV1) Verify(
	ctx context.Context,
	payload types.PaymentPayloadV1,
	requirements types.PaymentRequirementsV1,
	_ *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	network := x402.Network(requirements.Network)

	// Step 1: Validate Payment Requirements
	// V1: Check scheme from top level (not in Accepted)
	if payload.Scheme != svm.SchemeExact || requirements.Scheme != svm.SchemeExact {
		return nil, x402.NewVerifyError(ErrUnsupportedScheme, "", fmt.Sprintf("invalid scheme: %s", payload.Scheme))
	}

	// V1: Use payload.Network for validation (top level, not in Accepted)
	if payload.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, "", fmt.Sprintf("network mismatch: %s != %s", payload.Network, requirements.Network))
	}

	// Parse extra field for feePayer
	var reqExtraMap map[string]interface{}
	if requirements.Extra != nil {
		if err := json.Unmarshal(*requirements.Extra, &reqExtraMap); err != nil {
			return nil, x402.NewVerifyError(ErrInvalidExtraField, "", err.Error())
		}
	}

	if reqExtraMap == nil || reqExtraMap["feePayer"] == nil {
		return nil, x402.NewVerifyError(ErrMissingFeePayer, "", "missing feePayer")
	}

	feePayerStr, ok := reqExtraMap["feePayer"].(string)
	if !ok {
		return nil, x402.NewVerifyError(ErrMissingFeePayer, "", fmt.Sprintf("invalid feePayer: %v", reqExtraMap["feePayer"]))
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
	svmPayload, err := svm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayloadTransaction, "", err.Error())
	}

	// Step 2: Parse and Validate Transaction Structure
	// Read the version from the raw bytes first so a newer wire format is
	// reported as unsupported however the installed decoder handles it.
	if wireVersion, ok := svm.PeekWireTransactionVersion(svmPayload.Transaction); ok && !svm.IsAcceptedWireTransactionVersionIn(wireVersion, f.transactionVersions) {
		return nil, x402.NewVerifyError(ErrUnsupportedTransactionVersion, "", fmt.Sprintf("unsupported transaction message version %d", wireVersion))
	}
	tx, err := svm.DecodeTransaction(svmPayload.Transaction)
	if err != nil {
		return nil, x402.NewVerifyError(ErrTransactionCouldNotBeDecoded, "", err.Error())
	}

	// Message version gate, before any signature or instruction check.
	if !svm.IsAcceptedTransactionVersionIn(tx.Message.GetVersion(), f.transactionVersions) {
		return nil, x402.NewVerifyError(ErrUnsupportedTransactionVersion, "", fmt.Sprintf("unsupported transaction message version %d", svm.WireTransactionVersion(tx.Message.GetVersion())))
	}

	// Size limit of the message version (§1.5): 1232 bytes for legacy and
	// version 0, 4096 for version 1. The decoder accepts larger payloads.
	if size, limit, exceeded := svm.TransactionSizeExceeded(svmPayload.Transaction, tx.Message.GetVersion()); exceeded {
		return nil, x402.NewVerifyError(ErrTransactionSizeExceeded, "", fmt.Sprintf("transaction is %d bytes, above the %d-byte limit", size, limit))
	}

	if err := exactv2.VerifyRequiredSignatures(tx, feePayerStr); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	if len(tx.Message.GetAddressTableLookups()) > 0 {
		return nil, x402.NewVerifyError(ErrTransactionCouldNotBeDecoded, "", "transaction uses Address Lookup Tables")
	}

	// Legacy and version 0 allow 3-6 instructions:
	// - 3 instructions: ComputeLimit + ComputePrice + TransferChecked
	// - 4 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse or Memo
	// - 5 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse or Memo
	// - 6 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse + Memo
	// See: https://github.com/x402-foundation/x402/issues/828
	// Version 1 carries the compute budget in its message config, so the same
	// layout starts at the TransferChecked: 1-4 instructions.
	transferIndex := 2
	if tx.Message.GetVersion() == solana.MessageVersionV1 {
		transferIndex = 0
	}
	numInstructions := len(tx.Message.Instructions)
	minInstructions, maxInstructions := transferIndex+1, transferIndex+4
	if numInstructions < minInstructions || numInstructions > maxInstructions {
		return nil, x402.NewVerifyError(ErrTransactionInstructionsLength, "", fmt.Sprintf("transaction instructions length mismatch: %d < %d or %d > %d", numInstructions, minInstructions, numInstructions, maxInstructions))
	}

	// Step 3: Verify the compute budget
	if transferIndex == 0 {
		if err := verifyTransactionV1Config(tx); err != nil {
			return nil, x402.NewVerifyError(err.Error(), "", err.Error())
		}
	} else {
		if err := f.verifyComputeLimitInstruction(tx, tx.Message.Instructions[0]); err != nil {
			return nil, x402.NewVerifyError(err.Error(), "", err.Error())
		}

		if err := f.verifyComputePriceInstruction(tx, tx.Message.Instructions[1]); err != nil {
			return nil, x402.NewVerifyError(err.Error(), "", err.Error())
		}
	}

	// Extract payer from transaction
	payer, err := svm.GetTokenPayerFromTransaction(tx)
	if err != nil {
		return nil, x402.NewVerifyError(ErrNoTransferInstruction, payer, err.Error())
	}

	// Step 4: Verify Transfer Instruction
	if err := f.verifyTransferInstruction(tx, tx.Message.Instructions[transferIndex], requirements, signerAddressStrs); err != nil {
		return nil, x402.NewVerifyError(err.Error(), payer, err.Error())
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
		}

		for i, instruction := range optionalInstructions {
			progID, progErr := tx.Message.Program(instruction.ProgramIDIndex)
			if progErr != nil {
				reason := ErrUnknownSixthInstruction
				if i < len(invalidReasons) {
					reason = invalidReasons[i]
				}
				return nil, x402.NewVerifyError(reason, payer, progErr.Error())
			}
			if progID.Equals(lighthousePubkey) || progID.Equals(memoPubkey) {
				continue
			}

			reason := ErrUnknownSixthInstruction
			if i < len(invalidReasons) {
				reason = invalidReasons[i]
			}

			return nil, x402.NewVerifyError(reason, payer, fmt.Sprintf("unknown optional instruction: %s", progID.String()))
		}

		// Step 5b: Verify memo content matches extra.memo when present
		if expectedMemo, ok := reqExtraMap["memo"].(string); ok && expectedMemo != "" {
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
				return nil, x402.NewVerifyError(ErrMemoCount, payer, "expected exactly one memo instruction when extra.memo is present")
			}
			if string(actualMemoData) != expectedMemo {
				return nil, x402.NewVerifyError(ErrMemoMismatch, payer, "memo data does not match extra.memo")
			}
		}
	}

	// Step 6: Simulate Transaction
	// CRITICAL: Simulation proves transaction will succeed (catches insufficient balance, invalid accounts, etc)
	// Signatures are verified locally; the fee-payer slot is unsigned until settle.
	if err := f.signer.SimulateTransaction(ctx, tx, string(requirements.Network), nil); err != nil {
		return nil, x402.NewVerifyError(ErrTransactionSimulationFailed, payer, err.Error())
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   payer,
	}, nil
}

// Settle settles a payment by submitting the transaction (V1)
// Ensures the correct signer is used based on the feePayer specified in requirements.
func (f *ExactSvmSchemeV1) Settle(
	ctx context.Context,
	payload types.PaymentPayloadV1,
	requirements types.PaymentRequirementsV1,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Network)

	// Parse payload
	svmPayload, err := svm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, "", network, "", err.Error())
	}
	// Decode transaction before the cache check so we can key on the message hash.
	if wireVersion, ok := svm.PeekWireTransactionVersion(svmPayload.Transaction); ok && !svm.IsAcceptedWireTransactionVersionIn(wireVersion, f.transactionVersions) {
		return nil, x402.NewSettleError(ErrUnsupportedTransactionVersion, "", network, "", fmt.Sprintf("unsupported transaction message version %d", wireVersion))
	}
	tx, err := svm.DecodeTransaction(svmPayload.Transaction)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, "", network, "", err.Error())
	}
	if !svm.IsAcceptedTransactionVersionIn(tx.Message.GetVersion(), f.transactionVersions) {
		return nil, x402.NewSettleError(ErrUnsupportedTransactionVersion, "", network, "", fmt.Sprintf("unsupported transaction message version %d", svm.WireTransactionVersion(tx.Message.GetVersion())))
	}
	txKey, err := svm.MessageHash(tx)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, "", network, "", err.Error())
	}
	// Duplicate settlement check keyed on message hash (immune to mutable fee-payer sig at slot 0).
	if f.settlementCache.IsDuplicate(txKey) {
		payer, _ := svm.GetTokenPayerFromTransaction(tx)
		return nil, x402.NewSettleError(ErrDuplicateSettlement, payer, network, "", "duplicate transaction")
	}

	// First verify the payment
	verifyResp, err := f.Verify(ctx, payload, requirements, fctx)
	if err != nil {
		f.settlementCache.Delete(txKey)
		// Convert VerifyError to SettleError
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	// Parse extra field for feePayer (V1 uses *json.RawMessage)
	var reqExtraMap map[string]interface{}
	if requirements.Extra != nil {
		if err := json.Unmarshal(*requirements.Extra, &reqExtraMap); err != nil {
			f.settlementCache.Delete(txKey)
			return nil, x402.NewSettleError(ErrInvalidExtraField, verifyResp.Payer, network, "", err.Error())
		}
	}

	feePayerStr, ok := reqExtraMap["feePayer"].(string)
	if !ok {
		f.settlementCache.Delete(txKey)
		return nil, x402.NewSettleError(ErrMissingFeePayer, verifyResp.Payer, network, "", "")
	}

	expectedFeePayer, err := solana.PublicKeyFromBase58(feePayerStr)
	if err != nil {
		f.settlementCache.Delete(txKey)
		return nil, x402.NewSettleError(ErrInvalidFeePayer, verifyResp.Payer, network, "", err.Error())
	}

	// Sign with the feePayer's signer
	if err := f.signer.SignTransaction(ctx, tx, expectedFeePayer, string(requirements.Network)); err != nil {
		f.settlementCache.Delete(txKey)
		return nil, x402.NewSettleError(ErrTransactionFailed, verifyResp.Payer, network, "", err.Error())
	}

	// Send transaction to network
	signature, err := f.signer.SendTransaction(ctx, tx, string(requirements.Network))
	if err != nil {
		f.settlementCache.Delete(txKey)
		return nil, x402.NewSettleError(ErrTransactionFailed, verifyResp.Payer, network, "", err.Error())
	}

	// Wait for confirmation
	if err := f.signer.ConfirmTransaction(ctx, signature, string(requirements.Network)); err != nil {
		f.settlementCache.Delete(txKey)
		return nil, x402.NewSettleError(ErrTransactionConfirmationFailed, verifyResp.Payer, network, signature.String(), err.Error())
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: signature.String(),
		Network:     network,
		Payer:       verifyResp.Payer,
	}, nil
}

// verifyTransactionV1Config applies the compute caps to a version-1 message
// config (SIMD-0385), which replaces the ComputeBudget instructions. Like the
// version-0 check, the compute unit limit is uncapped and the price is capped
// at svm.MaxComputeUnitPriceMicrolamports.
func verifyTransactionV1Config(tx *solana.Transaction) error {
	switch svm.ValidateTransactionV1Config(&tx.Message, math.MaxUint32, svm.MaxComputeUnitPriceMicrolamports) {
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
func (f *ExactSvmSchemeV1) verifyComputeLimitInstruction(tx *solana.Transaction, inst solana.CompiledInstruction) error {
	progID, err := tx.Message.Program(inst.ProgramIDIndex)
	if err != nil || !progID.Equals(solana.ComputeBudget) {
		return errors.New(ErrComputeLimitInstruction)
	}

	// Check discriminator (should be 2 for SetComputeUnitLimit)
	if len(inst.Data) < 5 || inst.Data[0] != 2 {
		return errors.New(ErrComputeLimitInstruction)
	}

	// Decode to validate format
	return nil
}

// verifyComputePriceInstruction verifies the compute unit price instruction
func (f *ExactSvmSchemeV1) verifyComputePriceInstruction(tx *solana.Transaction, inst solana.CompiledInstruction) error {
	progID, err := tx.Message.Program(inst.ProgramIDIndex)
	if err != nil || !progID.Equals(solana.ComputeBudget) {
		return errors.New(ErrComputePriceInstruction)
	}

	// Check discriminator (should be 3 for SetComputeUnitPrice)
	if len(inst.Data) < 9 || inst.Data[0] != 3 {
		return errors.New(ErrComputePriceInstruction)
	}

	// Decode to get microLamports
	microLamports := binary.LittleEndian.Uint64(inst.Data[1:9])
	// Check if it's SetComputeUnitPrice and validate the price
	if microLamports > uint64(svm.MaxComputeUnitPriceMicrolamports) {
		// Check if price exceeds maximum (5 lamports per compute unit = 5,000,000 microlamports)
		return errors.New(ErrComputePriceInstructionTooHigh)
	}

	return nil
}

// verifyTransferInstruction verifies the transfer instruction
func (f *ExactSvmSchemeV1) verifyTransferInstruction(
	tx *solana.Transaction,
	inst solana.CompiledInstruction,
	requirements types.PaymentRequirementsV1,
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

	expectedDestATA, _, err := solana.FindAssociatedTokenAddress(payToPubkey, mintPubkey)
	if err != nil {
		return errors.New(ErrRecipientMismatch)
	}

	destATA := transferChecked.GetDestinationAccount().PublicKey
	if destATA.String() != expectedDestATA.String() {
		return errors.New(ErrRecipientMismatch)
	}

	// Verify amount - V1: Use MaxAmountRequired
	amountStr := requirements.MaxAmountRequired

	requiredAmount, err := strconv.ParseUint(amountStr, 10, 64)
	if err != nil {
		return errors.New(ErrAmountMismatch)
	}

	if *transferChecked.Amount != requiredAmount {
		return errors.New(ErrAmountMismatch)
	}

	return nil
}
