package server

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

func TestPaymentFlowsDeclareAuthorizationAndUpfront(t *testing.T) {
	scheme := NewExactEvmScheme()
	flows := scheme.PaymentFlows()

	for _, atm := range []string{
		string(evm.AssetTransferMethodEIP3009),
		string(evm.AssetTransferMethodPermit2),
	} {
		require.Contains(t, flows, atm)
		assert.Equal(t, []x402.PaymentFlowName{x402.PaymentFlowAuthorization, x402.PaymentFlowUpfront}, flows[atm].Supported)
		assert.Equal(t, x402.PaymentFlowAuthorization, flows[atm].Default)
	}
}
