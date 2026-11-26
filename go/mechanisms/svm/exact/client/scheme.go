package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ExactSvmScheme implements the SchemeNetworkClient interface for SVM (Solana) exact payments (V2)
type ExactSvmScheme struct {
	signer    svm.ClientSvmSigner
	config    *svm.ClientConfig // Optional custom RPC configuration
	mintCache *svm.MintMetadataCache
}

// NewExactSvmScheme creates a new ExactSvmScheme
// Config is optional - if not provided, uses network defaults
func NewExactSvmScheme(signer svm.ClientSvmSigner, config ...*svm.ClientConfig) *ExactSvmScheme {
	var cfg *svm.ClientConfig
	if len(config) > 0 {
		cfg = config[0]
	}
	return &ExactSvmScheme{
		signer:    signer,
		config:    cfg,
		mintCache: svm.NewMintMetadataCache(),
	}
}

// Scheme returns the scheme identifier
func (c *ExactSvmScheme) Scheme() string {
	return svm.SchemeExact
}

func (c *ExactSvmScheme) FindDefaultAsset(asset string, network x402.Network) *x402.DefaultAsset {
	info := svm.FindDefaultAsset(asset, string(network))
	if info == nil {
		return nil
	}
	return &x402.DefaultAsset{Asset: info.Asset, Decimals: info.Decimals, Symbol: info.Symbol}
}

// CreatePaymentPayload creates a V2 payment payload for the Exact scheme
func (c *ExactSvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	_ x402.PaymentPayloadContext,
) (types.PaymentPayload, error) {
	// Validate network
	networkStr := string(requirements.Network)
	if !svm.IsValidNetwork(networkStr) {
		return types.PaymentPayload{}, fmt.Errorf(ErrUnsupportedNetwork+": %s", requirements.Network)
	}
	version, err := svm.ResolveTransactionVersionFor(requirements.Extra, c.config.ClientTransactionVersions())
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// Validate payment terms before RPC work. Recipient screening belongs in
	// the core client payment-creation hook.
	var legs []svm.PaymentLeg
	if svm.UsesSplitTerms(requirements) {
		parsed, err := svm.ParsePaymentLegs(requirements)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		legs = parsed
	}

	// Get network configuration
	config, err := svm.GetNetworkConfig(networkStr)
	if err != nil {
		return types.PaymentPayload{}, err
	}
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

	mintMetadata, err := c.mintCache.GetOrFetch(ctx, rpcClient, networkStr, mintPubkey)
	if err != nil {
		if errors.Is(err, svm.ErrUnknownMintTokenProgram) {
			return types.PaymentPayload{}, errors.New(ErrUnknownTokenProgram)
		}
		if errors.Is(err, svm.ErrFailedToDecodeMintData) {
			return types.PaymentPayload{}, fmt.Errorf(ErrFailedToDecodeMintData+": %w", err)
		}
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToGetMintAccount+": %w", err)
	}

	// Determine token program (Token or Token-2022)
	tokenProgramID := mintMetadata.TokenProgramID
	if tokenProgramID != solana.TokenProgramID && tokenProgramID != solana.Token2022ProgramID {
		return types.PaymentPayload{}, errors.New(ErrUnknownTokenProgram)
	}

	// Parse payTo address
	payToPubkey, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidPayToAddress+": %w", err)
	}

	// Find source ATA (client's token account)
	sourceATA, err := svm.DeriveATA(c.signer.Address(), mintPubkey, tokenProgramID)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToDeriveSourceATA+": %w", err)
	}

	if legs == nil {
		// No parsed splits: one primary leg for the full amount.
		amount, err := strconv.ParseUint(requirements.Amount, 10, 64)
		if err != nil {
			return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAmount+": %w", err)
		}
		legs = []svm.PaymentLeg{{Owner: payToPubkey, Amount: amount, IsPrimary: true}}
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

	recentBlockhash, err := c.resolveRecentBlockhash(ctx, rpcClient, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// One TransferChecked per leg, primary first (§5.7). A marked recipient gets
	// a fee-payer-funded CreateIdempotent unless its ATA is confirmed (§5.4).
	var createIxs, transferIxs []solana.Instruction
	for _, leg := range legs {
		destinationATA, err := svm.DeriveATA(leg.Owner, mintPubkey, tokenProgramID)
		if err != nil {
			return types.PaymentPayload{}, fmt.Errorf(ErrFailedToDeriveDestinationATA+": %w", err)
		}
		if leg.AtaCreationRequired && !accountExists(ctx, rpcClient, destinationATA) {
			createIxs = append(createIxs, svm.NewCreateIdempotentInstruction(
				feePayer, destinationATA, leg.Owner, mintPubkey, tokenProgramID,
			))
		}
		transferIx, err := token.NewTransferCheckedInstructionBuilder().
			SetAmount(leg.Amount).
			SetDecimals(mintMetadata.Decimals).
			SetSourceAccount(sourceATA).
			SetMintAccount(mintPubkey).
			SetDestinationAccount(destinationATA).
			SetOwnerAccount(c.signer.Address()).
			ValidateAndBuild()
		if err != nil {
			return types.PaymentPayload{}, fmt.Errorf(ErrFailedToBuildTransferIx+": %w", err)
		}
		transferData, err := transferIx.Data()
		if err != nil {
			return types.PaymentPayload{}, fmt.Errorf(ErrFailedToBuildTransferIx+": %w", err)
		}
		// Bind the mint's program to this instruction without changing token.ProgramID globally.
		transferIxs = append(transferIxs, solana.NewInstruction(tokenProgramID, transferIx.Accounts(), transferData))
	}
	computeUnitLimit := min(svm.DefaultMaxComputeUnits, svm.DefaultComputeUnitLimit+
		uint32(len(legs)-1)*svm.SplitTransferComputeUnits+
		uint32(len(createIxs))*svm.AtaCreationComputeUnits)

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

	// Build the highest message version shared with extra.transactionVersions
	// (version 0 when absent). Version 0 carries the compute budget as
	// ComputeBudget instructions; version 1 carries it in the message config.
	instructions := append(append(createIxs, transferIxs...), memoIx)
	tx, err := svm.BuildClientTransaction(
		version,
		feePayer,
		recentBlockhash,
		instructions,
		computeUnitLimit,
		svm.DefaultComputeUnitPriceMicrolamports,
	)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToCreateTransaction+": %w", err)
	}

	// Partially sign with client's key
	if err := c.signer.SignTransaction(ctx, tx); err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignTransaction+": %w", err)
	}

	// Encode transaction to base64
	base64Tx, err := svm.EncodeTransaction(tx)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToEncodeTransaction+": %w", err)
	}

	// Each leg adds a transfer and maybe an ATA creation (§5.2). Reject a
	// transaction over its version's size limit instead of failing at settlement.
	if size, limit, exceeded := svm.TransactionSizeExceeded(base64Tx, version); exceeded {
		return types.PaymentPayload{}, fmt.Errorf("%s: transaction is %d bytes, over the %d-byte limit; reduce extra.splits or ATA creations",
			ErrTransactionTooLarge, size, limit)
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

func (c *ExactSvmScheme) resolveRecentBlockhash(
	ctx context.Context,
	rpcClient *rpc.Client,
	requirements types.PaymentRequirements,
) (solana.Hash, error) {
	if blockhash, ok := requirements.Extra["recentBlockhash"].(string); ok && blockhash != "" {
		recentBlockhash, err := solana.HashFromBase58(blockhash)
		if err == nil {
			return recentBlockhash, nil
		}
	}

	latestBlockhash, err := rpcClient.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return solana.Hash{}, fmt.Errorf(ErrFailedToGetLatestBlockhash+": %w", err)
	}
	return latestBlockhash.Value.Blockhash, nil
}

// accountExists reports a confirmed account. An RPC failure counts as absent,
// so the caller includes an idempotent creation.
func accountExists(ctx context.Context, rpcClient *rpc.Client, address solana.PublicKey) bool {
	out, err := rpcClient.GetAccountInfoWithOpts(ctx, address, &rpc.GetAccountInfoOpts{
		Encoding:   solana.EncodingBase64,
		Commitment: rpc.CommitmentConfirmed,
	})
	return err == nil && out != nil && out.Value != nil
}
