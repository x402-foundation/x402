package authcapture

import (
	"context"
	"math/big"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// OperatorDomain returns the EIP-712 domain for Capture/Void signatures, scoped to the
// chain and the captureAuthorizer (PaymentInfo.operator).
func OperatorDomain(captureAuthorizer string, chainID *big.Int) evm.TypedDataDomain {
	return evm.TypedDataDomain{
		Name:              OperatorEIP712Domain.Name,
		Version:           OperatorEIP712Domain.Version,
		ChainID:           chainID,
		VerifyingContract: evm.NormalizeAddress(captureAuthorizer),
	}
}

// CaptureFee is the fee submitted with a capture: Bps on v1.0 deployments, Amount on v1.1.
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

// Arg returns the fee as the AuthCaptureEscrow.capture call argument.
func (f CaptureFee) Arg() interface{} {
	if f.Bps != nil {
		return *f.Bps
	}
	return f.Amount
}

// AddToWire sets the fee field (feeBps or feeAmount) on a capture wire payload.
func (f CaptureFee) AddToWire(payload map[string]interface{}) {
	if f.Bps != nil {
		payload["feeBps"] = *f.Bps
		return
	}
	payload["feeAmount"] = f.Amount.String()
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
	if p.Fee.Bps != nil {
		message["feeBps"] = big.NewInt(int64(*p.Fee.Bps))
	} else {
		message["feeAmount"] = p.Fee.Amount
	}
	return message
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
	return signer.SignTypedData(
		ctx, OperatorDomain(captureAuthorizer, chainID), CaptureTypesForDeployment(deployment), "Capture", params.message(),
	)
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
	return evm.VerifyTypedDataStrict(
		ctx, verifier, receiverAuthorizer,
		OperatorDomain(captureAuthorizer, chainID), CaptureTypesForDeployment(deployment), "Capture", params.message(), signature,
	)
}

// SignVoid signs the Void message; VerifyVoid checks it.
func SignVoid(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	captureAuthorizer string,
	chainID *big.Int,
	paymentInfoHash string,
) ([]byte, error) {
	return signer.SignTypedData(
		ctx, OperatorDomain(captureAuthorizer, chainID), VoidTypes, "Void", map[string]interface{}{"paymentInfoHash": paymentInfoHash},
	)
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
	return evm.VerifyTypedDataStrict(
		ctx, verifier, receiverAuthorizer,
		OperatorDomain(captureAuthorizer, chainID), VoidTypes, "Void", map[string]interface{}{"paymentInfoHash": paymentInfoHash}, signature,
	)
}
