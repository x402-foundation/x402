// Package server implements the SVM resource-server role of the `upto` payment
// scheme: it advertises the payment-channel challenge and signs the settlement
// voucher for the metered amount.
package server

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

// AssetTransferMethodChannel is the asset transfer method advertised for
// SVM `upto`: funds move through an onchain payment channel.
const AssetTransferMethodChannel = "channel"

// Config configures the server-side SVM `upto` scheme.
type Config struct {
	// ReceiverAuthorizerSigner is the server hot key set as the channel
	// authorized_signer. It signs settlement vouchers and is required.
	ReceiverAuthorizerSigner svm.ReceiverAuthorizerSigner

	// WithdrawDelay is the channel grace period in seconds. Defaults to
	// max(DefaultGracePeriodSeconds, maxTimeoutSeconds) per requirement.
	WithdrawDelay uint32

	// RPCURL, when set, is used to embed a fresh recentBlockhash/recentSlot
	// pair in the 402 challenge. Both hints are optional for clients.
	RPCURL string
}

// UptoSvmScheme implements the SchemeNetworkServer interface for SVM `upto`
// payments.
//
// It declares the escrow payment flow: a deposit settle before the handler and
// a claim (or zero-amount cancel) settle after. The voucher for the metered
// amount is attached only on the claim/cancel settle; the deposit settle must
// not carry one.
type UptoSvmScheme struct {
	moneyParsers []x402.MoneyParser
	config       *Config
}

// NewUptoSvmScheme creates a new UptoSvmScheme. The receiver authorizer signer
// is required: without it the server cannot authorize any settlement.
func NewUptoSvmScheme(config *Config) *UptoSvmScheme {
	if config == nil || config.ReceiverAuthorizerSigner == nil {
		panic("upto svm server: ReceiverAuthorizerSigner is required")
	}
	return &UptoSvmScheme{
		moneyParsers: []x402.MoneyParser{},
		config:       config,
	}
}

// Scheme returns the scheme identifier
func (s *UptoSvmScheme) Scheme() string {
	return svm.SchemeUpto
}

// DefaultAssetTransferMethod returns the ATM used when extra.assetTransferMethod is absent.
func (s *UptoSvmScheme) DefaultAssetTransferMethod() string {
	return AssetTransferMethodChannel
}

// PaymentFlows returns ATM-keyed payment flow support for upto SVM.
func (s *UptoSvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	return map[string]x402.PaymentFlowConfig{
		AssetTransferMethodChannel: {
			Supported: []x402.PaymentFlowName{x402.PaymentFlowEscrow},
			Default:   x402.PaymentFlowEscrow,
		},
	}
}

// DynamicExtraFields returns extra keys regenerated on each PaymentRequired
// response, so they are excluded from client echo validation.
func (s *UptoSvmScheme) DynamicExtraFields() []string {
	return []string{upto.ExtraRecentBlockhash, upto.ExtraLastValidBlockHeight, upto.ExtraRecentSlot}
}

// GetAssetDecimals implements AssetDecimalsProvider. Every registered stablecoin
// shares one precision, so registered symbols and mints all resolve to it.
//
// TypeScript rejects unregistered assets outright so a caller cannot mis-price a
// `$…` override, but this interface returns no error, so unregistered mints get
// the same precision here, as they do for every Go scheme.
func (s *UptoSvmScheme) GetAssetDecimals(_ string, _ x402.Network) int {
	return svm.StablecoinDecimals
}

// ValidateFacilitatorSupport fails server startup when the facilitator does not
// advertise a usable feePayer: without one, no client can build an open.
func (s *UptoSvmScheme) ValidateFacilitatorSupport(
	network x402.Network,
	supportedKind types.SupportedKind,
	_ []string,
) error {
	feePayer, _ := supportedKind.Extra[upto.ExtraFeePayer].(string)
	if !svm.ValidateSolanaAddress(feePayer) {
		return fmt.Errorf(
			"facilitator does not advertise a valid feePayer for upto on %s; a base58 Solana address is required",
			network,
		)
	}
	return nil
}

// SettleOnCancel settles canceled verified payments as a zero-amount refund so
// the facilitator can seal and distribute the channel, returning the full
// deposit to the client instead of stranding it until the grace period.
func (s *UptoSvmScheme) SettleOnCancel(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	switch ctx.Reason {
	case x402.CancellationReasonHandlerFailed,
		x402.CancellationReasonHandlerThrew,
		x402.CancellationReasonAfterVerifyAborted:
	default:
		return nil, nil
	}

	requirements := requirementsFromView(ctx.Requirements)
	requirements.Amount = "0"
	return &requirements, nil
}

// EnrichSettlementPayload attaches the receiver-authorizer voucher on the
// claim and cancel settles. The deposit settle (before-handler) must not carry
// a voucher: the facilitator rejects one there because no usage has occurred.
func (s *UptoSvmScheme) EnrichSettlementPayload(ctx x402.SettleContext) (map[string]interface{}, error) {
	if ctx.Phase == x402.SettlePhaseBeforeHandler {
		return nil, nil
	}

	// A payload from another mechanism has no voucher to sign.
	if !svm.IsUptoSvmPayload(ctx.Payload.GetPayload()) {
		return nil, nil
	}
	payload, err := svm.UptoPayloadFromMap(ctx.Payload.GetPayload())
	if err != nil {
		return nil, fmt.Errorf(ErrInvalidPayload+": %w", err)
	}

	authorizer := s.config.ReceiverAuthorizerSigner.Address()
	if payload.AuthorizedSigner != authorizer.String() {
		return nil, fmt.Errorf(
			ErrAuthorizerMismatch+": payload.authorizedSigner %s != configured receiverAuthorizer %s",
			payload.AuthorizedSigner, authorizer,
		)
	}

	channelID, err := solana.PublicKeyFromBase58(payload.ChannelId)
	if err != nil {
		return nil, fmt.Errorf(ErrInvalidPayload+": channelId is not a valid address: %w", err)
	}
	cumulativeAmount, err := strconv.ParseUint(ctx.Requirements.GetAmount(), 10, 64)
	if err != nil {
		return nil, fmt.Errorf(ErrInvalidPayload+": settlement amount is not an unsigned integer: %w", err)
	}

	message := paymentchannels.EncodeVoucherMessage(channelID, cumulativeAmount, payload.ExpiresAt)
	signature, err := s.config.ReceiverAuthorizerSigner.SignMessage(ctx.Ctx, message)
	if err != nil {
		return nil, fmt.Errorf(ErrFailedToSignVoucher+": %w", err)
	}
	if len(signature) != 64 {
		return nil, fmt.Errorf(ErrFailedToSignVoucher+": voucher signature must be 64 bytes, got %d", len(signature))
	}

	return map[string]interface{}{
		svm.UptoVoucherSignatureField: solana.SignatureFromBytes(signature).String(),
	}, nil
}

// RegisterMoneyParser registers a custom money parser in the parser chain.
// Multiple parsers can be registered - they will be tried in registration order.
// Each parser receives a decimal string (e.g., "1.50" for $1.50).
// If a parser returns nil, the next parser in the chain will be tried.
// The default parser is always the final fallback.
func (s *UptoSvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *UptoSvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice parses a price and converts it to an asset amount.
// If price is already an AssetAmount, returns it directly.
// If price is Money (string | number), parses to decimal and tries custom parsers.
// Falls back to default conversion if all custom parsers return nil.
func (s *UptoSvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	networkStr := string(network)
	defaultAsset, err := svm.GetDefaultAsset(networkStr, "")
	if err != nil {
		return x402.AssetAmount{}, err
	}

	if priceMap, ok := price.(map[string]interface{}); ok {
		if amountVal, hasAmount := priceMap["amount"]; hasAmount {
			amountStr, ok := amountVal.(string)
			if !ok {
				return x402.AssetAmount{}, errors.New(ErrAmountMustBeString)
			}

			asset := defaultAsset.Asset
			if assetStr, ok := priceMap["asset"].(string); ok && assetStr != "" {
				asset = assetStr
			}

			extra := make(map[string]interface{})
			if extraMap, ok := priceMap["extra"].(map[string]interface{}); ok {
				extra = extraMap
			}

			return x402.AssetAmount{Amount: amountStr, Asset: asset, Extra: extra}, nil
		}
	}

	decimalAmount, symbol, err := x402.ParseMoney(price)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	for _, parser := range s.moneyParsers {
		result, err := parser(decimalAmount, network)
		if err != nil {
			continue
		}
		if result != nil {
			return *result, nil
		}
	}

	return s.defaultMoneyConversion(decimalAmount, networkStr, symbol)
}

// EnhancePaymentRequirements folds the facilitator's feePayer into the
// requirement, declares the server-owned receiverAuthorizer and withdrawDelay,
// and embeds a fresh blockhash/slot pair for the client open when configured.
func (s *UptoSvmScheme) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	networkStr := string(requirements.Network)
	if _, err := svm.NormalizeNetwork(networkStr); err != nil {
		return requirements, err
	}

	var assetInfo *svm.AssetInfo
	var err error
	if requirements.Asset != "" {
		assetInfo, err = svm.GetAssetInfo(networkStr, requirements.Asset)
		if err != nil {
			return requirements, err
		}
	} else {
		assetInfo, err = svm.GetAssetInfo(networkStr, "")
		if err != nil {
			return requirements, err
		}
		requirements.Asset = assetInfo.Address
	}

	if strings.Contains(requirements.Amount, ".") {
		amount, err := svm.ParseAmount(requirements.Amount, assetInfo.Decimals)
		if err != nil {
			return requirements, fmt.Errorf(ErrFailedToParseAmount+": %w", err)
		}
		requirements.Amount = strconv.FormatUint(amount, 10)
	}

	extra := make(map[string]interface{}, len(requirements.Extra)+6)
	for key, value := range requirements.Extra {
		extra[key] = value
	}
	for key, value := range supportedKind.Extra {
		extra[key] = value
	}

	withdrawDelay := s.config.WithdrawDelay
	if withdrawDelay == 0 {
		withdrawDelay = uint32(paymentchannels.DefaultGracePeriodSeconds)
		if requirements.MaxTimeoutSeconds > paymentchannels.DefaultGracePeriodSeconds {
			withdrawDelay = uint32(requirements.MaxTimeoutSeconds)
		}
	}
	extra[upto.ExtraReceiverAuthorizer] = s.config.ReceiverAuthorizerSigner.Address().String()
	extra[upto.ExtraWithdrawDelay] = withdrawDelay

	// Token-2022 mints (USDG, PYUSD, CASH) need their own program on the open, and
	// an unregistered mint cannot be told from an SPL Token one without an RPC
	// round-trip, so the registry's default applies there.
	if _, ok := extra[upto.ExtraTokenProgram]; !ok {
		extra[upto.ExtraTokenProgram] = svm.GetStablecoinTokenProgram(requirements.Asset, networkStr)
	}

	s.enrichBlockhashHints(ctx, extra)

	for _, key := range extensionKeys {
		if value, ok := supportedKind.Extra[key]; ok {
			extra[key] = value
		}
	}

	requirements.Extra = extra
	return requirements, nil
}

// enrichBlockhashHints embeds a consistent blockhash/slot pair so the client
// needn't make its own RPC round-trip. Both come from the same response, whose
// context slot is the slot the blockhash was produced at. Best effort: on
// failure the client falls back to its own RPC.
func (s *UptoSvmScheme) enrichBlockhashHints(ctx context.Context, extra map[string]interface{}) {
	if s.config.RPCURL == "" {
		return
	}

	latest, err := rpc.New(s.config.RPCURL).GetLatestBlockhash(ctx, upto.BlockhashCommitment)
	if err != nil || latest == nil {
		return
	}

	extra[upto.ExtraRecentBlockhash] = latest.Value.Blockhash.String()
	extra[upto.ExtraLastValidBlockHeight] = strconv.FormatUint(latest.Value.LastValidBlockHeight, 10)
	extra[upto.ExtraRecentSlot] = strconv.FormatUint(latest.Context.Slot, 10)
}

// defaultMoneyConversion converts a decimal amount to atomic units of the
// requested stablecoin, defaulting to the network's default asset.
func (s *UptoSvmScheme) defaultMoneyConversion(
	amount string,
	network string,
	symbol string,
) (x402.AssetAmount, error) {
	assetInfo, err := svm.GetDefaultAsset(network, symbol)
	if err != nil {
		if symbol != "" {
			if address, stablecoinErr := svm.GetStablecoinAddress(strings.ToUpper(symbol), network); stablecoinErr == nil {
				tokenAmount, convertErr := x402.ConvertToTokenAmount(amount, svm.StablecoinDecimals)
				if convertErr != nil {
					return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", convertErr)
				}
				return x402.AssetAmount{
					Amount: tokenAmount,
					Asset:  address,
					Extra:  make(map[string]interface{}),
				}, nil
			}
		}
		assetInfo, err = svm.GetDefaultAsset(network, "")
		if err != nil {
			return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", err)
		}
	}

	tokenAmount, err := x402.ConvertToTokenAmount(amount, assetInfo.Decimals)
	if err != nil {
		return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", err)
	}

	return x402.AssetAmount{
		Amount: tokenAmount,
		Asset:  assetInfo.Asset,
		Extra:  make(map[string]interface{}),
	}, nil
}

// requirementsFromView rebuilds concrete requirements from the version-agnostic
// hook view so cancel settle can override only the amount.
func requirementsFromView(view x402.PaymentRequirementsView) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            view.GetScheme(),
		Network:           view.GetNetwork(),
		Amount:            view.GetAmount(),
		Asset:             view.GetAsset(),
		PayTo:             view.GetPayTo(),
		MaxTimeoutSeconds: view.GetMaxTimeoutSeconds(),
		Extra:             view.GetExtra(),
	}
}
