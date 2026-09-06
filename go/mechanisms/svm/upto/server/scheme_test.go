package server

import (
	"context"
	"crypto/ed25519"
	"strconv"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testNetwork = "solana-devnet"
	testChannel = "SysvarC1ock11111111111111111111111111111111"
)

// testAuthorizer signs vouchers with an ephemeral Ed25519 key.
type testAuthorizer struct {
	key solana.PrivateKey
}

func newTestAuthorizer(t *testing.T) *testAuthorizer {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return &testAuthorizer{key: key}
}

func (a *testAuthorizer) Address() solana.PublicKey {
	return a.key.PublicKey()
}

func (a *testAuthorizer) SignMessage(_ context.Context, message []byte) ([]byte, error) {
	signature, err := a.key.Sign(message)
	if err != nil {
		return nil, err
	}
	return signature[:], nil
}

func newTestScheme(t *testing.T) (*UptoSvmScheme, *testAuthorizer) {
	t.Helper()
	authorizer := newTestAuthorizer(t)
	return NewUptoSvmScheme(&Config{ReceiverAuthorizerSigner: authorizer}), authorizer
}

func newRequirements(authorizer solana.PublicKey, amount string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Amount:            amount,
		Asset:             svm.USDCDevnetAddress,
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 600,
		Extra: map[string]interface{}{
			upto.ExtraReceiverAuthorizer: authorizer.String(),
			upto.ExtraWithdrawDelay:      float64(3600),
		},
	}
}

func newPayload(authorizer solana.PublicKey) types.PaymentPayload {
	payload := &svm.UptoSvmPayload{
		From:             solana.SystemProgramID.String(),
		MaxAmount:        "10000",
		ExpiresAt:        1893456000,
		ValidAfter:       0,
		Nonce:            "42",
		OpenSlot:         "341000000",
		ChannelId:        testChannel,
		Deposit:          "10000",
		AuthorizedSigner: authorizer.String(),
		OpenTransaction:  "AQ==",
	}
	return types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: svm.SchemeUpto, Network: testNetwork},
		Payload:     payload.ToMap(),
	}
}

func TestPaymentFlowsDeclareEscrowOnly(t *testing.T) {
	scheme, _ := newTestScheme(t)

	flows := scheme.PaymentFlows()

	require.Contains(t, flows, AssetTransferMethodChannel)
	assert.Equal(t, AssetTransferMethodChannel, scheme.DefaultAssetTransferMethod())
	assert.Equal(t, []x402.PaymentFlowName{x402.PaymentFlowEscrow}, flows[AssetTransferMethodChannel].Supported)
	assert.Equal(t, x402.PaymentFlowEscrow, flows[AssetTransferMethodChannel].Default)
}

func TestDynamicExtraFieldsExcludeRegeneratedHints(t *testing.T) {
	scheme, _ := newTestScheme(t)

	assert.ElementsMatch(t,
		[]string{upto.ExtraRecentBlockhash, upto.ExtraLastValidBlockHeight, upto.ExtraRecentSlot},
		scheme.DynamicExtraFields(),
	)
}

func TestNewUptoSvmSchemeAllowsOmittingAnAuthorizer(t *testing.T) {
	assert.NotPanics(t, func() { NewUptoSvmScheme(nil) })
	assert.NotPanics(t, func() { NewUptoSvmScheme(&Config{}) })
}

func TestParsePrice(t *testing.T) {
	scheme, _ := newTestScheme(t)

	tests := []struct {
		name       string
		price      x402.Price
		wantAmount string
		wantAsset  string
	}{
		{
			name:       "dollar string to six-decimal atomic units",
			price:      "$0.05",
			wantAmount: "50000",
			wantAsset:  svm.USDCDevnetAddress,
		},
		{
			name:       "bare number",
			price:      0.001,
			wantAmount: "1000",
			wantAsset:  svm.USDCDevnetAddress,
		},
		{
			name: "pre-parsed asset amount passes through",
			price: map[string]interface{}{
				"amount": "1234",
				"asset":  svm.USDCMainnetAddress,
			},
			wantAmount: "1234",
			wantAsset:  svm.USDCMainnetAddress,
		},
		{
			name:       "a stablecoin suffix selects that mint",
			price:      "1.50 PYUSD",
			wantAmount: "1500000",
			wantAsset:  svm.PYUSDDevnetAddress,
		},
		{
			name:       "USD means USDC",
			price:      "$2 USD",
			wantAmount: "2000000",
			wantAsset:  svm.USDCDevnetAddress,
		},
		{
			name:       "a mainnet-only stablecoin falls back to its mainnet mint",
			price:      "1 USDT",
			wantAmount: "1000000",
			wantAsset:  svm.USDTMainnetAddress,
		},
		{
			name:       "an unsupported suffix falls back to the network default",
			price:      "1.25 WIF",
			wantAmount: "1250000",
			wantAsset:  svm.USDCDevnetAddress,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := scheme.ParsePrice(test.price, testNetwork)

			require.NoError(t, err)
			assert.Equal(t, test.wantAmount, result.Amount)
			assert.Equal(t, test.wantAsset, result.Asset)
		})
	}
}

func TestParsePriceRejectsNonStringAmount(t *testing.T) {
	scheme, _ := newTestScheme(t)

	_, err := scheme.ParsePrice(map[string]interface{}{"amount": 1234}, testNetwork)

	require.ErrorContains(t, err, ErrAmountMustBeString)
}

func TestEnhancePaymentRequirements(t *testing.T) {
	scheme, authorizer := newTestScheme(t)
	feePayer := solana.SysVarClockPubkey.String()
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Amount:            "10000",
		Asset:             svm.USDCDevnetAddress,
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 600,
		Extra:             map[string]interface{}{upto.ExtraMemo: "order-42"},
	}
	supportedKind := types.SupportedKind{
		Scheme:  svm.SchemeUpto,
		Network: testNetwork,
		Extra:   map[string]interface{}{upto.ExtraFeePayer: feePayer},
	}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
	require.NoError(t, err)

	assert.Equal(t, feePayer, enhanced.Extra[upto.ExtraFeePayer], "the facilitator feePayer is folded in")
	assert.Equal(t, "order-42", enhanced.Extra[upto.ExtraMemo], "seller-set extras survive enhancement")
	assert.Equal(t, authorizer.Address().String(), enhanced.Extra[upto.ExtraReceiverAuthorizer])
	assert.Equal(t, solana.TokenProgramID.String(), enhanced.Extra[upto.ExtraTokenProgram])
	assert.Equal(t, uint32(paymentchannels.DefaultGracePeriodSeconds), enhanced.Extra[upto.ExtraWithdrawDelay],
		"the grace period defaults to 900s when maxTimeoutSeconds is shorter")
	assert.NotContains(t, enhanced.Extra, upto.ExtraRecentBlockhash, "blockhash hints need a configured RPC")
}

func TestEnhancePaymentRequirementsRejectsUnsupportedNetwork(t *testing.T) {
	scheme, _ := newTestScheme(t)
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           "solana:fake",
		Amount:            "10000",
		Asset:             svm.USDCDevnetAddress,
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 600,
	}
	supportedKind := types.SupportedKind{
		Scheme:  svm.SchemeUpto,
		Network: "solana:fake",
		Extra:   map[string]interface{}{upto.ExtraFeePayer: solana.SysVarClockPubkey.String()},
	}

	_, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported Solana network")
}

// Token-2022 mints must be advertised with their own program: the client seals
// the token program into the open, and the wrong one fails onchain.
func TestEnhancePaymentRequirementsResolvesTheTokenProgramPerMint(t *testing.T) {
	tests := []struct {
		name             string
		asset            string
		wantTokenProgram string
	}{
		{name: "USDC is SPL Token", asset: svm.USDCDevnetAddress, wantTokenProgram: svm.TokenProgramAddress},
		{name: "PYUSD is Token-2022", asset: svm.PYUSDDevnetAddress, wantTokenProgram: svm.Token2022ProgramAddress},
		{name: "USDG is Token-2022", asset: svm.USDGDevnetAddress, wantTokenProgram: svm.Token2022ProgramAddress},
		{
			name:             "unregistered mints default to SPL Token",
			asset:            solana.SysVarClockPubkey.String(),
			wantTokenProgram: svm.TokenProgramAddress,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scheme, _ := newTestScheme(t)
			requirements := types.PaymentRequirements{
				Scheme:            svm.SchemeUpto,
				Network:           testNetwork,
				Amount:            "10000",
				Asset:             test.asset,
				PayTo:             solana.SysVarRentPubkey.String(),
				MaxTimeoutSeconds: 600,
			}
			supportedKind := types.SupportedKind{
				Scheme:  svm.SchemeUpto,
				Network: testNetwork,
				Extra:   map[string]interface{}{upto.ExtraFeePayer: solana.SysVarClockPubkey.String()},
			}

			enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)

			require.NoError(t, err)
			assert.Equal(t, test.wantTokenProgram, enhanced.Extra[upto.ExtraTokenProgram])
		})
	}
}

// A seller-set tokenProgram wins: only the seller knows a mint the registry does not.
func TestEnhancePaymentRequirementsKeepsASellerSetTokenProgram(t *testing.T) {
	scheme, _ := newTestScheme(t)
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Amount:            "10000",
		Asset:             svm.USDCDevnetAddress,
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 600,
		Extra:             map[string]interface{}{upto.ExtraTokenProgram: svm.Token2022ProgramAddress},
	}
	supportedKind := types.SupportedKind{
		Scheme:  svm.SchemeUpto,
		Network: testNetwork,
		Extra:   map[string]interface{}{upto.ExtraFeePayer: solana.SysVarClockPubkey.String()},
	}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)

	require.NoError(t, err)
	assert.Equal(t, svm.Token2022ProgramAddress, enhanced.Extra[upto.ExtraTokenProgram])
}

func TestEnhancePaymentRequirementsWidensGracePeriodToTheTimeout(t *testing.T) {
	scheme, _ := newTestScheme(t)
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Amount:            "10000",
		Asset:             svm.USDCDevnetAddress,
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 3600,
	}

	enhanced, err := scheme.EnhancePaymentRequirements(
		context.Background(), requirements,
		types.SupportedKind{Scheme: svm.SchemeUpto, Network: testNetwork},
		nil,
	)
	require.NoError(t, err)

	assert.Equal(t, uint32(3600), enhanced.Extra[upto.ExtraWithdrawDelay])
}

func TestEnhancePaymentRequirementsHonorsConfiguredWithdrawDelay(t *testing.T) {
	scheme := NewUptoSvmScheme(&Config{
		ReceiverAuthorizerSigner: newTestAuthorizer(t),
		WithdrawDelay:            120,
	})

	enhanced, err := scheme.EnhancePaymentRequirements(
		context.Background(),
		types.PaymentRequirements{
			Scheme: svm.SchemeUpto, Network: testNetwork, Amount: "10000",
			Asset: svm.USDCDevnetAddress, PayTo: solana.SysVarRentPubkey.String(), MaxTimeoutSeconds: 3600,
		},
		types.SupportedKind{Scheme: svm.SchemeUpto, Network: testNetwork},
		nil,
	)
	require.NoError(t, err)

	assert.Equal(t, uint32(120), enhanced.Extra[upto.ExtraWithdrawDelay])
}

func TestValidateFacilitatorSupport(t *testing.T) {
	scheme, _ := newTestScheme(t)

	tests := []struct {
		name    string
		extra   map[string]interface{}
		wantErr bool
	}{
		{
			name:  "valid fee payer",
			extra: map[string]interface{}{upto.ExtraFeePayer: solana.SysVarClockPubkey.String()},
		},
		{
			name:    "missing fee payer",
			extra:   map[string]interface{}{},
			wantErr: true,
		},
		{
			name:    "fee payer is not an address",
			extra:   map[string]interface{}{upto.ExtraFeePayer: "0xdeadbeef"},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := scheme.ValidateFacilitatorSupport(testNetwork, types.SupportedKind{Extra: test.extra}, nil)

			if test.wantErr {
				require.ErrorContains(t, err, "does not advertise a valid feePayer")
				return
			}
			require.NoError(t, err)
		})
	}
}

func TestGetAssetDecimals(t *testing.T) {
	scheme, _ := newTestScheme(t)

	assert.Equal(t, 6, scheme.GetAssetDecimals(svm.USDCDevnetAddress, testNetwork))
	assert.Equal(t, 6, scheme.GetAssetDecimals("USDC", testNetwork), "symbols resolve like mint addresses")
	assert.Equal(t, svm.DefaultDecimals, scheme.GetAssetDecimals(solana.SysVarRentPubkey.String(), testNetwork),
		"unregistered mints fall back to the stablecoin default rather than guessing")
}

func TestSettleOnCancelRefundsOnlyFailedHandlers(t *testing.T) {
	scheme, authorizer := newTestScheme(t)
	requirements := newRequirements(authorizer.Address(), "10000")

	tests := []struct {
		name       string
		reason     x402.VerifiedPaymentCancellationReason
		wantRefund bool
	}{
		{name: "handler failed", reason: x402.CancellationReasonHandlerFailed, wantRefund: true},
		{name: "handler threw", reason: x402.CancellationReasonHandlerThrew, wantRefund: true},
		{name: "after verify aborted", reason: x402.CancellationReasonAfterVerifyAborted, wantRefund: true},
		{name: "unknown reason", reason: "something_else"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := scheme.SettleOnCancel(x402.VerifiedPaymentCanceledContext{
				SettleContext: x402.SettleContext{Requirements: requirements},
				Reason:        test.reason,
			})

			require.NoError(t, err)
			if !test.wantRefund {
				assert.Nil(t, result)
				return
			}
			require.NotNil(t, result)
			assert.Equal(t, "0", result.Amount, "a canceled request settles at zero so the deposit is refunded")
			assert.Equal(t, requirements.PayTo, result.PayTo)
			assert.Equal(t, requirements.Extra, result.Extra)
		})
	}
}

func TestEnrichSettlementPayloadStampsDepositTypeWithoutAVoucher(t *testing.T) {
	scheme, authorizer := newTestScheme(t)

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      newPayload(authorizer.Address()),
		Requirements: newRequirements(authorizer.Address(), "10000"),
		Phase:        x402.SettlePhaseBeforeHandler,
	})

	require.NoError(t, err)
	assert.Equal(t, map[string]interface{}{svm.UptoPayloadTypeField: svm.UptoPayloadTypeDeposit}, fields)
}

func TestEnrichSettlementPayloadSignsTheMeteredVoucher(t *testing.T) {
	scheme, authorizer := newTestScheme(t)

	tests := []struct {
		name   string
		phase  x402.SettlePhase
		amount string
	}{
		{name: "claim settle", phase: x402.SettlePhaseAfterHandler, amount: "1858"},
		{name: "cancel refund settle", phase: x402.SettlePhaseCancel, amount: "0"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := newPayload(authorizer.Address())

			fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
				Ctx:          context.Background(),
				Payload:      payload,
				Requirements: newRequirements(authorizer.Address(), test.amount),
				Phase:        test.phase,
			})
			require.NoError(t, err)

			signatureBase58, ok := fields[svm.UptoVoucherSignatureField].(string)
			require.True(t, ok, "the voucher signature is returned as base58")
			assert.Equal(t, svm.UptoPayloadTypeClaim, fields[svm.UptoPayloadTypeField])

			decoded, err := svm.UptoPayloadFromMap(payload.Payload)
			require.NoError(t, err)
			amount, err := strconv.ParseUint(test.amount, 10, 64)
			require.NoError(t, err)
			message := paymentchannels.EncodeVoucherMessage(
				solana.MustPublicKeyFromBase58(decoded.ChannelId), amount, decoded.ExpiresAt,
			)
			require.NoError(t, paymentchannels.VerifyVoucherSignature(
				signatureBase58, authorizer.Address().String(), message,
			))

			signature, err := solana.SignatureFromBase58(signatureBase58)
			require.NoError(t, err)
			assert.Len(t, signature[:], ed25519.SignatureSize)
		})
	}
}

func TestEnrichSettlementPayloadRejectsAForeignAuthorizer(t *testing.T) {
	scheme, _ := newTestScheme(t)
	otherAuthorizer := newTestAuthorizer(t)

	_, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      newPayload(otherAuthorizer.Address()),
		Requirements: newRequirements(otherAuthorizer.Address(), "1858"),
		Phase:        x402.SettlePhaseAfterHandler,
	})

	require.ErrorContains(t, err, ErrAuthorizerMismatch)
}

func TestEnrichSettlementPayloadIgnoresForeignPayloads(t *testing.T) {
	scheme, authorizer := newTestScheme(t)
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: svm.SchemeUpto, Network: testNetwork},
		Payload:     map[string]interface{}{"transaction": "AQ=="},
	}

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      payload,
		Requirements: newRequirements(authorizer.Address(), "1858"),
		Phase:        x402.SettlePhaseAfterHandler,
	})

	require.NoError(t, err)
	assert.Equal(t, map[string]interface{}{svm.UptoPayloadTypeField: svm.UptoPayloadTypeClaim}, fields)
}

func TestEnrichSettlementPayloadRejectsANonIntegerAmount(t *testing.T) {
	scheme, authorizer := newTestScheme(t)

	_, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      newPayload(authorizer.Address()),
		Requirements: newRequirements(authorizer.Address(), "1.5"),
		Phase:        x402.SettlePhaseAfterHandler,
	})

	require.ErrorContains(t, err, ErrInvalidPayload)
}

func TestServerDelegatedReceiverAuthorizerFallsBackToFacilitatorExtra(t *testing.T) {
	advertised := svm.USDCMainnetAddress
	delegated := NewUptoSvmScheme(&Config{WithdrawDelay: 3600})
	supportedKind := types.SupportedKind{
		X402Version: 2,
		Scheme:      svm.SchemeUpto,
		Network:     testNetwork,
		Extra: map[string]interface{}{
			upto.ExtraFeePayer:           advertised,
			upto.ExtraReceiverAuthorizer: advertised,
		},
	}
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Asset:             svm.USDCDevnetAddress,
		Amount:            "1000000",
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 300,
		Extra:             map[string]interface{}{},
	}

	result, err := delegated.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
	require.NoError(t, err)
	assert.Equal(t, advertised, result.Extra[upto.ExtraReceiverAuthorizer])
}

func TestServerDelegatedReceiverAuthorizerThrowsWhenNeitherSideSuppliesOne(t *testing.T) {
	advertised := svm.USDCMainnetAddress
	delegated := NewUptoSvmScheme(&Config{WithdrawDelay: 3600})
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Asset:             svm.USDCDevnetAddress,
		Amount:            "1000000",
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 300,
		Extra:             map[string]interface{}{},
	}

	_, err := delegated.EnhancePaymentRequirements(
		context.Background(),
		requirements,
		types.SupportedKind{
			X402Version: 2,
			Scheme:      svm.SchemeUpto,
			Network:     testNetwork,
			Extra:       map[string]interface{}{upto.ExtraFeePayer: advertised},
		},
		nil,
	)
	require.ErrorContains(t, err, "valid extra.receiverAuthorizer")
}

func TestValidateFacilitatorSupportFailsWithoutLocalSignerOrAdvertisement(t *testing.T) {
	advertised := svm.USDCMainnetAddress
	delegated := NewUptoSvmScheme(&Config{WithdrawDelay: 3600})

	err := delegated.ValidateFacilitatorSupport(testNetwork, types.SupportedKind{
		X402Version: 2,
		Scheme:      svm.SchemeUpto,
		Network:     testNetwork,
		Extra:       map[string]interface{}{upto.ExtraFeePayer: advertised},
	}, nil)
	require.ErrorContains(t, err, "receiverAuthorizer")
}

func TestValidateFacilitatorSupportAcceptsFacilitatorAdvertisedAuthorizer(t *testing.T) {
	advertised := svm.USDCMainnetAddress
	delegated := NewUptoSvmScheme(&Config{WithdrawDelay: 3600})

	err := delegated.ValidateFacilitatorSupport(testNetwork, types.SupportedKind{
		X402Version: 2,
		Scheme:      svm.SchemeUpto,
		Network:     testNetwork,
		Extra: map[string]interface{}{
			upto.ExtraFeePayer:           advertised,
			upto.ExtraReceiverAuthorizer: advertised,
		},
	}, nil)
	require.NoError(t, err)
}

func TestEnrichSettlementPayloadStampsTypeAndOmitsVoucherWhenDelegating(t *testing.T) {
	advertised := svm.USDCMainnetAddress
	delegated := NewUptoSvmScheme(&Config{WithdrawDelay: 3600})
	requirements := types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Asset:             svm.USDCDevnetAddress,
		Amount:            "1000000",
		PayTo:             solana.SysVarRentPubkey.String(),
		MaxTimeoutSeconds: 300,
		Extra:             map[string]interface{}{},
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload: (&svm.UptoSvmPayload{
			From:             solana.SysVarRentPubkey.String(),
			MaxAmount:        "1000000",
			Deposit:          "1000000",
			ChannelId:        svm.USDCMainnetAddress,
			AuthorizedSigner: advertised,
			OpenTransaction:  "unused",
			OpenSlot:         "341000000",
			ExpiresAt:        1893456000,
			ValidAfter:       0,
			Nonce:            "1",
		}).ToMap(),
	}

	deposit, err := delegated.EnrichSettlementPayload(x402.SettleContext{
		Payload:      payload,
		Requirements: requirements,
		Phase:        x402.SettlePhaseBeforeHandler,
	})
	require.NoError(t, err)
	assert.Equal(t, map[string]interface{}{svm.UptoPayloadTypeField: svm.UptoPayloadTypeDeposit}, deposit)

	claim, err := delegated.EnrichSettlementPayload(x402.SettleContext{
		Payload: payload,
		Requirements: types.PaymentRequirements{
			Scheme:            requirements.Scheme,
			Network:           requirements.Network,
			Asset:             requirements.Asset,
			Amount:            "1858",
			PayTo:             requirements.PayTo,
			MaxTimeoutSeconds: requirements.MaxTimeoutSeconds,
			Extra:             requirements.Extra,
		},
		Phase: x402.SettlePhaseAfterHandler,
	})
	require.NoError(t, err)
	assert.Equal(t, map[string]interface{}{svm.UptoPayloadTypeField: svm.UptoPayloadTypeClaim}, claim)
}
