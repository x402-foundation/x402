package client

import (
	"context"
	"errors"
	"fmt"
	"sync"

	solana "github.com/gagliardetto/solana-go"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

// BatchSvmScheme is the SVM batch-settlement client.
type BatchSvmScheme struct {
	signer           BatchClientSigner
	config           BatchSvmClientConfig
	trust            *ServerSignedTrustPolicy
	mintCache        *svm.MintMetadataCache
	mu               sync.Mutex
	channels         map[string]openChannel
	channelOrder     []string
	pending          map[string]pendingChannel
	pendingOrder     map[string][]string
	creationContexts map[string]x402.PaymentPayloadContext
	// discoverFn replaces chain discovery in tests.
	discoverFn func(ctx context.Context, requirements types.PaymentRequirements, terms resolvedTerms) (*openChannel, error)
}

// NewBatchSvmScheme builds a client scheme. Config may be nil.
func NewBatchSvmScheme(signer BatchClientSigner, config *BatchSvmClientConfig) (*BatchSvmScheme, error) {
	cfg := BatchSvmClientConfig{}
	if config != nil {
		cfg = *config
	}
	if cfg.DepositPolicy != nil && cfg.DepositPolicy.DepositMultiplier != nil {
		multiplier := *cfg.DepositPolicy.DepositMultiplier
		if multiplier < MinDepositMultiplier {
			return nil, fmt.Errorf("depositMultiplier must be an integer >= %d", MinDepositMultiplier)
		}
	}
	trust, err := NewServerSignedTrustPolicy(cfg.ServerSignedChannelsPolicy)
	if err != nil {
		return nil, err
	}
	return &BatchSvmScheme{
		signer:           signer,
		config:           cfg,
		trust:            trust,
		mintCache:        svm.NewMintMetadataCache(),
		channels:         map[string]openChannel{},
		pending:          map[string]pendingChannel{},
		pendingOrder:     map[string][]string{},
		creationContexts: map[string]x402.PaymentPayloadContext{},
	}, nil
}

// Scheme returns the scheme identifier.
func (s *BatchSvmScheme) Scheme() string { return batchsettlement.Scheme }

// FindDefaultAsset reverse-looks up a USD-pegged mint for spend caps.
func (s *BatchSvmScheme) FindDefaultAsset(asset string, network x402.Network) *x402.DefaultAsset {
	info := svm.FindDefaultAsset(asset, string(network))
	if info == nil {
		return nil
	}
	return &x402.DefaultAsset{Asset: info.Asset, Decimals: info.Decimals, Symbol: info.Symbol}
}

// PaymentPolicy drops untrusted server-signed accepts and prefers trusted ones.
func (s *BatchSvmScheme) PaymentPolicy() x402.PaymentPolicy {
	return func(requirements []x402.PaymentRequirementsView) []x402.PaymentRequirementsView {
		accepts := make([]types.PaymentRequirements, 0, len(requirements))
		for _, view := range requirements {
			req, ok := view.(types.PaymentRequirements)
			if !ok {
				continue
			}
			accepts = append(accepts, req)
		}
		filtered, err := s.trust.FilterAccepts(accepts)
		if err != nil {
			return []x402.PaymentRequirementsView{}
		}
		out := make([]x402.PaymentRequirementsView, len(filtered))
		for i, req := range filtered {
			out[i] = req
		}
		return out
	}
}

// CreatePaymentPayload builds a deposit, voucher, or authorization for requirements.
func (s *BatchSvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	payloadCtx x402.PaymentPayloadContext,
) (types.PaymentPayload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.creationContexts[requirementsFingerprint(requirements)] = payloadCtx
	return s.createPaymentPayload(ctx, requirements, payloadCtx)
}

// Refund closes the channel backing url and returns unused escrow.
func (s *BatchSvmScheme) Refund(ctx context.Context, url string, options *BatchRefundOptions) (*x402.SettleResponse, error) {
	return RefundBatchChannel(ctx, s.CreateRefundPayload, url, options)
}

// CreateRefundPayload builds the payer-signed close for the cached channel.
func (s *BatchSvmScheme) CreateRefundPayload(
	ctx context.Context,
	x402Version int,
	requirements types.PaymentRequirements,
	options RefundPayloadOptions,
) (types.PaymentPayload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.createRefundPayload(ctx, x402Version, requirements, options)
}

// OnPaymentCreationFailure pays the same resource client-signed when the
// selected accept needed an operator this client does not trust.
func (s *BatchSvmScheme) OnPaymentCreationFailure(
	ctx context.Context,
	failure x402.PaymentCreationFailureContext,
) (*x402.PaymentCreationFailureHookResult, error) {
	var untrusted *UntrustedOperatorError
	if failure.Error == nil || !errors.As(failure.Error, &untrusted) || failure.PaymentRequired == nil {
		return nil, nil
	}
	refused, ok := failure.SelectedRequirements.(types.PaymentRequirements)
	if !ok || !batchsettlement.IsDigits(refused.Amount) {
		return nil, nil
	}
	refusedAmount, parseErr := paymentchannels.ParseU64(refused.Amount, "amount")
	if parseErr != nil {
		return nil, nil //nolint:nilerr // malformed refused amount: no fallback hook
	}
	var fallback *types.PaymentRequirements
	for i := range failure.PaymentRequired.Accepts {
		accept := failure.PaymentRequired.Accepts[i]
		if accept.Scheme != batchsettlement.Scheme || accept.Network != refused.Network || accept.Asset != refused.Asset {
			continue
		}
		if voucherSignerOf(accept.Extra) != batchsettlement.VoucherSignerClient {
			continue
		}
		if !batchsettlement.IsDigits(accept.Amount) {
			continue
		}
		amount, err := paymentchannels.ParseU64(accept.Amount, "amount")
		if err != nil || amount > refusedAmount {
			continue
		}
		fallback = &accept
		break
	}
	if fallback == nil {
		return nil, nil
	}
	s.mu.Lock()
	payloadCtx := s.creationContexts[requirementsFingerprint(refused)]
	s.mu.Unlock()
	partial, err := s.CreatePaymentPayload(ctx, *fallback, payloadCtx)
	if err != nil {
		return nil, err
	}
	partial.Accepted = *fallback
	partial.Resource = failure.PaymentRequired.Resource
	if failure.PaymentRequired.Extensions != nil {
		partial.Extensions = failure.PaymentRequired.Extensions
	}
	partial.X402Version = failure.PaymentRequired.X402Version
	return &x402.PaymentCreationFailureHookResult{Recovered: true, Payload: partial}, nil
}

// OnPaymentResponse reconciles local channel state with the server's answer.
func (s *BatchSvmScheme) OnPaymentResponse(
	ctx context.Context,
	response x402.PaymentResponseContext,
) (x402.PaymentResponseResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	recovered, err := s.handlePaymentResponse(ctx, response)
	if err != nil {
		return x402.PaymentResponseResult{}, err
	}
	return x402.PaymentResponseResult{Recovered: recovered}, nil
}

func (s *BatchSvmScheme) createPaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	payloadCtx x402.PaymentPayloadContext,
) (types.PaymentPayload, error) {
	terms, err := s.resolveTerms(ctx, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	charge, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return types.PaymentPayload{}, err
	}
	if charge == 0 {
		return types.PaymentPayload{}, fmt.Errorf("batch-settlement amount must be positive")
	}
	authorizationExpiresAt := authorizationExpiry(requirements.MaxTimeoutSeconds)
	key := s.channelKey(requirements, terms.feePayer, terms.withdrawDelay)
	existing, err := s.loadChannel(key)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	channelPending := s.pendingFor(key)
	if len(channelPending) > 0 {
		blocking := channelPending[0]
		if blocking.amount != requirements.Amount {
			return types.PaymentPayload{}, fmt.Errorf("batch-settlement channel has a pending allocation for a different amount")
		}
		if terms.voucherSigner == batchsettlement.VoucherSignerServer {
			return types.PaymentPayload{}, fmt.Errorf("batch-settlement server-signed channel has a pending request")
		}
		return types.PaymentPayload{X402Version: blocking.payment.X402Version, Payload: blocking.payment.Payload}, nil
	}
	if existing != nil {
		reserved := uint64(0)
		for _, candidate := range channelPending {
			amount, err := paymentchannels.ParseU64(candidate.amount, "pending amount")
			if err != nil {
				return types.PaymentPayload{}, err
			}
			reserved, err = batchsettlement.AddU64Checked(reserved, amount)
			if err != nil {
				return types.PaymentPayload{}, err
			}
		}
		cumulative, err := batchsettlement.AddU64Checked(existing.tracker.Cumulative(), reserved)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		cumulative, err = batchsettlement.AddU64Checked(cumulative, charge)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		if cumulative <= existing.deposit {
			return s.queueCredential(ctx, requirements, terms, key, *existing, charge, cumulative, authorizationExpiresAt)
		}
		if len(channelPending) > 0 {
			return types.PaymentPayload{}, fmt.Errorf("batch-settlement channel has insufficient unreserved capacity")
		}
		shortfall, ok := batchsettlement.SubU64(cumulative, existing.deposit)
		if !ok {
			return types.PaymentPayload{}, fmt.Errorf("batch-settlement amount overflow")
		}
		topUpAmount, err := s.resolveDepositAmount(requirements, charge, shortfall, payloadCtx, terms.trust, existing.deposit)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		rpcClient, err := s.rpcClient(requirements.Network)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		blockhash, err := svm.ResolveBlockhash(ctx, rpcClient, requirements)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		feePayer, err := solana.PublicKeyFromBase58(terms.feePayer)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		mint, err := solana.PublicKeyFromBase58(requirements.Asset)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		tokenProgram, err := solana.PublicKeyFromBase58(terms.tokenProgram)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		channelID, err := solana.PublicKeyFromBase58(existing.tracker.ChannelID)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		topUp, err := paymentchannels.BuildTopUpPaymentChannelTransaction(paymentchannels.BuildTopUpArgs{
			Payer:        s.signer.Address(),
			ChannelID:    channelID,
			Mint:         mint,
			TokenProgram: tokenProgram,
			FeePayer:     feePayer,
			Amount:       topUpAmount,
			Blockhash:    blockhash,
			Memo:         terms.memo,
		})
		if err != nil {
			return types.PaymentPayload{}, err
		}
		if err := s.signer.SignTransaction(ctx, topUp.Transaction); err != nil {
			return types.PaymentPayload{}, err
		}
		encoded, err := svm.EncodeTransaction(topUp.Transaction)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		credential, err := s.credential(ctx, terms, existing.tracker, charge, authorizationExpiresAt)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		depositPayload := batchsettlement.BatchDepositPayload{
			Type:          batchsettlement.PayloadTypeDeposit,
			ChannelConfig: existing.tracker.ChannelConfig,
			Voucher:       credential.voucher,
			Authorization: credential.authorization,
			Deposit:       batchsettlement.BatchDeposit{Amount: batchsettlement.FormatU64(topUpAmount), Transaction: encoded},
		}
		body, err := batchsettlement.WireMap(depositPayload)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		nextDeposit, err := batchsettlement.AddU64Checked(existing.deposit, topUpAmount)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		next := pendingChannel{
			openChannel:  openChannel{tracker: existing.tracker, deposit: nextDeposit},
			confirmed:    existing,
			key:          key,
			operationKey: key,
			amount:       requirements.Amount,
			cumulative:   cumulative,
			payment:      PendingPayment{Payload: body, X402Version: 2},
		}
		if err := s.rememberPending(next); err != nil {
			return types.PaymentPayload{}, err
		}
		return types.PaymentPayload{X402Version: 2, Payload: body}, nil
	}

	discovered, err := s.discoverChannel(ctx, requirements, terms)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	if discovered != nil {
		s.channels[key] = *discovered
		if s.config.ChannelStorage != nil {
			if err := s.config.ChannelStorage.Set(key, s.toStorageRecord(*discovered, false, nil)); err != nil {
				return types.PaymentPayload{}, err
			}
		}
		return s.createPaymentPayload(ctx, requirements, payloadCtx)
	}

	if s.config.DepositAmount != nil {
		configured, err := paymentchannels.ParseU64(s.config.DepositAmount, "depositAmount")
		if err != nil {
			return types.PaymentPayload{}, err
		}
		if configured < charge {
			return types.PaymentPayload{}, fmt.Errorf("depositAmount must cover the current request")
		}
	}
	deposit, err := s.resolveDepositAmount(requirements, charge, charge, payloadCtx, terms.trust, 0)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	rpcClient, err := s.rpcClient(requirements.Network)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	blockhash, err := svm.ResolveBlockhash(ctx, rpcClient, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	openSlot, err := svm.ResolveOpenSlot(ctx, rpcClient, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	salt, err := s.salt()
	if err != nil {
		return types.PaymentPayload{}, err
	}
	var expires *int64
	var operator string
	if terms.voucherSigner == batchsettlement.VoucherSignerServer {
		expires = &authorizationExpiresAt
		operator = terms.operator
	}
	built, err := BuildDepositPayload(ctx, BuildDepositArgs{
		Payer:                  s.signer,
		Receiver:               requirements.PayTo,
		ReceiverAuthorizer:     terms.receiverAuthorizer,
		Mint:                   requirements.Asset,
		FeePayer:               terms.feePayer,
		TokenProgram:           terms.tokenProgram,
		Blockhash:              blockhash,
		OpenSlot:               openSlot,
		DepositAmount:          deposit,
		FirstCharge:            charge,
		WithdrawDelay:          terms.withdrawDelay,
		Memo:                   terms.memo,
		Salt:                   &salt,
		VoucherSigner:          terms.voucherSigner,
		Operator:               operator,
		AuthorizationExpiresAt: expires,
	})
	if err != nil {
		return types.PaymentPayload{}, err
	}
	body, err := batchsettlement.WireMap(built.Payload)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	operationKey := key
	if built.Payload.Authorization != nil {
		operationKey = key + OperationKeySeparator + built.Payload.Authorization.RequestID
	}
	next := pendingChannel{
		openChannel:  openChannel{tracker: built.Tracker, deposit: deposit},
		key:          key,
		operationKey: operationKey,
		amount:       requirements.Amount,
		cumulative:   charge,
		payment:      PendingPayment{Payload: body, X402Version: 2},
	}
	if err := s.rememberPending(next); err != nil {
		return types.PaymentPayload{}, err
	}
	return types.PaymentPayload{X402Version: 2, Payload: body}, nil
}
