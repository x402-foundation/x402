package server

import (
	"context"
	"fmt"
	"math/big"
	"strconv"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// settleRequest is what every settle hook derives from the client's collect payload and the
// effective requirements. Its paymentInfo is bound to the amount the payer signed, which a
// settlement amount override may undercut.
type settleRequest struct {
	requirements    types.PaymentRequirements
	extra           authcapture.AuthCaptureExtra
	deployment      authcapture.AuthCaptureDeployment
	chainID         *big.Int
	collect         collectFields
	tokenCollector  string
	paymentInfo     authcapture.PaymentInfoStruct
	paymentInfoHash string
	signedAmount    *big.Int
}

func (s *AuthCaptureEvmScheme) newSettleRequest(ctx x402.SettleContext) (*settleRequest, error) {
	requirements := requirementsFromView(ctx.Requirements)
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	if err != nil {
		return nil, fmt.Errorf(ErrInvalidCollectPayload+": %w", err)
	}
	chainID, err := evm.GetEvmChainId(requirements.Network)
	if err != nil {
		return nil, err
	}
	collect, err := collectPayloadFields(ctx.Payload.GetPayload())
	if err != nil {
		return nil, fmt.Errorf(ErrInvalidCollectPayload+": %w", err)
	}
	signedAmount, ok := new(big.Int).SetString(collect.authorizedAmount, 10)
	if !ok || signedAmount.Sign() <= 0 {
		return nil, fmt.Errorf(ErrInvalidCollectPayload+": invalid authorized amount %s", collect.authorizedAmount)
	}

	signed := requirements
	signed.Amount = collect.authorizedAmount
	paymentInfo := authcapture.ReconstructPaymentInfo(collect.payer, collect.preApprovalExpiry, collect.salt, signed, extra)
	hash, err := authcapture.ComputePaymentInfoHash(chainID, paymentInfo, collect.payer, deployment.Escrow)
	if err != nil {
		return nil, err
	}
	tokenCollector := deployment.EIP3009Collector
	if collect.permit2 {
		tokenCollector = deployment.Permit2Collector
	}
	return &settleRequest{
		requirements:    requirements,
		extra:           extra,
		deployment:      deployment,
		chainID:         chainID,
		collect:         collect,
		tokenCollector:  tokenCollector,
		paymentInfo:     paymentInfo,
		paymentInfoHash: hash,
		signedAmount:    signedAmount,
	}, nil
}

// settlementAmount is the amount this settle moves: the requirements' amount, which a settlement
// override sets, and which must fit within what the payer signed.
func (r *settleRequest) settlementAmount(limit *big.Int) (*big.Int, error) {
	amount, ok := new(big.Int).SetString(r.requirements.Amount, 10)
	if !ok || amount.Sign() <= 0 || amount.Cmp(limit) > 0 {
		return nil, fmt.Errorf(ErrInvalidCaptureAmount+": amount %s must be > 0 and <= %s", r.requirements.Amount, limit)
	}
	return amount, nil
}

// SettleOnCancel voids the escrow hold when a verified payment is canceled before the handler
// completes, releasing funds without waiting for onchain expiry. A custom operator's hold is its
// own contract's to release, and the authorization flow holds nothing. Nothing is held until the
// before-handler authorize settled, so a cancel before then has nothing to void.
func (s *AuthCaptureEvmScheme) SettleOnCancel(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	if !x402.SettledPhasesContain(ctx.SettledPhases, x402.SettlePhaseBeforeHandler) {
		return nil, nil
	}
	switch ctx.Reason {
	case x402.CancellationReasonHandlerFailed,
		x402.CancellationReasonHandlerThrew,
		x402.CancellationReasonAfterVerifyAborted:
	default:
		return nil, nil
	}
	requirements := requirementsFromView(ctx.Requirements)
	extra, _, err := authcapture.ParseAuthCaptureExtra(requirements)
	if err != nil {
		return nil, fmt.Errorf(ErrInvalidCollectPayload+": %w", err)
	}
	if extra.PaymentFlow == authcapture.PaymentFlowAuthorization ||
		extra.OperatorType == authcapture.OperatorTypeCustom ||
		authcapture.AuthorizerModeFor(extra.ReceiverAuthorizer, s.config.ReceiverAuthorizerSigner) == authcapture.AuthorizerModeCollectOnly {
		return nil, nil
	}
	return &requirements, nil
}

// EnrichSettlementPayload adds the receiver-authorizer fields the facilitator needs: none for
// authorize, a Charge completing the authorization flow, a Capture after the handler (plus a
// Void of the remainder on a partial capture), and a Void on cancel. A deferred route adds
// nothing after the handler because its capture happens later through the lifecycle manager.
// Without a local signer for the route's receiverAuthorizer (delegated to the facilitator) the
// enrichments carry no signatures, and a collect-only route gets no enrichment.
func (s *AuthCaptureEvmScheme) EnrichSettlementPayload(ctx x402.SettleContext) (map[string]interface{}, error) {
	if ctx.Phase == x402.SettlePhaseBeforeHandler {
		return nil, nil
	}
	request, err := s.newSettleRequest(ctx)
	if err != nil {
		return nil, err
	}

	// Delegated mode builds the same payloads without signatures; the facilitator signs them.
	mode := authcapture.AuthorizerModeFor(request.extra.ReceiverAuthorizer, s.config.ReceiverAuthorizerSigner)
	var signer evm.ClientEvmSigner
	switch mode {
	case authcapture.AuthorizerModeCollectOnly:
		return nil, nil
	case authcapture.AuthorizerModeSelf:
		signer = s.config.ReceiverAuthorizerSigner
	case authcapture.AuthorizerModeDelegated:
	default:
		return nil, fmt.Errorf("unexpected authorizer mode %s", mode)
	}

	switch {
	case ctx.Phase == x402.SettlePhaseCancel:
		return s.voidEnrichment(ctx.Ctx, signer, request)
	case request.extra.PaymentFlow == authcapture.PaymentFlowAuthorization:
		return s.chargeEnrichment(ctx.Ctx, signer, request)
	case request.extra.CaptureMode == authcapture.CaptureModeDeferred:
		return nil, nil
	default:
		return s.captureEnrichment(ctx.Ctx, signer, request)
	}
}

// voidEnrichment builds the cancel Void, signed when a local signer is given.
func (s *AuthCaptureEvmScheme) voidEnrichment(ctx context.Context, signer evm.ClientEvmSigner, request *settleRequest) (map[string]interface{}, error) {
	paymentInfo, err := request.paymentInfo.ToWireMap()
	if err != nil {
		return nil, err
	}
	result := map[string]interface{}{
		"type":        "void",
		"paymentInfo": paymentInfo,
	}
	if signer == nil {
		return result, nil
	}
	signature, err := authcapture.SignVoid(ctx, signer, request.extra.CaptureAuthorizer, request.chainID, request.paymentInfoHash)
	if err != nil {
		return nil, fmt.Errorf(ErrFailedToSignVoid+": %w", err)
	}
	result["authorizerSignature"] = evm.BytesToHex(signature)
	return result, nil
}

// chargeEnrichment completes an authorization-flow charge with the settlement amount, the fee at
// the route's minimum, and, when a local signer is given, a Charge signature bound to the
// client's collector data.
func (s *AuthCaptureEvmScheme) chargeEnrichment(ctx context.Context, signer evm.ClientEvmSigner, request *settleRequest) (map[string]interface{}, error) {
	amount, err := request.settlementAmount(request.signedAmount)
	if err != nil {
		return nil, err
	}
	fee := authcapture.DefaultCaptureFee(&request.deployment, amount, request.extra.MinFeeBps)
	result := map[string]interface{}{
		"amount":      amount.String(),
		"feeReceiver": request.extra.FeeRecipient,
	}
	fee.AddToWire(result)
	if signer == nil {
		return result, nil
	}
	collectorData, err := evm.HexToBytes(request.collect.signature)
	if err != nil {
		return nil, fmt.Errorf(ErrInvalidCollectPayload+": signature: %w", err)
	}
	signature, err := authcapture.SignCharge(ctx, signer, &request.deployment, request.extra.CaptureAuthorizer, request.chainID,
		authcapture.ChargeParams{
			PaymentInfoHash: request.paymentInfoHash,
			Amount:          amount,
			TokenCollector:  request.tokenCollector,
			CollectorData:   collectorData,
			Fee:             fee,
			FeeReceiver:     request.extra.FeeRecipient,
		})
	if err != nil {
		return nil, fmt.Errorf(ErrFailedToSignCharge+": %w", err)
	}
	result["authorizerSignature"] = evm.BytesToHex(signature)
	return result, nil
}

// storedBalances returns the capturable and refundable amounts a lifecycle signature must name:
// the stored ones, else the full hold of a payment just collected.
func (s *AuthCaptureEvmScheme) storedBalances(ctx context.Context, request *settleRequest) (*big.Int, *big.Int, error) {
	record, err := s.storage.Get(ctx, request.paymentInfoHash)
	if err != nil {
		return nil, nil, err
	}
	if record == nil {
		return request.signedAmount, new(big.Int), nil
	}
	capturable, capturableOK := parseBalance(record.CapturableAmount)
	refundable, refundableOK := parseBalance(record.RefundableAmount)
	if !capturableOK || !refundableOK {
		return nil, nil, fmt.Errorf(ErrInvalidLifecycleAmount+": stored balances of %s are unreadable", request.paymentInfoHash)
	}
	return capturable, refundable, nil
}

func (s *AuthCaptureEvmScheme) captureEnrichment(ctx context.Context, signer evm.ClientEvmSigner, request *settleRequest) (map[string]interface{}, error) {
	capturable, refundable, err := s.storedBalances(ctx, request)
	if err != nil {
		return nil, err
	}
	amount, err := request.settlementAmount(capturable)
	if err != nil {
		return nil, err
	}
	signed, err := buildCaptureFields(ctx, signer, request.deployment, request.extra, request.chainID, captureTerms{
		paymentInfoHash: request.paymentInfoHash,
		amount:          amount,
		fee:             authcapture.DefaultCaptureFee(&request.deployment, amount, request.extra.MinFeeBps),
		feeReceiver:     request.extra.FeeRecipient,
		capturable:      capturable,
		refundable:      refundable,
		voidRemainder:   amount.Cmp(capturable) < 0,
	})
	if err != nil {
		return nil, err
	}
	paymentInfo, err := request.paymentInfo.ToWireMap()
	if err != nil {
		return nil, err
	}
	signed["type"] = "capture"
	signed["paymentInfo"] = paymentInfo
	return signed, nil
}

// captureTerms are the values a Capture signature binds, and whether to also sign a Void of
// whatever the capture leaves.
type captureTerms struct {
	paymentInfoHash string
	amount          *big.Int
	fee             authcapture.CaptureFee
	feeReceiver     string
	capturable      *big.Int
	refundable      *big.Int
	voidRemainder   bool
}

// buildCaptureFields builds the capture wire fields shared by in-request and manager captures,
// signing the Capture (and a Void when the remainder is released) when a local signer is given.
// Without one (authorizer delegated to the facilitator) the signatures are omitted and
// voidRemainder asks the facilitator to sign the Void leg.
func buildCaptureFields(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	deployment authcapture.AuthCaptureDeployment,
	extra authcapture.AuthCaptureExtra,
	chainID *big.Int,
	terms captureTerms,
) (map[string]interface{}, error) {
	result := map[string]interface{}{
		"amount":                   terms.amount.String(),
		"feeReceiver":              terms.feeReceiver,
		"expectedCapturableAmount": terms.capturable.String(),
		"expectedRefundableAmount": terms.refundable.String(),
	}
	terms.fee.AddToWire(result)
	if signer == nil {
		if terms.voidRemainder {
			result["voidRemainder"] = true
		}
		return result, nil
	}

	signature, err := authcapture.SignCapture(ctx, signer, &deployment, extra.CaptureAuthorizer, chainID,
		authcapture.CaptureParams{
			PaymentInfoHash:    terms.paymentInfoHash,
			Amount:             terms.amount,
			Fee:                terms.fee,
			FeeReceiver:        terms.feeReceiver,
			ExpectedCapturable: terms.capturable,
			ExpectedRefundable: terms.refundable,
		})
	if err != nil {
		return nil, fmt.Errorf(ErrFailedToSignCapture+": %w", err)
	}
	result["authorizerSignature"] = evm.BytesToHex(signature)
	if terms.voidRemainder {
		voidSignature, err := authcapture.SignVoid(ctx, signer, extra.CaptureAuthorizer, chainID, terms.paymentInfoHash)
		if err != nil {
			return nil, fmt.Errorf(ErrFailedToSignVoid+": %w", err)
		}
		result["voidAuthorizerSignature"] = evm.BytesToHex(voidSignature)
	}
	return result, nil
}

// BeforeSettleHook skips the after-handler settle of a deferred escrow route, echoing the stored
// collect receipt, because that route captures later through the lifecycle manager.
func (s *AuthCaptureEvmScheme) BeforeSettleHook() x402.BeforeSettleHook {
	return func(ctx x402.SettleContext) (*x402.BeforeHookResult, error) {
		if ctx.Phase != x402.SettlePhaseAfterHandler {
			return nil, nil
		}
		request, err := s.newSettleRequest(ctx)
		if err != nil || !request.deferred() {
			return nil, nil //nolint:nilerr // a malformed payload fails in the settle itself
		}
		record, err := s.storage.Get(ctx.Ctx, request.paymentInfoHash)
		if err != nil {
			return nil, err
		}
		if record == nil {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  ErrPaymentNotFound,
				Message: "the authorized payment was not recorded, so it cannot be captured later",
			}, nil
		}
		return &x402.BeforeHookResult{
			Skip: true,
			SkipResult: &x402.SettleResponse{
				Success:     true,
				Payer:       record.PaymentInfo.Payer,
				Transaction: record.CollectTransaction,
				Network:     x402.Network(record.Network),
				Amount:      record.PaymentInfo.MaxAmount,
			},
		}, nil
	}
}

func (r *settleRequest) deferred() bool {
	return r.extra.PaymentFlow != authcapture.PaymentFlowAuthorization && r.extra.CaptureMode == authcapture.CaptureModeDeferred
}

// AfterSettleHook records an authorized payment after its collect settles, and keeps the stored
// balances in step with an in-request capture, charge or cancel void.
func (s *AuthCaptureEvmScheme) AfterSettleHook() x402.AfterSettleHook {
	return func(ctx x402.SettleResultContext) error {
		if ctx.Result == nil || !ctx.Result.Success {
			return nil
		}
		request, err := s.newSettleRequest(ctx.SettleContext)
		if err != nil {
			return err
		}
		switch {
		case ctx.Phase == x402.SettlePhaseCancel:
			return applyVoid(ctx.Ctx, s.storage, request.paymentInfoHash)
		case ctx.Phase == x402.SettlePhaseBeforeHandler:
			return s.persist(ctx.Ctx, request, ctx.Result, request.signedAmount, new(big.Int))
		case request.extra.PaymentFlow == authcapture.PaymentFlowAuthorization:
			charged := request.requirements.Amount
			if ctx.Result.Amount != "" {
				charged = ctx.Result.Amount
			}
			amount, ok := new(big.Int).SetString(charged, 10)
			if !ok {
				return fmt.Errorf(ErrInvalidCaptureAmount+": settled amount %s", charged)
			}
			return s.persist(ctx.Ctx, request, ctx.Result, new(big.Int), amount)
		case request.deferred():
			return nil
		default:
			return s.recordCapture(ctx.Ctx, request)
		}
	}
}

func (s *AuthCaptureEvmScheme) recordCapture(ctx context.Context, request *settleRequest) error {
	capturable, _, err := s.storedBalances(ctx, request)
	if err != nil {
		return err
	}
	amount, err := request.settlementAmount(capturable)
	if err != nil {
		return err
	}
	return applyCapture(ctx, s.storage, request.paymentInfoHash, amount, amount.Cmp(capturable) < 0)
}

// persist stores the collected payment. The first write wins: a second collect of the same
// paymentInfoHash cannot succeed onchain, so reaching here twice is a retry whose stored balances
// are authoritative.
func (s *AuthCaptureEvmScheme) persist(
	ctx context.Context,
	request *settleRequest,
	result *x402.SettleResponse,
	capturable, refundable *big.Int,
) error {
	record := &AuthorizedPayment{
		PaymentInfoHash:     request.paymentInfoHash,
		PaymentInfo:         request.paymentInfo,
		SaltNonce:           request.collect.saltNonce,
		Network:             request.requirements.Network,
		ReceiverAuthorizer:  request.extra.ReceiverAuthorizer,
		Policy:              request.extra.Policy,
		Name:                request.extra.Name,
		Version:             request.extra.Version,
		PaymentFlow:         firstNonEmpty(request.extra.PaymentFlow, authcapture.PaymentFlowEscrow),
		OperatorType:        firstNonEmpty(request.extra.OperatorType, authcapture.OperatorTypeDelegated),
		AssetTransferMethod: request.extra.AssetTransferMethod,
		AuthCaptureEscrow:   request.extra.AuthCaptureEscrow,
		CapturableAmount:    capturable.String(),
		RefundableAmount:    refundable.String(),
		CollectTransaction:  result.Transaction,
		CreatedAt:           time.Now(),
	}
	return s.storage.Update(ctx, request.paymentInfoHash, func(current *AuthorizedPayment) *AuthorizedPayment {
		if current != nil {
			return current
		}
		return record
	})
}

type collectFields struct {
	payer             string
	preApprovalExpiry uint64
	salt              string
	saltNonce         string
	signature         string
	authorizedAmount  string
	permit2           bool
}

// collectPayloadFields reads the payer, expiry, salt and authorized hold from the client's
// EIP-3009 or Permit2 collect payload, the only shape the server ever receives. The signed
// amount is the escrow's maxAmount, which the settlement amount override may undercut.
func collectPayloadFields(payload map[string]interface{}) (collectFields, error) {
	switch {
	case authcapture.IsEip3009Payload(payload):
		p, err := authcapture.Eip3009CollectPayloadFromMap(payload)
		if err != nil {
			return collectFields{}, err
		}
		expiry, err := strconv.ParseUint(p.Authorization.ValidBefore, 10, 64)
		if err != nil {
			return collectFields{}, fmt.Errorf("invalid authorization.validBefore: %s", p.Authorization.ValidBefore)
		}
		return collectFields{
			payer: p.Authorization.From, preApprovalExpiry: expiry, salt: p.Salt, saltNonce: p.SaltNonce,
			signature: p.Signature, authorizedAmount: p.Authorization.Value,
		}, nil
	case authcapture.IsPermit2Payload(payload):
		p, err := authcapture.Permit2CollectPayloadFromMap(payload)
		if err != nil {
			return collectFields{}, err
		}
		expiry, err := strconv.ParseUint(p.Permit2Authorization.Deadline, 10, 64)
		if err != nil {
			return collectFields{}, fmt.Errorf("invalid permit2Authorization.deadline: %s", p.Permit2Authorization.Deadline)
		}
		return collectFields{
			payer: p.Permit2Authorization.From, preApprovalExpiry: expiry, salt: p.Salt, saltNonce: p.SaltNonce,
			signature: p.Signature, authorizedAmount: p.Permit2Authorization.Permitted.Amount, permit2: true,
		}, nil
	default:
		return collectFields{}, fmt.Errorf("payload is neither an EIP-3009 nor a Permit2 auth-capture collect payload")
	}
}

// requirementsFromView rebuilds concrete requirements from the version-agnostic hook view.
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
