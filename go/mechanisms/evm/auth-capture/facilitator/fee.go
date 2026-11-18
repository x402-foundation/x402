package facilitator

import (
	"math/big"
	"strings"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
)

func parseUint(value string) (*big.Int, bool) {
	n, ok := new(big.Int).SetString(value, 10)
	return n, ok && n.Sign() >= 0
}

// parseSubmittedFee reads the deployment's fee field (feeBps on v1.0, feeAmount on v1.1) and
// rejects a payload that carries the other one or none.
func parseSubmittedFee(feeBps *uint16, feeAmount string, deployment *authcapture.AuthCaptureDeployment) (authcapture.CaptureFee, bool) {
	if deployment.Version == authcapture.AuthCaptureDeploymentV1_0 {
		return authcapture.CaptureFee{Bps: feeBps}, feeBps != nil && feeAmount == ""
	}
	amount, ok := parseUint(feeAmount)
	return authcapture.CaptureFee{Amount: amount}, ok && feeBps == nil
}

// feeWithinBounds applies the escrow's fee range: feeBps in [min, max] on v1.0, and
// feeAmount in [amount*min/10000, amount*max/10000] on v1.1.
func feeWithinBounds(fee authcapture.CaptureFee, amount *big.Int, extra authcapture.AuthCaptureExtra) bool {
	if fee.Bps != nil {
		return *fee.Bps >= extra.MinFeeBps && *fee.Bps <= extra.MaxFeeBps
	}
	lowest := authcapture.FeeAmountFromBps(amount, extra.MinFeeBps)
	highest := authcapture.FeeAmountFromBps(amount, extra.MaxFeeBps)
	return fee.Amount.Cmp(lowest) >= 0 && fee.Amount.Cmp(highest) <= 0
}

// feeAmountOf is the absolute fee the escrow takes from amount for a submitted fee.
func feeAmountOf(fee authcapture.CaptureFee, amount *big.Int) *big.Int {
	if fee.Bps != nil {
		return authcapture.FeeAmountFromBps(amount, *fee.Bps)
	}
	return fee.Amount
}

// validateSubmittedFee returns the invalidReason for a charge or capture fee the escrow would
// reject or the extra does not allow, or "" when it is valid. A zero extra.feeRecipient lets the
// submitter name any receiver, which the escrow then requires to be non-zero for a non-zero fee.
func validateSubmittedFee(extra authcapture.AuthCaptureExtra, amount *big.Int, fee authcapture.CaptureFee, feeReceiver string) string {
	switch {
	case !evm.IsValidAddress(feeReceiver):
		return ErrFeeReceiver
	case authcapture.IsNonZeroAddress(extra.FeeRecipient) && !strings.EqualFold(feeReceiver, extra.FeeRecipient):
		return ErrFeeReceiver
	case !feeWithinBounds(fee, amount, extra):
		return ErrFeeBpsOutOfRange
	case !authcapture.IsNonZeroAddress(feeReceiver) && feeAmountOf(fee, amount).Sign() != 0:
		return ErrZeroFeeReceiver
	}
	return ""
}
