package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/mechanisms/svm"
	"github.com/x402-foundation/x402/go/types"
)

// ExactSvmScheme implements the SchemeNetworkClient interface for SVM (Solana) exact payments (V2)
type ExactSvmScheme struct {
	signer svm.ClientSvmSigner
	config *svm.ClientConfig // Optional custom RPC configuration
}

// NewExactSvmScheme creates a new ExactSvmScheme
// Config is optional - if not provided, uses network defaults
func NewExactSvmScheme(signer svm.ClientSvmSigner, config ...*svm.ClientConfig) *ExactSvmScheme {
	var cfg *svm.ClientConfig
	if len(config) > 0 {
		cfg = config[0]
	}
	return &ExactSvmScheme{
		signer: signer,
		config: cfg,
	}
}

// Scheme returns the scheme identifier
func (c *ExactSvmScheme) Scheme() string {
	return svm.SchemeExact
}

// CreatePaymentPayload creates a V2 payment payload for the Exact scheme
func (c *ExactSvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	// Validate network
	networkStr := string(requirements.Network)
	if !svm.IsValidNetwork(networkStr) {
		return types.PaymentPayload{}, fmt.Errorf(ErrUnsupportedNetwork+": %s", requirements.Network)
	}

	// Get network configuration
	config, err := svm.GetNetworkConfig(networkStr)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// Get RPC URL (custom or default)
	rpcURL := config.RPCURL
	if c.config != nil && c.config.RPCURL != "" {
		rpcURL = c.config.RPCURL
	}

	// Create RPC client
	rpcClient := rpc.New(rpcURL)

	// Parse mint address
	mintPubkey, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAssetAddress+": %w", err)
	}

	// Get mint account to determine token program
	mintAccount, err := rpcClient.GetAccountInfo(ctx, mintPubkey)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToGetMintAccount+": %w", err)
	}

	// Determine token program (Token or Token-2022)
	tokenProgramID := mintAccount.Value.Owner
	if tokenProgramID != solana.TokenProgramID && tokenProgramID != solana.Token2022ProgramID {
		return types.PaymentPayload{}, errors.New(ErrUnknownTokenProgram)
	}

	// Parse payTo address
	payToPubkey, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidPayToAddress+": %w", err)
	}

	// Find source ATA (client's token account)
	sourceATA, _, err := solana.FindAssociatedTokenAddress(c.signer.Address(), mintPubkey)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToDeriveSourceATA+": %w", err)
	}

	// Find destination ATA (recipient's token account)
	destinationATA, _, err := solana.FindAssociatedTokenAddress(payToPubkey, mintPubkey)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToDeriveDestinationATA+": %w", err)
	}

	// Parse amount
	amount, err := strconv.ParseUint(requirements.Amount, 10, 64)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAmount+": %w", err)
	}

	// Get fee payer from requirements.extra
	feePayerAddr, ok := requirements.Extra["feePayer"].(string)
	if !ok {
		return types.PaymentPayload{}, errors.New(ErrFeePayerRequired)
	}

	feePayer, err := solana.PublicKeyFromBase58(feePayerAddr)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidFeePayerAddress+": %w", err)
	}

	// Get mint account data to get decimals
	var mintData token.Mint
	err = bin.NewBinDecoder(mintAccount.Value.Data.GetBinary()).Decode(&mintData)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToDecodeMintData+": %w", err)
	}

	// Get latest blockhash
	latestBlockhash, err := rpcClient.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToGetLatestBlockhash+": %w", err)
	}
	recentBlockhash := latestBlockhash.Value.Blockhash

	// Build compute budget instructions
	cuLimit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(svm.DefaultComputeUnitLimit).
		ValidateAndBuild()
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToBuildComputeLimitIx+": %w", err)
	}

	cuPrice, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
		SetMicroLamports(svm.DefaultComputeUnitPriceMicrolamports).
		ValidateAndBuild()
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToBuildComputePriceIx+": %w", err)
	}

	// Build final transfer instruction
	transferIx, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(amount).
		SetDecimals(mintData.Decimals).
		SetSourceAccount(sourceATA).
		SetMintAccount(mintPubkey).
		SetDestinationAccount(destinationATA).
		SetOwnerAccount(c.signer.Address()).
		ValidateAndBuild()
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToBuildTransferIx+": %w", err)
	}

	// Memo instruction: use seller-defined memo from extra.memo, or random nonce for uniqueness
	var memoPayload []byte
	if memoStr, ok := requirements.Extra["memo"].(string); ok && memoStr != "" {
		memoPayload = []byte(memoStr)
		if len(memoPayload) > svm.MaxMemoBytes {
			return types.PaymentPayload{}, errors.New(ErrMemoExceedsMaxSize)
		}
	} else {
		memoBytes := make([]byte, 16)
		if _, err := rand.Read(memoBytes); err != nil {
			return types.PaymentPayload{}, fmt.Errorf(ErrFailedToBuildMemoIx+": %w", err)
		}
		memoPayload = []byte(hex.EncodeToString(memoBytes))
	}
	memoIx := solana.NewInstruction(
		solana.MustPublicKeyFromBase58(svm.MemoProgramAddress),
		solana.AccountMetaSlice{},
		memoPayload,
	)

	// Create final transaction
	tx, err := solana.NewTransactionBuilder().
		AddInstruction(cuLimit).
		AddInstruction(cuPrice).
		AddInstruction(transferIx).
		AddInstruction(memoIx).
		SetRecentBlockHash(recentBlockhash).
		SetFeePayer(feePayer).
		Build()
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToCreateTransaction+": %w", err)
	}

	// Set message version to V0 (versioned transaction) for cross-platform compatibility
	// This ensures the transaction can be correctly signed by facilitators in all languages
	// (TypeScript, Python, Go) as they all expect versioned transactions
	tx.Message.SetVersion(solana.MessageVersionV0)

	// Partially sign with client's key
	if err := c.signer.SignTransaction(ctx, tx); err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignTransaction+": %w", err)
	}

	// Encode transaction to base64
	base64Tx, err := svm.EncodeTransaction(tx)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToEncodeTransaction+": %w", err)
	}

	// Create SVM payload
	svmPayload := &svm.ExactSvmPayload{
		Transaction: base64Tx,
	}

	// Return partial V2 payload (core will add accepted, resource, extensions)
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     svmPayload.ToMap(),
	}, nil
}
