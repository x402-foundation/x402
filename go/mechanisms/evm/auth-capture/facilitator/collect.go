package facilitator

import (
	"context"
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
}

// collectPreconditions is the verified state settleCollect reuses from verifyCollect.
type collectPreconditions struct {
	deployment   authcapture.AuthCaptureDeployment
	paymentInfo  authcapture.PaymentInfoStruct
	payer        string
	collector    string
	sigData      *evm.ERC6492SignatureData
	rawSignature []byte
}

func parseEip3009Auth(payload map[string]interface{}, rc *requestContext, asset string) (*collectAuth, error) {
	p, err := authcapture.Eip3009CollectPayloadFromMap(payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	auth := p.Authorization
	if p.Charge != nil {
		return nil, x402.NewVerifyError(ErrUnsupportedPaymentFlow, auth.From, "terminal charge completion is not supported")
	}
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
	}, nil
}

func parsePermit2Auth(payload map[string]interface{}, rc *requestContext) (*collectAuth, error) {
	p, err := authcapture.Permit2CollectPayloadFromMap(payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	auth := p.Permit2Authorization
	if p.Charge != nil {
		return nil, x402.NewVerifyError(ErrUnsupportedPaymentFlow, auth.From, "terminal charge completion is not supported")
	}
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
	}, nil
}

// checkOperator applies the operator, policy and payment-flow checks for a collect payload.
func (f *AuthCaptureEvmScheme) checkOperator(extra authcapture.AuthCaptureExtra, payer string) error {
	if extra.OperatorType != "" && extra.OperatorType != "delegated" {
		return x402.NewVerifyError(ErrUnsupportedOperatorType, payer, fmt.Sprintf("unsupported operatorType: %s", extra.OperatorType))
	}
	if !f.controlsAddress(extra.CaptureAuthorizer) {
		return x402.NewVerifyError(ErrOperatorNotAdmitted, payer, fmt.Sprintf("captureAuthorizer %s is not controlled by this facilitator", extra.CaptureAuthorizer))
	}
	if authcapture.IsNonZeroAddress(extra.Policy) {
		return x402.NewVerifyError(ErrPolicy, payer, "policy operator type is not supported")
	}
	if extra.PaymentFlow != "" && extra.PaymentFlow != "escrow" {
		return x402.NewVerifyError(ErrUnsupportedPaymentFlow, payer, fmt.Sprintf("unsupported paymentFlow: %s", extra.PaymentFlow))
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

// checkBindings requires the collector, token and amount to match the requirements.
func checkBindings(requirements types.PaymentRequirements, auth *collectAuth) error {
	if !strings.EqualFold(auth.collector, auth.expectedCollector) {
		return x402.NewVerifyError(ErrTokenCollectorMismatch, auth.payer, fmt.Sprintf("collector mismatch: %s != %s", auth.collector, auth.expectedCollector))
	}
	if auth.token != "" && !strings.EqualFold(auth.token, requirements.Asset) {
		return x402.NewVerifyError(ErrTokenMismatch, auth.payer, "permitted token mismatch")
	}
	if auth.amount != requirements.Amount {
		return x402.NewVerifyError(ErrAmountMismatch, auth.payer, fmt.Sprintf("amount mismatch: %s != %s", auth.amount, requirements.Amount))
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

// checkCollectPreconditions runs every collect verification step short of simulation.
func (f *AuthCaptureEvmScheme) checkCollectPreconditions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*collectPreconditions, error) {
	payer := payloadPayer(payload.Payload)
	rc, err := checkRequest(payload, requirements, payer)
	if err != nil {
		return nil, err
	}
	if err := f.checkOperator(rc.extra, payer); err != nil {
		return nil, err
	}

	var auth *collectAuth
	if authcapture.IsPermit2Payload(payload.Payload) {
		auth, err = parsePermit2Auth(payload.Payload, rc)
	} else {
		auth, err = parseEip3009Auth(payload.Payload, rc, requirements.Asset)
	}
	if err != nil {
		return nil, err
	}

	if err := checkMethodRouting(rc.extra, auth); err != nil {
		return nil, err
	}
	if err := checkTimes(rc.extra, requirements, auth); err != nil {
		return nil, err
	}
	if err := checkBindings(requirements, auth); err != nil {
		return nil, err
	}
	if err := checkSalt(rc.extra, auth); err != nil {
		return nil, err
	}

	paymentInfo := authcapture.ReconstructPaymentInfo(auth.payer, auth.validBefore, auth.salt, requirements, rc.extra)
	expectedNonce, err := authcapture.ComputePayerAgnosticPaymentInfoHash(rc.chainID, paymentInfo, rc.deployment.Escrow)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, auth.payer, err.Error())
	}
	if !strings.EqualFold(expectedNonce, auth.nonce) {
		return nil, x402.NewVerifyError(ErrNonceMismatch, auth.payer, fmt.Sprintf("nonce mismatch: %s != %s", auth.nonce, expectedNonce))
	}

	sigData, err := f.verifyPayerSignature(ctx, auth)
	if err != nil {
		return nil, err
	}
	return &collectPreconditions{
		deployment:   rc.deployment,
		paymentInfo:  paymentInfo,
		payer:        auth.payer,
		collector:    auth.expectedCollector,
		sigData:      sigData,
		rawSignature: sigData.InnerSignature,
	}, nil
}

// authorizeArgs are the AuthCaptureEscrow.authorize call arguments.
func (pre *collectPreconditions) authorizeArgs() ([]interface{}, error) {
	amount, ok := new(big.Int).SetString(pre.paymentInfo.MaxAmount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrPayloadFormat, pre.payer, "invalid amount")
	}
	tuple, err := pre.paymentInfo.ToAbiTuple()
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, pre.payer, err.Error())
	}
	return []interface{}{tuple, amount, common.HexToAddress(pre.collector), pre.rawSignature}, nil
}

// simulateAuthorize simulates the authorize call, or only the factory deploy for a counterfactual payer.
func simulateAuthorize(ctx context.Context, signer evm.FacilitatorEvmSigner, pre *collectPreconditions) error {
	if needsFactoryDeploy(pre.sigData) {
		return simulateFactoryDeploy(ctx, signer, pre.sigData, pre.payer)
	}
	args, err := pre.authorizeArgs()
	if err != nil {
		return err
	}
	return simulateEscrowCall(ctx, signer, &pre.deployment, pre.paymentInfo.Operator, pre.payer, "authorize", args...)
}

// verifyCollect validates an EIP-3009 or Permit2 collect payload and simulates the authorize.
func (f *AuthCaptureEvmScheme) verifyCollect(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.VerifyResponse, error) {
	pre, err := f.checkCollectPreconditions(ctx, payload, requirements)
	if err != nil {
		return nil, err
	}
	if err := simulateAuthorize(ctx, f.signer, pre); err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: pre.payer}, nil
}

// settleCollect submits the authorize call for a collect payload.
func (f *AuthCaptureEvmScheme) settleCollect(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	if resp, err := f.resumePending(ctx, payload, requirements); resp != nil || err != nil {
		return resp, err
	}

	pre, err := f.checkCollectPreconditions(ctx, payload, requirements)
	if err != nil {
		return nil, toSettleError(err, network, "")
	}
	if f.config.SimulateInSettle {
		if err := simulateAuthorize(ctx, f.signer, pre); err != nil {
			return nil, toSettleError(err, network, pre.payer)
		}
	}
	if needsFactoryDeploy(pre.sigData) {
		if err := evm.SendFactoryDeployTransaction(ctx, f.signer, pre.sigData); err != nil {
			return nil, x402.NewSettleError(ErrSmartWalletDeploymentFailed, pre.payer, network, "", err.Error())
		}
	}

	args, err := pre.authorizeArgs()
	if err != nil {
		return nil, toSettleError(err, network, pre.payer)
	}
	txHash, err := f.writeEscrow(ctx, fctx, payload, requirements, &pre.deployment, pre.payer, "authorize", args...)
	if err != nil {
		return nil, err
	}
	return f.awaitSettlement(ctx, payload, requirements, pre.payer, txHash)
}
