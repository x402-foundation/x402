package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	methodEip3009 = "eip3009"
	methodPermit2 = "permit2"
)

// collectAuth is the method-independent view of an EIP-3009 or Permit2 collect payload.
type collectAuth struct {
	method            string
	payer             string
	collector         string
	expectedCollector string
	token             string // Permit2 only; EIP-3009 binds the token through its domain
	amount            string
	validAfter        uint64
	validBefore       uint64
	nonce             string
	digest            [32]byte
	signature         string
	salt              string
	saltNonce         string
	charge            *authcapture.ChargeCompletion
}

// collectOperation is the escrow call a collect payload settles as: authorize for the whole hold,
// or charge of the amount and fee the server's completion names (the provisional full amount and
// default fee until the payload is completed).
type collectOperation struct {
	function    string
	amount      *big.Int
	fee         authcapture.CaptureFee
	feeReceiver string
	completed   bool
}

// collectOutcome is what a collect call must leave on chain, reconstructed from the payload
// without verifying it. A resumed settlement checks a custom operator against it.
type collectOutcome struct {
	collectOperation
	deployment      authcapture.AuthCaptureDeployment
	extra           authcapture.AuthCaptureExtra
	paymentInfo     authcapture.PaymentInfoStruct
	paymentInfoHash string
	payer           string
	tokenCollector  string
	network         x402.Network
}

// collectPreconditions is the verified state settleCollect reuses from verifyCollect.
type collectPreconditions struct {
	collectOutcome
	auth         *collectAuth
	sigData      *evm.ERC6492SignatureData
	rawSignature []byte
}

func parseEip3009Auth(payload map[string]interface{}, rc *requestContext, asset string) (*collectAuth, error) {
	p, err := authcapture.Eip3009CollectPayloadFromMap(payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	auth := p.Authorization
	validAfter, err := strconv.ParseUint(auth.ValidAfter, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.From, "invalid validAfter")
	}
	validBefore, err := strconv.ParseUint(auth.ValidBefore, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.From, "invalid validBefore")
	}
	digest, err := authcapture.HashERC3009Authorization(auth, rc.extra, asset, rc.chainID)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.From, err.Error())
	}
	return &collectAuth{
		method:            methodEip3009,
		payer:             auth.From,
		collector:         auth.To,
		expectedCollector: rc.deployment.EIP3009Collector,
		amount:            auth.Value,
		validAfter:        validAfter,
		validBefore:       validBefore,
		nonce:             auth.Nonce,
		digest:            digest,
		signature:         p.Signature,
		salt:              p.Salt,
		saltNonce:         p.SaltNonce,
		charge:            p.Charge,
	}, nil
}

func parsePermit2Auth(payload map[string]interface{}, rc *requestContext) (*collectAuth, error) {
	p, err := authcapture.Permit2CollectPayloadFromMap(payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	auth := p.Permit2Authorization
	deadline, err := strconv.ParseUint(auth.Deadline, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.From, "invalid deadline")
	}
	nonce, ok := new(big.Int).SetString(auth.Nonce, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.From, "invalid nonce")
	}
	digest, err := authcapture.HashPermit2Authorization(auth, rc.chainID)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.From, err.Error())
	}
	return &collectAuth{
		method:            methodPermit2,
		payer:             auth.From,
		collector:         auth.Spender,
		expectedCollector: rc.deployment.Permit2Collector,
		token:             auth.Permitted.Token,
		amount:            auth.Permitted.Amount,
		validBefore:       deadline,
		nonce:             evm.BytesToHex(common.LeftPadBytes(nonce.Bytes(), 32)),
		digest:            digest,
		signature:         p.Signature,
		salt:              p.Salt,
		saltNonce:         p.SaltNonce,
		charge:            p.Charge,
	}, nil
}

// checkOperator applies the operator and policy checks. A lifecycle payload is relayed only for
// a delegated operator with a receiver authorizer; a custom operator runs lifecycle out of band.
func (f *AuthCaptureEvmScheme) checkOperator(extra authcapture.AuthCaptureExtra, payer string, lifecycle bool) error {
	if authcapture.IsNonZeroAddress(extra.Policy) {
		return x402.NewVerifyError(ErrPolicy, payer, "policy operator type is not supported")
	}
	switch extra.OperatorType {
	case authcapture.OperatorTypeCustom:
		if !f.operatorAdmitted(extra.CaptureAuthorizer) {
			return x402.NewVerifyError(ErrOperatorNotAdmitted, payer, fmt.Sprintf("captureAuthorizer %s is not an admitted custom operator", extra.CaptureAuthorizer))
		}
		if lifecycle {
			return x402.NewVerifyError(ErrLifecycleNotRelayed, payer, "lifecycle payloads are not relayed for custom operators")
		}
	case "", authcapture.OperatorTypeDelegated:
		if !f.controlsAddress(extra.CaptureAuthorizer) {
			return x402.NewVerifyError(ErrOperatorNotAdmitted, payer, fmt.Sprintf("captureAuthorizer %s is not controlled by this facilitator", extra.CaptureAuthorizer))
		}
		if lifecycle && !authcapture.IsNonZeroAddress(extra.ReceiverAuthorizer) {
			return x402.NewVerifyError(ErrLifecycleNotRelayed, payer, "lifecycle payloads require a non-zero receiverAuthorizer")
		}
	default:
		return x402.NewVerifyError(ErrUnsupportedOperatorType, payer, fmt.Sprintf("unsupported operatorType: %s", extra.OperatorType))
	}
	return nil
}

// checkMethodRouting requires the payload shape to match extra.assetTransferMethod.
func checkMethodRouting(extra authcapture.AuthCaptureExtra, auth *collectAuth) error {
	expected := extra.AssetTransferMethod
	if expected == "" {
		expected = methodEip3009
	}
	if expected != methodEip3009 && expected != methodPermit2 {
		return x402.NewVerifyError(ErrUnsupportedAssetTransferMethod, auth.payer, fmt.Sprintf("unsupported assetTransferMethod: %s", expected))
	}
	if expected != auth.method {
		return x402.NewVerifyError(ErrPayloadMethodMismatch, auth.payer, fmt.Sprintf("%s payload for assetTransferMethod %s", auth.method, expected))
	}
	return nil
}

// checkTimes applies the deadline ordering and time window steps.
func checkTimes(extra authcapture.AuthCaptureExtra, requirements types.PaymentRequirements, auth *collectAuth) error {
	now := uint64(time.Now().Unix())
	floor := now + timeSkewSeconds
	timeout := uint64(max(requirements.MaxTimeoutSeconds, 0))

	if extra.CaptureDeadline <= floor {
		return x402.NewVerifyError(ErrCaptureDeadlineExpired, auth.payer, "captureDeadline is too close or in the past")
	}
	if extra.RefundDeadline < extra.CaptureDeadline || now+timeout > extra.CaptureDeadline || auth.validBefore > extra.CaptureDeadline {
		return x402.NewVerifyError(ErrDeadlineOrdering, auth.payer, "now + maxTimeoutSeconds <= captureDeadline <= refundDeadline violated")
	}
	if auth.validBefore <= floor {
		return x402.NewVerifyError(ErrAuthorizationExpired, auth.payer, "authorization already expired")
	}
	if auth.validAfter > now {
		return x402.NewVerifyError(ErrAuthorizationNotYetValid, auth.payer, "authorization not yet valid")
	}
	return nil
}

// checkBindings requires the collector, token and amount to match the requirements. The amount
// is the one the payer was offered: on a charge settle requirements.Amount carries the charge.
func checkBindings(acceptedAmount string, requirements types.PaymentRequirements, auth *collectAuth) error {
	if !strings.EqualFold(auth.collector, auth.expectedCollector) {
		return x402.NewVerifyError(ErrTokenCollectorMismatch, auth.payer, fmt.Sprintf("collector mismatch: %s != %s", auth.collector, auth.expectedCollector))
	}
	if auth.token != "" && !strings.EqualFold(auth.token, requirements.Asset) {
		return x402.NewVerifyError(ErrTokenMismatch, auth.payer, "permitted token mismatch")
	}
	if auth.amount != acceptedAmount {
		return x402.NewVerifyError(ErrAmountMismatch, auth.payer, fmt.Sprintf("amount mismatch: %s != %s", auth.amount, acceptedAmount))
	}
	return nil
}

// checkSalt requires saltNonce exactly when the bind is on, and the derived salt to match.
func checkSalt(extra authcapture.AuthCaptureExtra, auth *collectAuth) error {
	bindOn := authcapture.IsSaltBindingOn(extra)
	if bindOn != (auth.saltNonce != "") {
		return x402.NewVerifyError(ErrPayloadFormat, auth.payer, "saltNonce must be present if and only if salt binding is on")
	}
	if !bindOn {
		return nil
	}
	expectedSalt, err := authcapture.DeriveBoundSalt(
		authcapture.ExtraAddress(extra.ReceiverAuthorizer),
		authcapture.ExtraAddress(extra.Policy),
		auth.saltNonce,
	)
	if err != nil {
		return x402.NewVerifyError(ErrSaltBindingMismatch, auth.payer, err.Error())
	}
	if !strings.EqualFold(expectedSalt, auth.salt) {
		return x402.NewVerifyError(ErrSaltBindingMismatch, auth.payer, "salt does not match derived bound salt")
	}
	return nil
}

// verifyPayerSignature checks the client signature. Only a counterfactual smart-wallet payer
// passes on an allowlisted factory, with the deploy simulation vouching for it. A deployed
// wallet must always present a signature its own ERC-1271 check accepts, wrapped or not.
func (f *AuthCaptureEvmScheme) verifyPayerSignature(ctx context.Context, auth *collectAuth) (*evm.ERC6492SignatureData, error) {
	signatureBytes, err := evm.HexToBytes(auth.signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrSignature, auth.payer, err.Error())
	}
	valid, sigData, err := evm.VerifyUniversalSignature(ctx, f.signer, auth.payer, auth.digest, signatureBytes, true)
	if err != nil {
		return nil, x402.NewVerifyError(ErrSignature, auth.payer, err.Error())
	}
	if sigData == nil {
		sigData = &evm.ERC6492SignatureData{InnerSignature: signatureBytes}
	}
	if valid {
		return sigData, nil
	}
	switch {
	case sigData.CodeDeployed:
		return nil, x402.NewVerifyError(ErrSignature, auth.payer, "deployed wallet signature failed ERC-1271 verification")
	case evm.HasEIP6492Deployment(sigData):
		if !evm.IsFactoryAllowed(sigData.Factory, f.config.EIP6492AllowedFactories) {
			return nil, x402.NewVerifyError(ErrErc6492FactoryNotAllowed, auth.payer, "factory not in EIP6492AllowedFactories allowlist")
		}
		return sigData, nil
	case len(sigData.InnerSignature) != 65:
		return nil, x402.NewVerifyError(ErrUndeployedSmartWallet, auth.payer, "smart wallet signature could not be verified")
	default:
		return nil, x402.NewVerifyError(ErrSignature, auth.payer, "invalid signature")
	}
}

// resolveCollectOperation decides the escrow call: authorize for an escrow payload, charge for an
// authorization payload. A charge is completed by the server's amount, fee and signature; before
// that (a raw /verify) it is simulated as a full-amount charge at the minimum fee, and /settle
// rejects it with requireCompletion.
func resolveCollectOperation(rc *requestContext, auth *collectAuth, requireCompletion bool) (collectOperation, error) {
	signed, ok := parseUint(auth.amount)
	if !ok {
		return collectOperation{}, x402.NewVerifyError(ErrPayloadFormat, auth.payer, "invalid amount")
	}
	charging := rc.extra.PaymentFlow == authcapture.PaymentFlowAuthorization
	switch {
	case auth.charge != nil && !charging:
		return collectOperation{}, x402.NewVerifyError(ErrPayloadFormat, auth.payer, "charge completion requires paymentFlow authorization")
	case auth.charge == nil && !charging:
		return collectOperation{function: "authorize", amount: signed}, nil
	case auth.charge == nil && requireCompletion:
		return collectOperation{}, x402.NewVerifyError(ErrPayloadFormat, auth.payer, "settle requires a completed charge payload")
	case auth.charge == nil:
		return collectOperation{
			function:    "charge",
			amount:      signed,
			fee:         authcapture.DefaultCaptureFee(&rc.deployment, signed, rc.extra.MinFeeBps),
			feeReceiver: rc.extra.FeeRecipient,
		}, nil
	}

	charge := auth.charge
	amount, ok := parseUint(charge.Amount)
	if !ok {
		return collectOperation{}, x402.NewVerifyError(ErrPayloadFormat, auth.payer, "invalid charge amount")
	}
	if amount.Sign() == 0 || amount.Cmp(signed) > 0 {
		return collectOperation{}, x402.NewVerifyError(ErrAmountMismatch, auth.payer, "charge amount must be > 0 and <= the signed amount")
	}
	fee, ok := parseSubmittedFee(charge.FeeBps, charge.FeeAmount, &rc.deployment)
	if !ok {
		return collectOperation{}, x402.NewVerifyError(ErrPayloadFormat, auth.payer, "charge fee field does not match the escrow deployment")
	}
	if reason := validateSubmittedFee(rc.extra, amount, fee, charge.FeeReceiver); reason != "" {
		return collectOperation{}, x402.NewVerifyError(reason, auth.payer, "submitted fee or feeReceiver does not satisfy extra")
	}
	return collectOperation{function: "charge", amount: amount, fee: fee, feeReceiver: charge.FeeReceiver, completed: true}, nil
}

func parseCollectAuth(payload types.PaymentPayload, rc *requestContext, requirements types.PaymentRequirements) (*collectAuth, error) {
	if authcapture.IsPermit2Payload(payload.Payload) {
		return parsePermit2Auth(payload.Payload, rc)
	}
	return parseEip3009Auth(payload.Payload, rc, requirements.Asset)
}

// newCollectOutcome reconstructs the PaymentInfo the payer signed, which is bound to the amount
// it was offered (payload.Accepted), not a charge settle's overridden requirements.Amount.
func newCollectOutcome(
	rc *requestContext,
	auth *collectAuth,
	op collectOperation,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*collectOutcome, error) {
	accepted := requirements
	accepted.Amount = payload.Accepted.Amount
	paymentInfo := authcapture.ReconstructPaymentInfo(auth.payer, auth.validBefore, auth.salt, accepted, rc.extra)
	hash, err := authcapture.ComputePaymentInfoHash(rc.chainID, paymentInfo, auth.payer, rc.deployment.Escrow)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.payer, err.Error())
	}
	return &collectOutcome{
		collectOperation: op,
		deployment:       rc.deployment,
		extra:            rc.extra,
		paymentInfo:      paymentInfo,
		paymentInfoHash:  hash,
		payer:            auth.payer,
		tokenCollector:   auth.expectedCollector,
		network:          x402.Network(payload.Accepted.Network),
	}, nil
}

// reconstructCollectOutcome rebuilds a collect's expected outcome without verifying it, for a
// settlement resumed after its transaction was already broadcast.
func reconstructCollectOutcome(payload types.PaymentPayload, requirements types.PaymentRequirements) (*collectOutcome, error) {
	payer := payloadPayer(payload.Payload)
	rc, err := checkRequest(payload, requirements, payer)
	if err != nil {
		return nil, err
	}
	auth, err := parseCollectAuth(payload, rc, requirements)
	if err != nil {
		return nil, err
	}
	op, err := resolveCollectOperation(rc, auth, true)
	if err != nil {
		return nil, err
	}
	return newCollectOutcome(rc, auth, op, payload, requirements)
}

// chargeParams are the values the receiver authorizer signs for a completed charge. The
// collector data is the client signature exactly as it arrived on the wire.
func chargeParams(auth *collectAuth, out *collectOutcome) (authcapture.ChargeParams, error) {
	collectorData, err := evm.HexToBytes(auth.signature)
	if err != nil {
		return authcapture.ChargeParams{}, x402.NewVerifyError(ErrSignature, auth.payer, err.Error())
	}
	return authcapture.ChargeParams{
		PaymentInfoHash: out.paymentInfoHash,
		Amount:          out.amount,
		TokenCollector:  out.tokenCollector,
		CollectorData:   collectorData,
		Fee:             out.fee,
		FeeReceiver:     out.feeReceiver,
	}, nil
}

// checkChargeSignature verifies the receiver authorizer's signature over a completed charge.
func (f *AuthCaptureEvmScheme) checkChargeSignature(ctx context.Context, rc *requestContext, auth *collectAuth, out *collectOutcome) error {
	signature, err := evm.HexToBytes(auth.charge.AuthorizerSignature)
	if err != nil {
		return x402.NewVerifyError(ErrAuthorizerSignature, auth.payer, err.Error())
	}
	params, err := chargeParams(auth, out)
	if err != nil {
		return err
	}
	valid, err := authcapture.VerifyCharge(ctx, f.signer, rc.extra.ReceiverAuthorizer, &rc.deployment, rc.extra.CaptureAuthorizer, rc.chainID, params, signature)
	if err != nil {
		return x402.NewVerifyError(ErrAuthorizerSignature, auth.payer, err.Error())
	}
	if !valid {
		return x402.NewVerifyError(ErrAuthorizerSignature, auth.payer, "authorizer signature invalid")
	}
	return nil
}

// checkCollectPreconditions runs every collect verification step short of simulation.
func (f *AuthCaptureEvmScheme) checkCollectPreconditions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	requireCompletion bool,
) (*collectPreconditions, error) {
	payer := payloadPayer(payload.Payload)
	rc, err := checkRequest(payload, requirements, payer)
	if err != nil {
		return nil, err
	}
	if err := f.checkOperator(rc.extra, payer, false); err != nil {
		return nil, err
	}

	auth, err := parseCollectAuth(payload, rc, requirements)
	if err != nil {
		return nil, err
	}
	if err := checkMethodRouting(rc.extra, auth); err != nil {
		return nil, err
	}
	if err := checkTimes(rc.extra, requirements, auth); err != nil {
		return nil, err
	}
	if err := checkBindings(payload.Accepted.Amount, requirements, auth); err != nil {
		return nil, err
	}
	if err := checkSalt(rc.extra, auth); err != nil {
		return nil, err
	}

	op, err := resolveCollectOperation(rc, auth, requireCompletion)
	if err != nil {
		return nil, err
	}
	out, err := newCollectOutcome(rc, auth, op, payload, requirements)
	if err != nil {
		return nil, err
	}
	expectedNonce, err := authcapture.ComputePayerAgnosticPaymentInfoHash(rc.chainID, out.paymentInfo, rc.deployment.Escrow)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.payer, err.Error())
	}
	if !strings.EqualFold(expectedNonce, auth.nonce) {
		return nil, x402.NewVerifyError(ErrNonceMismatch, auth.payer, fmt.Sprintf("nonce mismatch: %s != %s", auth.nonce, expectedNonce))
	}
	if op.completed {
		if auth.charge.AuthorizerSignature != "" {
			if err := f.checkChargeSignature(ctx, rc, auth, out); err != nil {
				return nil, err
			}
		} else if getDelegatedAuthorizer(f.config, rc.extra.ReceiverAuthorizer) == nil {
			// A delegated authorizer signs at settle time, after authenticating the caller.
			return nil, x402.NewVerifyError(ErrAuthorizerSignature, auth.payer, "authorizerSignature is required unless the authorizer is delegated to this facilitator")
		}
	}

	sigData, err := f.verifyPayerSignature(ctx, auth)
	if err != nil {
		return nil, err
	}
	if rc.extra.OperatorType == authcapture.OperatorTypeCustom && needsFactoryDeploy(sigData) {
		return nil, x402.NewVerifyError(ErrUndeployedSmartWallet, auth.payer, "custom operators do not support counterfactual wallets")
	}
	return &collectPreconditions{collectOutcome: *out, auth: auth, sigData: sigData, rawSignature: sigData.InnerSignature}, nil
}

// escrowArgs are the AuthCaptureEscrow authorize or charge call arguments.
func (pre *collectPreconditions) escrowArgs() ([]interface{}, error) {
	tuple, err := pre.paymentInfo.ToAbiTuple()
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, pre.payer, err.Error())
	}
	args := []interface{}{tuple, pre.amount, common.HexToAddress(pre.tokenCollector), pre.rawSignature}
	if pre.function == "charge" {
		args = append(args, pre.fee.Arg(), common.HexToAddress(pre.feeReceiver))
	}
	return args, nil
}

// simulateCollect simulates the collect call, or only the factory deploy for a counterfactual payer.
// A failed simulation is reported as insufficient_balance when the payer holds less than it signed.
func (f *AuthCaptureEvmScheme) simulateCollect(ctx context.Context, pre *collectPreconditions) error {
	err := f.simulateCollectCall(ctx, pre)
	if err == nil {
		return nil
	}
	var verifyErr *x402.VerifyError
	if !errors.As(err, &verifyErr) {
		return err
	}
	balance := readTokenBalance(ctx, f.signer, pre.paymentInfo.Token, pre.payer)
	signed, ok := parseUint(pre.paymentInfo.MaxAmount)
	if balance == nil || !ok || balance.Cmp(signed) >= 0 {
		return err
	}
	return x402.NewVerifyError(ErrInsufficientBalance, pre.payer, "payer balance is below the signed amount")
}

func (f *AuthCaptureEvmScheme) simulateCollectCall(ctx context.Context, pre *collectPreconditions) error {
	if pre.extra.OperatorType == authcapture.OperatorTypeCustom {
		return f.simulateCustomCollect(ctx, pre)
	}
	if needsFactoryDeploy(pre.sigData) {
		return simulateFactoryDeploy(ctx, f.signer, pre.sigData, pre.payer)
	}
	args, err := pre.escrowArgs()
	if err != nil {
		return err
	}
	return simulateEscrowCall(ctx, f.signer, &pre.deployment, pre.paymentInfo.Operator, pre.payer, pre.function, args...)
}

// verifyCollect validates an EIP-3009 or Permit2 collect payload and simulates its authorize or charge.
func (f *AuthCaptureEvmScheme) verifyCollect(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.VerifyResponse, error) {
	pre, err := f.checkCollectPreconditions(ctx, payload, requirements, false)
	if err != nil {
		return nil, err
	}
	if err := f.simulateCollect(ctx, pre); err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: pre.payer}, nil
}

// settleCollect submits the authorize or charge call for a collect payload. A charge and a custom
// operator are always re-simulated: the first moves the funds for good, the second is untrusted code.
func (f *AuthCaptureEvmScheme) settleCollect(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	if resp, err := f.resumePending(ctx, payload, requirements, f.resumedCollectCheck(payload, requirements)); resp != nil || err != nil {
		return resp, err
	}

	pre, err := f.checkCollectPreconditions(ctx, payload, requirements, true)
	if err != nil {
		return nil, toSettleError(err, network, "")
	}
	custom := pre.extra.OperatorType == authcapture.OperatorTypeCustom
	if f.config.SimulateInSettle || custom || pre.completed {
		if err := f.simulateCollect(ctx, pre); err != nil {
			return nil, toSettleError(err, network, pre.payer)
		}
	}

	delegated := getDelegatedAuthorizer(f.config, pre.extra.ReceiverAuthorizer)
	if delegated == nil {
		return f.broadcastCollect(ctx, fctx, payload, requirements, pre).response()
	}

	bindRecord, err := f.authenticateDelegatedCollect(ctx, delegated, fctx, payload, requirements, pre)
	if err != nil {
		return nil, err
	}
	if bindRecord == nil {
		return f.broadcastCollect(ctx, fctx, payload, requirements, pre).response()
	}
	bound := bindThenBroadcast(ctx, delegated, *bindRecord, func() (settleOutcome, bindDisposition) {
		outcome := f.broadcastCollect(ctx, fctx, payload, requirements, pre)
		return outcome, outcome.disposition
	})
	if !bound.OK {
		if bound.Reason == bindConflict {
			return nil, x402.NewSettleError(ErrUnauthenticatedAuthorizerRequest, pre.payer, network, "", "")
		}
		return nil, x402.NewSettleError(ErrDelegatedAuthUnavailable, pre.payer, network, "",
			"failed to bind delegated caller: "+evm.TruncateErrorMessage(bound.Err.Error()))
	}
	return bound.Value.response()
}

// settleOutcome is a settle result, which is either a response or an error, and whether a caller
// binding written for it should be kept: it is reverted only when no transaction can have landed.
type settleOutcome struct {
	resp        *x402.SettleResponse
	err         error
	disposition bindDisposition
}

func (o settleOutcome) response() (*x402.SettleResponse, error) {
	return o.resp, o.err
}

// notBroadcast is the outcome of a settle that failed before any transaction was sent.
func notBroadcast(err error) settleOutcome {
	return settleOutcome{err: err, disposition: bindRevert}
}

// awaited is the outcome of a settle whose transaction was broadcast. A pending receipt or any
// other post-broadcast outcome may still have landed onchain; only a revert is final.
func awaited(resp *x402.SettleResponse, err error) settleOutcome {
	var settleErr *x402.SettleError
	if errors.As(err, &settleErr) && settleErr.ErrorReason == ErrTransactionReverted {
		return settleOutcome{resp: resp, err: err, disposition: bindRevert}
	}
	return settleOutcome{resp: resp, err: err, disposition: bindKeep}
}

// authenticateDelegatedCollect authenticates a collect whose authorizer is delegated to this
// facilitator, produces the Charge signature the server omitted, and returns the binding to write
// before broadcast. It returns a nil record when the payment needs no binding.
func (f *AuthCaptureEvmScheme) authenticateDelegatedCollect(
	ctx context.Context,
	delegated *delegatedAuthorizer,
	fctx *x402.FacilitatorContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	pre *collectPreconditions,
) (*AuthCaptureDelegatedAuthRecord, error) {
	network := pre.network
	fail := func(reason, message string) error {
		return x402.NewSettleError(reason, pre.payer, network, "", message)
	}

	identity := resolveDelegatedCallerIdentity(ctx, delegated, DelegatedSettleContext{
		Step:               DelegatedStep(pre.function),
		PaymentInfoHash:    pre.paymentInfoHash,
		Network:            network,
		Payer:              pre.payer,
		Payload:            payload,
		Requirements:       requirements,
		FacilitatorContext: fctx,
	})
	if identity == "" {
		return nil, fail(ErrUnauthenticatedAuthorizerRequest, "")
	}

	if pre.function == "charge" && pre.auth.charge.AuthorizerSignature == "" {
		if err := f.signDelegatedCharge(ctx, delegated, pre); err != nil {
			return nil, toSettleError(err, network, pre.payer)
		}
	}

	// Only payments whose later steps the facilitator can still relay need a binding.
	// A custom operator's lifecycle is never relayed, and a charge is only refundable
	// through the facilitator when refunds are funded.
	relayable := pre.extra.OperatorType != authcapture.OperatorTypeCustom &&
		(pre.function == "authorize" || f.config.RefundFunding)
	if !relayable {
		return nil, nil
	}
	return &AuthCaptureDelegatedAuthRecord{
		Network:         network,
		PaymentInfoHash: pre.paymentInfoHash,
		CallerIdentity:  identity,
		ExpiresAt:       pre.extra.RefundDeadline,
	}, nil
}

// signDelegatedCharge signs the Charge digest the server omitted and checks that the signature
// verifies as the receiver authorizer's.
func (f *AuthCaptureEvmScheme) signDelegatedCharge(ctx context.Context, delegated *delegatedAuthorizer, pre *collectPreconditions) error {
	chainID, err := evm.GetEvmChainId(string(pre.network))
	if err != nil {
		return x402.NewVerifyError(ErrInvalidNetwork, pre.payer, err.Error())
	}
	params, err := chargeParams(pre.auth, &pre.collectOutcome)
	if err != nil {
		return err
	}
	signature, err := authcapture.SignCharge(ctx, delegated.signer, &pre.deployment, pre.extra.CaptureAuthorizer, chainID, params)
	if err != nil {
		return x402.NewVerifyError(ErrAuthorizerSignature, pre.payer, err.Error())
	}
	valid, err := authcapture.VerifyCharge(ctx, f.signer, pre.extra.ReceiverAuthorizer, &pre.deployment, pre.extra.CaptureAuthorizer, chainID, params, signature)
	if err != nil {
		return x402.NewVerifyError(ErrAuthorizerSignature, pre.payer, err.Error())
	}
	if !valid {
		return x402.NewVerifyError(ErrAuthorizerSignature, pre.payer, "authorizer signature invalid")
	}
	return nil
}

// broadcastCollect submits the authorize or charge call and awaits its receipt.
func (f *AuthCaptureEvmScheme) broadcastCollect(
	ctx context.Context,
	fctx *x402.FacilitatorContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	pre *collectPreconditions,
) settleOutcome {
	network := pre.network
	custom := pre.extra.OperatorType == authcapture.OperatorTypeCustom
	if needsFactoryDeploy(pre.sigData) {
		if err := evm.SendFactoryDeployTransaction(ctx, f.signer, pre.sigData); err != nil {
			return notBroadcast(x402.NewSettleError(ErrSmartWalletDeploymentFailed, pre.payer, network, "", err.Error()))
		}
	}

	args, err := pre.escrowArgs()
	if err != nil {
		return notBroadcast(toSettleError(err, network, pre.payer))
	}
	if !custom {
		txHash, err := f.writeEscrow(ctx, fctx, payload, requirements, &pre.deployment, pre.paymentInfo.Operator, pre.payer, pre.function, args...)
		if err != nil {
			return notBroadcast(err)
		}
		return awaited(f.awaitSettlement(ctx, payload, requirements, pre.payer, txHash, nil))
	}

	before, err := f.snapshotCustomBalances(ctx, &pre.collectOutcome)
	if err != nil {
		return notBroadcast(toSettleError(err, network, pre.payer))
	}
	txHash, err := f.submitEscrowCall(ctx, fctx, payload, requirements, &pre.deployment, "", pre.payer,
		pre.extra.CaptureAuthorizer, f.customGasLimit(), pre.function, args...)
	if err != nil {
		return notBroadcast(err)
	}
	return awaited(f.awaitSettlement(ctx, payload, requirements, pre.payer, txHash, f.customReceiptCheck(&pre.collectOutcome, before)))
}

// resumedCollectCheck is the receipt check for a collect whose transaction was broadcast by an
// earlier settle attempt. Only a custom operator needs one.
func (f *AuthCaptureEvmScheme) resumedCollectCheck(payload types.PaymentPayload, requirements types.PaymentRequirements) receiptCheck {
	return func(ctx context.Context, receipt *evm.TransactionReceipt) (*x402.SettleResponse, error) {
		out, err := reconstructCollectOutcome(payload, requirements)
		if err != nil || out.extra.OperatorType != authcapture.OperatorTypeCustom {
			return nil, nil //nolint:nilerr // an unreadable outcome is reported by the settle that resumes it
		}
		return f.customReceiptCheck(out, nil)(ctx, receipt)
	}
}
