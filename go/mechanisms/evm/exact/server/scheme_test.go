package server

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
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

func TestParsePriceRejectsNonCanonicalAtomicAmount(t *testing.T) {
	server := NewExactEvmScheme()
	network := x402.Network("eip155:8453")
	asset := "0x1234567890123456789012345678901234567890"
	amounts := []string{
		"1e4",
		"0x2710",
		"1_000",
		"+1000",
		" 1000 ",
		"115792089237316195423570985008687907853269984665640564039457584007913129639936",
	}

	for _, amount := range amounts {
		t.Run(amount, func(t *testing.T) {
			_, err := server.ParsePrice(map[string]interface{}{
				"amount": amount,
				"asset":  asset,
			}, network)

			require.Error(t, err)
			assert.ErrorContains(t, err, "amount")
			assert.ErrorContains(t, err, amount)
		})
	}
}

func TestParsePriceLeavesDottedAmountForEnhance(t *testing.T) {
	server := NewExactEvmScheme()
	result, err := server.ParsePrice(map[string]interface{}{
		"amount": "0.01",
		"asset":  "0x1234567890123456789012345678901234567890",
	}, x402.Network("eip155:8453"))

	require.NoError(t, err)
	assert.Equal(t, "0.01", result.Amount)
}

func TestParsePriceAcceptsCanonicalAtomicAmount(t *testing.T) {
	server := NewExactEvmScheme()
	network := x402.Network("eip155:8453")
	asset := "0x1234567890123456789012345678901234567890"

	for _, amount := range []string{"0", "1000", "01000"} {
		t.Run(amount, func(t *testing.T) {
			result, err := server.ParsePrice(map[string]interface{}{
				"amount": amount,
				"asset":  asset,
			}, network)

			require.NoError(t, err)
			assert.Equal(t, amount, result.Amount)
			assert.Equal(t, asset, result.Asset)
		})
	}
}

func TestParsePriceRejectsNonCanonicalMoneyParserAmount(t *testing.T) {
	server := NewExactEvmScheme()
	server.RegisterMoneyParser(func(string, x402.Network) (*x402.AssetAmount, error) {
		return &x402.AssetAmount{
			Amount: "1_000",
			Asset:  "0x1234567890123456789012345678901234567890",
		}, nil
	})

	_, err := server.ParsePrice("1", x402.Network("eip155:8453"))

	require.Error(t, err)
	assert.ErrorContains(t, err, "amount")
	assert.ErrorContains(t, err, "1_000")
}

func TestEnhancePaymentRequirementsConvertsDottedBaseUSDCAmount(t *testing.T) {
	server := NewExactEvmScheme()
	network := "eip155:8453"
	requirements := types.PaymentRequirements{
		Scheme:            "exact",
		Network:           network,
		Asset:             evm.DefaultAssets[network][0].Asset,
		Amount:            "0.01",
		PayTo:             "0x1234567890123456789012345678901234567890",
		MaxTimeoutSeconds: 3600,
	}

	result, err := server.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)

	require.NoError(t, err)
	assert.Equal(t, "10000", result.Amount)
}

func TestEnhancePaymentRequirementsRejectsNonCanonicalAtomicAmount(t *testing.T) {
	server := NewExactEvmScheme()
	network := "eip155:8453"
	amounts := []string{"1e4", "0x2710", "1_000", "+1000", " 1000 "}

	for _, amount := range amounts {
		t.Run(amount, func(t *testing.T) {
			requirements := types.PaymentRequirements{
				Scheme:            "exact",
				Network:           network,
				Asset:             evm.DefaultAssets[network][0].Asset,
				Amount:            amount,
				PayTo:             "0x1234567890123456789012345678901234567890",
				MaxTimeoutSeconds: 3600,
			}

			_, err := server.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)

			require.Error(t, err)
			assert.ErrorContains(t, err, "amount")
			assert.ErrorContains(t, err, amount)
		})
	}
}

func TestEnhancePaymentRequirementsLeavesUnregisteredTokenDomainUnset(t *testing.T) {
	server := NewExactEvmScheme()
	requirements := types.PaymentRequirements{
		Scheme:            "exact",
		Network:           "eip155:8453",
		Asset:             "0x1111111111111111111111111111111111111111",
		Amount:            "1000",
		PayTo:             "0x1234567890123456789012345678901234567890",
		MaxTimeoutSeconds: 3600,
		Extra:             map[string]interface{}{"assetTransferMethod": "permit2"},
	}

	result, err := server.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)

	require.NoError(t, err)
	assert.NotContains(t, result.Extra, "name")
	assert.NotContains(t, result.Extra, "version")
}

func TestEnhancePaymentRequirementsRejectsDottedAmountForUnregisteredToken(t *testing.T) {
	server := NewExactEvmScheme()
	requirements := types.PaymentRequirements{
		Scheme:            "exact",
		Network:           "eip155:8453",
		Asset:             "0x1111111111111111111111111111111111111111",
		Amount:            "0.01",
		PayTo:             "0x1234567890123456789012345678901234567890",
		MaxTimeoutSeconds: 3600,
	}

	_, err := server.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)

	require.Error(t, err)
	assert.ErrorContains(t, err, "not a registered asset")
}
