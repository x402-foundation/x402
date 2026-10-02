package facilitator

import (
	"context"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestVerifyCapture_HappyPath(t *testing.T) {
	bps := uint16(50)
	tests := []struct {
		name  string
		extra map[string]interface{}
		opts  captureOpts
	}{
		{name: "v1.1 full capture"},
		{name: "v1.1 fee at the upper bound", opts: captureOpts{feeAmount: big.NewInt(10000)}},
		{name: "v1.0 fee in bps", extra: map[string]interface{}{"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address}, opts: captureOpts{feeBps: &bps}},
		{name: "capture and void", opts: captureOpts{amount: "600000", withVoid: true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fx := newLifecycleFixture(t, test.extra)
			scheme := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{})

			resp, err := scheme.Verify(context.Background(), fx.payload(fx.buildCapture(t, test.opts)), fx.requirements, nil)
			require.NoError(t, err)
			assert.True(t, resp.IsValid)
			assert.Equal(t, strings.ToLower(fx.paymentInfo.Payer), strings.ToLower(resp.Payer))
		})
	}
}

func TestVerifyCapture_Rejections(t *testing.T) {
	over := uint16(101)
	tests := []struct {
		name   string
		extra  map[string]interface{}
		opts   captureOpts
		mutate func(fx *lifecycleFixture, wire map[string]interface{}, signer *mockFacSigner)
		reason string
	}{
		{
			name:   "stale expected amounts",
			opts:   captureOpts{amount: "1", expectedCapturable: "1"},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name: "capture deadline passed",
			extra: map[string]interface{}{
				"captureDeadline": float64(time.Now().Unix() - 10),
				"refundDeadline":  float64(time.Now().Unix() + 86400),
			},
			reason: ErrCaptureDeadlineExpired,
		},
		{
			name:   "amount above the hold",
			opts:   captureOpts{amount: "1000001"},
			reason: ErrInsufficientAuthorization,
		},
		{
			name:   "fee receiver differs",
			opts:   captureOpts{feeReceiver: "0x" + strings.Repeat("8", 40)},
			reason: ErrFeeReceiver,
		},
		{
			name:   "v1.1 fee above the bound",
			opts:   captureOpts{feeAmount: big.NewInt(10001)},
			reason: ErrFeeBpsOutOfRange,
		},
		{
			name:   "v1.0 fee above the bound",
			extra:  map[string]interface{}{"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address},
			opts:   captureOpts{feeBps: &over},
			reason: ErrFeeBpsOutOfRange,
		},
		{
			name:  "v1.0 deployment given feeAmount",
			extra: map[string]interface{}{"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address},
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				delete(wire, "feeBps")
				wire["feeAmount"] = "0"
			},
			reason: ErrPayloadFormat,
		},
		{
			name: "both fee fields",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["feeBps"] = uint16(1)
			},
			reason: ErrPayloadFormat,
		},
		{
			name:   "void signature with nothing left to void",
			opts:   captureOpts{withVoid: true},
			reason: ErrVoidRemainderFullCapture,
		},
		{
			name: "void signature over another payment",
			opts: captureOpts{amount: "600000", withVoid: true},
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				other := newKeySigner(t)
				sig, err := authcapture.SignVoid(context.Background(), other, facCaptureAuthorizer, big.NewInt(84532), "0x"+strings.Repeat("1", 64))
				require.NoError(t, err)
				wire["voidAuthorizerSignature"] = evm.BytesToHex(sig)
			},
			reason: ErrVoidAuthorizerSignature,
		},
		{
			name: "capture signature from another key",
			mutate: func(fx *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["authorizerSignature"] = fx.voidSignature(t)
			},
			reason: ErrAuthorizerSignature,
		},
		{
			name: "operator differs from captureAuthorizer",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["paymentInfo"].(map[string]interface{})["operator"] = "0x" + strings.Repeat("9", 40)
			},
			reason: ErrOperatorMismatch,
		},
		{
			name: "maxAmount differs from the requirements",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["paymentInfo"].(map[string]interface{})["maxAmount"] = "1"
			},
			reason: ErrPaymentInfoMismatch,
		},
		{
			name: "salt does not match the binding",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["saltNonce"] = "0x02"
			},
			reason: ErrSaltBindingMismatch,
		},
		{
			name: "payment never collected",
			mutate: func(_ *lifecycleFixture, _ map[string]interface{}, signer *mockFacSigner) {
				signer.paymentStateHasCollected = false
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name: "payment state unreadable",
			mutate: func(_ *lifecycleFixture, _ map[string]interface{}, signer *mockFacSigner) {
				signer.paymentStateErr = assert.AnError
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name:   "custom operator does not relay lifecycle",
			extra:  map[string]interface{}{"operatorType": "custom"},
			reason: ErrLifecycleNotRelayed,
		},
		{
			name: "no receiver authorizer",
			mutate: func(fx *lifecycleFixture, _ map[string]interface{}, _ *mockFacSigner) {
				fx.requirements.Extra["receiverAuthorizer"] = authcapture.ZeroAddress
			},
			reason: ErrLifecycleNotRelayed,
		},
		{
			name:   "authorization flow has nothing to capture",
			extra:  map[string]interface{}{"paymentFlow": "authorization"},
			reason: ErrPayloadType,
		},
		{
			name: "operator not controlled",
			mutate: func(_ *lifecycleFixture, _ map[string]interface{}, signer *mockFacSigner) {
				signer.addresses = []string{"0x" + strings.Repeat("9", 40)}
			},
			reason: ErrOperatorNotAdmitted,
		},
		{
			name: "malformed amount",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["amount"] = "-5"
			},
			reason: ErrPayloadFormat,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fx := newLifecycleFixture(t, test.extra)
			signer := fx.signer()
			wire := fx.buildCapture(t, test.opts)
			if test.mutate != nil {
				test.mutate(&fx, wire, signer)
			}
			scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})

			_, err := scheme.Verify(context.Background(), fx.payload(wire), fx.requirements, nil)
			assertVerifyReason(t, err, test.reason)
		})
	}
}

func TestVerifyCapture_SimulatesBothLegs(t *testing.T) {
	fx := newLifecycleFixture(t, nil)
	wire := fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})

	signer := fx.signer()
	signer.simulateErr["void"] = escrowRevert(t, "InvalidSender", common.Address{}, common.Address{})
	_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(wire), fx.requirements, nil)
	assertVerifyReason(t, err, ErrOperatorMismatch)

	signer = fx.signer()
	signer.simulateErr["capture"] = escrowRevert(t, "FeeAmountOutOfRange", big.NewInt(1), big.NewInt(0), big.NewInt(0))
	_, err = newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(wire), fx.requirements, nil)
	assertVerifyReason(t, err, ErrFeeBpsOutOfRange)
}

func TestSettleCapture(t *testing.T) {
	t.Run("full capture reports the captured amount", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, fx.paymentInfo.MaxAmount, resp.Amount)
		assert.Equal(t, []string{"capture"}, signer.writtenFunctions)
		assert.Nil(t, resp.Extra)
	})

	t.Run("capture and void voids the remainder", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.afterWrite = func(function string) {
			if function == "capture" {
				signer.paymentStateCapturable = big.NewInt(400000)
			}
		}

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})), fx.requirements, nil)
		require.NoError(t, err)
		assert.Equal(t, "600000", resp.Amount)
		assert.Equal(t, []string{"capture", "void"}, signer.writtenFunctions)
		assert.Equal(t, signer.writeTx, resp.Extra["voidTransaction"])
	})

	t.Run("a race that emptied the hold skips the void", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.afterWrite = func(function string) {
			if function == "capture" {
				signer.paymentStateCapturable = big.NewInt(0)
			}
		}

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})), fx.requirements, nil)
		require.NoError(t, err)
		assert.Equal(t, []string{"capture"}, signer.writtenFunctions)
		assert.Nil(t, resp.Extra)
	})

	t.Run("a failed void is reported without failing the capture", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.afterWrite = func(function string) {
			if function == "capture" {
				signer.paymentStateCapturable = big.NewInt(400000)
			}
		}
		signer.writeErr["void"] = escrowRevert(t, "ZeroAuthorization", [32]byte{})

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Contains(t, resp.Extra["voidError"], ErrZeroAuthorization)
	})

	t.Run("a reverted void receipt is reported", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.afterWrite = func(function string) {
			switch function {
			case "capture":
				signer.paymentStateCapturable = big.NewInt(400000)
			case "void":
				signer.receipt = &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: signer.writeTx}
			}
		}

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})), fx.requirements, nil)
		require.NoError(t, err)
		assert.Contains(t, resp.Extra["voidError"], "reverted")
	})

	t.Run("typed revert and re-simulation", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.writeErr["capture"] = escrowRevert(t, "AfterAuthorizationExpiry", big.NewInt(2), big.NewInt(1))
		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrCaptureDeadlineExpired)

		signer = fx.signer()
		signer.simulateErr["capture"] = escrowRevert(t, "InsufficientAuthorization", [32]byte{}, big.NewInt(1), big.NewInt(2))
		_, err = newScheme(signer, AuthCaptureEvmSchemeConfig{SimulateInSettle: true}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrInsufficientAuthorization)
	})

	t.Run("verification failure", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.paymentStateHasCollected = false
		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrUnexpectedPaymentState)
	})

	t.Run("pending settlement is resumed", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})
		wire := fx.buildCapture(t, captureOpts{})
		require.NoError(t, scheme.pendingStore.Set(context.Background(), wire["authorizerSignature"].(string), signer.writeTx))

		resp, err := scheme.Settle(context.Background(), fx.payload(wire), fx.requirements, nil)
		require.NoError(t, err)
		assert.Equal(t, strings.ToLower(fx.paymentInfo.Payer), strings.ToLower(resp.Payer))
		assert.Empty(t, signer.writtenFunctions)
	})
}

func TestVoid(t *testing.T) {
	t.Run("verify", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		resp, err := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(fx.buildVoid(t)), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})

	rejections := []struct {
		name   string
		mutate func(fx *lifecycleFixture, wire map[string]interface{}, signer *mockFacSigner)
		reason string
	}{
		{
			name: "no capturable balance",
			mutate: func(_ *lifecycleFixture, _ map[string]interface{}, s *mockFacSigner) {
				s.paymentStateCapturable = big.NewInt(0)
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name: "voidAuthorizerSignature must not appear",
			mutate: func(fx *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["voidAuthorizerSignature"] = fx.voidSignature(t)
			},
			reason: ErrVoidAuthorizerSignature,
		},
		{
			name: "signature from another key",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				sig, err := authcapture.SignVoid(context.Background(), newKeySigner(t), facCaptureAuthorizer, big.NewInt(84532), "0x"+strings.Repeat("1", 64))
				require.NoError(t, err)
				wire["authorizerSignature"] = evm.BytesToHex(sig)
			},
			reason: ErrAuthorizerSignature,
		},
	}
	for _, test := range rejections {
		t.Run(test.name, func(t *testing.T) {
			fx := newLifecycleFixture(t, nil)
			signer := fx.signer()
			wire := fx.buildVoid(t)
			test.mutate(&fx, wire, signer)

			_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(wire), fx.requirements, nil)
			assertVerifyReason(t, err, test.reason)
		})
	}

	t.Run("simulation revert", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.simulateErr["void"] = escrowRevert(t, "ZeroAuthorization", [32]byte{})
		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(fx.buildVoid(t)), fx.requirements, nil)
		assertVerifyReason(t, err, ErrZeroAuthorization)
	})

	t.Run("settle", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{SimulateInSettle: true}).Settle(context.Background(), fx.payload(fx.buildVoid(t)), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Empty(t, resp.Amount)
		assert.Equal(t, []string{"void"}, signer.writtenFunctions)
	})

	t.Run("settle failures", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.paymentStateCapturable = big.NewInt(0)
		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildVoid(t)), fx.requirements, nil)
		assertSettleReason(t, err, ErrUnexpectedPaymentState)

		signer = fx.signer()
		signer.simulateErr["void"] = escrowRevert(t, "ZeroAuthorization", [32]byte{})
		_, err = newScheme(signer, AuthCaptureEvmSchemeConfig{SimulateInSettle: true}).Settle(context.Background(), fx.payload(fx.buildVoid(t)), fx.requirements, nil)
		assertSettleReason(t, err, ErrZeroAuthorization)

		signer = fx.signer()
		signer.writeErr["void"] = escrowRevert(t, "InvalidSender", common.Address{}, common.Address{})
		_, err = newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(fx.buildVoid(t)), fx.requirements, nil)
		assertSettleReason(t, err, ErrOperatorMismatch)
	})
}

func TestToSettleError(t *testing.T) {
	err := toSettleError(x402.NewVerifyError(ErrAmountMismatch, "0xpayer", "bad"), facNetwork, "")
	assertSettleReason(t, err, ErrAmountMismatch)

	err = toSettleError(assert.AnError, facNetwork, "0xpayer")
	assertSettleReason(t, err, ErrVerificationFailed)
}

func TestRevertReason(t *testing.T) {
	deployment := authcapture.ResolveAuthCaptureDeployment("")
	v10 := authcapture.ResolveAuthCaptureDeployment(authcapture.AuthCaptureEscrowV1_0Address)

	assert.Equal(t, ErrSimulationFailed, revertReason(deployment, nil))
	assert.Equal(t, ErrSimulationFailed, revertReason(deployment, []byte{0xde, 0xad, 0xbe, 0xef}))

	data := errorRevertData(escrowRevert(t, "FeeAmountOutOfRange", big.NewInt(1), big.NewInt(0), big.NewInt(0)))
	assert.Equal(t, ErrFeeBpsOutOfRange, revertReason(deployment, data))

	// FeeAmountOutOfRange is not declared by the v1.0 ABI.
	assert.Equal(t, ErrSimulationFailed, revertReason(v10, data))

	assert.Nil(t, errorRevertData(assert.AnError))
	assert.Nil(t, errorRevertData(revertError{data: "not hex"}))
}

func TestLifecycle_PartialCaptureAmountOverride(t *testing.T) {
	override := func(fx lifecycleFixture, amount string) types.PaymentRequirements {
		requirements := fx.requirements
		requirements.Amount = amount
		return requirements
	}

	t.Run("verify and settle accept a requirements amount below the signed hold", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		wire := fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})
		requirements := override(fx, "600000")

		verified, err := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(wire), requirements, nil)
		require.NoError(t, err)
		assert.True(t, verified.IsValid)

		settled, err := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload(wire), requirements, nil)
		require.NoError(t, err)
		assert.True(t, settled.Success)
	})

	t.Run("maxAmount must equal the accepted amount, not the override", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		payload := fx.payload(fx.buildCapture(t, captureOpts{}))
		payload.Accepted.Amount = "600000"

		_, err := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), payload, override(fx, "1000000"), nil)
		assertVerifyReason(t, err, ErrPaymentInfoMismatch)
	})
}

func TestLifecycle_SignaturesAreVerifiedBeforeChainState(t *testing.T) {
	tests := []struct {
		name   string
		build  func(t *testing.T, fx lifecycleFixture) map[string]interface{}
		reason string
	}{
		{
			name: "capture signature over a different amount",
			build: func(t *testing.T, fx lifecycleFixture) map[string]interface{} {
				wire := fx.buildCapture(t, captureOpts{})
				wire["amount"] = "999999"
				return wire
			},
			reason: ErrAuthorizerSignature,
		},
		{
			name: "void leg signed by another key",
			build: func(t *testing.T, fx lifecycleFixture) map[string]interface{} {
				wire := fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})
				voidSignature, err := authcapture.SignVoid(context.Background(), newKeySigner(t), fx.extra.CaptureAuthorizer, fx.chainID, fx.paymentHash)
				require.NoError(t, err)
				wire["voidAuthorizerSignature"] = evm.BytesToHex(voidSignature)
				return wire
			},
			reason: ErrVoidAuthorizerSignature,
		},
		{
			name: "void payload signed by another key",
			build: func(t *testing.T, fx lifecycleFixture) map[string]interface{} {
				wire := fx.buildVoid(t)
				voidSignature, err := authcapture.SignVoid(context.Background(), newKeySigner(t), fx.extra.CaptureAuthorizer, fx.chainID, fx.paymentHash)
				require.NoError(t, err)
				wire["authorizerSignature"] = evm.BytesToHex(voidSignature)
				return wire
			},
			reason: ErrAuthorizerSignature,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fx := newLifecycleFixture(t, nil)
			signer := fx.signer()

			_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(test.build(t, fx)), fx.requirements, nil)
			assertVerifyReason(t, err, test.reason)
			assert.Zero(t, signer.stateReads, "no chain state may be read for an unauthenticated payload")
		})
	}
}

func TestLifecycle_SimulationsRunAsTheOperator(t *testing.T) {
	fx := newLifecycleFixture(t, nil)
	wire := fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})

	signer := fx.signer()
	_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(wire), fx.requirements, nil)
	require.NoError(t, err)
	require.Len(t, signer.readFroms, 2, "capture and void are both simulated")
	for _, from := range signer.readFroms {
		assert.True(t, strings.EqualFold(fx.paymentInfo.Operator, from), "simulated from %s, want the operator %s", from, fx.paymentInfo.Operator)
	}

	t.Run("a signer without SenderReader still simulates", func(t *testing.T) {
		plain := struct{ evm.FacilitatorEvmSigner }{fx.signer()}
		_, err := NewAuthCaptureEvmScheme(plain, AuthCaptureEvmSchemeConfig{CaptureAuthorizer: facCaptureAuthorizer}).
			Verify(context.Background(), fx.payload(wire), fx.requirements, nil)
		require.NoError(t, err)
	})
}
