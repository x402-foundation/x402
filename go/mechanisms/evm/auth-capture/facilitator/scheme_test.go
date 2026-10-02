package facilitator

import (
	"context"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestSchemeMetadata(t *testing.T) {
	signer := newMockFacSigner(facCaptureAuthorizer)

	noFee := newScheme(signer, AuthCaptureEvmSchemeConfig{})
	assert.Equal(t, authcapture.SchemeAuthCapture, noFee.Scheme())
	assert.Equal(t, "eip155:*", noFee.CaipFamily())
	assert.Equal(t, []string{facCaptureAuthorizer}, noFee.GetSigners(facNetwork))
	assert.Equal(t, map[string]interface{}{"captureAuthorizer": facCaptureAuthorizer}, noFee.GetExtra(facNetwork))

	withFee := newScheme(signer, AuthCaptureEvmSchemeConfig{FeeRecipient: facFeeRecipient, MinFeeBps: 5, MaxFeeBps: 5})
	extra := withFee.GetExtra(facNetwork)
	assert.Equal(t, facFeeRecipient, extra["feeRecipient"])
	assert.Equal(t, uint16(5), extra["minFeeBps"])

	unconfigured := NewAuthCaptureEvmScheme(signer, AuthCaptureEvmSchemeConfig{})
	assert.Nil(t, unconfigured.GetExtra(facNetwork))
}

func TestVerifyAndSettle_UnknownPayloadShape(t *testing.T) {
	scheme := newScheme(newMockFacSigner(facCaptureAuthorizer), AuthCaptureEvmSchemeConfig{})
	requirements := facBaseRequirements(facCaptureAuthorizer, nil)
	payload := types.PaymentPayload{Accepted: requirements, Payload: map[string]interface{}{"foo": "bar"}}

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	assertVerifyReason(t, err, ErrPayloadFormat)

	_, err = scheme.Settle(context.Background(), payload, requirements, nil)
	assertSettleReason(t, err, ErrPayloadFormat)
}

func TestVerifyCollect_HappyPath(t *testing.T) {
	tests := []struct {
		name  string
		extra map[string]interface{}
	}{
		{name: "eip3009"},
		{name: "permit2", extra: map[string]interface{}{"assetTransferMethod": "permit2"}},
		{name: "salt bound", extra: map[string]interface{}{"receiverAuthorizer": "0x" + strings.Repeat("7", 40)}},
		{name: "no fee, zero recipient", extra: map[string]interface{}{"feeRecipient": authcapture.ZeroAddress, "maxFeeBps": float64(0)}},
		{name: "v1.0 deployment", extra: map[string]interface{}{"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scheme := newScheme(newMockFacSigner(facCaptureAuthorizer), AuthCaptureEvmSchemeConfig{})
			requirements := facBaseRequirements(facCaptureAuthorizer, test.extra)
			payer := newKeySigner(t)

			resp, err := scheme.Verify(context.Background(), buildCollectPayload(t, requirements, payer, collectOpts{}), requirements, nil)
			require.NoError(t, err)
			assert.True(t, resp.IsValid)
			assert.Equal(t, strings.ToLower(payer.Address()), strings.ToLower(resp.Payer))
		})
	}
}

func TestVerifyCollect_Rejections(t *testing.T) {
	now := time.Now().Unix()
	tests := []struct {
		name   string
		extra  map[string]interface{}
		opts   collectOpts
		mutate func(requirements *types.PaymentRequirements, payload *types.PaymentPayload)
		reason string
	}{
		{
			name:   "payload scheme mismatch",
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) { p.Accepted.Scheme = "exact" },
			reason: ErrInvalidScheme,
		},
		{
			name:   "requirements scheme mismatch",
			mutate: func(r *types.PaymentRequirements, _ *types.PaymentPayload) { r.Scheme = "exact" },
			reason: ErrInvalidScheme,
		},
		{
			name:   "network mismatch",
			mutate: func(r *types.PaymentRequirements, _ *types.PaymentPayload) { r.Network = "eip155:1" },
			reason: ErrNetworkMismatch,
		},
		{
			name: "non-eip155 network",
			mutate: func(r *types.PaymentRequirements, p *types.PaymentPayload) {
				r.Network = "solana:devnet"
				p.Accepted.Network = "solana:devnet"
			},
			reason: ErrInvalidNetwork,
		},
		{
			name:   "missing extra",
			mutate: func(r *types.PaymentRequirements, _ *types.PaymentPayload) { delete(r.Extra, "captureDeadline") },
			reason: ErrExtra,
		},
		{name: "min fee above max", extra: map[string]interface{}{"minFeeBps": float64(200)}, reason: ErrExtra},
		{name: "max fee above 10000", extra: map[string]interface{}{"maxFeeBps": float64(10001)}, reason: ErrExtra},
		{name: "zero recipient with fee bounds", extra: map[string]interface{}{"feeRecipient": authcapture.ZeroAddress}, reason: ErrZeroFeeReceiver},
		{name: "legacy autoCapture", extra: map[string]interface{}{"autoCapture": true}, reason: ErrUnsupportedPaymentFlow},
		{name: "authorization flow", extra: map[string]interface{}{"paymentFlow": "authorization"}, reason: ErrUnsupportedPaymentFlow},
		{name: "custom operator", extra: map[string]interface{}{"operatorType": "custom"}, reason: ErrUnsupportedOperatorType},
		{name: "policy operator", extra: map[string]interface{}{"policy": "0x" + strings.Repeat("5", 40)}, reason: ErrPolicy},
		{name: "operator not controlled", extra: map[string]interface{}{"captureAuthorizer": "0x" + strings.Repeat("9", 40)}, reason: ErrOperatorNotAdmitted},
		{
			name: "eip3009 payload for permit2 route",
			mutate: func(r *types.PaymentRequirements, _ *types.PaymentPayload) {
				r.Extra["assetTransferMethod"] = "permit2"
			},
			reason: ErrPayloadMethodMismatch,
		},
		{name: "unknown asset transfer method", extra: map[string]interface{}{"assetTransferMethod": "magic"}, reason: ErrUnsupportedAssetTransferMethod},
		{
			name:   "capture deadline inside the skew floor",
			extra:  map[string]interface{}{"captureDeadline": float64(now + 3), "refundDeadline": float64(now + 100)},
			reason: ErrCaptureDeadlineExpired,
		},
		{
			name:   "timeout longer than the capture window",
			extra:  map[string]interface{}{"captureDeadline": float64(now + 1000), "refundDeadline": float64(now + 2000)},
			reason: ErrDeadlineOrdering,
		},
		{
			name:   "refund before capture",
			extra:  map[string]interface{}{"captureDeadline": float64(now + 86400), "refundDeadline": float64(now + 4000)},
			reason: ErrDeadlineOrdering,
		},
		{name: "validBefore inside the skew floor", opts: collectOpts{validBefore: now + 3}, reason: ErrAuthorizationExpired},
		{name: "validAfter in the future", opts: collectOpts{validAfter: uint64(now + 600)}, reason: ErrAuthorizationNotYetValid},
		{
			name: "amount mismatch",
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				p.Payload["authorization"].(map[string]interface{})["value"] = "1"
			},
			reason: ErrAmountMismatch,
		},
		{
			name: "collector mismatch",
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				p.Payload["authorization"].(map[string]interface{})["to"] = "0x" + strings.Repeat("1", 40)
			},
			reason: ErrTokenCollectorMismatch,
		},
		{
			name: "nonce mismatch",
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				p.Payload["authorization"].(map[string]interface{})["nonce"] = "0x" + strings.Repeat("1", 64)
			},
			reason: ErrNonceMismatch,
		},
		{
			name: "saltNonce present while unbound",
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				p.Payload["saltNonce"] = "0x01"
			},
			reason: ErrPayloadFormat,
		},
		{
			name:  "saltNonce missing while bound",
			extra: map[string]interface{}{"receiverAuthorizer": "0x" + strings.Repeat("7", 40)},
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				delete(p.Payload, "saltNonce")
			},
			reason: ErrPayloadFormat,
		},
		{
			name:  "salt does not match the binding",
			extra: map[string]interface{}{"receiverAuthorizer": "0x" + strings.Repeat("7", 40)},
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				p.Payload["salt"] = "0x" + strings.Repeat("1", 64)
			},
			reason: ErrSaltBindingMismatch,
		},
		{
			name: "signature from another key",
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				p.Payload["authorization"].(map[string]interface{})["from"] = newKeySigner(t).Address()
			},
			reason: ErrSignature,
		},
		{
			name: "terminal charge completion",
			mutate: func(_ *types.PaymentRequirements, p *types.PaymentPayload) {
				p.Payload["amount"] = "1"
				p.Payload["feeAmount"] = "0"
				p.Payload["feeReceiver"] = facFeeRecipient
				p.Payload["authorizerSignature"] = "0x01"
				p.Payload["saltNonce"] = "0x01"
			},
			reason: ErrUnsupportedPaymentFlow,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scheme := newScheme(newMockFacSigner(facCaptureAuthorizer), AuthCaptureEvmSchemeConfig{})
			requirements := facBaseRequirements(facCaptureAuthorizer, test.extra)
			payload := buildCollectPayload(t, requirements, newKeySigner(t), test.opts)
			if test.mutate != nil {
				test.mutate(&requirements, &payload)
			}

			_, err := scheme.Verify(context.Background(), payload, requirements, nil)
			assertVerifyReason(t, err, test.reason)
		})
	}
}

func TestVerifyCollect_Permit2Rejections(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(auth map[string]interface{})
		reason string
	}{
		{name: "spender is not the collector", mutate: func(a map[string]interface{}) { a["spender"] = "0x" + strings.Repeat("1", 40) }, reason: ErrTokenCollectorMismatch},
		{
			name: "permitted token differs",
			mutate: func(a map[string]interface{}) {
				a["permitted"].(map[string]interface{})["token"] = "0x" + strings.Repeat("1", 40)
			},
			reason: ErrTokenMismatch,
		},
		{
			name:   "permitted amount differs",
			mutate: func(a map[string]interface{}) { a["permitted"].(map[string]interface{})["amount"] = "1" },
			reason: ErrAmountMismatch,
		},
		{name: "malformed nonce", mutate: func(a map[string]interface{}) { a["nonce"] = "abc" }, reason: ErrPayloadFormat},
		{name: "malformed deadline", mutate: func(a map[string]interface{}) { a["deadline"] = "soon" }, reason: ErrPayloadFormat},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scheme := newScheme(newMockFacSigner(facCaptureAuthorizer), AuthCaptureEvmSchemeConfig{})
			requirements := facBaseRequirements(facCaptureAuthorizer, map[string]interface{}{"assetTransferMethod": "permit2"})
			payload := buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})
			test.mutate(payload.Payload["permit2Authorization"].(map[string]interface{}))

			_, err := scheme.Verify(context.Background(), payload, requirements, nil)
			assertVerifyReason(t, err, test.reason)
		})
	}
}

func TestVerifyCollect_SimulationRevertsAreTyped(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		reason string
	}{
		{name: "pre-approval expired", err: escrowRevert(t, "AfterPreApprovalExpiry", big.NewInt(2), big.NewInt(1)), reason: ErrAuthorizationExpired},
		{name: "wrong sender", err: escrowRevert(t, "InvalidSender", common.Address{}, common.Address{}), reason: ErrOperatorMismatch},
		{name: "already collected", err: escrowRevert(t, "PaymentAlreadyCollected", [32]byte{}), reason: ErrPaymentAlreadyCollected},
		{name: "collection failed", err: escrowRevert(t, "TokenCollectionFailed"), reason: ErrTokenCollectionFailed},
		{name: "unmapped rpc failure", err: assert.AnError, reason: ErrSimulationFailed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			signer := newMockFacSigner(facCaptureAuthorizer)
			signer.simulateErr["authorize"] = test.err
			scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})
			requirements := facBaseRequirements(facCaptureAuthorizer, nil)

			_, err := scheme.Verify(context.Background(), buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{}), requirements, nil)
			assertVerifyReason(t, err, test.reason)
		})
	}
}

func TestSettleCollect_HappyPath(t *testing.T) {
	signer := newMockFacSigner(facCaptureAuthorizer)
	scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})
	requirements := facBaseRequirements(facCaptureAuthorizer, nil)

	resp, err := scheme.Settle(context.Background(), buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{}), requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, signer.writeTx, resp.Transaction)
	assert.Equal(t, facAmount, resp.Amount)
	assert.Equal(t, []string{"authorize"}, signer.writtenFunctions)
}

func TestSettleCollect_FailureReasons(t *testing.T) {
	requirements := facBaseRequirements(facCaptureAuthorizer, nil)

	t.Run("verification failure", func(t *testing.T) {
		scheme := newScheme(newMockFacSigner("0x"+strings.Repeat("9", 40)), AuthCaptureEvmSchemeConfig{})
		_, err := scheme.Settle(context.Background(), buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{}), requirements, nil)
		assertSettleReason(t, err, ErrOperatorNotAdmitted)
	})

	t.Run("typed write revert", func(t *testing.T) {
		signer := newMockFacSigner(facCaptureAuthorizer)
		signer.writeErr["authorize"] = escrowRevert(t, "PaymentAlreadyCollected", [32]byte{})
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})
		_, err := scheme.Settle(context.Background(), buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{}), requirements, nil)
		assertSettleReason(t, err, ErrPaymentAlreadyCollected)
	})

	t.Run("simulation in settle", func(t *testing.T) {
		signer := newMockFacSigner(facCaptureAuthorizer)
		signer.simulateErr["authorize"] = escrowRevert(t, "TokenCollectionFailed")
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{SimulateInSettle: true})
		_, err := scheme.Settle(context.Background(), buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{}), requirements, nil)
		assertSettleReason(t, err, ErrTokenCollectionFailed)
		assert.Empty(t, signer.writtenFunctions)
	})

	t.Run("reverted receipt", func(t *testing.T) {
		signer := newMockFacSigner(facCaptureAuthorizer)
		signer.receipt = &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: signer.writeTx}
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})
		_, err := scheme.Settle(context.Background(), buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{}), requirements, nil)
		assertSettleReason(t, err, ErrTransactionReverted)
	})
}

func TestSettleCollect_PendingSettlementSkipsRebroadcast(t *testing.T) {
	signer := newMockFacSigner(facCaptureAuthorizer)
	scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})
	requirements := facBaseRequirements(facCaptureAuthorizer, nil)
	payload := buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})

	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	scheme.SetPendingSettlementStore(nil) // nil keeps the store
	require.NoError(t, store.Set(context.Background(), payload.Payload["signature"].(string), signer.writeTx))

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Empty(t, signer.writtenFunctions, "a pending settlement must not be re-broadcast")
}

func TestSimulateFactoryDeploy(t *testing.T) {
	sigData := &evm.ERC6492SignatureData{FactoryCalldata: []byte{0x01}}
	sigData.Factory[0] = 0xaa
	assert.True(t, needsFactoryDeploy(sigData))
	assert.False(t, needsFactoryDeploy(&evm.ERC6492SignatureData{}))

	signer := newMockFacSigner(facCaptureAuthorizer)
	require.NoError(t, simulateFactoryDeploy(context.Background(), signer, sigData, "0xpayer"))

	signer.multicallSuccess = false
	assertVerifyReason(t, simulateFactoryDeploy(context.Background(), signer, sigData, "0xpayer"), ErrSimulationFailed)
}

func TestVerifyCollect_ERC6492WrappedSignature(t *testing.T) {
	factory := common.HexToAddress("0x" + strings.Repeat("aa", 20))
	wrap := func(t *testing.T, payload types.PaymentPayload) {
		t.Helper()
		inner, err := evm.HexToBytes(payload.Payload["signature"].(string))
		require.NoError(t, err)
		payload.Payload["signature"] = evm.BytesToHex(wrapERC6492ForTest(t, factory, []byte{0x01}, inner))
	}
	config := AuthCaptureEvmSchemeConfig{EIP6492AllowedFactories: []string{factory.Hex()}}
	requirements := facBaseRequirements(facCaptureAuthorizer, nil)

	t.Run("counterfactual wallet on an allowlisted factory passes", func(t *testing.T) {
		payload := buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})
		wrap(t, payload)

		resp, err := newScheme(newMockFacSigner(facCaptureAuthorizer), config).Verify(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})

	t.Run("deployed wallet must pass its own ERC-1271 check", func(t *testing.T) {
		payload := buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})
		wrap(t, payload)
		signer := newMockFacSigner(facCaptureAuthorizer)
		signer.code = []byte{0x60}
		signer.isValidSignatureResult = [4]byte{0xff, 0xff, 0xff, 0xff}

		_, err := newScheme(signer, config).Verify(context.Background(), payload, requirements, nil)
		assertVerifyReason(t, err, ErrSignature)
		assert.Empty(t, signer.readFroms, "the authorize simulation must not be reached")
	})

	t.Run("deployed wallet whose ERC-1271 check accepts passes", func(t *testing.T) {
		payload := buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})
		wrap(t, payload)
		signer := newMockFacSigner(facCaptureAuthorizer)
		signer.code = []byte{0x60}
		signer.isValidSignatureResult = [4]byte{0x16, 0x26, 0xba, 0x7e}

		resp, err := newScheme(signer, config).Verify(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})
}

func wrapERC6492ForTest(t *testing.T, factory common.Address, factoryData, inner []byte) []byte {
	t.Helper()
	addressType, err := abi.NewType("address", "", nil)
	require.NoError(t, err)
	bytesType, err := abi.NewType("bytes", "", nil)
	require.NoError(t, err)
	packed, err := abi.Arguments{{Type: addressType}, {Type: bytesType}, {Type: bytesType}}.Pack(factory, factoryData, inner)
	require.NoError(t, err)
	magic, err := evm.HexToBytes(evm.ERC6492MagicValue)
	require.NoError(t, err)
	return append(packed, magic...)
}
