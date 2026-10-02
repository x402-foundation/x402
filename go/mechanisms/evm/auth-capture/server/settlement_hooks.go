package server

import (
	"fmt"
	"math/big"
	"strconv"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// SettleOnCancel voids the escrow hold when a verified payment is canceled before
// the handler completes, releasing funds without waiting for onchain expiry.
func (s *AuthCaptureEvmScheme) SettleOnCancel(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	switch ctx.Reason {
	case x402.CancellationReasonHandlerFailed,
		x402.CancellationReasonHandlerThrew,
		x402.CancellationReasonAfterVerifyAborted:
	default:
		return nil, nil
	}
	requirements := requirementsFromView(ctx.Requirements)
	return &requirements, nil
}

// EnrichSettlementPayload adds the receiver-authorizer signature the facilitator needs:
// none for authorize, a Capture after the handler (plus a Void of the remainder on a partial
// capture), and a Void on cancel.
func (s *AuthCaptureEvmScheme) EnrichSettlementPayload(ctx x402.SettleContext) (map[string]interface{}, error) {
	if ctx.Phase == x402.SettlePhaseBeforeHandler {
		return nil, nil
	}

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
	payer := collect.payer

	authorized := requirements
	authorized.Amount = collect.authorizedAmount
	paymentInfo := authcapture.ReconstructPaymentInfo(payer, collect.preApprovalExpiry, collect.salt, authorized, extra)
	paymentInfoHash, err := authcapture.ComputePaymentInfoHash(chainID, paymentInfo, payer, deployment.Escrow)
	if err != nil {
		return nil, err
	}
	paymentInfoMap, err := paymentInfo.ToWireMap()
	if err != nil {
		return nil, err
	}

	if ctx.Phase == x402.SettlePhaseCancel {
		signature, err := authcapture.SignVoid(ctx.Ctx, s.config.ReceiverAuthorizerSigner, extra.CaptureAuthorizer, chainID, paymentInfoHash)
		if err != nil {
			return nil, fmt.Errorf(ErrFailedToSignVoid+": %w", err)
		}
		return map[string]interface{}{
			"type":                "void",
			"paymentInfo":         paymentInfoMap,
			"authorizerSignature": evm.BytesToHex(signature),
		}, nil
	}

	maxAmount, ok := new(big.Int).SetString(collect.authorizedAmount, 10)
	if !ok {
		return nil, fmt.Errorf(ErrInvalidCollectPayload+": invalid authorized amount %s", collect.authorizedAmount)
	}
	amount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok || amount.Sign() <= 0 || amount.Cmp(maxAmount) > 0 {
		return nil, fmt.Errorf(ErrInvalidCaptureAmount+": capture amount %s must be > 0 and <= authorized amount %s",
			requirements.Amount, collect.authorizedAmount)
	}
	fee := authcapture.DefaultCaptureFee(&deployment, amount, extra.MinFeeBps)
	signature, err := authcapture.SignCapture(ctx.Ctx, s.config.ReceiverAuthorizerSigner, &deployment, extra.CaptureAuthorizer, chainID,
		authcapture.CaptureParams{
			PaymentInfoHash:    paymentInfoHash,
			Amount:             amount,
			Fee:                fee,
			FeeReceiver:        extra.FeeRecipient,
			ExpectedCapturable: maxAmount,
			ExpectedRefundable: big.NewInt(0),
		})
	if err != nil {
		return nil, fmt.Errorf(ErrFailedToSignCapture+": %w", err)
	}

	result := map[string]interface{}{
		"type":                     "capture",
		"paymentInfo":              paymentInfoMap,
		"amount":                   amount.String(),
		"feeReceiver":              extra.FeeRecipient,
		"expectedCapturableAmount": maxAmount.String(),
		"expectedRefundableAmount": "0",
		"authorizerSignature":      evm.BytesToHex(signature),
	}
	fee.AddToWire(result)

	if amount.Cmp(maxAmount) < 0 {
		voidSignature, err := authcapture.SignVoid(ctx.Ctx, s.config.ReceiverAuthorizerSigner, extra.CaptureAuthorizer, chainID, paymentInfoHash)
		if err != nil {
			return nil, fmt.Errorf(ErrFailedToSignVoid+": %w", err)
		}
		result["voidAuthorizerSignature"] = evm.BytesToHex(voidSignature)
	}
	return result, nil
}

type collectFields struct {
	payer             string
	preApprovalExpiry uint64
	salt              string
	authorizedAmount  string
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
		return collectFields{p.Authorization.From, expiry, p.Salt, p.Authorization.Value}, nil
	case authcapture.IsPermit2Payload(payload):
		p, err := authcapture.Permit2CollectPayloadFromMap(payload)
		if err != nil {
			return collectFields{}, err
		}
		expiry, err := strconv.ParseUint(p.Permit2Authorization.Deadline, 10, 64)
		if err != nil {
			return collectFields{}, fmt.Errorf("invalid permit2Authorization.deadline: %s", p.Permit2Authorization.Deadline)
		}
		return collectFields{p.Permit2Authorization.From, expiry, p.Salt, p.Permit2Authorization.Permitted.Amount}, nil
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
