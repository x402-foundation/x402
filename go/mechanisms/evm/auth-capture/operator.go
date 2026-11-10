package authcapture

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// OperatorDomain returns the EIP-712 domain for the operator signatures, scoped to the
// chain and the captureAuthorizer (PaymentInfo.operator).
func OperatorDomain(captureAuthorizer string, chainID *big.Int) evm.TypedDataDomain {
	return evm.TypedDataDomain{
		Name:              OperatorEIP712Domain.Name,
		Version:           OperatorEIP712Domain.Version,
		ChainID:           chainID,
		VerifyingContract: evm.NormalizeAddress(captureAuthorizer),
	}
}

// CaptureFee is the fee submitted with a charge or capture: Bps on v1.0 deployments, Amount on v1.1.
type CaptureFee struct {
	Bps    *uint16
	Amount *big.Int
}

// DefaultCaptureFee returns minFeeBps of amount in the deployment's fee encoding.
func DefaultCaptureFee(deployment *AuthCaptureDeployment, amount *big.Int, minFeeBps uint16) CaptureFee {
	if deployment.Version == AuthCaptureDeploymentV1_0 {
		return CaptureFee{Bps: &minFeeBps}
	}
	return CaptureFee{Amount: FeeAmountFromBps(amount, minFeeBps)}
}

// Arg returns the fee as the AuthCaptureEscrow.charge or capture call argument.
func (f CaptureFee) Arg() interface{} {
	if f.Bps != nil {
		return *f.Bps
	}
	return f.Amount
}

// AddToWire sets the fee field (feeBps or feeAmount) on a charge or capture wire payload.
func (f CaptureFee) AddToWire(payload map[string]interface{}) {
	if f.Bps != nil {
		payload["feeBps"] = *f.Bps
		return
	}
	payload["feeAmount"] = f.Amount.String()
}

func (f CaptureFee) addToMessage(message map[string]interface{}) {
	if f.Bps != nil {
		message["feeBps"] = big.NewInt(int64(*f.Bps))
		return
	}
	message["feeAmount"] = f.Amount
}

// CaptureParams are the values the receiver authorizer signs for a capture.
type CaptureParams struct {
	PaymentInfoHash    string
	Amount             *big.Int
	Fee                CaptureFee
	FeeReceiver        string
	ExpectedCapturable *big.Int
	ExpectedRefundable *big.Int
}

func (p CaptureParams) message() map[string]interface{} {
	message := map[string]interface{}{
		"paymentInfoHash":          p.PaymentInfoHash,
		"amount":                   p.Amount,
		"feeReceiver":              evm.NormalizeAddress(p.FeeReceiver),
		"expectedCapturableAmount": p.ExpectedCapturable,
		"expectedRefundableAmount": p.ExpectedRefundable,
	}
	p.Fee.addToMessage(message)
	return message
}

// ChargeParams are the values the receiver authorizer signs for a terminal charge.
// CollectorData is the client signature exactly as it arrived on the wire.
type ChargeParams struct {
	PaymentInfoHash string
	Amount          *big.Int
	TokenCollector  string
	CollectorData   []byte
	Fee             CaptureFee
	FeeReceiver     string
}

func (p ChargeParams) message() map[string]interface{} {
	message := map[string]interface{}{
		"paymentInfoHash":   p.PaymentInfoHash,
		"amount":            p.Amount,
		"tokenCollector":    evm.NormalizeAddress(p.TokenCollector),
		"collectorDataHash": crypto.Keccak256Hash(p.CollectorData).Hex(),
		"feeReceiver":       evm.NormalizeAddress(p.FeeReceiver),
	}
	p.Fee.addToMessage(message)
	return message
}

// RefundParams are the values the receiver authorizer signs for a refund.
type RefundParams struct {
	PaymentInfoHash    string
	Amount             *big.Int
	TokenCollector     string
	ExpectedCapturable *big.Int
	ExpectedRefundable *big.Int
}

func (p RefundParams) message() map[string]interface{} {
	return map[string]interface{}{
		"paymentInfoHash":          p.PaymentInfoHash,
		"amount":                   p.Amount,
		"tokenCollector":           evm.NormalizeAddress(p.TokenCollector),
		"expectedCapturableAmount": p.ExpectedCapturable,
		"expectedRefundableAmount": p.ExpectedRefundable,
	}
}

func signOperator(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	captureAuthorizer string,
	chainID *big.Int,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	return signer.SignTypedData(ctx, OperatorDomain(captureAuthorizer, chainID), types, primaryType, message)
}

func verifyOperator(
	ctx context.Context,
	verifier evm.FacilitatorEvmSigner,
	receiverAuthorizer string,
	captureAuthorizer string,
	chainID *big.Int,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	return evm.VerifyTypedDataStrict(
		ctx, verifier, receiverAuthorizer, OperatorDomain(captureAuthorizer, chainID), types, primaryType, message, signature,
	)
}

// SignCapture signs the Capture message; VerifyCapture checks it, so both sides share one digest.
func SignCapture(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	deployment *AuthCaptureDeployment,
	captureAuthorizer string,
	chainID *big.Int,
	params CaptureParams,
) ([]byte, error) {
	return signOperator(ctx, signer, captureAuthorizer, chainID, CaptureTypesForDeployment(deployment), "Capture", params.message())
}

// VerifyCapture reports whether signature is receiverAuthorizer's signature over the Capture params.
func VerifyCapture(
	ctx context.Context,
	verifier evm.FacilitatorEvmSigner,
	receiverAuthorizer string,
	deployment *AuthCaptureDeployment,
	captureAuthorizer string,
	chainID *big.Int,
	params CaptureParams,
	signature []byte,
) (bool, error) {
	return verifyOperator(ctx, verifier, receiverAuthorizer, captureAuthorizer, chainID, CaptureTypesForDeployment(deployment), "Capture", params.message(), signature)
}

// SignCharge signs the Charge message; VerifyCharge checks it.
func SignCharge(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	deployment *AuthCaptureDeployment,
	captureAuthorizer string,
	chainID *big.Int,
	params ChargeParams,
) ([]byte, error) {
	return signOperator(ctx, signer, captureAuthorizer, chainID, ChargeTypesForDeployment(deployment), "Charge", params.message())
}

// VerifyCharge reports whether signature is receiverAuthorizer's signature over the Charge params.
func VerifyCharge(
	ctx context.Context,
	verifier evm.FacilitatorEvmSigner,
	receiverAuthorizer string,
	deployment *AuthCaptureDeployment,
	captureAuthorizer string,
	chainID *big.Int,
	params ChargeParams,
	signature []byte,
) (bool, error) {
	return verifyOperator(ctx, verifier, receiverAuthorizer, captureAuthorizer, chainID, ChargeTypesForDeployment(deployment), "Charge", params.message(), signature)
}

// SignVoid signs the Void message; VerifyVoid checks it.
func SignVoid(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	captureAuthorizer string,
	chainID *big.Int,
	paymentInfoHash string,
) ([]byte, error) {
	return signOperator(ctx, signer, captureAuthorizer, chainID, VoidTypes, "Void", voidMessage(paymentInfoHash))
}

// VerifyVoid reports whether signature is receiverAuthorizer's signature over the Void message.
func VerifyVoid(
	ctx context.Context,
	verifier evm.FacilitatorEvmSigner,
	receiverAuthorizer string,
	captureAuthorizer string,
	chainID *big.Int,
	paymentInfoHash string,
	signature []byte,
) (bool, error) {
	return verifyOperator(ctx, verifier, receiverAuthorizer, captureAuthorizer, chainID, VoidTypes, "Void", voidMessage(paymentInfoHash), signature)
}

func voidMessage(paymentInfoHash string) map[string]interface{} {
	return map[string]interface{}{"paymentInfoHash": paymentInfoHash}
}

// SignRefund signs the Refund message; VerifyRefund checks it.
func SignRefund(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	captureAuthorizer string,
	chainID *big.Int,
	params RefundParams,
) ([]byte, error) {
	return signOperator(ctx, signer, captureAuthorizer, chainID, RefundTypes, "Refund", params.message())
}

// VerifyRefund reports whether signature is receiverAuthorizer's signature over the Refund params.
func VerifyRefund(
	ctx context.Context,
	verifier evm.FacilitatorEvmSigner,
	receiverAuthorizer string,
	captureAuthorizer string,
	chainID *big.Int,
	params RefundParams,
	signature []byte,
) (bool, error) {
	return verifyOperator(ctx, verifier, receiverAuthorizer, captureAuthorizer, chainID, RefundTypes, "Refund", params.message(), signature)
}
