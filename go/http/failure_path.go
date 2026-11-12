package http

import (
	"net/http"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ResolveCancelledSettlement cancels a verified payment that must not settle
// and returns the headers to write. It also deletes Settlement-Overrides.
func (s *x402HTTPResourceServer) ResolveCancelledSettlement(
	dispatcher *x402.PaymentCancellationDispatcher,
	opts x402.VerifiedPaymentCancelOptions,
	beforeHandlerSettlement *x402.CompletedSettlement,
	paymentPayload *types.PaymentPayload,
	responseHeaders http.Header,
) map[string]string {
	existingCacheControl := responseHeaders.Get("Cache-Control")
	responseHeaders.Del(SettlementOverridesHeader)

	var cancelSettlement *x402.SettleResponse
	if dispatcher != nil {
		cancelSettlement = dispatcher.Cancel(opts)
	}
	return s.CreateFailurePathSettlementHeaders(
		cancelSettlement,
		beforeHandlerSettlement,
		paymentPayload,
		existingCacheControl,
	)
}
