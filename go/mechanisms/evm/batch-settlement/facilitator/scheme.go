package facilitator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// BatchSettlementEvmSchemeConfig holds optional facilitator configuration.
type BatchSettlementEvmSchemeConfig struct {
	// EIP6492AllowedFactories is the allowlist of factory contract addresses (hex strings,
	// case-insensitive) the facilitator will call to deploy an undeployed (ERC-6492
	// counterfactual) smart wallet before an ERC-3009 deposit. A non-empty list enables
	// counterfactual deposit support; an empty list (the default) denies all factory
	// deployment, so counterfactual deposits are rejected with ErrFactoryNotAllowed.
	EIP6492AllowedFactories []string
	PendingSettlementStore  x402.PendingSettlementStore
	// VoucherStore enables facilitator-managed custody. Nil keeps self-managed mode.
	// Every field on VoucherStoreConfig is read only when this is set.
	VoucherStore *VoucherStoreConfig
	// ResolveCallerIdentity resolves a stable caller identity for a delegated settle.
	// When set, /supported advertises extra.delegatedRefund: true. Self-managed: an unsigned
	// cooperative refund is accepted only from the caller that created the channel.
	// Facilitator-managed: also authorizes refunds on channels whose 402 omits
	// extra.refundAuthorizer.
	ResolveCallerIdentity ResolveCallerIdentity
	DelegatedAuthStore    storage.DelegatedAuthStore
	SubmitMode            SubmitMode
	AuthorizerSubmitter   evm.FacilitatorEvmSigner
	// Logger receives facilitator events. Nil uses slog.Default().
	Logger *slog.Logger
	// OnStorageError is called when removing a binding after a failed deposit
	// fails; the deposit error is returned to the caller instead. Nil logs it through Logger.
	OnStorageError func(err error, network, channelId string)
}

type voucherStoreRuntime struct {
	storage             storage.ChannelStorage[*FacilitatorChannel]
	lockStorage         storage.ChannelLockStorage
	settleTargetStorage storage.SettleTargetStorage
	withdrawDelay       int
	onchainStateTtlMs   *int64
	keepFinishedRows    bool
}

// BatchSettlementEvmScheme implements SchemeNetworkFacilitator for batch settlement on EVM.
type BatchSettlementEvmScheme struct {
	signer                evm.FacilitatorEvmSigner
	authorizerSigner      batchsettlement.AuthorizerSigner
	config                BatchSettlementEvmSchemeConfig
	submitMode            SubmitMode
	authorizerSubmitter   evm.FacilitatorEvmSigner
	pendingStore          x402.PendingSettlementStore
	voucherStore          *voucherStoreRuntime
	resolveCallerIdentity ResolveCallerIdentity
	delegatedAuthStore    storage.DelegatedAuthStore
	onStorageError        func(err error, network, channelId string)
	logger                *slog.Logger
}

// NewBatchSettlementEvmScheme creates a new batch settlement facilitator scheme.
func NewBatchSettlementEvmScheme(signer evm.FacilitatorEvmSigner, authorizerSigner batchsettlement.AuthorizerSigner) *BatchSettlementEvmScheme {
	s, err := NewBatchSettlementEvmSchemeWithConfig(signer, authorizerSigner, nil)
	if err != nil {
		panic(err)
	}
	return s
}

// NewBatchSettlementEvmSchemeWithConfig creates a batch settlement facilitator scheme with
// optional configuration (e.g. the ERC-6492 factory allowlist for counterfactual deposits).
// A nil config behaves identically to NewBatchSettlementEvmScheme.
func NewBatchSettlementEvmSchemeWithConfig(
	signer evm.FacilitatorEvmSigner,
	authorizerSigner batchsettlement.AuthorizerSigner,
	config *BatchSettlementEvmSchemeConfig,
) (*BatchSettlementEvmScheme, error) {
	s := &BatchSettlementEvmScheme{
		signer:           signer,
		authorizerSigner: authorizerSigner,
		pendingStore:     x402.NewInMemoryPendingSettlementStore(),
		submitMode:       SubmitModeRelay,
	}
	if config != nil {
		s.config = *config
		if err := AssertDirectAuthorizerSubmitter(config.SubmitMode, authorizerSigner, config.AuthorizerSubmitter); err != nil {
			return nil, err
		}
		if config.VoucherStore != nil && authorizerSigner == nil {
			return nil, fmt.Errorf("voucherStore requires authorizerSigner")
		}
		if config.SubmitMode != "" {
			s.submitMode = config.SubmitMode
		}
		s.authorizerSubmitter = config.AuthorizerSubmitter
		if config.PendingSettlementStore != nil {
			s.pendingStore = config.PendingSettlementStore
		}
		if config.ResolveCallerIdentity != nil && config.DelegatedAuthStore == nil {
			return nil, fmt.Errorf("resolveCallerIdentity requires delegatedAuthStore")
		}
		s.resolveCallerIdentity = config.ResolveCallerIdentity
		s.delegatedAuthStore = config.DelegatedAuthStore
		s.logger = config.Logger
		s.onStorageError = config.OnStorageError
		if config.VoucherStore != nil {
			lockStorage := channelLockStorage(config.VoucherStore.LockStorage, config.VoucherStore.Storage)
			if lockStorage == nil {
				return nil, fmt.Errorf("voucherStore.lockStorage is required when storage does not implement ChannelLockStorage")
			}
			withdrawDelay := config.VoucherStore.WithdrawDelay
			if withdrawDelay == 0 {
				withdrawDelay = batchsettlement.MinWithdrawDelay
			}
			settleTargets := config.VoucherStore.SettleTargetStorage
			if settleTargets == nil {
				settleTargets = storage.NewChannelSettleTargets(config.VoucherStore.Storage)
			}
			s.voucherStore = &voucherStoreRuntime{
				storage:             config.VoucherStore.Storage,
				lockStorage:         lockStorage,
				settleTargetStorage: settleTargets,
				withdrawDelay:       withdrawDelay,
				onchainStateTtlMs:   config.VoucherStore.OnchainStateTtlMs,
				keepFinishedRows:    config.VoucherStore.KeepFinishedRows,
			}
		}
	}
	if s.onStorageError == nil {
		s.onStorageError = s.logStorageError
	}
	return s, nil
}

func channelLockStorage(explicit storage.ChannelLockStorage, store any) storage.ChannelLockStorage {
	if explicit != nil {
		return explicit
	}
	lockStorage, _ := store.(storage.ChannelLockStorage)
	return lockStorage
}

func (f *BatchSettlementEvmScheme) logStorageError(err error, network, channelId string) {
	logger := f.logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Error("batch-settlement: delegated auth store operation failed", "error", err, "network", network, "channelId", channelId)
}

// SetPendingSettlementStore overrides the default in-memory PendingSettlementStore.
func (f *BatchSettlementEvmScheme) SetPendingSettlementStore(store x402.PendingSettlementStore) {
	if store != nil {
		f.pendingStore = store
	}
}

// Scheme returns the scheme identifier.
func (f *BatchSettlementEvmScheme) Scheme() string {
	return batchsettlement.SchemeBatched
}

// CaipFamily returns the CAIP family pattern this facilitator supports.
func (f *BatchSettlementEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
func (f *BatchSettlementEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	if f.authorizerSigner == nil {
		return nil
	}
	extra := map[string]interface{}{
		"receiverAuthorizer": f.authorizerSigner.Address(),
		// true iff /settle callers are authenticated, so unsigned (caller-identity)
		// refunds are honored for the service that created the channel.
		"delegatedRefund": f.resolveCallerIdentity != nil,
	}
	if f.voucherStore != nil {
		extra["withdrawDelay"] = f.voucherStore.withdrawDelay
		extra["voucherManager"] = []string{batchsettlement.VoucherManagerServer, batchsettlement.VoucherManagerFacilitator}
	}
	return extra
}

// GetSigners returns signer addresses used by this facilitator.
func (f *BatchSettlementEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a batched payment payload.
func (f *BatchSettlementEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	if payload.Accepted.Scheme != batchsettlement.SchemeBatched || requirements.Scheme != batchsettlement.SchemeBatched {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidScheme}, nil
	}
	if payload.Accepted.Network != requirements.Network {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrNetworkMismatch}, nil
	}

	if storage.IsFacilitatorManaged(requirements.Extra) {
		if f.voucherStore == nil || f.authorizerSigner == nil {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrVoucherStoreUnavailable}, nil
		}
		return VerifyManaged(ctx, f.voucherStoreDeps(), payload, requirements, fctx)
	}

	data := payload.Payload

	if batchsettlement.IsDepositPayload(data) {
		depositPayload, err := batchsettlement.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidDepositPayload, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		return VerifyDeposit(ctx, f.signer, depositPayload, requirements, payload.Extensions, fctx, f.config.EIP6492AllowedFactories)
	}

	if batchsettlement.IsVoucherPayload(data) {
		voucherPayload, err := batchsettlement.VoucherPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidVoucherPayload, "",
				fmt.Sprintf("failed to parse voucher payload: %s", err))
		}
		return VerifyVoucher(ctx, f.signer, voucherPayload, requirements, voucherPayload.ChannelConfig)
	}

	if batchsettlement.IsRefundPayload(data) {
		refundPayload, err := batchsettlement.RefundPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidRefundPayload, "",
				fmt.Sprintf("failed to parse refund payload: %s", err))
		}
		return VerifyRefundVoucher(ctx, f.signer, refundPayload, requirements, refundPayload.ChannelConfig)
	}

	return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidPayload}, nil
}

// Settle settles a batched payment onchain.
func (f *BatchSettlementEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	data := payload.Payload
	network := x402.Network(requirements.Network)

	dataSuffix, err := evm.ResolveDataSuffix(fctx, evm.DataSuffixContext{Payload: payload, Requirements: requirements})
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, "", network, "", err.Error())
	}

	managed := storage.IsFacilitatorManaged(requirements.Extra)
	if managed {
		if f.voucherStore == nil || f.authorizerSigner == nil {
			return &x402.SettleResponse{
				Success:     false,
				ErrorReason: ErrVoucherStoreUnavailable,
				Transaction: "",
				Network:     network,
			}, nil
		}
		if !batchsettlement.IsClaimPayload(data) && !batchsettlement.IsSettlePayload(data) {
			return SettleManaged(ctx, f.voucherStoreDeps(), payload, requirements, fctx, dataSuffix)
		}
	}

	if batchsettlement.IsDepositPayload(data) {
		depositPayload, err := batchsettlement.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		delegatedCaller, bindErr := ResolveDepositDelegatedCaller(ctx, f.resolveCallerIdentity, f.delegatedAuthStore,
			payload, depositPayload, requirements, fctx)
		if bindErr != nil {
			return nil, bindErr
		}
		settled, _, err := SettleDeposit(ctx, f.signer, depositPayload, requirements, payload.Extensions, fctx, dataSuffix, f.config.EIP6492AllowedFactories, f.pendingStore,
			newDelegatedDepositBinding(f.delegatedAuthStore, delegatedCaller, f.onStorageError))
		if err != nil {
			return nil, err
		}
		return settled, nil
	}

	if batchsettlement.IsClaimPayload(data) {
		claimPayload, err := batchsettlement.ClaimPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
				fmt.Sprintf("failed to parse claim payload: %s", err))
		}
		if managed {
			begun := make([]attestedClaim, 0, len(claimPayload.Claims))
			counts := make([]uint64, 0, len(claimPayload.Claims))
			now := time.Now().UnixMilli()
			for _, claim := range claimPayload.Claims {
				channelID, idErr := batchsettlement.ComputeChannelId(claim.Voucher.Channel, requirements.Network)
				if idErr != nil {
					_ = abortAttestedClaims(ctx, f.voucherStore.storage, begun)
					return nil, idErr
				}
				one, result, beginErr := beginAttestedClaim(ctx, f.voucherStore.storage, channelID, claim, now)
				if beginErr != nil {
					_ = abortAttestedClaims(ctx, f.voucherStore.storage, begun)
					return nil, beginErr
				}
				switch result {
				case beginStarted:
				case beginBusy, beginSuperseded, beginAlreadyClaimed, beginMissing:
					_ = abortAttestedClaims(ctx, f.voucherStore.storage, begun)
					return &x402.SettleResponse{
						Success:     false,
						ErrorReason: ErrChannelBusy,
						Transaction: "",
						Network:     network,
					}, nil
				default:
					_ = abortAttestedClaims(ctx, f.voucherStore.storage, begun)
					return nil, fmt.Errorf("unexpected begin result %d", result)
				}
				begun = append(begun, one)
				counts = append(counts, chargeCountUint(one.Count))
			}
			claimSuffix, suffixErr := evm.ResolveDataSuffix(fctx, evm.DataSuffixContext{
				Payload:      payload,
				Requirements: requirements,
				Metadata:     batchsettlement.ChargeCountsMetadata(counts),
			})
			if suffixErr != nil {
				_ = abortAttestedClaims(ctx, f.voucherStore.storage, begun)
				return nil, x402.NewSettleError(ErrInvalidPayload, "", network, "", suffixErr.Error())
			}
			claimed := map[string]struct{}{}
			settled, err := SubmitClaim(ctx, SubmitClaimInput{
				Network:    requirements.Network,
				Claims:     claimPayload.Claims,
				Signature:  claimPayload.ClaimAuthorizerSignature,
				DataSuffix: claimSuffix,
				OnClaimed:  func(ids map[string]struct{}) { claimed = ids },
			}, f.submitContext())
			landed, releaseErr := releaseAttestedClaims(ctx, f.voucherStore.storage, begun, err, settled)
			if err != nil {
				if releaseErr != nil {
					return nil, releaseErr
				}
				return nil, err
			}
			if !landed {
				if releaseErr != nil {
					return nil, releaseErr
				}
				return settled, nil
			}
			if afterErr := afterClaim(ctx, f.voucherStore.storage, claimPayload.Claims, requirements.Network, f.voucherStore.settleTargetStorage, nil, begun, claimed); afterErr != nil || releaseErr != nil {
				logger := f.logger
				if logger == nil {
					logger = slog.Default()
				}
				logger.Error("batch-settlement: claim landed but attested bookkeeping failed", "error", errors.Join(afterErr, releaseErr), "network", requirements.Network)
				return settled, nil
			}
			return settled, nil
		}
		settled, err := SubmitClaim(ctx, SubmitClaimInput{
			Network:    requirements.Network,
			Claims:     claimPayload.Claims,
			Signature:  claimPayload.ClaimAuthorizerSignature,
			DataSuffix: dataSuffix,
		}, f.submitContext())
		if err != nil {
			return nil, err
		}
		return settled, nil
	}

	if batchsettlement.IsEnrichedRefundPayload(data) {
		refundPayload, err := batchsettlement.EnrichedRefundPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to parse refund payload: %s", err))
		}
		if consentErr := f.checkSelfManagedRefundCaller(ctx, payload, refundPayload, requirements, fctx); consentErr != "" {
			return &x402.SettleResponse{
				Success:     false,
				ErrorReason: consentErr,
				Transaction: "",
				Network:     network,
			}, nil
		}
		return SubmitRefund(ctx, SubmitRefundInput{
			Network:    requirements.Network,
			Payload:    refundPayload,
			DataSuffix: dataSuffix,
		}, f.submitContext())
	}

	if batchsettlement.IsSettlePayload(data) {
		settlePayload, err := batchsettlement.SettlePayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidSettlePayload, "", network, "",
				fmt.Sprintf("failed to parse settle payload: %s", err))
		}
		return ExecuteSettle(ctx, f.signer, settlePayload, requirements, dataSuffix)
	}

	return nil, x402.NewSettleError(ErrUnknownSettleAction, "", network, "",
		"unrecognized batch-settlement settle action or payload type")
}

// CreateChannelManager creates a FacilitatorChannelManager wired to this scheme's voucher store.
func (f *BatchSettlementEvmScheme) CreateChannelManager(fctx *x402.FacilitatorContext) (*FacilitatorChannelManager, error) {
	if f.voucherStore == nil || f.authorizerSigner == nil {
		return nil, fmt.Errorf("createChannelManager requires voucherStore and authorizerSigner")
	}
	return NewFacilitatorChannelManager(FacilitatorChannelManagerConfig{
		Storage:             f.voucherStore.storage,
		LockStorage:         f.voucherStore.lockStorage,
		Signer:              f.signer,
		AuthorizerSigner:    f.authorizerSigner,
		AuthorizerSubmitter: f.authorizerSubmitter,
		SubmitMode:          f.submitMode,
		Context:             fctx,
		KeepFinishedRows:    f.voucherStore.keepFinishedRows,
		SettleTargetStorage: f.voucherStore.settleTargetStorage,
		Logger:              f.logger,
	})
}

func (f *BatchSettlementEvmScheme) voucherStoreDeps() VoucherStoreDeps {
	return VoucherStoreDeps{
		Signer:                  f.signer,
		AuthorizerSigner:        f.authorizerSigner,
		AuthorizerSubmitter:     f.authorizerSubmitter,
		SubmitMode:              f.submitMode,
		Storage:                 f.voucherStore.storage,
		LockStorage:             f.voucherStore.lockStorage,
		WithdrawDelay:           f.voucherStore.withdrawDelay,
		OnchainStateTtlMs:       f.voucherStore.onchainStateTtlMs,
		ResolveCallerIdentity:   f.resolveCallerIdentity,
		DelegatedAuthStore:      f.delegatedAuthStore,
		EIP6492AllowedFactories: f.config.EIP6492AllowedFactories,
		PendingStore:            f.pendingStore,
		KeepFinishedRows:        f.voucherStore.keepFinishedRows,
		SettleTargetStorage:     f.voucherStore.settleTargetStorage,
		OnStorageError:          f.onStorageError,
		Logger:                  f.logger,
	}
}

func (f *BatchSettlementEvmScheme) submitContext() SubmitContext {
	return SubmitContext{
		SubmitMode:          f.submitMode,
		Signer:              f.signer,
		AuthorizerSigner:    f.authorizerSigner,
		AuthorizerSubmitter: f.authorizerSubmitter,
	}
}

func (f *BatchSettlementEvmScheme) checkSelfManagedRefundCaller(
	ctx context.Context,
	payload types.PaymentPayload,
	raw *batchsettlement.BatchSettlementEnrichedRefundPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) string {
	if amountErr := refundAmountError(raw.Amount); amountErr != "" {
		return amountErr
	}
	if raw.RefundAuthorizerSignature != "" || f.resolveCallerIdentity == nil {
		return ""
	}
	if f.delegatedAuthStore == nil {
		return ErrRefundAuthorizerSignature
	}
	identity, err := f.resolveCallerIdentity(DelegatedSettleContext{
		Ctx:                ctx,
		Step:               DelegatedSettleStepRefund,
		ChannelId:          raw.Voucher.ChannelId,
		Network:            requirements.Network,
		Payer:              raw.ChannelConfig.Payer,
		Amount:             raw.Amount,
		Payload:            payload,
		Requirements:       requirements,
		FacilitatorContext: fctx,
	})
	if err != nil || identity == "" {
		return ErrRefundAuthorizerSignature
	}
	binding, err := f.delegatedAuthStore.Get(ctx, raw.Voucher.ChannelId, requirements.Network)
	if err != nil || binding == nil {
		return ErrRefundAuthorizerSignature
	}
	if binding.CallerIdentity != identity {
		return ErrRefundAuthorizerSignature
	}
	return ""
}
