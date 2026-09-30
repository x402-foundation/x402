package facilitator

import (
	"fmt"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

// AssertServerModeRefundProof verifies a server-mode refund's payer proof: authorizedAmount is zero.
func AssertServerModeRefundProof(payload batchsettlement.BatchRefundPayload, channelID string, nowSeconds int64) error {
	if payload.Voucher != nil {
		return fmt.Errorf("%s: invalid payer proof", batchsettlement.ErrVoucherSignature)
	}
	return serverModeProof(payload.Authorization, payload.ChannelConfig, channelID, 0, ProofAmountExact, true, nowSeconds)
}

// AssertServerModeProof verifies the payer proof behind a server-signed request.
// Verify requires requirements.amount to equal the signed ceiling. Settle allows a metered charge at or below it.
func AssertServerModeProof(
	payload batchsettlement.ParsedBatchPayload,
	channelID string,
	requirements types.PaymentRequirements,
	bound ProofAmountBound,
	nowSeconds int64,
) error {
	charged, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return err
	}
	return serverModeProof(payload.Authorization, payload.ChannelConfig, channelID, charged, bound, false, nowSeconds)
}

func serverModeProof(
	authorization *batchsettlement.BatchAuthorization,
	config batchsettlement.BatchChannelConfig,
	channelID string,
	charged uint64,
	bound ProofAmountBound,
	refund bool,
	nowSeconds int64,
) error {
	invalid := fmt.Errorf("%s: invalid payer proof", batchsettlement.ErrVoucherSignature)
	if authorization == nil {
		return fmt.Errorf("%s: payer proof missing", batchsettlement.ErrVoucherSignature)
	}
	authorized, err := paymentchannels.ParseU64(authorization.AuthorizedAmount, "authorizedAmount")
	if err != nil {
		return invalid
	}
	if refund && authorized != 0 {
		return invalid
	}
	if authorization.ChannelID != channelID || authorization.Payer != config.Payer || authorization.RequestID == "" {
		return invalid
	}
	if !refund && !proofCoversCharge(charged, authorized, bound) {
		return invalid
	}
	if !batchsettlement.VerifyBatchAuthorization(*authorization, config.PayerAuthorizer, nowSeconds) {
		return invalid
	}
	return nil
}

func proofCoversCharge(charged, authorized uint64, bound ProofAmountBound) bool {
	switch bound {
	case ProofAmountExact:
		return charged == authorized
	case ProofAmountCeiling:
		return charged <= authorized
	default:
		return false
	}
}

// VoucherSignerFor resolves voucher mode from the requirements or from the payload.
func VoucherSignerFor(config batchsettlement.BatchChannelConfig, extra map[string]any, binding VoucherModeBinding) (string, error) {
	switch binding {
	case VoucherModePayload:
		voucherSigner := config.VoucherSigner
		if voucherSigner == "" {
			voucherSigner = batchsettlement.VoucherSignerClient
		}
		if voucherSigner != batchsettlement.VoucherSignerClient && voucherSigner != batchsettlement.VoucherSignerServer {
			return "", errorsNew(batchsettlement.ErrChannelState)
		}
		operator, operatorIsString := extraString(extra, batchsettlement.ExtraOperator)
		if voucherSigner == batchsettlement.VoucherSignerServer && (!operatorIsString || config.PayerAuthorizer != operator) {
			return "", errorsNew(batchsettlement.ErrChannelState)
		}
		return voucherSigner, nil
	case VoucherModeRequirements:
		voucherSigner, present := extraString(extra, batchsettlement.ExtraVoucherSigner)
		if !extraPresent(extra, batchsettlement.ExtraVoucherSigner) {
			voucherSigner = batchsettlement.VoucherSignerClient
			present = true
		}
		if !present || (voucherSigner != batchsettlement.VoucherSignerClient && voucherSigner != batchsettlement.VoucherSignerServer) {
			return "", errorsNew(batchsettlement.ErrChannelState)
		}
		operator, operatorIsString := extraString(extra, batchsettlement.ExtraOperator)
		operatorPresent := extraPresent(extra, batchsettlement.ExtraOperator)
		configSigner := config.VoucherSigner
		if configSigner == "" {
			configSigner = batchsettlement.VoucherSignerClient
		}
		if (voucherSigner == batchsettlement.VoucherSignerServer && (!operatorIsString || config.PayerAuthorizer != operator)) ||
			(voucherSigner == batchsettlement.VoucherSignerClient && operatorPresent) ||
			configSigner != voucherSigner {
			return "", errorsNew(batchsettlement.ErrChannelState)
		}
		return voucherSigner, nil
	default:
		return "", fmt.Errorf("%s: %s", batchsettlement.ErrChannelState, binding)
	}
}

func extraPresent(extra map[string]any, key string) bool {
	if extra == nil {
		return false
	}
	value, present := extra[key]
	return present && value != nil
}

func extraString(extra map[string]any, key string) (string, bool) {
	if extra == nil {
		return "", false
	}
	value, present := extra[key]
	if !present || value == nil {
		return "", false
	}
	text, ok := value.(string)
	return text, ok
}

func errorsNew(message string) error {
	return fmt.Errorf("%s", message)
}
