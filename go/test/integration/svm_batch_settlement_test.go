// Package integration_test contains integration tests for the x402 Go SDK.
// This file exercises the SVM batch-settlement scheme against Solana devnet.
package integration_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	batchfacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/facilitator"
	batchserver "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	batchIntegrationPrice         = "$0.001"
	batchIntegrationDepositMicros = uint64(10_000)
	batchIntegrationWithdrawDelay = 900
	batchIntegrationRequestMicros = uint64(1_000)
)

type batchSvmPipeline struct {
	client       uptoSvmClient
	scheme       *batchclient.BatchSvmScheme
	resource     *x402.X402ResourceServer
	serverScheme *batchserver.BatchSvmScheme
	store        *batchserver.MemoryChannelStore
	facilitator  *x402.X402Facilitator
}

type batchSvmEnv struct {
	payerKey       string
	payTo          string
	authorizer     svm.ReceiverAuthorizerSigner
	facSigner      *realFacilitatorSvmSigner
	lifecycle      *batchclient.BatchSvmScheme
	resourceInfo   *types.ResourceInfo
	resourceConfig x402.ResourceConfig
}

func newBatchSvmEnv(t *testing.T) *batchSvmEnv {
	t.Helper()
	clientKey := os.Getenv("SVM_CLIENT_PRIVATE_KEY")
	facilitatorKey := os.Getenv("SVM_FACILITATOR_PRIVATE_KEY")
	authorizerKey := os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
	payTo := os.Getenv("SVM_RESOURCE_SERVER_ADDRESS")
	if clientKey == "" || facilitatorKey == "" || authorizerKey == "" || payTo == "" {
		t.Skip("Skipping SVM batch-settlement integration test: SVM_CLIENT_PRIVATE_KEY, " +
			"SVM_FACILITATOR_PRIVATE_KEY, SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY, and " +
			"SVM_RESOURCE_SERVER_ADDRESS must be set")
	}
	authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(authorizerKey)
	if err != nil {
		t.Fatalf("Failed to create receiver authorizer signer: %v", err)
	}
	facSigner, err := newRealFacilitatorSvmSigner(facilitatorKey, uptoSvmRPCURL())
	if err != nil {
		t.Fatalf("Failed to create facilitator signer: %v", err)
	}
	payer, err := batchclient.NewPrivateKeySigner(clientKey)
	if err != nil {
		t.Fatalf("Failed to create client signer: %v", err)
	}
	lifecycle, err := batchclient.NewBatchSvmScheme(payer, &batchclient.BatchSvmClientConfig{
		RPCURL:        uptoSvmRPCURL(),
		DepositAmount: batchIntegrationDepositMicros,
	})
	if err != nil {
		t.Fatalf("Failed to create lifecycle batch client: %v", err)
	}
	return &batchSvmEnv{
		payerKey:   clientKey,
		payTo:      payTo,
		authorizer: authorizer,
		facSigner:  facSigner,
		lifecycle:  lifecycle,
		resourceInfo: &types.ResourceInfo{
			URL:      "https://example.test/paid",
			MimeType: "application/json",
		},
		resourceConfig: x402.ResourceConfig{
			Scheme:            batchsettlement.Scheme,
			Network:           svm.SolanaDevnetCAIP2,
			PayTo:             payTo,
			Price:             batchIntegrationPrice,
			MaxTimeoutSeconds: 300,
		},
	}
}

func (env *batchSvmEnv) pipeline(
	t *testing.T,
	ctx context.Context,
	store *batchserver.MemoryChannelStore,
	coldClient bool,
) *batchSvmPipeline {
	t.Helper()
	withdrawDelay := batchIntegrationWithdrawDelay
	batchFac := batchfacilitator.NewBatchSvmScheme(ctx, env.facSigner, &batchfacilitator.Config{})
	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{svm.SolanaDevnetCAIP2}, batchFac)

	serverScheme := batchserver.NewBatchSvmScheme(&batchserver.Config{
		ReceiverAuthorizer: env.authorizer,
		Store:              store,
		WithdrawDelay:      &withdrawDelay,
	})
	resource := x402.Newx402ResourceServer(x402.WithFacilitatorClient(&localSvmFacilitatorClient{
		facilitator: facilitator,
		signer:      env.facSigner,
	}))
	resource.Register(svm.SolanaDevnetCAIP2, serverScheme)
	if err := resource.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	scheme := env.lifecycle
	if coldClient {
		payer, err := batchclient.NewPrivateKeySigner(env.payerKey)
		if err != nil {
			t.Fatalf("Failed to create cold client signer: %v", err)
		}
		scheme, err = batchclient.NewBatchSvmScheme(payer, &batchclient.BatchSvmClientConfig{
			RPCURL:        uptoSvmRPCURL(),
			DepositAmount: batchIntegrationDepositMicros,
		})
		if err != nil {
			t.Fatalf("Failed to create cold batch client: %v", err)
		}
	}

	client := x402.Newx402Client()
	client.DisableSpendControls()
	client.Register(svm.SolanaDevnetCAIP2, scheme)

	return &batchSvmPipeline{
		client:       client,
		scheme:       scheme,
		resource:     resource,
		serverScheme: serverScheme,
		store:        store,
		facilitator:  facilitator,
	}
}

func (pipe *batchSvmPipeline) accepts(t *testing.T, ctx context.Context, env *batchSvmEnv) []types.PaymentRequirements {
	t.Helper()
	accepts, err := pipe.resource.BuildPaymentRequirementsFromConfig(ctx, env.resourceConfig)
	if err != nil {
		t.Fatalf("Failed to build payment requirements: %v", err)
	}
	return accepts
}

func batchChannelIDFromPayload(payload types.PaymentPayload) (string, error) {
	parsed, err := batchsettlement.ParseBatchPayload(payload.Payload)
	if err != nil {
		return "", err
	}
	if parsed.Voucher != nil && parsed.Voucher.ChannelID != "" {
		return parsed.Voucher.ChannelID, nil
	}
	if parsed.Authorization != nil && parsed.Authorization.ChannelID != "" {
		return parsed.Authorization.ChannelID, nil
	}
	if parsed.Authorization != nil && parsed.Authorization.ChannelID != "" {
		return parsed.Authorization.ChannelID, nil
	}
	return "", fmt.Errorf("batch payload has no channel id")
}

func fetchBatchChannel(t *testing.T, ctx context.Context, channelID string) *generated.Channel {
	t.Helper()
	key, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		t.Fatalf("Failed to parse channel id: %v", err)
	}
	account, err := retryWhileRateLimited(ctx, func() (*rpc.GetAccountInfoResult, error) {
		return rpc.New(uptoSvmRPCURL()).GetAccountInfoWithOpts(ctx, key, &rpc.GetAccountInfoOpts{
			Encoding:   solana.EncodingBase64,
			Commitment: svm.DefaultCommitment,
		})
	})
	if err != nil {
		t.Fatalf("Failed to fetch channel %s: %v", channelID, err)
	}
	channel, err := paymentchannels.DecodeChannel(account.Value.Data.GetBinary())
	if err != nil {
		t.Fatalf("Failed to decode channel %s: %v", channelID, err)
	}
	return channel
}

type batchPayOptions struct {
	expectDeposit bool
	meteredAmount string
	requiredCtx   *types.PaymentRequired
}

func payBatchFlow(
	t *testing.T,
	ctx context.Context,
	pipe *batchSvmPipeline,
	env *batchSvmEnv,
	opts batchPayOptions,
) (types.PaymentPayload, types.PaymentRequirements) {
	t.Helper()
	accepts := pipe.accepts(t, ctx, env)
	info := env.resourceInfo
	required := pipe.resource.CreatePaymentRequiredResponse(accepts, info, "", nil)
	if opts.requiredCtx != nil {
		required = *opts.requiredCtx
		accepts = required.Accepts
	}
	selected, err := pipe.client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("Failed to select payment requirements: %v", err)
	}
	payload, err := retryWhileRateLimited(ctx, func() (types.PaymentPayload, error) {
		return pipe.client.CreatePaymentPayload(x402.WithPaymentRequired(ctx, required), selected, info, required.Extensions)
	})
	if err != nil {
		t.Fatalf("Failed to create payment payload: %v", err)
	}
	if opts.expectDeposit && payload.Payload["type"] != batchsettlement.PayloadTypeDeposit {
		t.Fatalf("Expected a deposit payload, got %v", payload.Payload["type"])
	}
	matched := pipe.resource.FindMatchingRequirements(accepts, payload)
	if matched == nil {
		t.Fatal("No matching payment requirements found")
	}
	verified, err := pipe.resource.VerifyPayment(ctx, payload, *matched)
	if err != nil {
		t.Fatalf("Failed to verify payment: %v", err)
	}
	if !verified.IsValid {
		t.Fatalf("Payment verification failed: %s", verified.InvalidReason)
	}
	var overrides *x402.SettlementOverrides
	if opts.meteredAmount != "" {
		overrides = &x402.SettlementOverrides{Amount: opts.meteredAmount}
	}
	settled, err := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
		return pipe.resource.SettlePaymentWithExtensions(ctx, payload, *matched, overrides, nil, x402.SettlePhaseAfterHandler)
	})
	if err != nil {
		t.Fatalf("Failed to settle payment: %v", err)
	}
	if !settled.Success {
		t.Fatalf("Payment settlement failed: %s", settled.ErrorReason)
	}
	if _, err := pipe.scheme.OnPaymentResponse(ctx, x402.PaymentResponseContext{
		PaymentPayload: payload,
		Requirements:   *matched,
		SettleResponse: settled,
	}); err != nil {
		t.Fatalf("Client failed to record the settlement: %v", err)
	}
	return payload, *matched
}

// TestSVMIntegrationBatchSettlement runs batch-settlement against devnet with the
// same SVM_* keys as the upto integration test.
func TestSVMIntegrationBatchSettlement(t *testing.T) {
	ctx := context.Background()
	env := newBatchSvmEnv(t)

	var channelID string
	var lifecycleStore *batchserver.MemoryChannelStore

	t.Run("opens a channel, serves a paid request, and charges it once", func(t *testing.T) {
		lifecycleStore = batchserver.NewMemoryChannelStore()
		pipe := env.pipeline(t, ctx, lifecycleStore, false)
		payload, _ := payBatchFlow(t, ctx, pipe, env, batchPayOptions{expectDeposit: true})

		id, err := batchChannelIDFromPayload(payload)
		if err != nil {
			t.Fatalf("Failed to read channel id from payload: %v", err)
		}
		channelID = id
		channel := fetchBatchChannel(t, ctx, channelID)
		if generated.ChannelStatus(channel.Status) != generated.ChannelStatus_Open {
			t.Fatalf("Expected an open channel, got status %d", channel.Status)
		}
		if channel.Deposit != batchIntegrationDepositMicros {
			t.Fatalf("Expected deposit %d, got %d", batchIntegrationDepositMicros, channel.Deposit)
		}
		state, err := lifecycleStore.Get(channelID)
		if err != nil {
			t.Fatalf("Failed to read server store: %v", err)
		}
		if state == nil || state.ChargedCumulativeAmount != batchIntegrationRequestMicros {
			t.Fatalf("Expected charged cumulative %d, got %+v", batchIntegrationRequestMicros, state)
		}
	})

	t.Run("serves a steady-state voucher with no transaction", func(t *testing.T) {
		if channelID == "" {
			t.Fatal("opening payment did not succeed")
		}
		pipe := env.pipeline(t, ctx, lifecycleStore, false)
		payload, _ := payBatchFlow(t, ctx, pipe, env, batchPayOptions{})
		if payload.Payload["type"] != batchsettlement.PayloadTypeVoucher {
			t.Fatalf("Expected a voucher payload, got %v", payload.Payload["type"])
		}
		if _, ok := payload.Payload["transaction"]; ok {
			t.Fatal("steady-state voucher must not carry a transaction")
		}
		if _, ok := payload.Payload["deposit"]; ok {
			t.Fatal("steady-state voucher must not carry a deposit")
		}
		state, err := lifecycleStore.Get(channelID)
		if err != nil {
			t.Fatalf("Failed to read server store: %v", err)
		}
		if state == nil || state.ChargedCumulativeAmount != 2*batchIntegrationRequestMicros {
			t.Fatalf("Expected charged cumulative %d, got %+v", 2*batchIntegrationRequestMicros, state)
		}
	})

	t.Run("resynchronizes a rediscovered client through a corrective 402", func(t *testing.T) {
		if channelID == "" {
			t.Fatal("opening payment did not succeed")
		}
		pipe := env.pipeline(t, ctx, lifecycleStore, true)
		accepts := pipe.accepts(t, ctx, env)
		required := pipe.resource.CreatePaymentRequiredResponse(accepts, env.resourceInfo, "", nil)
		selected, err := pipe.client.SelectPaymentRequirements(accepts)
		if err != nil {
			t.Fatalf("Failed to select payment requirements: %v", err)
		}
		payload, err := retryWhileRateLimited(ctx, func() (types.PaymentPayload, error) {
			return pipe.client.CreatePaymentPayload(x402.WithPaymentRequired(ctx, required), selected, env.resourceInfo, required.Extensions)
		})
		if err != nil {
			t.Fatalf("Failed to create payment payload: %v", err)
		}
		id, err := batchChannelIDFromPayload(payload)
		if err != nil {
			t.Fatalf("Failed to read channel id: %v", err)
		}
		if id != channelID {
			t.Fatalf("expected channel %s, got %s", channelID, id)
		}
		matched := pipe.resource.FindMatchingRequirements(accepts, payload)
		if matched == nil {
			t.Fatal("No matching payment requirements found")
		}
		verified, err := pipe.resource.VerifyPayment(ctx, payload, *matched)
		if err != nil {
			t.Fatalf("Failed to verify payment: %v", err)
		}
		if verified.IsValid {
			t.Fatal("expected cumulative mismatch verification failure")
		}
		if verified.InvalidReason != batchsettlement.ErrCumulativeAmountMismatch {
			t.Fatalf("expected %q, got %q", batchsettlement.ErrCumulativeAmountMismatch, verified.InvalidReason)
		}

		corrective := pipe.resource.CreatePaymentRequiredResponseWithPayload(
			accepts, env.resourceInfo, verified.InvalidReason, nil, &payload,
		)
		var batchAccept *types.PaymentRequirements
		for i := range corrective.Accepts {
			if corrective.Accepts[i].Scheme == batchsettlement.Scheme {
				batchAccept = &corrective.Accepts[i]
				break
			}
		}
		if batchAccept == nil {
			t.Fatal("expected a batch-settlement accept in the corrective 402")
		}
		channelState, _ := batchAccept.Extra[batchsettlement.ExtraChannelState].(map[string]any)
		if channelState == nil || channelState["chargedCumulativeAmount"] != "2000" {
			t.Fatalf("unexpected channelState: %v", batchAccept.Extra[batchsettlement.ExtraChannelState])
		}
		voucherState, _ := batchAccept.Extra[batchsettlement.ExtraVoucherState].(map[string]any)
		if voucherState == nil || voucherState["signedMaxClaimable"] != "2000" {
			t.Fatalf("unexpected voucherState: %v", batchAccept.Extra[batchsettlement.ExtraVoucherState])
		}

		recovered, err := pipe.scheme.OnPaymentResponse(ctx, x402.PaymentResponseContext{
			PaymentPayload:  payload,
			Requirements:    *matched,
			SettleResponse:  &x402.SettleResponse{Success: false},
			PaymentRequired: &corrective,
		})
		if err != nil {
			t.Fatalf("OnPaymentResponse failed: %v", err)
		}
		if !recovered.Recovered {
			t.Fatal("expected the client to recover from the corrective 402")
		}

		retryRequired := pipe.resource.CreatePaymentRequiredResponse(accepts, env.resourceInfo, "", nil)
		retryPayload, err := retryWhileRateLimited(ctx, func() (types.PaymentPayload, error) {
			return pipe.client.CreatePaymentPayload(x402.WithPaymentRequired(ctx, retryRequired), *batchAccept, env.resourceInfo, retryRequired.Extensions)
		})
		if err != nil {
			t.Fatalf("Failed to create retry payload: %v", err)
		}
		parsed, err := batchsettlement.ParseBatchPayload(retryPayload.Payload)
		if err != nil {
			t.Fatalf("Failed to parse retry payload: %v", err)
		}
		if parsed.Voucher == nil || parsed.Voucher.MaxClaimableAmount != "3000" {
			t.Fatalf("expected maxClaimableAmount 3000, got %+v", parsed.Voucher)
		}
		retryMatched := pipe.resource.FindMatchingRequirements(accepts, retryPayload)
		if retryMatched == nil {
			t.Fatal("No matching payment requirements found")
		}
		retryVerified, err := pipe.resource.VerifyPayment(ctx, retryPayload, *retryMatched)
		if err != nil {
			t.Fatalf("Failed to verify retry payment: %v", err)
		}
		if !retryVerified.IsValid {
			t.Fatalf("Retry verification failed: %s", retryVerified.InvalidReason)
		}
		settled, err := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
			return pipe.resource.SettlePaymentWithExtensions(ctx, retryPayload, *retryMatched, nil, nil, x402.SettlePhaseAfterHandler)
		})
		if err != nil {
			t.Fatalf("Failed to settle retry payment: %v", err)
		}
		if !settled.Success {
			t.Fatalf("Retry settlement failed: %s", settled.ErrorReason)
		}
		state, err := lifecycleStore.Get(channelID)
		if err != nil {
			t.Fatalf("Failed to read server store: %v", err)
		}
		if state == nil || state.ChargedCumulativeAmount != 3*batchIntegrationRequestMicros {
			t.Fatalf("Expected charged cumulative %d, got %+v", 3*batchIntegrationRequestMicros, state)
		}
	})

	t.Run("rebuilds a lost server record from chain", func(t *testing.T) {
		if channelID == "" {
			t.Fatal("opening payment did not succeed")
		}
		emptyStore := batchserver.NewMemoryChannelStore()
		pipe := env.pipeline(t, ctx, emptyStore, true)
		accepts := pipe.accepts(t, ctx, env)
		required := pipe.resource.CreatePaymentRequiredResponse(accepts, env.resourceInfo, "", nil)
		selected, err := pipe.client.SelectPaymentRequirements(accepts)
		if err != nil {
			t.Fatalf("Failed to select payment requirements: %v", err)
		}
		payload, err := retryWhileRateLimited(ctx, func() (types.PaymentPayload, error) {
			return pipe.client.CreatePaymentPayload(x402.WithPaymentRequired(ctx, required), selected, env.resourceInfo, required.Extensions)
		})
		if err != nil {
			t.Fatalf("Failed to create payment payload: %v", err)
		}
		matched := pipe.resource.FindMatchingRequirements(accepts, payload)
		if matched == nil {
			t.Fatal("No matching payment requirements found")
		}
		verified, err := pipe.resource.VerifyPayment(ctx, payload, *matched)
		if err != nil {
			t.Fatalf("Failed to verify payment: %v", err)
		}
		rebuilt, err := emptyStore.Get(channelID)
		if err != nil {
			t.Fatalf("Failed to read rebuilt store: %v", err)
		}
		if rebuilt == nil {
			t.Fatal("expected the record to be rebuilt from confirmed onchain state")
		}
		if rebuilt.Deposit != batchIntegrationDepositMicros {
			t.Fatalf("expected deposit %d, got %d", batchIntegrationDepositMicros, rebuilt.Deposit)
		}
		if rebuilt.ChargedCumulativeAmount != rebuilt.Settled {
			t.Fatalf("expected charged to match settled watermark, got charged=%d settled=%d",
				rebuilt.ChargedCumulativeAmount, rebuilt.Settled)
		}
		if !verified.IsValid {
			t.Fatalf("Payment verification failed after rebuild: %s", verified.InvalidReason)
		}
		settled, err := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
			return pipe.resource.SettlePaymentWithExtensions(ctx, payload, *matched, nil, nil, x402.SettlePhaseAfterHandler)
		})
		if err != nil {
			t.Fatalf("Failed to settle payment: %v", err)
		}
		if !settled.Success {
			t.Fatalf("Payment settlement failed: %s", settled.ErrorReason)
		}
	})

	t.Run("starts the payer-forced close", func(t *testing.T) {
		if channelID == "" {
			t.Fatal("opening payment did not succeed")
		}
		pipe := env.pipeline(t, ctx, lifecycleStore, false)
		accepts := pipe.accepts(t, ctx, env)
		required := pipe.resource.CreatePaymentRequiredResponse(accepts, env.resourceInfo, "", nil)
		var requirements types.PaymentRequirements
		for _, accept := range required.Accepts {
			if accept.Scheme == batchsettlement.Scheme {
				requirements = accept
				break
			}
		}
		if requirements.Scheme == "" {
			t.Fatal("expected batch-settlement requirements")
		}
		refund, err := pipe.scheme.CreateRefundPayload(ctx, 2, requirements, batchclient.RefundPayloadOptions{})
		if err != nil {
			t.Fatalf("Failed to create refund payload: %v", err)
		}
		payload := types.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     refund.Payload,
		}
		matched := pipe.resource.FindMatchingRequirements(accepts, payload)
		if matched == nil {
			t.Fatal("No matching payment requirements found")
		}
		verified, err := pipe.resource.VerifyPayment(ctx, payload, *matched)
		if err != nil {
			t.Fatalf("Failed to verify refund: %v", err)
		}
		if !verified.IsValid {
			t.Fatalf("Refund verification failed: %s", verified.InvalidReason)
		}
		settled, err := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
			return pipe.resource.SettlePaymentWithExtensions(ctx, payload, *matched, nil, nil, x402.SettlePhaseAfterHandler)
		})
		if err != nil {
			t.Fatalf("Failed to settle refund: %v", err)
		}
		if !settled.Success {
			t.Fatalf("Refund settlement failed: %s", settled.ErrorReason)
		}
		channel := fetchBatchChannel(t, ctx, channelID)
		if generated.ChannelStatus(channel.Status) != generated.ChannelStatus_Closing {
			t.Fatalf("Expected a closing channel, got status %d", channel.Status)
		}
		state, err := lifecycleStore.Get(channelID)
		if err != nil {
			t.Fatalf("Failed to read server store: %v", err)
		}
		if state == nil || state.Status != batchserver.ChannelStatusClosing {
			t.Fatalf("Expected store status closing, got %+v", state)
		}
	})

	t.Run("tops up a channel whose escrow is spent", func(t *testing.T) {
		payer, err := batchclient.NewPrivateKeySigner(env.payerKey)
		if err != nil {
			t.Fatalf("Failed to create payer signer: %v", err)
		}
		thrifty, err := batchclient.NewBatchSvmScheme(payer, &batchclient.BatchSvmClientConfig{
			RPCURL:        uptoSvmRPCURL(),
			DepositAmount: batchIntegrationRequestMicros,
			Salt:          "1",
		})
		if err != nil {
			t.Fatalf("Failed to create thrifty client: %v", err)
		}
		store := batchserver.NewMemoryChannelStore()
		withdrawDelay := batchIntegrationWithdrawDelay
		batchFac := batchfacilitator.NewBatchSvmScheme(ctx, env.facSigner, &batchfacilitator.Config{})
		facilitator := x402.Newx402Facilitator()
		facilitator.Register([]x402.Network{svm.SolanaDevnetCAIP2}, batchFac)
		serverScheme := batchserver.NewBatchSvmScheme(&batchserver.Config{
			ReceiverAuthorizer: env.authorizer,
			Store:              store,
			WithdrawDelay:      &withdrawDelay,
		})
		resource := x402.Newx402ResourceServer(x402.WithFacilitatorClient(&localSvmFacilitatorClient{
			facilitator: facilitator,
			signer:      env.facSigner,
		}))
		resource.Register(svm.SolanaDevnetCAIP2, serverScheme)
		if err := resource.Initialize(ctx); err != nil {
			t.Fatalf("Failed to initialize server: %v", err)
		}
		client := x402.Newx402Client()
		client.DisableSpendControls()
		client.Register(svm.SolanaDevnetCAIP2, thrifty)
		pipe := &batchSvmPipeline{
			client:       client,
			scheme:       thrifty,
			resource:     resource,
			serverScheme: serverScheme,
			store:        store,
			facilitator:  facilitator,
		}

		pay := func(expectDeposit bool) map[string]any {
			payload, _ := payBatchFlow(t, ctx, pipe, env, batchPayOptions{expectDeposit: expectDeposit})
			return payload.Payload
		}

		opened := pay(true)
		topChannelID, _ := opened["voucher"].(map[string]any)["channelId"].(string)
		if topChannelID == "" {
			t.Fatal("expected channel id on open payload")
		}
		afterOpen := fetchBatchChannel(t, ctx, topChannelID)
		if afterOpen.Deposit != batchIntegrationRequestMicros {
			t.Fatalf("expected deposit %d after open, got %d", batchIntegrationRequestMicros, afterOpen.Deposit)
		}

		toppedUp := pay(true)
		if toppedUp["type"] != batchsettlement.PayloadTypeDeposit {
			t.Fatalf("expected top-up deposit, got %v", toppedUp["type"])
		}
		if nestedStringMap(t, toppedUp, "voucher", "channelId") != topChannelID {
			t.Fatal("top-up must reuse the same channel")
		}
		afterTopUp := fetchBatchChannel(t, ctx, topChannelID)
		if afterTopUp.Deposit != 2*batchIntegrationRequestMicros {
			t.Fatalf("expected deposit %d after top-up, got %d", 2*batchIntegrationRequestMicros, afterTopUp.Deposit)
		}
		state, err := store.Get(topChannelID)
		if err != nil {
			t.Fatalf("Failed to read store: %v", err)
		}
		if state == nil || state.ChargedCumulativeAmount != 2*batchIntegrationRequestMicros {
			t.Fatalf("Expected charged cumulative %d, got %+v", 2*batchIntegrationRequestMicros, state)
		}
	})

	t.Run("redeems through the channel manager", func(t *testing.T) {
		if channelID == "" {
			t.Fatal("opening payment did not succeed")
		}
		pipe := env.pipeline(t, ctx, lifecycleStore, false)
		accepts := pipe.accepts(t, ctx, env)
		matched := accepts[0]
		before := batchPayeeBalance(t, ctx, env.payTo, matched)

		manager, err := pipe.serverScheme.CreateChannelManager(&localSvmFacilitatorClient{
			facilitator: pipe.facilitator,
			signer:      env.facSigner,
		}, matched, batchserver.BatchChannelManagerConfig{RPCURL: uptoSvmRPCURL()})
		if err != nil {
			t.Fatalf("Failed to create channel manager: %v", err)
		}

		redeemed, err := retryWhileRateLimited(ctx, func() (batchserver.RedemptionResult, error) {
			return manager.Redeem(ctx)
		})
		if err != nil {
			t.Fatalf("Redeem failed: %v", err)
		}
		if len(redeemed.Claimed) != 1 || redeemed.Claimed[0] != channelID {
			t.Fatalf("expected claim on %s, got %+v", channelID, redeemed.Claimed)
		}
		if len(redeemed.Distributed) != 1 || redeemed.Distributed[0] != channelID {
			t.Fatalf("expected distribute on %s, got %+v", channelID, redeemed.Distributed)
		}

		channel := fetchBatchChannel(t, ctx, channelID)
		state, err := lifecycleStore.Get(channelID)
		if err != nil {
			t.Fatalf("Failed to read store: %v", err)
		}
		if state == nil {
			t.Fatal("expected store record")
		}
		if channel.Settlement.Settled != state.ChargedCumulativeAmount {
			t.Fatalf("onchain settled %d != charged %d", channel.Settlement.Settled, state.ChargedCumulativeAmount)
		}
		if channel.Settlement.PayoutWatermark != state.ChargedCumulativeAmount {
			t.Fatalf("onchain payout watermark %d != charged %d", channel.Settlement.PayoutWatermark, state.ChargedCumulativeAmount)
		}
		after := batchPayeeBalance(t, ctx, env.payTo, matched)
		if after <= before {
			t.Fatalf("expected payee balance to increase, before=%d after=%d", before, after)
		}

		again, err := manager.Redeem(ctx)
		if err != nil {
			t.Fatalf("Second redeem failed: %v", err)
		}
		if len(again.Claimed) != 0 || len(again.Distributed) != 0 {
			t.Fatalf("expected empty second pass, got %+v", again)
		}
	})
}

func TestSVMIntegrationBatchSettlementOperatorSigning(t *testing.T) {
	ctx := context.Background()
	env := newBatchSvmEnv(t)

	operatorKey := solana.NewWallet()
	operator, err := batchclient.NewPrivateKeySigner(operatorKey.PrivateKey.String())
	if err != nil {
		t.Fatalf("Failed to create operator signer: %v", err)
	}

	store := batchserver.NewMemoryChannelStore()
	withdrawDelay := batchIntegrationWithdrawDelay
	batchFac := batchfacilitator.NewBatchSvmScheme(ctx, env.facSigner, &batchfacilitator.Config{})
	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{svm.SolanaDevnetCAIP2}, batchFac)
	serverScheme := batchserver.NewBatchSvmScheme(&batchserver.Config{
		ReceiverAuthorizer: env.authorizer,
		Operator:           operator,
		Store:              store,
		WithdrawDelay:      &withdrawDelay,
	})
	resource := x402.Newx402ResourceServer(x402.WithFacilitatorClient(&localSvmFacilitatorClient{
		facilitator: facilitator,
		signer:      env.facSigner,
	}))
	resource.Register(svm.SolanaDevnetCAIP2, serverScheme)
	if err := resource.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	payer, err := batchclient.NewPrivateKeySigner(env.payerKey)
	if err != nil {
		t.Fatalf("Failed to create payer signer: %v", err)
	}
	clientScheme, err := batchclient.NewBatchSvmScheme(payer, &batchclient.BatchSvmClientConfig{
		RPCURL:        uptoSvmRPCURL(),
		DepositAmount: batchIntegrationDepositMicros,
		Salt:          "2",
		ServerSignedChannelsPolicy: &batchclient.BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
		},
	})
	if err != nil {
		t.Fatalf("Failed to create server-signed client: %v", err)
	}
	client := x402.Newx402Client()
	client.DisableSpendControls()
	client.Register(svm.SolanaDevnetCAIP2, clientScheme)

	accepts, err := resource.BuildPaymentRequirementsFromConfig(ctx, env.resourceConfig)
	if err != nil {
		t.Fatalf("Failed to build payment requirements: %v", err)
	}
	for i := range accepts {
		if accepts[i].Extra == nil {
			accepts[i].Extra = map[string]any{}
		}
		accepts[i].Extra[batchsettlement.ExtraOperator] = operator.Address().String()
		accepts[i].Extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
	}
	required := resource.CreatePaymentRequiredResponse(accepts, &types.ResourceInfo{
		URL: "https://example.test/operator-paid",
	}, "", nil)

	payMetered := func(amount string) (types.PaymentPayload, types.PaymentRequirements) {
		t.Helper()
		selected, err := client.SelectPaymentRequirements(required.Accepts)
		if err != nil {
			t.Fatalf("Failed to select payment requirements: %v", err)
		}
		payload, err := retryWhileRateLimited(ctx, func() (types.PaymentPayload, error) {
			return client.CreatePaymentPayload(x402.WithPaymentRequired(ctx, required), selected, env.resourceInfo, required.Extensions)
		})
		if err != nil {
			t.Fatalf("Failed to create payment payload: %v", err)
		}
		matched := resource.FindMatchingRequirements(required.Accepts, payload)
		if matched == nil {
			t.Fatal("No matching payment requirements found")
		}
		verified, err := resource.VerifyPayment(ctx, payload, *matched)
		if err != nil {
			t.Fatalf("Failed to verify payment: %v", err)
		}
		if !verified.IsValid {
			t.Fatalf("Payment verification failed: %s", verified.InvalidReason)
		}
		settled, err := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
			return resource.SettlePaymentWithExtensions(ctx, payload, *matched, &x402.SettlementOverrides{Amount: amount}, nil, x402.SettlePhaseAfterHandler)
		})
		if err != nil {
			t.Fatalf("Failed to settle payment: %v", err)
		}
		if !settled.Success {
			t.Fatalf("Payment settlement failed: %s", settled.ErrorReason)
		}
		if _, err := clientScheme.OnPaymentResponse(ctx, x402.PaymentResponseContext{
			PaymentPayload: payload,
			Requirements:   *matched,
			SettleResponse: settled,
		}); err != nil {
			t.Fatalf("Client failed to record the settlement: %v", err)
		}
		return payload, *matched
	}

	first, _ := payMetered("400")
	firstParsed, err := batchsettlement.ParseBatchPayload(first.Payload)
	if err != nil {
		t.Fatalf("Failed to parse first payload: %v", err)
	}
	if firstParsed.Type != batchsettlement.PayloadTypeDeposit {
		t.Fatalf("expected deposit, got %s", firstParsed.Type)
	}
	if firstParsed.ChannelConfig.PayerAuthorizer != operator.Address().String() {
		t.Fatalf("expected operator authorizer, got %s", firstParsed.ChannelConfig.PayerAuthorizer)
	}
	if firstParsed.ChannelConfig.VoucherSigner != batchsettlement.VoucherSignerServer {
		t.Fatalf("expected server voucher signer, got %s", firstParsed.ChannelConfig.VoucherSigner)
	}
	if firstParsed.Voucher != nil {
		t.Fatal("opening deposit must not carry a voucher in server mode")
	}
	channelID, err := batchChannelIDFromPayload(first)
	if err != nil {
		t.Fatalf("Failed to read channel id: %v", err)
	}

	second, _ := payMetered("200")
	third, _ := payMetered("300")
	secondParsed, err := batchsettlement.ParseBatchPayload(second.Payload)
	if err != nil {
		t.Fatalf("Failed to parse second payload: %v", err)
	}
	if secondParsed.Type != batchsettlement.PayloadTypeAuthorization {
		t.Fatalf("expected authorization payload, got %s", secondParsed.Type)
	}
	if secondParsed.Authorization.ExpiresAt <= time.Now().Unix() {
		t.Fatal("authorization should expire in the future")
	}
	thirdParsed, err := batchsettlement.ParseBatchPayload(third.Payload)
	if err != nil {
		t.Fatalf("Failed to parse third payload: %v", err)
	}
	if secondParsed.Authorization.RequestID == firstParsed.Authorization.RequestID {
		t.Fatal("expected a fresh request id on the second payment")
	}
	if thirdParsed.Authorization.RequestID == secondParsed.Authorization.RequestID {
		t.Fatal("expected a fresh request id on the third payment")
	}

	state, err := store.Get(channelID)
	if err != nil {
		t.Fatalf("Failed to read store: %v", err)
	}
	if state == nil || state.ChargedCumulativeAmount != 900 {
		t.Fatalf("expected charged cumulative 900, got %+v", state)
	}
	if state.HighestVoucherSignature == "" {
		t.Fatal("expected stored operator voucher signature")
	}
	message := paymentchannels.EncodeVoucherMessage(
		solana.MustPublicKeyFromBase58(channelID),
		state.ChargedCumulativeAmount,
		0,
	)
	if err := paymentchannels.VerifyVoucherSignature(
		state.HighestVoucherSignature,
		operator.Address().String(),
		message,
	); err != nil {
		t.Fatalf("stored operator voucher failed verification: %v", err)
	}

	matched := required.Accepts[0]
	before := batchPayeeBalance(t, ctx, env.payTo, matched)
	manager, err := serverScheme.CreateChannelManager(&localSvmFacilitatorClient{
		facilitator: facilitator,
		signer:      env.facSigner,
	}, matched, batchserver.BatchChannelManagerConfig{RPCURL: uptoSvmRPCURL()})
	if err != nil {
		t.Fatalf("Failed to create channel manager: %v", err)
	}
	redeemed, err := retryWhileRateLimited(ctx, func() (batchserver.RedemptionResult, error) {
		return manager.Redeem(ctx)
	})
	if err != nil {
		t.Fatalf("Redeem failed: %v", err)
	}
	if len(redeemed.Claimed) != 1 || redeemed.Claimed[0] != channelID {
		t.Fatalf("unexpected claim result: %+v", redeemed)
	}
	if len(redeemed.Distributed) != 1 || redeemed.Distributed[0] != channelID {
		t.Fatalf("unexpected distribute result: %+v", redeemed)
	}
	after := batchPayeeBalance(t, ctx, env.payTo, matched)
	if after-before != 900 {
		t.Fatalf("expected payee credit 900, got %d", after-before)
	}
}

func batchPayeeBalance(t *testing.T, ctx context.Context, payTo string, requirements types.PaymentRequirements) uint64 {
	t.Helper()
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		t.Fatalf("Failed to parse asset mint: %v", err)
	}
	tokenProgram := solana.TokenProgramID
	if tp, ok := requirements.Extra[batchsettlement.ExtraTokenProgram].(string); ok && tp != "" {
		tokenProgram, err = solana.PublicKeyFromBase58(tp)
		if err != nil {
			t.Fatalf("Failed to parse token program: %v", err)
		}
	}
	owner, err := solana.PublicKeyFromBase58(payTo)
	if err != nil {
		t.Fatalf("Failed to parse payTo: %v", err)
	}
	return tokenBalance(t, ctx, owner, mint, tokenProgram)
}

func nestedStringMap(t *testing.T, value map[string]any, keys ...string) string {
	t.Helper()
	current := value
	for i, key := range keys {
		if i == len(keys)-1 {
			out, _ := current[key].(string)
			return out
		}
		next, ok := current[key].(map[string]any)
		if !ok {
			t.Fatalf("expected map at %q", key)
		}
		current = next
	}
	return ""
}
