// Package integration_test contains integration tests for the x402 Go SDK.
// This file specifically tests the SVM (Solana) mechanism integration with both V1 and V2 implementations.
// These tests make REAL on-chain transactions using private keys from environment variables.
package integration_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm"
	svmclient "github.com/x402-foundation/x402/go/mechanisms/svm/exact/client"
	svmfacilitator "github.com/x402-foundation/x402/go/mechanisms/svm/exact/facilitator"
	svmserver "github.com/x402-foundation/x402/go/mechanisms/svm/exact/server"
	svmsigners "github.com/x402-foundation/x402/go/signers/svm"
	"github.com/x402-foundation/x402/go/types"
)

// newRealClientSvmSigner creates a client signer using the helper
func newRealClientSvmSigner(privateKeyBase58 string) (svm.ClientSvmSigner, error) {
	return svmsigners.NewClientSignerFromPrivateKey(privateKeyBase58)
}

// Real Solana facilitator signer
type realFacilitatorSvmSigner struct {
	privateKey solana.PrivateKey
	rpcClients map[string]*rpc.Client
	rpcURL     string
}

func newRealFacilitatorSvmSigner(privateKeyBase58 string, rpcURL string) (*realFacilitatorSvmSigner, error) {
	privateKey, err := solana.PrivateKeyFromBase58(privateKeyBase58)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	return &realFacilitatorSvmSigner{
		privateKey: privateKey,
		rpcClients: make(map[string]*rpc.Client),
		rpcURL:     rpcURL,
	}, nil
}

// getRPC is a private helper method to get RPC client for a network
func (s *realFacilitatorSvmSigner) getRPC(_ context.Context, network string) (*rpc.Client, error) {
	// Return cached RPC client if exists
	if client, ok := s.rpcClients[network]; ok {
		return client, nil
	}

	// Create new RPC client
	// Use custom RPC URL if provided, otherwise use network default
	rpcURL := s.rpcURL
	if rpcURL == "" {
		config, err := svm.GetNetworkConfig(network)
		if err != nil {
			return nil, err
		}
		rpcURL = config.RPCURL
	}

	client := rpc.New(rpcURL)
	s.rpcClients[network] = client
	return client, nil
}

func (s *realFacilitatorSvmSigner) SignTransaction(ctx context.Context, tx *solana.Transaction, feePayer solana.PublicKey, network string) error {
	// Verify feePayer matches our key
	if feePayer != s.privateKey.PublicKey() {
		return fmt.Errorf("no signer for feePayer %s. Available: %s", feePayer, s.privateKey.PublicKey())
	}

	// Partially sign - only sign for facilitator key, client has already signed

	// Get the message bytes to sign
	messageBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	// Sign the message
	signature, err := s.privateKey.Sign(messageBytes)
	if err != nil {
		return fmt.Errorf("failed to sign: %w", err)
	}

	// Find the index of facilitator's public key in the account keys
	accountIndex, err := tx.GetAccountIndex(s.privateKey.PublicKey())
	if err != nil {
		return fmt.Errorf("failed to get account index: %w", err)
	}

	// Ensure signatures array is large enough
	if len(tx.Signatures) <= int(accountIndex) {
		newSignatures := make([]solana.Signature, accountIndex+1)
		copy(newSignatures, tx.Signatures)
		tx.Signatures = newSignatures
	}

	// Add facilitator signature at the correct index
	tx.Signatures[accountIndex] = signature

	return nil
}

func (s *realFacilitatorSvmSigner) SimulateTransaction(ctx context.Context, tx *solana.Transaction, network string) error {
	rpcClient, err := s.getRPC(ctx, network)
	if err != nil {
		return err
	}

	opts := rpc.SimulateTransactionOpts{
		SigVerify:              true,
		ReplaceRecentBlockhash: false,
		Commitment:             svm.DefaultCommitment,
	}

	simResult, err := rpcClient.SimulateTransactionWithOpts(ctx, tx, &opts)
	if err != nil {
		return fmt.Errorf("simulation failed: %w", err)
	}

	if simResult != nil && simResult.Value != nil && simResult.Value.Err != nil {
		return fmt.Errorf("simulation failed: transaction would fail on-chain")
	}

	return nil
}

func (s *realFacilitatorSvmSigner) SendTransaction(ctx context.Context, tx *solana.Transaction, network string) (solana.Signature, error) {
	rpcClient, err := s.getRPC(ctx, network)
	if err != nil {
		return solana.Signature{}, err
	}

	// Send transaction with skip preflight (we already simulated)
	sig, err := rpcClient.SendTransactionWithOpts(ctx, tx, rpc.TransactionOpts{
		SkipPreflight:       true,
		PreflightCommitment: svm.DefaultCommitment,
	})
	if err != nil {
		return solana.Signature{}, fmt.Errorf("failed to send transaction: %w", err)
	}

	return sig, nil
}

func (s *realFacilitatorSvmSigner) ConfirmTransaction(ctx context.Context, signature solana.Signature, network string) error {
	rpcClient, err := s.getRPC(ctx, network)
	if err != nil {
		return err
	}

	// Wait for confirmation with retries
	for attempt := 0; attempt < svm.MaxConfirmAttempts; attempt++ {
		// Check for context cancellation
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Try getSignatureStatuses first (faster)
		statuses, err := rpcClient.GetSignatureStatuses(ctx, true, signature)
		if err == nil && statuses != nil && statuses.Value != nil && len(statuses.Value) > 0 {
			status := statuses.Value[0]
			if status != nil {
				if status.Err != nil {
					return fmt.Errorf("transaction failed on-chain")
				}
				if status.ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
					status.ConfirmationStatus == rpc.ConfirmationStatusFinalized {
					return nil
				}
			}
		}

		// Fallback to getTransaction
		if err != nil {
			txResult, txErr := rpcClient.GetTransaction(ctx, signature, &rpc.GetTransactionOpts{
				Encoding:   solana.EncodingBase58,
				Commitment: svm.DefaultCommitment,
			})

			if txErr == nil && txResult != nil && txResult.Meta != nil {
				if txResult.Meta.Err != nil {
					return fmt.Errorf("transaction failed on-chain")
				}
				return nil
			}
		}

		// Wait before retrying
		time.Sleep(svm.ConfirmRetryDelay)
	}

	return fmt.Errorf("transaction confirmation timed out after %d attempts", svm.MaxConfirmAttempts)
}

func (s *realFacilitatorSvmSigner) GetAddresses(ctx context.Context, network string) []solana.PublicKey {
	return []solana.PublicKey{s.privateKey.PublicKey()}
}

// Local facilitator client for testing with extra fields support
type localSvmFacilitatorClient struct {
	facilitator *x402.X402Facilitator
	signer      *realFacilitatorSvmSigner
}

func (l *localSvmFacilitatorClient) Verify(
	ctx context.Context,
	payloadBytes []byte,
	requirementsBytes []byte,
) (*x402.VerifyResponse, error) {
	// Pass bytes directly to facilitator (it handles unmarshaling internally)
	return l.facilitator.Verify(ctx, payloadBytes, requirementsBytes)
}

func (l *localSvmFacilitatorClient) Settle(
	ctx context.Context,
	payloadBytes []byte,
	requirementsBytes []byte,
) (*x402.SettleResponse, error) {
	// Pass bytes directly to facilitator (it handles unmarshaling internally)
	return l.facilitator.Settle(ctx, payloadBytes, requirementsBytes)
}

func (l *localSvmFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	// Networks already registered - no parameters needed
	// GetExtra() on the SVM facilitator will automatically add feePayer
	return l.facilitator.GetSupported(), nil
}

// TestSVMIntegrationV2 tests the full V2 SVM payment flow with real on-chain transactions
func TestSVMIntegrationV2(t *testing.T) {
	// Skip if environment variables not set
	clientPrivateKey := os.Getenv("SVM_CLIENT_PRIVATE_KEY")
	facilitatorPrivateKey := os.Getenv("SVM_FACILITATOR_PRIVATE_KEY")
	facilitatorAddress := os.Getenv("SVM_FACILITATOR_ADDRESS")
	resourceServerAddress := os.Getenv("SVM_RESOURCE_SERVER_ADDRESS")

	if clientPrivateKey == "" || facilitatorPrivateKey == "" || facilitatorAddress == "" || resourceServerAddress == "" {
		t.Skip("Skipping SVM integration test: SVM_CLIENT_PRIVATE_KEY, SVM_FACILITATOR_PRIVATE_KEY, SVM_FACILITATOR_ADDRESS, and SVM_RESOURCE_SERVER_ADDRESS must be set")
	}

	t.Run("SVM V2 Flow - x402Client / x402ResourceServer / x402Facilitator", func(t *testing.T) {
		ctx := context.Background()

		// Create real client signer
		clientSigner, err := newRealClientSvmSigner(clientPrivateKey)
		if err != nil {
			t.Fatalf("Failed to create client signer: %v", err)
		}

		// Setup client with SVM v2 scheme
		client := x402.Newx402Client()
		svmClient := svmclient.NewExactSvmScheme(clientSigner, &svm.ClientConfig{
			RPCURL: "https://api.devnet.solana.com",
		})
		// Register for Solana Devnet
		client.Register(svm.SolanaDevnetCAIP2, svmClient)

		// Create real facilitator signer
		facilitatorSigner, err := newRealFacilitatorSvmSigner(facilitatorPrivateKey, "https://api.devnet.solana.com")
		if err != nil {
			t.Fatalf("Failed to create facilitator signer: %v", err)
		}

		// Setup facilitator with SVM v2 scheme
		facilitator := x402.Newx402Facilitator()
		svmFacilitator := svmfacilitator.NewExactSvmScheme(facilitatorSigner)
		// Register for Solana Devnet
		facilitator.Register([]x402.Network{svm.SolanaDevnetCAIP2}, svmFacilitator)

		// Create facilitator client wrapper (adds feePayer via GetSupported override)
		facilitatorClient := &localSvmFacilitatorClient{
			facilitator: facilitator,
			signer:      facilitatorSigner,
		}

		// Setup resource server with SVM v2
		svmServer := svmserver.NewExactSvmScheme()
		server := x402.Newx402ResourceServer(
			x402.WithFacilitatorClient(facilitatorClient),
		)
		server.Register(svm.SolanaDevnetCAIP2, svmServer)

		// Initialize server to fetch supported kinds
		err = server.Initialize(ctx)
		if err != nil {
			t.Fatalf("Failed to initialize server: %v", err)
		}

		// Server - builds PaymentRequired response for 0.001 USDC (V2 typed)
		accepts := []types.PaymentRequirements{
			{
				Scheme:  svm.SchemeExact,
				Network: svm.SolanaDevnetCAIP2,
				Asset:   svm.USDCDevnetAddress,
				Amount:  "1000", // 0.001 USDC in smallest unit (6 decimals)
				PayTo:   resourceServerAddress,
				Extra: map[string]interface{}{
					"feePayer": facilitatorAddress,
				},
			},
		}
		resource := &types.ResourceInfo{
			URL:         "https://api.example.com/premium",
			Description: "Premium API Access",
			MimeType:    "application/json",
		}
		paymentRequiredResponse := server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

		// Verify it's V2
		if paymentRequiredResponse.X402Version != 2 {
			t.Errorf("Expected X402Version 2, got %d", paymentRequiredResponse.X402Version)
		}

		// Verify feePayer is in requirements
		if len(paymentRequiredResponse.Accepts) == 0 {
			t.Fatal("Expected at least one payment requirement")
		}

		firstAccept := paymentRequiredResponse.Accepts[0]
		if firstAccept.Extra == nil || firstAccept.Extra["feePayer"] == nil {
			t.Fatal("Expected feePayer in payment requirements extra")
		}

		// Client - selects payment requirement (V2 typed)
		selected, err := client.SelectPaymentRequirements(paymentRequiredResponse.Accepts)
		if err != nil {
			t.Fatalf("Failed to select payment requirements: %v", err)
		}

		// Client - creates payment payload (V2 typed)
		paymentPayload, err := client.CreatePaymentPayload(ctx, selected, paymentRequiredResponse.Resource, paymentRequiredResponse.Extensions)
		if err != nil {
			t.Fatalf("Failed to create payment payload: %v", err)
		}

		// Verify payload is V2
		if paymentPayload.X402Version != 2 {
			t.Errorf("Expected payload X402Version 2, got %d", paymentPayload.X402Version)
		}

		// Verify payload structure
		if paymentPayload.Accepted.Scheme != svm.SchemeExact {
			t.Errorf("Expected scheme %s, got %s", svm.SchemeExact, paymentPayload.Accepted.Scheme)
		}

		svmPayload, err := svm.PayloadFromMap(paymentPayload.Payload)
		if err != nil {
			t.Fatalf("Failed to parse SVM payload: %v", err)
		}

		if svmPayload.Transaction == "" {
			t.Error("Expected transaction in payload")
		}

		// Server - finds matching requirements (typed)
		accepted := server.FindMatchingRequirements(accepts, paymentPayload)
		if accepted == nil {
			t.Fatal("No matching payment requirements found")
		}

		// Server - verifies payment (typed)
		verifyResponse, err := server.VerifyPayment(ctx, paymentPayload, *accepted)
		if err != nil {
			t.Fatalf("Failed to verify payment: %v", err)
		}

		if !verifyResponse.IsValid {
			t.Fatalf("Payment verification failed: %s", verifyResponse.InvalidReason)
		}

		if verifyResponse.Payer != clientSigner.Address().String() {
			t.Errorf("Expected payer %s, got %s", clientSigner.Address().String(), verifyResponse.Payer)
		}

		// Server does work here...

		// Server - settles payment (REAL ON-CHAIN TRANSACTION, typed)
		settleResponse, err := server.SettlePayment(ctx, paymentPayload, *accepted, nil)
		if err != nil {
			t.Fatalf("Failed to settle payment: %v", err)
		}

		if !settleResponse.Success {
			t.Fatalf("Payment settlement failed: %s", settleResponse.ErrorReason)
		}

		// Verify the transaction signature
		if settleResponse.Transaction == "" {
			t.Error("Expected transaction signature in settlement response")
		}

		if settleResponse.Network != svm.SolanaDevnetCAIP2 {
			t.Errorf("Expected network %s, got %s", svm.SolanaDevnetCAIP2, settleResponse.Network)
		}

		if settleResponse.Payer != clientSigner.Address().String() {
			t.Errorf("Expected payer %s, got %s", clientSigner.Address().String(), settleResponse.Payer)
		}
	})
}

// TestSVMIntegrationV1 tests the full V1 SVM payment flow with real on-chain transactions (legacy)
// TestSVMIntegrationV1 - SKIPPED: V1 flow not supported in V2-only server
/*
func TestSVMIntegrationV1(t *testing.T) {
	// Skip if environment variables not set
	clientPrivateKey := os.Getenv("SVM_CLIENT_PRIVATE_KEY")
	facilitatorPrivateKey := os.Getenv("SVM_FACILITATOR_PRIVATE_KEY")
	facilitatorAddress := os.Getenv("SVM_FACILITATOR_ADDRESS")
	resourceServerAddress := os.Getenv("SVM_RESOURCE_SERVER_ADDRESS")

	if clientPrivateKey == "" || facilitatorPrivateKey == "" || facilitatorAddress == "" || resourceServerAddress == "" {
		t.Skip("Skipping SVM V1 integration test: SVM_CLIENT_PRIVATE_KEY, SVM_FACILITATOR_PRIVATE_KEY, SVM_FACILITATOR_ADDRESS, and SVM_RESOURCE_SERVER_ADDRESS must be set")
	}

	t.Run("SVM V1 Flow (Legacy) - x402Client / x402ResourceServer / x402Facilitator", func(t *testing.T) {
		ctx := context.Background()

		// Create real client signer
		clientSigner, err := newRealClientSvmSigner(clientPrivateKey)
		if err != nil {
			t.Fatalf("Failed to create client signer: %v", err)
		}

		// Setup client with SVM v1 scheme
		client := x402.Newx402Client()
		svmClient := svmv1client.NewExactSvmSchemeV1(clientSigner, &svm.ClientConfig{
			RPCURL: "https://api.devnet.solana.com",
		})
		// Register for Solana Devnet (V1 uses simple name)
		client.RegisterV1(svm.SolanaDevnetV1, svmClient)

		// Create real facilitator signer
		facilitatorSigner, err := newRealFacilitatorSvmSigner(facilitatorPrivateKey, "https://api.devnet.solana.com")
		if err != nil {
			t.Fatalf("Failed to create facilitator signer: %v", err)
		}

		// Setup facilitator with SVM v1 scheme
		facilitator := x402.Newx402Facilitator()
		svmFacilitator := svmv1facilitator.NewExactSvmSchemeV1(facilitatorSigner)
		// Register for Solana Devnet
		facilitator.RegisterV1([]x402.Network{svm.SolanaDevnetV1}, svmFacilitator)

		// Create facilitator client wrapper (adds feePayer via GetSupported override)
		facilitatorClient := &localSvmFacilitatorClient{
			facilitator: facilitator,
			signer:      facilitatorSigner,
		}

		// Setup resource server with SVM v2 (server is V2 only)
		svmServer := svmserver.NewExactSvmScheme()
		server := x402.Newx402ResourceServer(
			x402.WithFacilitatorClient(facilitatorClient),
		)
		// Register for CAIP-2 network (server uses V2 format)
		server.Register(svm.SolanaDevnetCAIP2, svmServer)

		// Initialize server to fetch supported kinds
		err = server.Initialize(ctx)
		if err != nil {
			t.Fatalf("Failed to initialize server: %v", err)
		}

		// Server - builds PaymentRequired response for 0.001 USDC (V1 uses version 1)
		accepts := []x402.PaymentRequirements{
			{
				Scheme:            svm.SchemeExact,
				Network:           svm.SolanaDevnetV1, // V1 network name
				Asset:             svm.USDCDevnetAddress,
				MaxAmountRequired: "1000", // V1 uses MaxAmountRequired, not Amount
				PayTo:             resourceServerAddress,
				Extra: map[string]interface{}{
					"feePayer": facilitatorAddress,
				},
			},
		}
		resource := x402.ResourceInfo{
			URL:         "https://legacy.example.com/api",
			Description: "Legacy API Access",
			MimeType:    "application/json",
		}

		// For V1, we need to explicitly set the version to 1
		paymentRequiredResponse := x402.PaymentRequired{
			X402Version: 1, // V1 uses version 1
			Accepts:     accepts,
			Resource:    &resource,
		}

		// Client - responds with PaymentPayload response
		selected, err := client.SelectPaymentRequirements(paymentRequiredResponse.X402Version, accepts)
		if err != nil {
			t.Fatalf("Failed to select payment requirements: %v", err)
		}

		// Marshal selected requirements to bytes
		selectedBytes, err := json.Marshal(selected)
		if err != nil {
			t.Fatalf("Failed to marshal requirements: %v", err)
		}

		// V1 doesn't use resource/extensions from PaymentRequired
		payloadBytes, err := client.CreatePaymentPayload(ctx, paymentRequiredResponse.X402Version, selectedBytes, nil, nil)
		if err != nil {
			t.Fatalf("Failed to create payment payload: %v", err)
		}

		// Unmarshal to v1 payload for verification
		paymentPayload, err := types.ToPaymentPayloadV1(payloadBytes)
		if err != nil {
			t.Fatalf("Failed to unmarshal payment payload: %v", err)
		}

		// Verify payload is V1
		if paymentPayload.X402Version != 1 {
			t.Errorf("Expected payload X402Version 1, got %d", paymentPayload.X402Version)
		}

		// Server - maps payment payload to payment requirements
		accepted := server.FindMatchingRequirements(accepts, payloadBytes)
		if accepted == nil {
			t.Fatal("No matching payment requirements found")
		}

		// Marshal accepted requirements to bytes
		acceptedBytes, err := json.Marshal(accepted)
		if err != nil {
			t.Fatalf("Failed to marshal accepted requirements: %v", err)
		}

		// Server - verifies payment
		verifyResponse, err := server.VerifyPayment(ctx, payloadBytes, acceptedBytes)
		if err != nil {
			t.Fatalf("Failed to verify payment: %v", err)
		}

		if !verifyResponse.IsValid {
			t.Fatalf("Payment verification failed: %s", verifyResponse.InvalidReason)
		}

		if verifyResponse.Payer != clientSigner.Address().String() {
			t.Errorf("Expected payer %s, got %s", clientSigner.Address().String(), verifyResponse.Payer)
		}

		// Server does work here...

		// Server - settles payment (REAL ON-CHAIN TRANSACTION)
		settleResponse, err := server.SettlePayment(ctx, payloadBytes, acceptedBytes)
		if err != nil {
			t.Fatalf("Failed to settle payment: %v", err)
		}

		if !settleResponse.Success {
			t.Fatalf("Payment settlement failed: %s", settleResponse.ErrorReason)
		}

		// Verify the transaction signature
		if settleResponse.Transaction == "" {
			t.Error("Expected transaction signature in settlement response")
		}
	})
}
*/
