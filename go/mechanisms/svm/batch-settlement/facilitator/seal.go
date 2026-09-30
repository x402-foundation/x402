package facilitator

import (
	"context"
	"encoding/json"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

// CloseIntent selects a cooperative close of a Closing channel or an Open one.
type CloseIntent string

const (
	CloseIntentSeal   CloseIntent = "seal"
	CloseIntentRefund CloseIntent = "refund"
)

// RefundLimits are the operator ceilings a sponsored request_close must respect.
type RefundLimits struct {
	MaxComputeUnits             *uint32
	MaxPriorityFeeMicroLamports *uint64
}

// PreparedRefund is a validated refund. RequestClose is set only on the sponsored fallback path.
type PreparedRefund struct {
	ChannelID    string
	Terms        BatchTerms
	RequestClose string
}

// SealDependencies are the scheme internals the seal path borrows.
type SealDependencies struct {
	PendingStore             PendingSettlementStore
	ResolveTerms             func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error)
	ReadBinding              func(context.Context, string, string) (ChannelBinding, error)
	IsDelegatedAuthorizer    func(string) bool
	ResolveDelegatedIdentity func(context.Context, DelegatedSettleContext) (string, error)
	DeriveChannelID          func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error)
	FetchChannel             func(context.Context, string, string) (*generated.Channel, error)
	ReadChannel              func(context.Context, string, string) (*generated.Channel, error)
	AssertClaimChannel       func(*generated.Channel, batchsettlement.BatchChannelConfig, BatchTerms, types.PaymentRequirements, []generated.ChannelStatus) error
	DistributeInstruction    func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error)
	SubmitRedemption         func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error)
	CompleteOrPending        func(context.Context, string, string, string, string) (*x402.SettleResponse, error)
	NowSeconds               func() int64
	SettlementCache          interface{ IsDuplicate(string) bool }
	// PrepareRefund, when set, replaces PrepareRefund on the refund settle path.
	PrepareRefund func(context.Context, batchsettlement.BatchRefundPayload, types.PaymentRequirements, RefundLimits, any) (PreparedRefund, error)
}

// AssertNotClosing rejects a Closing channel with the dedicated code.
func AssertNotClosing(channel *generated.Channel, channelID string) error {
	if generated.ChannelStatus(channel.Status) == generated.ChannelStatus_Closing {
		return fmt.Errorf("%s: %s is closing; apply the final voucher with a seal payload", batchsettlement.ErrChannelClosing, channelID)
	}
	return nil
}

// SettleSeal applies the server's latest voucher with settle_and_seal and pays out with distribute.
func SettleSeal(
	ctx context.Context,
	deps SealDependencies,
	payload batchsettlement.BatchSealPayload,
	requirements types.PaymentRequirements,
	intent CloseIntent,
	facilitatorContext any,
) (*x402.SettleResponse, error) {
	network := requirements.Network
	payer := payload.ChannelConfig.Payer
	binding := VoucherModeRequirements
	if intent == CloseIntentSeal {
		binding = VoucherModePayload
	}
	terms, err := deps.ResolveTerms(ctx, payload.ChannelConfig, requirements, binding)
	if err != nil {
		return nil, err
	}
	channelID, err := deps.DeriveChannelID(ctx, payload.ChannelConfig, terms.FeePayer)
	if err != nil {
		return nil, err
	}
	if channelID != payload.ChannelID {
		return nil, fmt.Errorf("%s", batchsettlement.ErrChannelIDMismatch)
	}
	cumulative, err := verifyCloseVoucher(payload.Voucher, payload.ChannelConfig, channelID)
	if err != nil {
		return nil, err
	}
	if err := authenticateServer(ctx, deps, payload, requirements, terms, channelID, cumulative, intent, facilitatorContext); err != nil {
		return nil, err
	}
	key := fmt.Sprintf("batch:%s:%s:%s:%d", intent, network, channelID, cumulative)
	if previous, ok, err := deps.PendingStore.Get(ctx, key+":result"); err != nil {
		return nil, err
	} else if ok {
		var stored x402.SettleResponse
		if err := json.Unmarshal([]byte(previous), &stored); err != nil {
			return nil, err
		}
		return &stored, nil
	}
	channel, err := deps.FetchChannel(ctx, network, channelID)
	if err != nil {
		return nil, err
	}
	required := generated.ChannelStatus_Closing
	if intent == CloseIntentRefund {
		required = generated.ChannelStatus_Open
	}
	if generated.ChannelStatus(channel.Status) != required {
		return nil, fmt.Errorf("%s: %s applies only to a %s channel; observed status %s",
			batchsettlement.ErrCloseState, intent, paymentchannels.ChannelStatusString(required), paymentchannels.ChannelStatusString(generated.ChannelStatus(channel.Status)))
	}
	if err := deps.AssertClaimChannel(channel, payload.ChannelConfig, terms, requirements, []generated.ChannelStatus{required}); err != nil {
		return nil, err
	}
	if intent == CloseIntentSeal && deps.NowSeconds() >= channel.ClosureStartedAt+int64(channel.GracePeriod) {
		return nil, fmt.Errorf("%s: grace period elapsed; the permissionless seal path applies", batchsettlement.ErrCloseState)
	}
	settled := channel.Settlement.Settled
	if cumulative < settled || cumulative > channel.Deposit {
		return nil, fmt.Errorf("%s: voucher %d must lie within settled %d and deposit %d", batchsettlement.ErrCloseState, cumulative, settled, channel.Deposit)
	}
	payee, err := solana.PublicKeyFromBase58(terms.FeePayer)
	if err != nil {
		return nil, err
	}
	channelKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return nil, err
	}
	authorizer, err := solana.PublicKeyFromBase58(payload.ChannelConfig.PayerAuthorizer)
	if err != nil {
		return nil, err
	}
	build := paymentchannels.SettleAndSealBuildArgs{ChannelID: channelKey, Payee: payee}
	if cumulative > settled {
		build.Voucher = &paymentchannels.SettleVoucher{
			AuthorizedSigner: authorizer,
			SignatureBase58:  payload.Voucher.Signature,
			CumulativeAmount: cumulative,
			ExpiresAt:        batchsettlement.ClientVoucherExpiresAt,
		}
	}
	instructions, err := paymentchannels.BuildSettleAndSealInstructions(build)
	if err != nil {
		return nil, err
	}
	distribute, err := deps.DistributeInstruction(ctx, channelID, channel, terms, requirements)
	if err != nil {
		return nil, err
	}
	instructions = append(instructions, distribute)
	if deps.SettlementCache != nil && deps.SettlementCache.IsDuplicate(key) {
		return SettleFailure(x402.Network(requirements.Network), ChannelBusy, payer, ""), nil
	}
	submitted, err := deps.SubmitRedemption(ctx, terms.FeePayer, network, instructions, key, payer)
	if err != nil {
		return nil, err
	}
	if !submitted.OK {
		return submitted.Response, nil
	}
	observed, err := deps.ReadChannel(ctx, network, channelID)
	if err != nil {
		return nil, err
	}
	if observed != nil && generated.ChannelStatus(observed.Status) == required {
		return SettlementPending(x402.Network(network), payer, submitted.Signature, string(intent)+" confirmed but the sealed state is not visible yet"), nil
	}
	if incomplete, err := deps.CompleteOrPending(ctx, key, submitted.Signature, network, payer); err != nil {
		return nil, err
	} else if incomplete != nil {
		return incomplete, nil
	}
	paid := uint64(0)
	if cumulative >= channel.Settlement.PayoutWatermark {
		paid = cumulative - channel.Settlement.PayoutWatermark
	}
	sealed := SealResponse(channelID, payer, x402.Network(network), submitted.Signature, paid, channel.Deposit, cumulative)
	if intent == CloseIntentRefund {
		refunded := uint64(0)
		if channel.Deposit >= cumulative {
			refunded = channel.Deposit - cumulative
		}
		sealed.Amount = fmt.Sprintf("%d", refunded)
	}
	encoded, err := json.Marshal(sealed)
	if err != nil {
		return nil, err
	}
	if err := deps.PendingStore.Set(ctx, key+":result", string(encoded)); err != nil {
		return nil, err
	}
	return sealed, nil
}

// PrepareRefund validates a refund and picks the cooperative close or the payer-signed request_close.
func PrepareRefund(
	ctx context.Context,
	deps SealDependencies,
	payload batchsettlement.BatchRefundPayload,
	requirements types.PaymentRequirements,
	limits RefundLimits,
	facilitatorContext any,
) (PreparedRefund, error) {
	terms, err := deps.ResolveTerms(ctx, payload.ChannelConfig, requirements, VoucherModeRequirements)
	if err != nil {
		return PreparedRefund{}, err
	}
	channelID, err := deps.DeriveChannelID(ctx, payload.ChannelConfig, terms.FeePayer)
	if err != nil {
		return PreparedRefund{}, err
	}
	if payload.Voucher == nil || !batchsettlement.IsBatchVoucher(voucherMap(payload.Voucher)) {
		serverMode := payload.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer
		if serverMode {
			return PreparedRefund{}, fmt.Errorf("%s: refund missing operator voucher", batchsettlement.ErrVoucherSignature)
		}
		return PreparedRefund{}, fmt.Errorf("%s: refund missing voucher", batchsettlement.ErrVoucherSignature)
	}
	cumulative, err := verifyCloseVoucher(*payload.Voucher, payload.ChannelConfig, channelID)
	if err != nil {
		return PreparedRefund{}, err
	}
	channel, err := deps.ReadChannel(ctx, requirements.Network, channelID)
	if err != nil {
		return PreparedRefund{}, err
	}
	if channel != nil && (cumulative < channel.Settlement.Settled || cumulative > channel.Deposit) {
		return PreparedRefund{}, fmt.Errorf("%s: refund voucher must lie within settled and deposit", batchsettlement.ErrCumulativeAmountMismatch)
	}
	binding, err := deps.ReadBinding(ctx, requirements.Network, channelID)
	if err != nil {
		return PreparedRefund{}, err
	}
	bound := binding.ReceiverAuthorizer
	if bound != "" {
		if _, err := RequireReceiverAuthorizer(bound, terms.ReceiverAuthorizer, channelID); err != nil {
			return PreparedRefund{}, err
		}
		_ = facilitatorContext
		return PreparedRefund{ChannelID: channelID, Terms: terms}, nil
	}
	if payload.Transaction == "" {
		return PreparedRefund{}, fmt.Errorf("%s: resend the refund with a payer-signed request_close transaction", batchsettlement.ErrReceiverBindingUnavailable)
	}
	feePayer, err := solana.PublicKeyFromBase58(terms.FeePayer)
	if err != nil {
		return PreparedRefund{}, err
	}
	payer, err := solana.PublicKeyFromBase58(payload.ChannelConfig.Payer)
	if err != nil {
		return PreparedRefund{}, err
	}
	channelKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return PreparedRefund{}, err
	}
	if err := paymentchannels.VerifyRequestCloseTransaction(payload.Transaction, paymentchannels.VerifyRequestCloseExpected{
		Payer:                       payer,
		FeePayer:                    feePayer,
		ChannelID:                   channelKey,
		Memo:                        terms.Memo,
		MaxComputeUnits:             limits.MaxComputeUnits,
		MaxPriorityFeeMicroLamports: limits.MaxPriorityFeeMicroLamports,
	}); err != nil {
		return PreparedRefund{}, fmt.Errorf("%s: %s", batchsettlement.ErrRefundTransaction, err.Error())
	}
	return PreparedRefund{ChannelID: channelID, Terms: terms, RequestClose: payload.Transaction}, nil
}

// ValidateRefund verifies a refund against the channel's current onchain state.
func ValidateRefund(
	ctx context.Context,
	deps SealDependencies,
	payload batchsettlement.BatchRefundPayload,
	requirements types.PaymentRequirements,
	limits RefundLimits,
	facilitatorContext any,
) (*generated.Channel, string, BatchTerms, error) {
	prepared, err := PrepareRefund(ctx, deps, payload, requirements, limits, facilitatorContext)
	if err != nil {
		return nil, "", BatchTerms{}, err
	}
	channel, err := deps.FetchChannel(ctx, requirements.Network, prepared.ChannelID)
	if err != nil {
		return nil, "", BatchTerms{}, err
	}
	if err := deps.AssertClaimChannel(channel, payload.ChannelConfig, prepared.Terms, requirements, []generated.ChannelStatus{
		generated.ChannelStatus_Open,
		generated.ChannelStatus_Closing,
	}); err != nil {
		return nil, "", BatchTerms{}, err
	}
	return channel, prepared.ChannelID, prepared.Terms, nil
}

// SettleCooperativeRefund closes an Open channel. A channel already closing reports that close instead.
func SettleCooperativeRefund(
	ctx context.Context,
	deps SealDependencies,
	payload batchsettlement.BatchRefundPayload,
	requirements types.PaymentRequirements,
	prepared PreparedRefund,
	facilitatorContext any,
) (*x402.SettleResponse, error) {
	current, err := deps.ReadChannel(ctx, requirements.Network, prepared.ChannelID)
	if err != nil {
		return nil, err
	}
	if current != nil && generated.ChannelStatus(current.Status) == generated.ChannelStatus_Closing {
		if err := deps.AssertClaimChannel(current, payload.ChannelConfig, prepared.Terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Closing}); err != nil {
			return nil, err
		}
		return RefundResponse(prepared.ChannelID, current, x402.Network(requirements.Network), ""), nil
	}
	seal := batchsettlement.BatchSealPayload{
		Type:               batchsettlement.PayloadTypeSeal,
		ChannelID:          prepared.ChannelID,
		ChannelConfig:      payload.ChannelConfig,
		Voucher:            *payload.Voucher,
		CloseAuthorization: payload.CloseAuthorization,
	}
	return SettleSeal(ctx, deps, seal, requirements, CloseIntentRefund, facilitatorContext)
}

func verifyCloseVoucher(voucher batchsettlement.BatchVoucher, config batchsettlement.BatchChannelConfig, channelID string) (uint64, error) {
	if voucher.ChannelID != channelID {
		return 0, fmt.Errorf("%s", batchsettlement.ErrChannelIDMismatch)
	}
	if voucher.ExpiresAt != batchsettlement.ClientVoucherExpiresAt {
		return 0, fmt.Errorf("%s", batchsettlement.ErrVoucherExpiry)
	}
	cumulative, err := paymentchannels.ParseU64(voucher.MaxClaimableAmount, "maxClaimableAmount")
	if err != nil {
		return 0, err
	}
	channelKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return 0, err
	}
	message := paymentchannels.EncodeVoucherMessage(channelKey, cumulative, batchsettlement.ClientVoucherExpiresAt)
	if err := paymentchannels.VerifyVoucherSignature(voucher.Signature, config.PayerAuthorizer, message); err != nil {
		return 0, fmt.Errorf("%s", batchsettlement.ErrVoucherSignature)
	}
	return cumulative, nil
}

func authenticateServer(
	ctx context.Context,
	deps SealDependencies,
	payload batchsettlement.BatchSealPayload,
	requirements types.PaymentRequirements,
	terms BatchTerms,
	channelID string,
	cumulative uint64,
	intent CloseIntent,
	facilitatorContext any,
) error {
	binding, err := deps.ReadBinding(ctx, requirements.Network, channelID)
	if err != nil {
		return err
	}
	bound, err := RequireReceiverAuthorizer(binding.ReceiverAuthorizer, terms.ReceiverAuthorizer, channelID)
	if err != nil {
		return err
	}
	if deps.IsDelegatedAuthorizer(bound) {
		step := DelegatedStepSeal
		if intent == CloseIntentRefund {
			step = DelegatedStepRefund
		}
		identity, err := deps.ResolveDelegatedIdentity(ctx, DelegatedSettleContext{
			Step:               step,
			ChannelID:          channelID,
			Network:            requirements.Network,
			Payer:              payload.ChannelConfig.Payer,
			FacilitatorContext: facilitatorContext,
		})
		if err != nil {
			return err
		}
		if identity == "" || identity != binding.CallerIdentity {
			return fmt.Errorf("%s: caller identity does not match the channel binding", batchsettlement.ErrDelegatedUnauthenticated)
		}
		return nil
	}
	if payload.CloseAuthorization == nil {
		return fmt.Errorf("%s: a closeAuthorization is required", batchsettlement.ErrCloseAuthorization)
	}
	if !batchsettlement.VerifyCloseAuthorization(*payload.CloseAuthorization, batchsettlement.CloseAuthorizationBinding{
		Network:            requirements.Network,
		FeePayer:           terms.FeePayer,
		ChannelID:          channelID,
		MaxClaimableAmount: batchsettlement.BigU64(cumulative),
		VoucherExpiresAt:   0,
	}, bound, int64(requirements.MaxTimeoutSeconds), deps.NowSeconds()) {
		return fmt.Errorf("%s: signature does not bind this close or is outside its validity window", batchsettlement.ErrCloseAuthorization)
	}
	return nil
}

func voucherMap(voucher *batchsettlement.BatchVoucher) any {
	if voucher == nil {
		return nil
	}
	return map[string]any{
		"channelId":          voucher.ChannelID,
		"maxClaimableAmount": voucher.MaxClaimableAmount,
		"expiresAt":          voucher.ExpiresAt,
		"signature":          voucher.Signature,
	}
}
