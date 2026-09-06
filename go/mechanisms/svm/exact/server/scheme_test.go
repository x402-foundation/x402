package server

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
)

func TestPaymentFlowsDeclareAuthorizationAndUpfront(t *testing.T) {
	scheme := NewExactSvmScheme()
	flows := scheme.PaymentFlows()

	require.Contains(t, flows, x402.SDKDefaultAssetTransferMethod)
	assert.Equal(t, x402.SDKDefaultAssetTransferMethod, scheme.DefaultAssetTransferMethod())
	assert.Equal(t, []x402.PaymentFlowName{x402.PaymentFlowAuthorization, x402.PaymentFlowUpfront}, flows[x402.SDKDefaultAssetTransferMethod].Supported)
	assert.Equal(t, x402.PaymentFlowAuthorization, flows[x402.SDKDefaultAssetTransferMethod].Default)
}
