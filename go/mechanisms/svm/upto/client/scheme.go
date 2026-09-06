// Package client implements the SVM client role of the `upto` payment scheme.
package client

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

// UptoSvmScheme implements the SchemeNetworkClient interface for SVM `upto`
// payments.
//
// It builds the channel `open` transaction whose deposit is the authorized
// ceiling, with extra.receiverAuthorizer as authorized signer and
// extra.feePayer as transaction fee payer, rent payer, and zero-share channel
// payee. The client signs only the open; the facilitator broadcasts it and
// later submits the settlement carrying the voucher for the metered amount.
type UptoSvmScheme struct {
	signer    svm.ClientSvmSigner
	config    *svm.ClientConfig
	mintCache *svm.MintMetadataCache
}

// NewUptoSvmScheme creates a new UptoSvmScheme.
// Config is optional - if not provided, uses network defaults.
func NewUptoSvmScheme(signer svm.ClientSvmSigner, config ...*svm.ClientConfig) *UptoSvmScheme {
	var cfg *svm.ClientConfig
	if len(config) > 0 {
		cfg = config[0]
	}
	return &UptoSvmScheme{
		signer:    signer,
		config:    cfg,
		mintCache: svm.NewMintMetadataCache(),
	}
}

// Scheme returns the scheme identifier
func (c *UptoSvmScheme) Scheme() string {
	return svm.SchemeUpto
}

// CreatePaymentPayload creates a payment payload authorizing up to
// requirements.Amount through a payment channel.
func (c *UptoSvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	networkStr := string(requirements.Network)
	if !svm.IsValidNetwork(networkStr) {
		return types.PaymentPayload{}, fmt.Errorf(ErrUnsupportedNetwork+": %s", requirements.Network)
	}

	channelConfig, err := upto.ResolvePaymentChannelConfig(requirements)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidPaymentRequirements+": %w", err)
	}

	feePayer, err := solana.PublicKeyFromBase58(channelConfig.FeePayer)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidFeePayerAddress+": %w", err)
	}
	receiverAuthorizer, err := solana.PublicKeyFromBase58(channelConfig.ReceiverAuthorizer)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidReceiverAuthorizer+": %w", err)
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAssetAddress+": %w", err)
	}
	if _, err := solana.PublicKeyFromBase58(requirements.PayTo); err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidPayToAddress+": %w", err)
	}

	maxAmount, err := strconv.ParseUint(requirements.Amount, 10, 64)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAmount+": %w", err)
	}

	rpcOverride := ""
	if c.config != nil {
		rpcOverride = c.config.RPCURL
	}
	rpcClient, err := upto.NewRPCClient(networkStr, rpcOverride)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	tokenProgram, err := c.resolveTokenProgram(ctx, rpcClient, networkStr, mint, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	blockhash, err := c.resolveBlockhash(ctx, rpcClient, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	openSlot, err := c.resolveOpenSlot(ctx, rpcClient, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	open, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
		Payer:            c.signer.Address(),
		Payee:            feePayer,
		Mint:             mint,
		AuthorizedSigner: receiverAuthorizer,
		FeePayer:         feePayer,
		TokenProgram:     tokenProgram,
		Deposit:          maxAmount,
		Blockhash:        blockhash,
		OpenSlot:         openSlot,
		GracePeriod:      channelConfig.WithdrawDelay,
		Recipients:       channelConfig.Splits,
		Memo:             upto.ParseExtraMemo(requirements.Extra[upto.ExtraMemo]),
	})
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToBuildOpen+": %w", err)
	}

	if err := c.signer.SignTransaction(ctx, open.Transaction); err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignTransaction+": %w", err)
	}
	openTransaction, err := svm.EncodeTransaction(open.Transaction)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToEncodeTransaction+": %w", err)
	}

	now := time.Now().Unix()
	validAfter := now
	if hint, ok := upto.ParseExtraUint64(requirements.Extra[upto.ExtraValidAfter]); ok {
		validAfter = int64(hint)
	}

	payload := &svm.UptoSvmPayload{
		From:             c.signer.Address().String(),
		MaxAmount:        strconv.FormatUint(maxAmount, 10),
		ExpiresAt:        now + int64(requirements.MaxTimeoutSeconds),
		ValidAfter:       validAfter,
		Nonce:            strconv.FormatUint(open.Salt, 10),
		OpenSlot:         strconv.FormatUint(open.OpenSlot, 10),
		ChannelId:        open.ChannelID.String(),
		Deposit:          strconv.FormatUint(maxAmount, 10),
		AuthorizedSigner: channelConfig.ReceiverAuthorizer,
		OpenTransaction:  openTransaction,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     payload.ToMap(),
	}, nil
}

// resolveTokenProgram prefers the requirement's hint and falls back to reading
// the mint account's owner.
func (c *UptoSvmScheme) resolveTokenProgram(
	ctx context.Context,
	rpcClient *rpc.Client,
	network string,
	mint solana.PublicKey,
	requirements types.PaymentRequirements,
) (solana.PublicKey, error) {
	tokenProgram, hinted, err := upto.ParseTokenProgramHint(requirements.Extra)
	if err != nil {
		return solana.PublicKey{}, fmt.Errorf(ErrUnknownTokenProgram+": %w", err)
	}
	if hinted {
		return tokenProgram, nil
	}

	metadata, err := c.mintCache.GetOrFetch(ctx, rpcClient, network, mint)
	if err != nil {
		if errors.Is(err, svm.ErrUnknownMintTokenProgram) {
			return solana.PublicKey{}, errors.New(ErrUnknownTokenProgram)
		}
		if errors.Is(err, svm.ErrFailedToDecodeMintData) {
			return solana.PublicKey{}, fmt.Errorf(ErrFailedToDecodeMintData+": %w", err)
		}
		return solana.PublicKey{}, fmt.Errorf(ErrFailedToGetMintAccount+": %w", err)
	}
	return metadata.TokenProgramID, nil
}

// resolveBlockhash prefers the challenge hint; missing or malformed hints fall
// back to an RPC fetch.
func (c *UptoSvmScheme) resolveBlockhash(
	ctx context.Context,
	rpcClient *rpc.Client,
	requirements types.PaymentRequirements,
) (solana.Hash, error) {
	if hint, ok := requirements.Extra[upto.ExtraRecentBlockhash].(string); ok && hint != "" {
		if blockhash, err := solana.HashFromBase58(hint); err == nil {
			return blockhash, nil
		}
	}

	latest, err := rpcClient.GetLatestBlockhash(ctx, upto.BlockhashCommitment)
	if err != nil {
		return solana.Hash{}, fmt.Errorf(ErrFailedToGetLatestBlockhash+": %w", err)
	}
	return latest.Value.Blockhash, nil
}

// resolveOpenSlot resolves the channel open-slot anchor.
func (c *UptoSvmScheme) resolveOpenSlot(
	ctx context.Context,
	rpcClient *rpc.Client,
	requirements types.PaymentRequirements,
) (uint64, error) {
	if slot, ok := upto.ParseExtraUint64(requirements.Extra[upto.ExtraRecentSlot]); ok {
		return slot, nil
	}

	slot, err := rpcClient.GetSlot(ctx, upto.SlotCommitment)
	if err != nil {
		return 0, fmt.Errorf(ErrFailedToGetSlot+": %w", err)
	}
	return slot, nil
}
