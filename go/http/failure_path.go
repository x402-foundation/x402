package http

import (
	"net/http"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ResolveCancelledSettlement cancels a verified payment that must not settle and
// returns the headers to write onto the response.
//
// The Gin, Echo and net/http middlewares each resolve the same three failure
// paths: the handler threw, the handler aborted, and the handler returned a
// failing status. Keeping the cancel + failure-receipt logic in one place is
// what keeps those paths identical across the adapters; the Gin abort branch
// previously drifted and discarded the handler response.
//
// responseHeaders is the handler's response header map. It is read for the
// existing Cache-Control value, which is preserved and marked private, and the
// internal Settlement-Overrides header is deleted from it: overrides only apply
// when a settlement runs, and ProcessSettlement is the sole other place that
// strips them. Leaving it behind would send an internal header to the client.
//
// opts carries the cancellation reason and its detail (Err when the handler
// threw, ResponseStatus when it returned a failing status). Returns nil when
// there is nothing to write.
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
