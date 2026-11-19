package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestVerifyAndSettleRejectNonCanonicalRequiredAmount(t *testing.T) {
	amounts := []string{"1e4", "10000.0", "0x2710", "0.01", "1_000", "+1000", " 1000 "}

	for _, amount := range amounts {
		t.Run("eip3009/"+amount, func(t *testing.T) {
			payload, requirements := canonicalAmountEIP3009(amount)
			scheme := NewExactEvmScheme(nil, nil)

			_, verifyErr := scheme.Verify(context.Background(), payload, requirements, nil)
			var verifyReason *x402.VerifyError
			require.ErrorAs(t, verifyErr, &verifyReason)
			assert.Equal(t, ErrInvalidRequiredAmount, verifyReason.InvalidReason)

			_, settleErr := scheme.Settle(context.Background(), payload, requirements, nil)
			var settleReason *x402.SettleError
			require.ErrorAs(t, settleErr, &settleReason)
			assert.Equal(t, ErrInvalidRequiredAmount, settleReason.ErrorReason)
		})

		t.Run("permit2/"+amount, func(t *testing.T) {
			payload, requirements := canonicalAmountPermit2(amount)
			scheme := NewExactEvmScheme(canonicalAmountSigner{}, nil)

			_, verifyErr := scheme.Verify(context.Background(), payload, requirements, nil)
			var verifyReason *x402.VerifyError
			require.ErrorAs(t, verifyErr, &verifyReason)
			assert.Equal(t, ErrInvalidRequiredAmount, verifyReason.InvalidReason)

			_, settleErr := scheme.Settle(context.Background(), payload, requirements, nil)
			var settleReason *x402.SettleError
			require.ErrorAs(t, settleErr, &settleReason)
			assert.Equal(t, ErrInvalidRequiredAmount, settleReason.ErrorReason)
		})
	}
}

func TestVerifyAcceptsCanonicalRequiredAmount(t *testing.T) {
	payload, requirements := canonicalAmountEIP3009("1000")
	scheme := NewExactEvmScheme(nil, nil)

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)

	var reason *x402.VerifyError
	require.ErrorAs(t, err, &reason)
	assert.NotEqual(t, ErrInvalidRequiredAmount, reason.InvalidReason)
}

func canonicalAmountEIP3009(amount string) (types.PaymentPayload, types.PaymentRequirements) {
	const payTo = "0x1111111111111111111111111111111111111111"
	requirements := types.PaymentRequirements{
		Scheme:  evm.SchemeExact,
		Network: "eip155:8453",
		Asset:   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		Amount:  amount,
		PayTo:   payTo,
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted: types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:8453",
		},
		Payload: map[string]interface{}{
			"signature": "0xzz",
			"authorization": map[string]interface{}{
				"from":        "0x2222222222222222222222222222222222222222",
				"to":          payTo,
				"value":       "1000",
				"validAfter":  "0",
				"validBefore": "9999999999",
				"nonce":       "0x" + strings.Repeat("11", 32),
			},
		},
	}
	return payload, requirements
}

func canonicalAmountPermit2(amount string) (types.PaymentPayload, types.PaymentRequirements) {
	const (
		payTo = "0x1111111111111111111111111111111111111111"
		payer = "0x2222222222222222222222222222222222222222"
		asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
	)
	requirements := types.PaymentRequirements{
		Scheme:  evm.SchemeExact,
		Network: "eip155:8453",
		Asset:   asset,
		Amount:  amount,
		PayTo:   payTo,
	}
	permit2Payload := &evm.ExactPermit2Payload{
		Signature: "0xzz",
		Permit2Authorization: evm.Permit2Authorization{
			From: payer,
			Permitted: evm.Permit2TokenPermissions{
				Token:  asset,
				Amount: "1000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "1",
			Deadline: fmt.Sprintf("%d", time.Now().Unix()+10000),
			Witness: evm.Permit2Witness{
				To:         payTo,
				ValidAfter: "0",
			},
		},
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     permit2Payload.ToMap(),
	}
	return payload, requirements
}

type canonicalAmountSigner struct{}

func (canonicalAmountSigner) GetAddresses() []string { return nil }

func (canonicalAmountSigner) ReadContract(context.Context, string, []byte, string, ...interface{}) (interface{}, error) {
	return nil, nil
}

func (canonicalAmountSigner) VerifyTypedData(context.Context, string, evm.TypedDataDomain, map[string][]evm.TypedDataField, string, map[string]interface{}, []byte) (bool, error) {
	return false, nil
}

func (canonicalAmountSigner) WriteContract(context.Context, string, []byte, string, []byte, ...interface{}) (string, error) {
	return "", nil
}

func (canonicalAmountSigner) SendTransaction(context.Context, string, []byte) (string, error) {
	return "", nil
}

func (canonicalAmountSigner) WaitForTransactionReceipt(context.Context, string) (*evm.TransactionReceipt, error) {
	return nil, nil
}

func (canonicalAmountSigner) GetBalance(context.Context, string, string) (*big.Int, error) {
	return big.NewInt(0), nil
}

func (canonicalAmountSigner) GetChainID(context.Context) (*big.Int, error) {
	return big.NewInt(8453), nil
}

func (canonicalAmountSigner) GetCode(context.Context, string) ([]byte, error) {
	return []byte{0x01}, nil
}
