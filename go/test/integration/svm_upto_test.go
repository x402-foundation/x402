// Package integration_test contains integration tests for the x402 Go SDK.
// This file exercises the SVM `upto` payment-channel scheme end to end against
// Solana devnet: the client opens a channel, the facilitator co-signs and
// broadcasts it, and the server settles for the metered amount.
package integration_test

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	uptosvmclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/client"
	uptosvmfacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/facilitator"
	uptosvmserver "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/server"
	svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// uptoSvmRPCURL is the devnet endpoint the whole flow runs against. An `upto`
// payment is far chattier than an `exact` one (blockhash, slot, simulation,
// confirmation, and balance reads), so SVM_RPC_URL can point the test at a
// dedicated endpoint when the public one starts shedding load.
func uptoSvmRPCURL() string {
	if url := os.Getenv("SVM_RPC_URL"); url != "" {
		return url
	}
	return "https://api.devnet.solana.com"
}

// uptoSvmClient is the client surface this test drives. The SDK constructors
// return unexported concrete types, so the trio is held behind local interfaces.
type uptoSvmClient interface {
	SelectPaymentRequirements(requirements []types.PaymentRequirements) (types.PaymentRequirements, error)
	CreatePaymentPayload(
		ctx context.Context,
		requirements types.PaymentRequirements,
		resource *types.ResourceInfo,
		extensions map[string]interface{},
	) (types.PaymentPayload, error)
}

// uptoSvmServer is the resource-server surface this test drives.
type uptoSvmServer interface {
	BuildPaymentRequirementsFromConfig(
		ctx context.Context, config x402.ResourceConfig,
	) ([]types.PaymentRequirements, error)
	CreatePaymentRequiredResponse(
		requirements []types.PaymentRequirements,
		resourceInfo *types.ResourceInfo,
		errorMsg string,
		extensions map[string]interface{},
	) types.PaymentRequired
	FindMatchingRequirements(
		available []types.PaymentRequirements, payload types.PaymentPayload,
	) *types.PaymentRequirements
	VerifyPayment(
		ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements,
	) (*x402.VerifyResponse, error)
	SettlePaymentWithExtensions(
		ctx context.Context,
		payload types.PaymentPayload,
		requirements types.PaymentRequirements,
		overrides *x402.SettlementOverrides,
		declaredExtensions map[string]interface{},
		phase x402.SettlePhase,
	) (*x402.SettleResponse, error)
}

// uptoSvmStack is a client / resource server / facilitator trio wired to
// devnet through the SVM `upto` scheme.
type uptoSvmStack struct {
	client      uptoSvmClient
	server      uptoSvmServer
	facilitator *uptosvmfacilitator.UptoSvmScheme
	payer       solana.PublicKey
	authorizer  solana.PublicKey
	payTo       string
}

// newUptoSvmStack builds the trio, skipping the test when devnet keys are absent.
func newUptoSvmStack(t *testing.T, ctx context.Context) *uptoSvmStack {
	t.Helper()

	clientPrivateKey := os.Getenv("SVM_CLIENT_PRIVATE_KEY")
	facilitatorPrivateKey := os.Getenv("SVM_FACILITATOR_PRIVATE_KEY")
	authorizerPrivateKey := os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
	resourceServerAddress := os.Getenv("SVM_RESOURCE_SERVER_ADDRESS")

	if clientPrivateKey == "" || facilitatorPrivateKey == "" ||
		authorizerPrivateKey == "" || resourceServerAddress == "" {
		t.Skip("Skipping SVM upto integration test: SVM_CLIENT_PRIVATE_KEY, " +
			"SVM_FACILITATOR_PRIVATE_KEY, SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY, and " +
			"SVM_RESOURCE_SERVER_ADDRESS must be set")
	}

	clientSigner, err := newRealClientSvmSigner(clientPrivateKey)
	if err != nil {
		t.Fatalf("Failed to create client signer: %v", err)
	}
	client := x402.Newx402Client()
	client.Register(svm.SolanaDevnetCAIP2, uptosvmclient.NewUptoSvmScheme(clientSigner, &svm.ClientConfig{
		RPCURL: uptoSvmRPCURL(),
	}))

	facilitatorSigner, err := newRealFacilitatorSvmSigner(facilitatorPrivateKey, uptoSvmRPCURL())
	if err != nil {
		t.Fatalf("Failed to create facilitator signer: %v", err)
	}
	uptoFacilitator := uptosvmfacilitator.NewUptoSvmScheme(facilitatorSigner, nil)
	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{svm.SolanaDevnetCAIP2}, uptoFacilitator)

	authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(authorizerPrivateKey)
	if err != nil {
		t.Fatalf("Failed to create receiver authorizer signer: %v", err)
	}
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(&localSvmFacilitatorClient{
		facilitator: facilitator,
		signer:      facilitatorSigner,
	}))
	server.Register(svm.SolanaDevnetCAIP2, uptosvmserver.NewUptoSvmScheme(&uptosvmserver.Config{
		ReceiverAuthorizerSigner: authorizer,
		RPCURL:                   uptoSvmRPCURL(),
	}))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	return &uptoSvmStack{
		client:      client,
		server:      server,
		facilitator: uptoFacilitator,
		payer:       clientSigner.Address(),
		authorizer:  authorizer.Address(),
		payTo:       resourceServerAddress,
	}
}

// openChannel runs the 402 challenge, payload creation, verify, and the deposit
// settle that broadcasts the channel open. It returns the payload, the
// requirements the claim settle must reuse, and the token balances as they
// stood before any funds moved.
func (s *uptoSvmStack) openChannel(
	t *testing.T, ctx context.Context, price string,
) (types.PaymentPayload, types.PaymentRequirements, tokenBalances) {
	t.Helper()

	accepts, err := s.server.BuildPaymentRequirementsFromConfig(ctx, x402.ResourceConfig{
		Scheme:            svm.SchemeUpto,
		Network:           svm.SolanaDevnetCAIP2,
		PayTo:             s.payTo,
		Price:             price,
		MaxTimeoutSeconds: 300,
	})
	if err != nil {
		t.Fatalf("Failed to build payment requirements: %v", err)
	}
	if accepts[0].Extra[upto.ExtraFeePayer] == nil {
		t.Fatalf("Expected a facilitator feePayer in the challenge, got extra=%v", accepts[0].Extra)
	}
	if accepts[0].Extra[upto.ExtraReceiverAuthorizer] != s.authorizer.String() {
		t.Fatalf("Expected receiverAuthorizer %s, got %v",
			s.authorizer, accepts[0].Extra[upto.ExtraReceiverAuthorizer])
	}

	resource := &types.ResourceInfo{
		URL:         "https://api.example.com/upto-svm",
		Description: "Upto SVM API Access",
		MimeType:    "application/json",
	}
	paymentRequired := s.server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

	selected, err := s.client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("Failed to select payment requirements: %v", err)
	}
	payload, err := retryWhileRateLimited(ctx, func() (types.PaymentPayload, error) {
		return s.client.CreatePaymentPayload(ctx, selected, resource, paymentRequired.Extensions)
	})
	if err != nil {
		t.Fatalf("Failed to create payment payload: %v", err)
	}
	if !svm.IsUptoSvmPayload(payload.Payload) {
		t.Fatalf("Expected an SVM upto payload, got %v", payload.Payload)
	}

	accepted := s.server.FindMatchingRequirements(accepts, payload)
	if accepted == nil {
		t.Fatal("No matching payment requirements found")
	}

	verifyResponse, err := s.server.VerifyPayment(ctx, payload, *accepted)
	if err != nil {
		t.Fatalf("Failed to verify payment: %v", err)
	}
	// The escrow flow verifies as part of the deposit settle, so this response is
	// the core's local pass rather than a facilitator verdict; the payer is only
	// echoed once the facilitator has seen the payload.
	if !verifyResponse.IsValid {
		t.Fatalf("Payment verification failed: %s", verifyResponse.InvalidReason)
	}

	before := s.readBalances(t, ctx, *accepted)

	// Deposit settle: escrows maxAmount by broadcasting the client's open.
	deposit, err := s.settle(ctx, payload, *accepted, x402.SettlePhaseBeforeHandler, nil)
	if err != nil {
		t.Fatalf("Failed to settle the deposit: %v", err)
	}
	if !deposit.Success {
		t.Fatalf("Deposit settlement failed: %s", deposit.ErrorReason)
	}
	if deposit.Transaction == "" {
		t.Error("Expected the open transaction signature in the deposit settlement")
	}
	if deposit.Network != svm.SolanaDevnetCAIP2 {
		t.Errorf("Expected network %s, got %s", svm.SolanaDevnetCAIP2, deposit.Network)
	}
	if deposit.Payer != s.payer.String() {
		t.Errorf("Expected payer %s, got %s", s.payer, deposit.Payer)
	}
	s.assertEscrowedChannel(t, ctx, payload, *accepted, before)

	return payload, *accepted, before
}

// settle runs a settle phase, retrying requests the devnet endpoint sheds.
func (s *uptoSvmStack) settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	phase x402.SettlePhase,
	overrides *x402.SettlementOverrides,
) (*x402.SettleResponse, error) {
	return retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
		return s.server.SettlePaymentWithExtensions(ctx, payload, requirements, overrides, nil, phase)
	})
}

// assertEscrowedChannel checks the freshly opened channel binds the challenge
// the client was served, and that the deposit really left the payer.
func (s *uptoSvmStack) assertEscrowedChannel(
	t *testing.T,
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	before tokenBalances,
) {
	t.Helper()

	decoded, err := svm.UptoPayloadFromMap(payload.Payload)
	if err != nil {
		t.Fatalf("Failed to decode the upto payload: %v", err)
	}
	authorized, err := strconv.ParseUint(decoded.MaxAmount, 10, 64)
	if err != nil {
		t.Fatalf("Failed to parse the authorized amount: %v", err)
	}

	channel := fetchChannel(t, ctx, payload)
	if channel.Status != paymentchannels.StatusOpen {
		t.Errorf("Expected an open channel, got %s", channel.Status)
	}
	if channel.Deposit != authorized {
		t.Errorf("Expected %d escrowed, got %d", authorized, channel.Deposit)
	}
	if channel.Payer.String() != s.payer.String() {
		t.Errorf("Expected channel payer %s, got %s", s.payer, channel.Payer)
	}
	if channel.AuthorizedSigner.String() != s.authorizer.String() {
		t.Errorf("Expected authorized signer %s, got %s", s.authorizer, channel.AuthorizedSigner)
	}
	if channel.Mint.String() != requirements.Asset {
		t.Errorf("Expected mint %s, got %s", requirements.Asset, channel.Mint)
	}
	feePayer, _ := requirements.Extra[upto.ExtraFeePayer].(string)
	if channel.Payee.String() != feePayer || channel.RentPayer.String() != feePayer {
		t.Errorf("Expected payee and rent payer %s, got payee %s rent payer %s",
			feePayer, channel.Payee, channel.RentPayer)
	}
	openSlot, err := strconv.ParseUint(decoded.OpenSlot, 10, 64)
	if err != nil {
		t.Fatalf("Failed to parse the open slot: %v", err)
	}
	if channel.OpenSlot != openSlot {
		t.Errorf("Expected open slot %d, got %d", openSlot, channel.OpenSlot)
	}

	// The escrow is real money: the deposit has to have left the payer.
	after := s.readBalances(t, ctx, requirements)
	if debit := before.payer - after.payer; debit != authorized {
		t.Errorf("Expected the payer to escrow %d, saw a debit of %d", authorized, debit)
	}
	if after.payee != before.payee {
		t.Errorf("Expected no payee credit before settlement, saw %d", after.payee-before.payee)
	}
}

// fetchChannel reads the live onchain channel account behind a payload.
func fetchChannel(t *testing.T, ctx context.Context, payload types.PaymentPayload) *paymentchannels.Channel {
	t.Helper()

	decoded, err := svm.UptoPayloadFromMap(payload.Payload)
	if err != nil {
		t.Fatalf("Failed to decode the upto payload: %v", err)
	}
	channelID, err := solana.PublicKeyFromBase58(decoded.ChannelId)
	if err != nil {
		t.Fatalf("Failed to parse the channel id: %v", err)
	}

	// Confirmed, not the RPC default of finalized: the settlement that produced
	// this state landed seconds ago.
	account, err := retryWhileRateLimited(ctx, func() (*rpc.GetAccountInfoResult, error) {
		return rpc.New(uptoSvmRPCURL()).GetAccountInfoWithOpts(ctx, channelID, &rpc.GetAccountInfoOpts{
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

// retryWhileRateLimited retries a call the public devnet endpoint refused with
// a 429. The `upto` flow issues enough requests to trip that limit, and a shed
// request says nothing about the payment under test. A 429 is refused before
// the transaction reaches the network, so retrying a settle cannot double-charge.
func retryWhileRateLimited[T any](ctx context.Context, call func() (T, error)) (T, error) {
	var result T
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if result, err = call(); err == nil || !strings.Contains(err.Error(), "rate limits exceeded") {
			return result, err
		}
		select {
		case <-ctx.Done():
			return result, err
		case <-time.After(time.Duration(attempt+1) * time.Second):
		}
	}
	return result, err
}

// tokenBalances is a snapshot of the SPL balances a settlement moves.
type tokenBalances struct {
	payer uint64
	payee uint64
}

// readBalances snapshots the payer and payTo token balances for the mint the
// requirements charge in.
func (s *uptoSvmStack) readBalances(
	t *testing.T, ctx context.Context, requirements types.PaymentRequirements,
) tokenBalances {
	t.Helper()

	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		t.Fatalf("Failed to parse the asset mint: %v", err)
	}
	tokenProgram, err := upto.ResolveTokenProgram(requirements)
	if err != nil {
		t.Fatalf("Failed to resolve the token program: %v", err)
	}
	payTo, err := solana.PublicKeyFromBase58(s.payTo)
	if err != nil {
		t.Fatalf("Failed to parse the payTo address: %v", err)
	}

	return tokenBalances{
		payer: tokenBalance(t, ctx, s.payer, mint, tokenProgram),
		payee: tokenBalance(t, ctx, payTo, mint, tokenProgram),
	}
}

// assertSettled checks the onchain token movement of a completed settlement:
// the payer is debited exactly what was metered (the rest of the escrow comes
// back) and the payTo account is credited it.
func (s *uptoSvmStack) assertSettled(
	t *testing.T,
	ctx context.Context,
	requirements types.PaymentRequirements,
	before tokenBalances,
	charged uint64,
) {
	t.Helper()

	after := s.readBalances(t, ctx, requirements)
	if debit := before.payer - after.payer; debit != charged {
		t.Errorf("Expected the payer to be charged %d, saw a debit of %d", charged, debit)
	}
	if credit := after.payee - before.payee; credit != charged {
		t.Errorf("Expected payTo to be credited %d, saw a credit of %d", charged, credit)
	}
}

// tokenBalance reads an owner's confirmed associated token balance, treating a
// missing account as zero.
func tokenBalance(
	t *testing.T, ctx context.Context, owner, mint, tokenProgram solana.PublicKey,
) uint64 {
	t.Helper()

	ata, err := paymentchannels.FindATA(owner, mint, tokenProgram)
	if err != nil {
		t.Fatalf("Failed to derive the associated token account for %s: %v", owner, err)
	}
	balance, err := retryWhileRateLimited(ctx, func() (*rpc.GetTokenAccountBalanceResult, error) {
		return rpc.New(uptoSvmRPCURL()).GetTokenAccountBalance(ctx, ata, svm.DefaultCommitment)
	})
	if err != nil {
		if strings.Contains(err.Error(), "could not find account") {
			return 0
		}
		t.Fatalf("Failed to read the token balance of %s: %v", ata, err)
	}
	amount, err := strconv.ParseUint(balance.Value.Amount, 10, 64)
	if err != nil {
		t.Fatalf("Failed to parse the token balance of %s: %v", ata, err)
	}
	return amount
}

// TestSVMIntegrationV2Upto runs the SVM `upto` escrow flow against devnet with
// real onchain transactions.
func TestSVMIntegrationV2Upto(t *testing.T) {
	ctx := context.Background()

	t.Run("SVM V2 Upto Flow - full settlement", func(t *testing.T) {
		stack := newUptoSvmStack(t, ctx)
		payload, requirements, before := stack.openChannel(t, ctx, "$0.001")

		settle, err := stack.settle(ctx, payload, requirements, x402.SettlePhaseAfterHandler, nil)
		if err != nil {
			t.Fatalf("Failed to settle payment: %v", err)
		}
		if !settle.Success {
			t.Fatalf("Payment settlement failed: %s", settle.ErrorReason)
		}
		if settle.Transaction == "" {
			t.Error("Expected the distribute signature in the settlement response")
		}
		if settle.Amount != requirements.Amount {
			t.Errorf("Expected settled amount %s, got %s", requirements.Amount, settle.Amount)
		}
		if settle.Payer != stack.payer.String() {
			t.Errorf("Expected payer %s, got %s", stack.payer, settle.Payer)
		}
		if channel := fetchChannel(t, ctx, payload); channel.Status != paymentchannels.StatusDistributed {
			t.Errorf("Expected a distributed channel, got %s", channel.Status)
		}
		charged, err := strconv.ParseUint(requirements.Amount, 10, 64)
		if err != nil {
			t.Fatalf("Failed to parse the authorized amount: %v", err)
		}
		stack.assertSettled(t, ctx, requirements, before, charged)
	})

	t.Run("SVM V2 Upto Flow - partial settlement refunds the remainder", func(t *testing.T) {
		stack := newUptoSvmStack(t, ctx)
		payload, requirements, before := stack.openChannel(t, ctx, "$0.001")

		maxAmount, err := strconv.ParseUint(requirements.Amount, 10, 64)
		if err != nil {
			t.Fatalf("Failed to parse the authorized amount: %v", err)
		}
		metered := strconv.FormatUint(maxAmount/2, 10)

		settle, err := stack.settle(
			ctx, payload, requirements, x402.SettlePhaseAfterHandler,
			&x402.SettlementOverrides{Amount: metered},
		)
		if err != nil {
			t.Fatalf("Failed to settle the metered amount: %v", err)
		}
		if !settle.Success {
			t.Fatalf("Metered settlement failed: %s", settle.ErrorReason)
		}
		if settle.Amount != metered {
			t.Errorf("Expected settled amount %s, got %s", metered, settle.Amount)
		}
		if settle.Transaction == "" {
			t.Error("Expected the distribute signature for a metered settlement")
		}
		if channel := fetchChannel(t, ctx, payload); channel.Status != paymentchannels.StatusDistributed {
			t.Errorf("Expected a distributed channel, got %s", channel.Status)
		}
		// The unmetered half must come back to the payer, not stay escrowed.
		stack.assertSettled(t, ctx, requirements, before, maxAmount/2)
	})

	t.Run("SVM V2 Upto Flow - zero settlement refunds the deposit", func(t *testing.T) {
		stack := newUptoSvmStack(t, ctx)
		payload, requirements, before := stack.openChannel(t, ctx, "$0.001")

		// The handler failed: seal at zero so the client is made whole.
		settle, err := stack.settle(
			ctx, payload, requirements, x402.SettlePhaseAfterHandler,
			&x402.SettlementOverrides{Amount: "0"},
		)
		if err != nil {
			t.Fatalf("Failed to settle zero: %v", err)
		}
		if !settle.Success {
			t.Fatalf("Zero settlement failed: %s", settle.ErrorReason)
		}
		if settle.Amount != "0" {
			t.Errorf("Expected settled amount '0', got %s", settle.Amount)
		}
		// A zero settlement still lands onchain: the channel must be closed out
		// so its escrow and rent are released.
		if settle.Transaction == "" {
			t.Error("Expected a distribute signature for a zero settlement")
		}
		if channel := fetchChannel(t, ctx, payload); channel.Status != paymentchannels.StatusDistributed {
			t.Errorf("Expected a distributed channel, got %s", channel.Status)
		}
		stack.assertSettled(t, ctx, requirements, before, 0)
	})

	t.Run("SVM V2 Upto Flow - rent cleanup defers a channel inside the reclaim gate", func(t *testing.T) {
		stack := newUptoSvmStack(t, ctx)
		payload, requirements, _ := stack.openChannel(t, ctx, "$0.001")

		if _, err := stack.settle(
			ctx, payload, requirements, x402.SettlePhaseAfterHandler, nil,
		); err != nil {
			t.Fatalf("Failed to settle payment: %v", err)
		}

		records, err := stack.facilitator.ChannelStorage().List(ctx)
		if err != nil {
			t.Fatalf("Failed to list stored channels: %v", err)
		}
		if len(records) == 0 {
			t.Fatal("Expected the settled channel to be tracked for rent cleanup")
		}

		// The reclaim gate needs 1500 slots past the open, so this pass must
		// leave the channel alone. It exercises cleanup against live state and
		// pins the deferral; reclaiming for real would mean waiting out the gate.
		manager := stack.facilitator.NewRentCleanupManager(svm.SolanaDevnetCAIP2)
		if err := manager.Cleanup(ctx, uptosvmfacilitator.CleanupOptions{
			OnError: func(err error, channelID string) {
				t.Errorf("Rent cleanup reported an error for %s: %v", channelID, err)
			},
			OnReclaim: func(result uptosvmfacilitator.ReclaimResult) {
				t.Errorf("Rent cleanup reclaimed %v before the open-slot gate elapsed", result.ChannelIDs)
			},
		}); err != nil {
			t.Fatalf("Rent cleanup failed: %v", err)
		}

		after, err := stack.facilitator.ChannelStorage().List(ctx)
		if err != nil {
			t.Fatalf("Failed to list stored channels: %v", err)
		}
		if len(after) != len(records) {
			t.Fatalf("Expected %d tracked channels after cleanup, got %d", len(records), len(after))
		}
	})
}

// newUptoSvmStackWithForcedPendingSigner builds the same client/server/facilitator
// trio as newUptoSvmStack, except the facilitator's signer is wrapped in a
// forcedPendingConfirmSigner so ConfirmTransaction can be made to fail on
// demand (for settlement-pending-auto-recovery tests) while every other
// signer method — including broadcast — delegates to the real signer.
func newUptoSvmStackWithForcedPendingSigner(t *testing.T, ctx context.Context) (*uptoSvmStack, *forcedPendingConfirmSigner) {
	t.Helper()

	clientPrivateKey := os.Getenv("SVM_CLIENT_PRIVATE_KEY")
	facilitatorPrivateKey := os.Getenv("SVM_FACILITATOR_PRIVATE_KEY")
	authorizerPrivateKey := os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
	resourceServerAddress := os.Getenv("SVM_RESOURCE_SERVER_ADDRESS")

	if clientPrivateKey == "" || facilitatorPrivateKey == "" || resourceServerAddress == "" {
		t.Skip("Skipping SVM upto settlement_pending test: SVM_CLIENT_PRIVATE_KEY, " +
			"SVM_FACILITATOR_PRIVATE_KEY, and SVM_RESOURCE_SERVER_ADDRESS must be set")
	}
	// The receiver authorizer only ever signs vouchers as raw Ed25519 messages
	// (never a transaction, per its interface docs) — it needs no SOL/token
	// balance, and every test built on this stack owns both the client and
	// server sides of that signature (the server signs, the facilitator
	// verifies), so any keypair is internally consistent even when it reaches
	// the voucher/claim path. So unlike newUptoSvmStack, a missing env var
	// here falls back to an ephemeral keypair instead of skipping.
	if authorizerPrivateKey == "" {
		authorizerPrivateKey = solana.NewWallet().PrivateKey.String()
	}

	clientSigner, err := newRealClientSvmSigner(clientPrivateKey)
	if err != nil {
		t.Fatalf("Failed to create client signer: %v", err)
	}
	client := x402.Newx402Client()
	// This test drives BuildPaymentRequirementsFromConfig/SelectPaymentRequirements
	// directly rather than a full HTTP round trip, which otherwise trips the
	// client's default allowed-assets spend control (see http_test.go /
	// core_test.go for the same pattern).
	client.DisableSpendControls()
	client.Register(svm.SolanaDevnetCAIP2, uptosvmclient.NewUptoSvmScheme(clientSigner, &svm.ClientConfig{
		RPCURL: uptoSvmRPCURL(),
	}))

	realFacilitatorSigner, err := newRealFacilitatorSvmSigner(facilitatorPrivateKey, uptoSvmRPCURL())
	if err != nil {
		t.Fatalf("Failed to create facilitator signer: %v", err)
	}
	facilitatorSigner := &forcedPendingConfirmSigner{FacilitatorSvmSigner: realFacilitatorSigner}
	uptoFacilitator := uptosvmfacilitator.NewUptoSvmScheme(facilitatorSigner, nil)
	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{svm.SolanaDevnetCAIP2}, uptoFacilitator)

	authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(authorizerPrivateKey)
	if err != nil {
		t.Fatalf("Failed to create receiver authorizer signer: %v", err)
	}
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(&localSvmFacilitatorClient{
		facilitator: facilitator,
		signer:      realFacilitatorSigner,
	}))
	server.Register(svm.SolanaDevnetCAIP2, uptosvmserver.NewUptoSvmScheme(&uptosvmserver.Config{
		ReceiverAuthorizerSigner: authorizer,
		RPCURL:                   uptoSvmRPCURL(),
	}))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	return &uptoSvmStack{
		client:      client,
		server:      server,
		facilitator: uptoFacilitator,
		payer:       clientSigner.Address(),
		authorizer:  authorizer.Address(),
		payTo:       resourceServerAddress,
	}, facilitatorSigner
}

// TestSVMIntegrationV2Upto_DepositSettlementPendingReconciliation exercises
// the settlement-pending-auto-recovery mechanism layer against a real
// on-chain SVM upto channel-open (deposit): the first deposit settle
// broadcasts the open for real but is forced (via forcedPendingConfirmSigner)
// to fail ConfirmTransaction, producing a settlement_pending SettleError with
// the broadcast signature attached and a PendingSettlementStore entry
// populated (keyed on the channel id). A second settle with the identical
// payload, now with confirmation no longer forced to fail, must hit the
// pending-store fast path (skip re-validate/re-broadcast — re-opening the
// same channel PDA would otherwise hit ErrChannelAlreadyOpen) and reconcile
// against that already-broadcast open — succeeding once it actually
// confirms on-chain, with the SAME signature as the first attempt, proving
// the channel was only ever opened once.
func TestSVMIntegrationV2Upto_DepositSettlementPendingReconciliation(t *testing.T) {
	ctx := context.Background()
	stack, facilitatorSigner := newUptoSvmStackWithForcedPendingSigner(t, ctx)

	accepts, err := stack.server.BuildPaymentRequirementsFromConfig(ctx, x402.ResourceConfig{
		Scheme:            svm.SchemeUpto,
		Network:           svm.SolanaDevnetCAIP2,
		PayTo:             stack.payTo,
		Price:             "$0.001",
		MaxTimeoutSeconds: 300,
	})
	if err != nil {
		t.Fatalf("Failed to build payment requirements: %v", err)
	}
	resource := &types.ResourceInfo{
		URL:         "https://api.example.com/upto-svm-pending",
		Description: "Upto SVM settlement-pending test",
		MimeType:    "application/json",
	}
	paymentRequired := stack.server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

	selected, err := stack.client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("Failed to select payment requirements: %v", err)
	}
	payload, err := retryWhileRateLimited(ctx, func() (types.PaymentPayload, error) {
		return stack.client.CreatePaymentPayload(ctx, selected, resource, paymentRequired.Extensions)
	})
	if err != nil {
		t.Fatalf("Failed to create payment payload: %v", err)
	}
	accepted := stack.server.FindMatchingRequirements(accepts, payload)
	if accepted == nil {
		t.Fatal("No matching payment requirements found")
	}

	// Attempt 1: the open broadcast is real; confirmation is forced to fail
	// regardless of real devnet confirmation speed.
	facilitatorSigner.forcePending.Store(true)

	_, settleErr := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
		return stack.server.SettlePaymentWithExtensions(ctx, payload, *accepted, nil, nil, x402.SettlePhaseBeforeHandler)
	})
	if settleErr == nil {
		t.Fatal("Expected settlement_pending error from a deliberately forced confirmation failure, got nil error")
	}
	var se *x402.SettleError
	if !errors.As(settleErr, &se) {
		t.Fatalf("Expected a *x402.SettleError, got %T: %v", settleErr, settleErr)
	}
	if se.ErrorReason != uptosvmfacilitator.ErrSettlementPending {
		t.Fatalf("Expected errorReason %q, got %q (%v)", uptosvmfacilitator.ErrSettlementPending, se.ErrorReason, se)
	}
	if se.Transaction == "" {
		t.Fatal("Expected a broadcast transaction signature on the settlement_pending error")
	}
	firstSignature := se.Transaction

	// Attempt 2: identical deposit payload, confirmation no longer forced to
	// fail. Must reconcile against firstSignature (pending-store hit) rather
	// than re-validating and re-opening the channel.
	facilitatorSigner.forcePending.Store(false)

	settleResponse, settleErr := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
		return stack.server.SettlePaymentWithExtensions(ctx, payload, *accepted, nil, nil, x402.SettlePhaseBeforeHandler)
	})
	if settleErr != nil {
		t.Fatalf("Expected the reconciliation settle to succeed once the original open tx confirms, got error: %v", settleErr)
	}
	if !settleResponse.Success {
		t.Fatalf("Expected reconciled deposit settlement to succeed, got: %+v", settleResponse)
	}
	if settleResponse.Transaction != firstSignature {
		t.Fatalf("Reconciliation must reuse the already-broadcast open transaction (channel can only be opened once): first=%s second=%s",
			firstSignature, settleResponse.Transaction)
	}
}

// TestSVMIntegrationV2Upto_ClaimSettlementPendingReconciliation exercises the
// settlement-pending-auto-recovery mechanism layer against a real on-chain
// SVM upto claim (distribute): after a normal, successful deposit opens the
// channel, the claim settle broadcasts the voucher-authorized distribute for
// real but is forced (via forcedPendingConfirmSigner) to fail
// ConfirmTransaction, producing a settlement_pending SettleError with the
// broadcast signature attached and a PendingSettlementStore entry populated
// (keyed on the channel's settlement, distinct from the deposit's open key —
// see TestDepositCacheDoesNotBlockTheLaterClaim). A second settle with the
// identical payload, now with confirmation no longer forced to fail, must
// hit the pending-store fast path (skip re-validate/re-broadcast — signing
// and submitting a second distribute for an already-distributed channel
// would otherwise fail) and reconcile against that already-broadcast claim —
// succeeding once it actually confirms on-chain, with the SAME signature as
// the first attempt, proving the channel was only ever distributed once.
func TestSVMIntegrationV2Upto_ClaimSettlementPendingReconciliation(t *testing.T) {
	ctx := context.Background()
	stack, facilitatorSigner := newUptoSvmStackWithForcedPendingSigner(t, ctx)

	// Deposit normally (confirmation not forced to fail) so the channel is
	// genuinely open before the claim step under test.
	payload, requirements, before := stack.openChannel(t, ctx, "$0.001")

	// Attempt 1: the distribute broadcast is real; confirmation is forced to
	// fail regardless of real devnet confirmation speed.
	facilitatorSigner.forcePending.Store(true)

	_, settleErr := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
		return stack.server.SettlePaymentWithExtensions(ctx, payload, requirements, nil, nil, x402.SettlePhaseAfterHandler)
	})
	if settleErr == nil {
		t.Fatal("Expected settlement_pending error from a deliberately forced confirmation failure, got nil error")
	}
	var se *x402.SettleError
	if !errors.As(settleErr, &se) {
		t.Fatalf("Expected a *x402.SettleError, got %T: %v", settleErr, settleErr)
	}
	if se.ErrorReason != uptosvmfacilitator.ErrSettlementPending {
		t.Fatalf("Expected errorReason %q, got %q (%v)", uptosvmfacilitator.ErrSettlementPending, se.ErrorReason, se)
	}
	if se.Transaction == "" {
		t.Fatal("Expected a broadcast transaction signature on the settlement_pending error")
	}
	firstSignature := se.Transaction

	// Attempt 2: identical claim payload, confirmation no longer forced to
	// fail. Must reconcile against firstSignature (pending-store hit) rather
	// than re-signing and re-submitting the distribute.
	facilitatorSigner.forcePending.Store(false)

	settleResponse, settleErr := retryWhileRateLimited(ctx, func() (*x402.SettleResponse, error) {
		return stack.server.SettlePaymentWithExtensions(ctx, payload, requirements, nil, nil, x402.SettlePhaseAfterHandler)
	})
	if settleErr != nil {
		t.Fatalf("Expected the reconciliation settle to succeed once the original distribute tx confirms, got error: %v", settleErr)
	}
	if !settleResponse.Success {
		t.Fatalf("Expected reconciled claim settlement to succeed, got: %+v", settleResponse)
	}
	if settleResponse.Transaction != firstSignature {
		t.Fatalf("Reconciliation must reuse the already-broadcast distribute transaction (channel can only be distributed once): first=%s second=%s",
			firstSignature, settleResponse.Transaction)
	}
	if channel := fetchChannel(t, ctx, payload); channel.Status != paymentchannels.StatusDistributed {
		t.Errorf("Expected a distributed channel, got %s", channel.Status)
	}
	charged, err := strconv.ParseUint(requirements.Amount, 10, 64)
	if err != nil {
		t.Fatalf("Failed to parse the authorized amount: %v", err)
	}
	stack.assertSettled(t, ctx, requirements, before, charged)
}
