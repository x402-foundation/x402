package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/programs/token"

	x402 "github.com/coinbase/x402/go"
	svm "github.com/coinbase/x402/go/mechanisms/svm"
	"github.com/coinbase/x402/go/types"
)

// ExactSvmSchemeV1 implements the SchemeNetworkFacilitator interface for SVM (Solana) exact payments (V1)
type ExactSvmSchemeV1 struct {
	signer          svm.FacilitatorSvmSigner
	settlementCache *svm.SettlementCache
}

// NewExactSvmSchemeV1 creates a new ExactSvmSchemeV1.
// An optional SettlementCache may be provided to share deduplication state
// across V1 and V2 instances; if nil a new cache is created.
func NewExactSvmSchemeV1(signer svm.FacilitatorSvmSigner, cache ...*svm.SettlementCache) *ExactSvmSchemeV1 {
	var c *svm.SettlementCache
	if len(cache) > 0 && cache[0] != nil {
		c = cache[0]
	} else {
		c = svm.NewSettlementCache()
	}
	return &ExactSvmSchemeV1{
		signer:          signer,
		settlementCache: c,
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
	randomIndex := rand.Intn(len(addresses))

	return map[string]interface{}{
		"feePayer": addresses[randomIndex].String(),
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
	tx, err := svm.DecodeTransaction(svmPayload.Transaction)
	if err != nil {
		return nil, x402.NewVerifyError(ErrTransactionCouldNotBeDecoded, "", err.Error())
	}

	// Allow 3-6 instructions:
	// - 3 instructions: ComputeLimit + ComputePrice + TransferChecked
	// - 4 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse or Memo
	// - 5 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse or Memo
	// - 6 instructions: ComputeLimit + ComputePrice + TransferChecked + Lighthouse + Lighthouse + Memo
	// See: https://github.com/coinbase/x402/issues/828
	numInstructions := len(tx.Message.Instructions)
	if numInstructions < 3 || numInstructions > 6 {
		return nil, x402.NewVerifyError(ErrTransactionInstructionsLength, "", fmt.Sprintf("transaction instructions length mismatch: %d < 3 or %d > 6", numInstructions, numInstructions))
	}

	// Step 3: Verify Compute Budget Instructions
	if err := f.verifyComputeLimitInstruction(tx, tx.Message.Instructions[0]); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	if err := f.verifyComputePriceInstruction(tx, tx.Message.Instructions[1]); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	// Extract payer from transaction
	payer, err := svm.GetTokenPayerFromTransaction(tx)
	if err != nil {
		return nil, x402.NewVerifyError(ErrNoTransferInstruction, payer, err.Error())
	}

	// Step 4: Verify Transfer Instruction
	if err := f.verifyTransferInstruction(tx, tx.Message.Instructions[2], requirements, signerAddressStrs); err != nil {
		return nil, x402.NewVerifyError(err.Error(), payer, err.Error())
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
		}

		for i, instruction := range optionalInstructions {
			progID := tx.Message.AccountKeys[instruction.ProgramIDIndex]
			if progID.Equals(lighthousePubkey) || progID.Equals(memoPubkey) {
				continue
			}

			reason := ErrUnknownSixthInstruction
			if i < len(invalidReasons) {
				reason = invalidReasons[i]
			}

			return nil, x402.NewVerifyError(reason, payer, fmt.Sprintf("unknown optional instruction: %s", progID.String()))
		}
	}

	// Step 6: Sign and Simulate Transaction
	// CRITICAL: Simulation proves transaction will succeed (catches insufficient balance, invalid accounts, etc)

	// feePayer already validated in Step 1
	feePayer, err := solana.PublicKeyFromBase58(feePayerStr)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidFeePayer, payer, err.Error())
	}

	// Sign transaction with the feePayer's signer
	if err := f.signer.SignTransaction(ctx, tx, feePayer, string(requirements.Network)); err != nil {
		return nil, x402.NewVerifyError(ErrTransactionSigningFailed, payer, err.Error())
	}

	// Simulate transaction to verify it would succeed
	if err := f.signer.SimulateTransaction(ctx, tx, string(requirements.Network)); err != nil {
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

	// First verify the payment
	verifyResp, err := f.Verify(ctx, payload, requirements, fctx)
	if err != nil {
		// Convert VerifyError to SettleError
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	// Parse payload
	svmPayload, err := svm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, verifyResp.Payer, network, "", err.Error())
	}

	// Duplicate settlement check: reject if this transaction is already being settled.
	txKey := svmPayload.Transaction
	if f.settlementCache.IsDuplicate(txKey) {
		return nil, x402.NewSettleError(ErrDuplicateSettlement, verifyResp.Payer, network, "", "duplicate transaction")
	}

	// Decode transaction
	tx, err := svm.DecodeTransaction(svmPayload.Transaction)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayloadTransaction, verifyResp.Payer, network, "", err.Error())
	}

	// Parse extra field for feePayer (V1 uses *json.RawMessage)
	var reqExtraMap map[string]interface{}
	if requirements.Extra != nil {
		if err := json.Unmarshal(*requirements.Extra, &reqExtraMap); err != nil {
			return nil, x402.NewSettleError(ErrInvalidExtraField, verifyResp.Payer, network, "", err.Error())
		}
	}

	// Extract and validate feePayer from requirements matches transaction
	feePayerStr, ok := reqExtraMap["feePayer"].(string)
	if !ok {
		return nil, x402.NewSettleError(ErrMissingFeePayer, verifyResp.Payer, network, "", "")
	}

	expectedFeePayer, err := solana.PublicKeyFromBase58(feePayerStr)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidFeePayer, verifyResp.Payer, network, "", err.Error())
	}

	// Verify transaction feePayer matches requirements
	actualFeePayer := tx.Message.AccountKeys[0] // First account is fee payer
	if actualFeePayer != expectedFeePayer {
		return nil, x402.NewSettleError(ErrFeePayerMismatch, verifyResp.Payer, network, "",
			fmt.Sprintf("expected %s, got %s", expectedFeePayer, actualFeePayer))
	}

	// Sign with the feePayer's signer
	if err := f.signer.SignTransaction(ctx, tx, expectedFeePayer, string(requirements.Network)); err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, verifyResp.Payer, network, "", err.Error())
	}

	// Send transaction to network
	signature, err := f.signer.SendTransaction(ctx, tx, string(requirements.Network))
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, verifyResp.Payer, network, "", err.Error())
	}

	// Wait for confirmation
	if err := f.signer.ConfirmTransaction(ctx, signature, string(requirements.Network)); err != nil {
		return nil, x402.NewSettleError(ErrTransactionConfirmationFailed, verifyResp.Payer, network, signature.String(), err.Error())
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: signature.String(),
		Network:     network,
		Payer:       verifyResp.Payer,
	}, nil
}

// verifyComputeLimitInstruction verifies the compute unit limit instruction
func (f *ExactSvmSchemeV1) verifyComputeLimitInstruction(tx *solana.Transaction, inst solana.CompiledInstruction) error {
	progID := tx.Message.AccountKeys[inst.ProgramIDIndex]

	if !progID.Equals(solana.ComputeBudget) {
		return errors.New(ErrComputeLimitInstruction)
	}

	// Check discriminator (should be 2 for SetComputeUnitLimit)
	if len(inst.Data) < 1 || inst.Data[0] != 2 {
		return errors.New(ErrComputeLimitInstruction)
	}

	// Decode to validate format
	accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
	if err != nil {
		return errors.New(ErrComputeLimitInstruction)
	}

	_, err = computebudget.DecodeInstruction(accounts, inst.Data)
	if err != nil {
		return errors.New(ErrComputeLimitInstruction)
	}

	return nil
}

// verifyComputePriceInstruction verifies the compute unit price instruction
func (f *ExactSvmSchemeV1) verifyComputePriceInstruction(tx *solana.Transaction, inst solana.CompiledInstruction) error {
	progID := tx.Message.AccountKeys[inst.ProgramIDIndex]

	if !progID.Equals(solana.ComputeBudget) {
		return errors.New(ErrComputePriceInstruction)
	}

	// Check discriminator (should be 3 for SetComputeUnitPrice)
	if len(inst.Data) < 1 || inst.Data[0] != 3 {
		return errors.New(ErrComputePriceInstruction)
	}

	// Decode to get microLamports
	accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
	if err != nil {
		return errors.New(ErrComputePriceInstruction)
	}

	decoded, err := computebudget.DecodeInstruction(accounts, inst.Data)
	if err != nil {
		return errors.New(ErrComputePriceInstruction)
	}

	// Check if it's SetComputeUnitPrice and validate the price
	if priceInst, ok := decoded.Impl.(*computebudget.SetComputeUnitPrice); ok {
		// Check if price exceeds maximum (5 lamports per compute unit = 5,000,000 microlamports)
		if priceInst.MicroLamports > uint64(svm.MaxComputeUnitPriceMicrolamports) {
			return errors.New(ErrComputePriceInstructionTooHigh)
		}
	} else {
		return errors.New(ErrComputePriceInstruction)
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
	progID := tx.Message.AccountKeys[inst.ProgramIDIndex]

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
		return errors.New(ErrAmountInsufficient)
	}

	if *transferChecked.Amount < requiredAmount {
		return errors.New(ErrAmountInsufficient)
	}

	return nil
}
