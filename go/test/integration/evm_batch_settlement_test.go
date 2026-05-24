// Package integration_test contains integration tests for the x402 Go SDK.
// This file specifically tests the EVM batch-settlement (batched) mechanism with
// REAL on-chain transactions on Base Sepolia using private keys from environment
// variables. Tests skip automatically when required env vars are missing.
//
// Required env vars:
//   - EVM_CLIENT_PRIVATE_KEY        — payer key (must hold USDC + ETH on Base Sepolia)
//   - EVM_FACILITATOR_PRIVATE_KEY   — facilitator key (must hold ETH on Base Sepolia)
//   - EVM_RESOURCE_SERVER_ADDRESS          — receiver/payee address
//
// Optional:
//   - EVM_AUTHORIZER_PRIVATE_KEY    — receiver-authorizer key (defaults to facilitator key)
//   - EVM_RPC_URL                   — RPC endpoint (defaults to https://sepolia.base.org)
package integration_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	nethttpmw "github.com/x402-foundation/x402/go/http/nethttp"
	evmmech "github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	batchedclient "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement/client"
	batchedfacilitator "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement/facilitator"
	batchedserver "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement/server"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
	"github.com/x402-foundation/x402/go/types"
)

const (
	batchedTestNetwork    = x402.Network("eip155:84532")
	batchedTestUSDC       = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	batchedTestRPCDefault = "https://sepolia.base.org"
)

// batchedTestKeys holds the parsed env-var keys for a batched integration test run.
type batchedTestKeys struct {
	clientPK      string
	facilitatorPK string
	authorizerPK  string
	receiver      string
	rpcURL        string
}

// loadBatchedTestKeys reads required env vars or returns nil and skips the test.
func loadBatchedTestKeys(t *testing.T) *batchedTestKeys {
	t.Helper()
	clientPK := os.Getenv("EVM_CLIENT_PRIVATE_KEY")
	facilitatorPK := os.Getenv("EVM_FACILITATOR_PRIVATE_KEY")
	receiver := os.Getenv("EVM_RESOURCE_SERVER_ADDRESS")
	if clientPK == "" || facilitatorPK == "" || receiver == "" {
		t.Skip("Skipping batched integration test: set EVM_CLIENT_PRIVATE_KEY, EVM_FACILITATOR_PRIVATE_KEY, EVM_RESOURCE_SERVER_ADDRESS")
	}
	authorizerPK := os.Getenv("EVM_AUTHORIZER_PRIVATE_KEY")
	if authorizerPK == "" {
		authorizerPK = facilitatorPK
	}
	rpcURL := os.Getenv("EVM_RPC_URL")
	if rpcURL == "" {
		rpcURL = batchedTestRPCDefault
	}
	return &batchedTestKeys{
		clientPK:      clientPK,
		facilitatorPK: facilitatorPK,
		authorizerPK:  authorizerPK,
		receiver:      receiver,
		rpcURL:        rpcURL,
	}
}

// batchedAuthorizerSigner implements both batchedserver.AuthorizerSigner (for the
// server scheme; SignTypedData) and batchsettlement.AuthorizerSigner (for the facilitator
// scheme; SignClaimBatch + SignRefund), backed by a single ECDSA key.
type batchedAuthorizerSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
}

func newBatchedAuthorizerSigner(privateKeyHex string) (*batchedAuthorizerSigner, error) {
	pk, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("parse authorizer key: %w", err)
	}
	return &batchedAuthorizerSigner{
		privateKey: pk,
		address:    crypto.PubkeyToAddress(pk.PublicKey),
	}, nil
}

func (s *batchedAuthorizerSigner) Address() string { return s.address.Hex() }

func (s *batchedAuthorizerSigner) SignTypedData(
	_ context.Context,
	domain evmmech.TypedDataDomain,
	allTypes map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	td := buildBatchedTypedData(domain, allTypes, primaryType, message)
	return s.signEIP712(td)
}

func (s *batchedAuthorizerSigner) SignClaimBatch(
	_ context.Context,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
) ([]byte, error) {
	chainId, err := evmmech.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}
	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)
	allTypes := map[string][]evmmech.TypedDataField{
		"ClaimBatch": batchsettlement.ClaimBatchTypes["ClaimBatch"],
		"ClaimEntry": batchsettlement.ClaimBatchTypes["ClaimEntry"],
	}
	entries := make([]map[string]interface{}, len(claims))
	for i, claim := range claims {
		channelId, _ := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		channelIdBytes, _ := evmmech.HexToBytes(channelId)
		maxClaimable, _ := new(big.Int).SetString(claim.Voucher.MaxClaimableAmount, 10)
		totalClaimed, _ := new(big.Int).SetString(claim.TotalClaimed, 10)
		entries[i] = map[string]interface{}{
			"channelId":          channelIdBytes,
			"maxClaimableAmount": maxClaimable,
			"totalClaimed":       totalClaimed,
		}
	}
	td := buildBatchedTypedData(domain, allTypes, "ClaimBatch", map[string]interface{}{"claims": entries})
	return s.signEIP712(td)
}

func (s *batchedAuthorizerSigner) SignRefund(
	_ context.Context,
	channelId, amount, nonce, network string,
) ([]byte, error) {
	chainId, err := evmmech.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}
	channelIdBytes, err := evmmech.HexToBytes(channelId)
	if err != nil {
		return nil, err
	}
	amt, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid refund amount %q", amount)
	}
	non, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid refund nonce %q", nonce)
	}
	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)
	allTypes := map[string][]evmmech.TypedDataField{"Refund": batchsettlement.RefundTypes["Refund"]}
	td := buildBatchedTypedData(domain, allTypes, "Refund", map[string]interface{}{
		"channelId": channelIdBytes,
		"nonce":     non,
		"amount":    amt,
	})
	return s.signEIP712(td)
}

func (s *batchedAuthorizerSigner) signEIP712(td apitypes.TypedData) ([]byte, error) {
	dataHash, err := td.HashStruct(td.PrimaryType, td.Message)
	if err != nil {
		return nil, fmt.Errorf("hash struct: %w", err)
	}
	domainSep, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		return nil, fmt.Errorf("hash domain: %w", err)
	}
	digest := crypto.Keccak256(append([]byte{0x19, 0x01}, append(domainSep, dataHash...)...))
	sig, err := crypto.Sign(digest, s.privateKey)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}
	sig[64] += 27
	return sig, nil
}

func buildBatchedTypedData(
	domain evmmech.TypedDataDomain,
	allTypes map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
) apitypes.TypedData {
	td := apitypes.TypedData{
		Types:       apitypes.Types{},
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              domain.Name,
			Version:           domain.Version,
			ChainId:           (*math.HexOrDecimal256)(domain.ChainID),
			VerifyingContract: domain.VerifyingContract,
		},
		Message: message,
	}
	for name, fields := range allTypes {
		conv := make([]apitypes.Type, len(fields))
		for i, f := range fields {
			conv[i] = apitypes.Type{Name: f.Name, Type: f.Type}
		}
		td.Types[name] = conv
	}
	td.Types["EIP712Domain"] = []apitypes.Type{
		{Name: "name", Type: "string"},
		{Name: "version", Type: "string"},
		{Name: "chainId", Type: "uint256"},
		{Name: "verifyingContract", Type: "address"},
	}
	return td
}

// batchedPipeline holds the wired client/server/facilitator + helpers for one test run.
type batchedPipeline struct {
	clientScheme      *batchedclient.BatchSettlementEvmScheme
	serverScheme      *batchedserver.BatchSettlementEvmScheme
	facilitatorScheme *batchedfacilitator.BatchSettlementEvmScheme
	x402Client        *x402.X402Client
	x402Server        *x402.X402ResourceServer
	x402Facilitator   *x402.X402Facilitator
	facilitatorClient x402.FacilitatorClient
	facilitatorSigner *realFacilitatorEvmSigner
	authorizerSigner  *batchedAuthorizerSigner
	clientSigner      evmmech.ClientEvmSigner
	clientAddress     string
	receiverAddress   string
	channelSalt       string
}

// buildBatchedPipeline wires up a complete batched pipeline for the given keys
// and a fresh random channel salt (so each test gets an isolated channel).
func buildBatchedPipeline(t *testing.T, keys *batchedTestKeys) *batchedPipeline {
	t.Helper()

	// The refund flow needs to read on-chain channel state via the client signer,
	// so build the signer with an ethclient bound to the test RPC URL.
	clientEthClient, err := ethclient.Dial(keys.rpcURL)
	if err != nil {
		t.Fatalf("dial client RPC: %v", err)
	}
	clientSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(keys.clientPK, clientEthClient)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	facilitatorSigner, err := newRealFacilitatorEvmSigner(keys.facilitatorPK, keys.rpcURL)
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}
	authorizerSigner, err := newBatchedAuthorizerSigner(keys.authorizerPK)
	if err != nil {
		t.Fatalf("authorizer signer: %v", err)
	}

	salt := randomChannelSalt(t)

	clientScheme := batchedclient.NewBatchSettlementEvmScheme(clientSigner, &batchedclient.BatchSettlementEvmSchemeOptions{
		DepositMultiplier: 5,
		Salt:              salt,
	})
	x402Client := x402.Newx402Client()
	x402Client.Register(batchedTestNetwork, clientScheme)

	facilitatorScheme := batchedfacilitator.NewBatchSettlementEvmScheme(facilitatorSigner, authorizerSigner)
	x402Facilitator := x402.Newx402Facilitator()
	x402Facilitator.Register([]x402.Network{batchedTestNetwork}, facilitatorScheme)
	facClient := &localEvmFacilitatorClient{facilitator: x402Facilitator}

	serverScheme := batchedserver.NewBatchSettlementEvmScheme(keys.receiver, &batchedserver.BatchSettlementEvmSchemeServerConfig{
		ReceiverAuthorizerSigner: authorizerSigner,
	})
	x402Server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facClient))
	// Register auto-wires scheme-provided lifecycle hooks (BeforeVerify, AfterVerify,
	// BeforeSettle, AfterSettle, OnVerifiedPaymentCanceled) — no manual On*(...) calls
	// needed; mirrors TS schemeHooks auto-registration.
	x402Server.Register(batchedTestNetwork, serverScheme)

	if err := x402Server.Initialize(context.Background()); err != nil {
		t.Fatalf("server initialize: %v", err)
	}

	return &batchedPipeline{
		clientScheme:      clientScheme,
		serverScheme:      serverScheme,
		facilitatorScheme: facilitatorScheme,
		x402Client:        x402Client,
		x402Server:        x402Server,
		x402Facilitator:   x402Facilitator,
		facilitatorClient: facClient,
		facilitatorSigner: facilitatorSigner,
		authorizerSigner:  authorizerSigner,
		clientSigner:      clientSigner,
		clientAddress:     clientSigner.Address(),
		receiverAddress:   keys.receiver,
		channelSalt:       salt,
	}
}

// randomChannelSalt generates a fresh 32-byte salt so each test owns an isolated channel.
func randomChannelSalt(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("random salt: %v", err)
	}
	return "0x" + hex.EncodeToString(b)
}

// batchedRequirements builds payment requirements for a batched payment.
func (p *batchedPipeline) requirements(amount string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            batchsettlement.SchemeBatched,
		Network:           string(batchedTestNetwork),
		Asset:             batchedTestUSDC,
		Amount:            amount,
		PayTo:             p.receiverAddress,
		MaxTimeoutSeconds: 3600,
		Extra: map[string]interface{}{
			"name":                "USDC",
			"version":             "2",
			"assetTransferMethod": "eip3009",
			"receiverAuthorizer":  p.authorizerSigner.Address(),
		},
	}
}

// onChainChannel reads (balance, totalClaimed) from the BatchSettlement contract.
func onChainChannel(ctx context.Context, signer *realFacilitatorEvmSigner, channelId string) (*big.Int, *big.Int, error) {
	channelIdBytes := common.HexToHash(channelId)
	result, err := signer.ReadContract(ctx, batchsettlement.BatchSettlementAddress, batchsettlement.BatchSettlementChannelsABI, "channels", channelIdBytes)
	if err != nil {
		return nil, nil, err
	}
	results, ok := result.([]interface{})
	if !ok || len(results) < 2 {
		return nil, nil, fmt.Errorf("unexpected channels() result: %v", result)
	}
	balance, _ := results[0].(*big.Int)
	claimed, _ := results[1].(*big.Int)
	if balance == nil {
		balance = big.NewInt(0)
	}
	if claimed == nil {
		claimed = big.NewInt(0)
	}
	return balance, claimed, nil
}

// assertChannelHasBalance reads the channel state once and fails if balance is not positive.
// The facilitator's settle path already waits for the deposit receipt, so the contract state
// is up to date by the time this is called — no polling needed.
func assertChannelHasBalance(ctx context.Context, t *testing.T, signer *realFacilitatorEvmSigner, channelId string) {
	t.Helper()
	balance, _, err := onChainChannel(ctx, signer, channelId)
	if err != nil {
		t.Fatalf("read channel %s: %v", channelId, err)
	}
	if balance == nil || balance.Sign() <= 0 {
		t.Fatalf("expected channel %s to have nonzero balance, got %v", channelId, balance)
	}
}

// assertTotalClaimedAtLeast polls totalClaimed briefly. Even though the facilitator
// waits for the claim receipt before returning, public Base Sepolia RPCs can lag a
// few hundred milliseconds behind the canonical chain head — the call we just made
// to confirm the receipt may have hit a node that hasn't ingested the block yet.
// Retry for up to 3 s with a short backoff.
func assertTotalClaimedAtLeast(ctx context.Context, t *testing.T, signer *realFacilitatorEvmSigner, channelId string, expected *big.Int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var claimed *big.Int
	for {
		var err error
		_, claimed, err = onChainChannel(ctx, signer, channelId)
		if err == nil && claimed != nil && claimed.Cmp(expected) >= 0 {
			return
		}
		if time.Now().After(deadline) {
			if err != nil {
				t.Fatalf("read channel %s: %v", channelId, err)
			}
			t.Fatalf("expected channel %s totalClaimed >= %s, got %v", channelId, expected, claimed)
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// channelIdForRequirements computes the channel ID the client will derive for these requirements.
func (p *batchedPipeline) channelIdForRequirements(req types.PaymentRequirements) string {
	cfg, err := p.clientScheme.BuildChannelConfig(req)
	if err != nil {
		return ""
	}
	id, err := batchsettlement.ComputeChannelId(cfg, req.Network)
	if err != nil {
		return ""
	}
	return batchsettlement.NormalizeChannelId(id)
}

// resourceInfo returns a stub resource descriptor for createPaymentPayload.
func batchedResourceInfo() *types.ResourceInfo {
	return &types.ResourceInfo{
		URL:         "https://example.com/api/batched-test",
		Description: "Batched integration test resource",
		MimeType:    "application/json",
	}
}

// ----------------------------------------------------------------------------
// Scenario 1: deposit + voucher follow-up via direct API
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_DepositThenVoucher(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	accepts := []types.PaymentRequirements{pipe.requirements("1000")}
	resource := batchedResourceInfo()

	prr := pipe.x402Server.CreatePaymentRequiredResponse(accepts, resource, "", nil)
	if prr.X402Version != 2 {
		t.Fatalf("expected X402Version 2, got %d", prr.X402Version)
	}

	firstPayload, err := pipe.x402Client.CreatePaymentPayload(ctx, accepts[0], resource, prr.Extensions)
	if err != nil {
		t.Fatalf("first createPaymentPayload: %v", err)
	}
	if firstPayload.Accepted.Scheme != batchsettlement.SchemeBatched {
		t.Fatalf("expected scheme %s, got %s", batchsettlement.SchemeBatched, firstPayload.Accepted.Scheme)
	}
	if pType, _ := firstPayload.Payload["type"].(string); pType != "deposit" {
		t.Fatalf("expected first payload type=deposit, got %v", firstPayload.Payload["type"])
	}

	accepted := pipe.x402Server.FindMatchingRequirements(accepts, firstPayload)
	if accepted == nil {
		t.Fatal("no matching requirements")
	}

	verify, err := pipe.x402Server.VerifyPayment(ctx, firstPayload, *accepted)
	if err != nil {
		t.Fatalf("verify deposit: %v", err)
	}
	if !verify.IsValid {
		t.Fatalf("deposit verify failed: %s", verify.InvalidReason)
	}
	if !strings.EqualFold(verify.Payer, pipe.clientAddress) {
		t.Fatalf("expected payer %s, got %s", pipe.clientAddress, verify.Payer)
	}

	settle, err := pipe.x402Server.SettlePayment(ctx, firstPayload, *accepted, nil)
	if err != nil {
		t.Fatalf("settle deposit: %v", err)
	}
	if !settle.Success {
		t.Fatalf("deposit settle failed: %s — %s", settle.ErrorReason, settle.ErrorMessage)
	}
	if settle.Transaction == "" {
		t.Fatal("expected deposit transaction hash")
	}
	t.Logf("deposit settled, tx=%s", settle.Transaction)

	channelId := pipe.channelIdForRequirements(accepts[0])
	if channelId == "" {
		t.Fatal("could not derive channel ID")
	}
	assertChannelHasBalance(ctx, t, pipe.facilitatorSigner, channelId)

	// Mirror the TS flow: feed the settle response back so the client can update local state.
	if err := pipe.clientScheme.ProcessSettleResponse(asMap(settle.Extra)); err != nil {
		t.Fatalf("processSettleResponse: %v", err)
	}

	// Second request — pure voucher (no chain tx).
	secondPayload, err := pipe.x402Client.CreatePaymentPayload(ctx, accepts[0], resource, prr.Extensions)
	if err != nil {
		t.Fatalf("second createPaymentPayload: %v", err)
	}
	if pType, _ := secondPayload.Payload["type"].(string); pType != "voucher" {
		t.Fatalf("expected second payload type=voucher, got %v", secondPayload.Payload["type"])
	}

	accepted2 := pipe.x402Server.FindMatchingRequirements(accepts, secondPayload)
	verify2, err := pipe.x402Server.VerifyPayment(ctx, secondPayload, *accepted2)
	if err != nil {
		t.Fatalf("verify voucher: %v", err)
	}
	if !verify2.IsValid {
		t.Fatalf("voucher verify failed: %s", verify2.InvalidReason)
	}
	settle2, err := pipe.x402Server.SettlePayment(ctx, secondPayload, *accepted2, nil)
	if err != nil {
		t.Fatalf("settle voucher: %v", err)
	}
	if !settle2.Success {
		t.Fatalf("voucher settle failed: %s — %s", settle2.ErrorReason, settle2.ErrorMessage)
	}
	// Voucher path should NOT produce a chain tx — settlement is off-chain.
	if settle2.Transaction != "" {
		t.Logf("voucher settle returned tx=%s (unexpected for off-chain voucher path; non-fatal)", settle2.Transaction)
	}
}

// asMap converts a *Extra-like value (map or interface) to map[string]interface{}.
func asMap(v interface{}) map[string]interface{} {
	if v == nil {
		return nil
	}
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return nil
}

// ----------------------------------------------------------------------------
// Scenario 2: deposit + voucher via HTTP middleware end-to-end
// ----------------------------------------------------------------------------

// startBatchedHTTPServer wires a real httptest.Server with the batched scheme
// and returns the URL + a shutdown func. Reuses the pipeline's facilitator
// scheme directly (no remote facilitator round-trip).
func startBatchedHTTPServer(t *testing.T, pipe *batchedPipeline, route string, price string) (string, func()) {
	t.Helper()

	routes := x402http.RoutesConfig{
		"GET " + route: {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  batchsettlement.SchemeBatched,
					Price:   price,
					Network: batchedTestNetwork,
					PayTo:   pipe.receiverAddress,
					Extra: map[string]interface{}{
						"name":                "USDC",
						"version":             "2",
						"assetTransferMethod": "eip3009",
						"receiverAuthorizer":  pipe.authorizerSigner.Address(),
					},
				},
			},
			Description: "batched HTTP integration test",
			MimeType:    "application/json",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET "+route, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// Use the pipeline's pre-built x402Server so the BatchSettlementEvmScheme hooks
	// (AfterVerify SkipHandler for refunds, BeforeSettle voucher accumulation /
	// refund-payload rewrite) are wired into the middleware. X402Payment(Config)
	// would create a fresh server with no hooks and break the refund flow.
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, pipe.x402Server)
	handler := nethttpmw.PaymentMiddlewareFromHTTPServer(httpServer,
		nethttpmw.WithTimeout(60*time.Second),
		nethttpmw.WithSyncFacilitatorOnStart(false),
	)(mux)

	srv := httptest.NewServer(handler)
	return srv.URL + route, srv.Close
}

func TestBatchSettlementIntegration_HTTPMiddleware(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	url, shutdown := startBatchedHTTPServer(t, pipe, "/api/test", "$0.001")
	defer shutdown()

	httpClient := x402http.WrapHTTPClientWithPayment(&http.Client{}, x402http.Newx402HTTPClient(pipe.x402Client))

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("HTTP request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 after payment, got %d: %s", resp.StatusCode, string(body))
	}

	settleHeader := resp.Header.Get("PAYMENT-RESPONSE")
	if settleHeader == "" {
		t.Fatal("expected PAYMENT-RESPONSE header on success")
	}
	decoded, err := base64.StdEncoding.DecodeString(settleHeader)
	if err != nil {
		t.Fatalf("decode PAYMENT-RESPONSE: %v", err)
	}
	var settle x402.SettleResponse
	if err := json.Unmarshal(decoded, &settle); err != nil {
		t.Fatalf("unmarshal settle: %v", err)
	}
	if !settle.Success {
		t.Fatalf("settle failed: %s — %s", settle.ErrorReason, settle.ErrorMessage)
	}
	if settle.Transaction == "" {
		t.Fatal("expected deposit transaction hash on first request")
	}
	t.Logf("HTTP deposit settled, tx=%s", settle.Transaction)

	// Second request — should use a voucher (no chain tx).
	req2, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp2, err := httpClient.Do(req2)
	if err != nil {
		t.Fatalf("HTTP request 2: %v", err)
	}
	defer resp2.Body.Close()
	_, _ = io.ReadAll(resp2.Body)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on voucher request, got %d", resp2.StatusCode)
	}
}

// ----------------------------------------------------------------------------
// Scenario 3: multi-voucher session + manual claim+settle through facilitator
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_MultiVoucherClaimSettle(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	accepts := []types.PaymentRequirements{pipe.requirements("500")}
	resource := batchedResourceInfo()
	_ = pipe.x402Server.CreatePaymentRequiredResponse(accepts, resource, "", nil)

	channelId := pipe.channelIdForRequirements(accepts[0])

	// 1st request: deposit
	depositPayload, err := pipe.x402Client.CreatePaymentPayload(ctx, accepts[0], resource, nil)
	if err != nil {
		t.Fatalf("deposit createPaymentPayload: %v", err)
	}
	depositMatch := pipe.x402Server.FindMatchingRequirements(accepts, depositPayload)
	if v, err := pipe.x402Server.VerifyPayment(ctx, depositPayload, *depositMatch); err != nil || !v.IsValid {
		t.Fatalf("deposit verify: %v / %v", err, v)
	}
	depositSettle, err := pipe.x402Server.SettlePayment(ctx, depositPayload, *depositMatch, nil)
	if err != nil || !depositSettle.Success {
		t.Fatalf("deposit settle: %v / %+v", err, depositSettle)
	}
	assertChannelHasBalance(ctx, t, pipe.facilitatorSigner, channelId)
	_ = pipe.clientScheme.ProcessSettleResponse(asMap(depositSettle.Extra))

	// Vouchers 2..4 (no chain tx — accumulates session.signedMaxClaimable).
	for i := 0; i < 3; i++ {
		voucher, err := pipe.x402Client.CreatePaymentPayload(ctx, accepts[0], resource, nil)
		if err != nil {
			t.Fatalf("voucher %d: %v", i, err)
		}
		match := pipe.x402Server.FindMatchingRequirements(accepts, voucher)
		v, err := pipe.x402Server.VerifyPayment(ctx, voucher, *match)
		if err != nil || !v.IsValid {
			t.Fatalf("voucher %d verify: %v / %v", i, err, v)
		}
		s, err := pipe.x402Server.SettlePayment(ctx, voucher, *match, nil)
		if err != nil || !s.Success {
			t.Fatalf("voucher %d settle: %v / %+v", i, err, s)
		}
		_ = pipe.clientScheme.ProcessSettleResponse(asMap(s.Extra))
	}

	// Now manually trigger a claim through the channel manager.
	manager := pipe.serverScheme.CreateChannelManager(pipe.facilitatorClient, batchedTestNetwork)
	claims, err := manager.GetClaimableVouchers(nil)
	if err != nil {
		t.Fatalf("GetClaimableVouchers: %v", err)
	}
	if len(claims) != 1 {
		t.Fatalf("expected 1 claim entry, got %d", len(claims))
	}
	results, err := manager.Claim(ctx, &batchedserver.ClaimOptions{MaxClaimsPerBatch: 50})
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if len(results) == 0 || results[0].Transaction == "" {
		t.Fatalf("expected claim transaction, got %+v (claims=%d)", results, len(claims))
	}
	t.Logf("claim tx=%s vouchers=%d", results[0].Transaction, results[0].Vouchers)

	// Wait for on-chain totalClaimed to reflect the vouchers.
	expectedClaimed := new(big.Int).SetInt64(2000) // 4 requests * 500
	assertTotalClaimedAtLeast(ctx, t, pipe.facilitatorSigner, channelId, expectedClaimed)

	// Settle (transfer claimed funds to receiver).
	settleResult, err := manager.Settle(ctx)
	if err != nil {
		t.Fatalf("manager.Settle: %v", err)
	}
	if settleResult == nil || settleResult.Transaction == "" {
		t.Fatal("expected settle transaction")
	}
	t.Logf("settle tx=%s", settleResult.Transaction)
}

// ----------------------------------------------------------------------------
// Refund helpers (used by scenarios 4-7)
// ----------------------------------------------------------------------------

// makePaidRequest issues a single payment-aware GET against url and asserts 200.
// Returns the decoded settle response (from the PAYMENT-RESPONSE header) for tests
// that want to inspect the deposit/voucher tx.
func makePaidRequest(ctx context.Context, t *testing.T, pipe *batchedPipeline, url string) *x402.SettleResponse {
	t.Helper()
	httpClient := x402http.WrapHTTPClientWithPayment(&http.Client{}, x402http.Newx402HTTPClient(pipe.x402Client))
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("paid request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from paid request, got %d: %s", resp.StatusCode, string(body))
	}
	header := resp.Header.Get("PAYMENT-RESPONSE")
	if header == "" {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		t.Fatalf("decode PAYMENT-RESPONSE: %v", err)
	}
	var settle x402.SettleResponse
	if err := json.Unmarshal(decoded, &settle); err != nil {
		t.Fatalf("unmarshal settle: %v", err)
	}
	// PaymentRoundTripper now auto-dispatches the scheme's OnPaymentResponse hook
	// after each paid retry, so local session state is folded back without a
	// manual ProcessSettleResponse call (mirrors TS @x402/fetch behavior).
	return &settle
}

// ----------------------------------------------------------------------------
// Scenario 4: cooperative partial refund — channel stays open, balance drops
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_RefundPartial(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	// Per-request 500, default DepositMultiplier=5 from buildBatchedPipeline → deposit=2500.
	url, shutdown := startBatchedHTTPServer(t, pipe, "/api/refund-partial", "$0.0005")
	defer shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	depositSettle := makePaidRequest(ctx, t, pipe, url)
	if depositSettle == nil || depositSettle.Transaction == "" {
		t.Fatal("expected deposit transaction on first request")
	}
	t.Logf("deposit tx=%s", depositSettle.Transaction)

	// Confirm the channel is funded on chain.
	channelId := pipe.channelIdForRequirements(pipe.requirements("500"))
	assertChannelHasBalance(ctx, t, pipe.facilitatorSigner, channelId)

	balanceBefore, _, err := onChainChannel(ctx, pipe.facilitatorSigner, channelId)
	if err != nil {
		t.Fatalf("read pre-refund balance: %v", err)
	}

	// Partial refund — request 1000 of the remaining balance back.
	refundResp, err := pipe.clientScheme.Refund(ctx, url, &batchedclient.RefundOptions{Amount: "1000"})
	if err != nil {
		t.Fatalf("partial refund: %v", err)
	}
	if !refundResp.Success {
		t.Fatalf("partial refund failed: %s — %s", refundResp.ErrorReason, refundResp.ErrorMessage)
	}
	if refundResp.Transaction == "" {
		t.Fatal("expected refund transaction hash")
	}
	t.Logf("refund tx=%s", refundResp.Transaction)

	// Public Base Sepolia RPCs occasionally lag a few hundred ms behind the
	// canonical chain head, so poll briefly for the post-refund balance to land.
	expected := new(big.Int).Sub(balanceBefore, big.NewInt(1000))
	deadline := time.Now().Add(3 * time.Second)
	var balanceAfter *big.Int
	for {
		balanceAfter, _, err = onChainChannel(ctx, pipe.facilitatorSigner, channelId)
		if err == nil && balanceAfter != nil && balanceAfter.Cmp(expected) == 0 {
			break
		}
		if time.Now().After(deadline) {
			if err != nil {
				t.Fatalf("read channel after refund: %v", err)
			}
			t.Fatalf("on-chain balance after partial refund: got %s, want %s (before=%s)", balanceAfter, expected, balanceBefore)
		}
		time.Sleep(150 * time.Millisecond)
	}

	// Local session must still exist (partial refund leaves the channel open).
	if !pipe.clientScheme.HasSession(channelId) {
		t.Fatal("expected local session to survive partial refund")
	}
}

// ----------------------------------------------------------------------------
// Scenario 5: drained channel — local short-circuit prevents network round-trip
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_RefundDrainedChannelShortCircuit(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	url, shutdown := startBatchedHTTPServer(t, pipe, "/api/refund-drained", "$0.0005")
	defer shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// Deposit via the first paid request.
	depositSettle := makePaidRequest(ctx, t, pipe, url)
	if depositSettle == nil || depositSettle.Transaction == "" {
		t.Fatal("expected deposit tx on first request")
	}

	// Issue a full refund first to drain the channel locally + on chain.
	full, err := pipe.clientScheme.Refund(ctx, url, nil)
	if err != nil {
		t.Fatalf("full refund: %v", err)
	}
	if !full.Success {
		t.Fatalf("full refund failed: %s — %s", full.ErrorReason, full.ErrorMessage)
	}
	t.Logf("full refund tx=%s", full.Transaction)

	// A second refund should short-circuit locally with "no remaining balance"
	// — no HTTP call, no chain interaction.
	_, err = pipe.clientScheme.Refund(ctx, url, nil)
	if err == nil {
		t.Fatal("expected refund on drained channel to error locally")
	}
	if !strings.Contains(err.Error(), "no remaining balance") {
		t.Fatalf("expected drained-channel short-circuit, got: %v", err)
	}
}

// ----------------------------------------------------------------------------
// Scenario 6: non-recoverable refund error — fast fail, no retry
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_RefundNonRecoverableFastFail(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	url, shutdown := startBatchedHTTPServer(t, pipe, "/api/refund-exceeds", "$0.0005")
	defer shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	depositSettle := makePaidRequest(ctx, t, pipe, url)
	if depositSettle == nil || depositSettle.Transaction == "" {
		t.Fatal("expected deposit tx on first request")
	}

	// Request a refund larger than the on-chain remainder.
	// Server returns 402 with PAYMENT-REQUIRED Error=invalid_batch_settlement_evm_refund_amount_exceeds_balance.
	// Client must fail fast (non-recoverable error) without retry.
	start := time.Now()
	_, err := pipe.clientScheme.Refund(ctx, url, &batchedclient.RefundOptions{Amount: "999999999"})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected non-recoverable refund error")
	}
	if !strings.Contains(err.Error(), batchsettlement.ErrRefundAmountExceedsBalance) {
		t.Fatalf("expected non-recoverable error code, got: %v", err)
	}
	t.Logf("fast-failed in %s with: %v", elapsed, err)
}

// ----------------------------------------------------------------------------
// Scenario 7: recoverable refund error — retry budget exhausted
// ----------------------------------------------------------------------------

// alwaysStaleRefundHandler serves a payment-required probe (so the client can
// build a refund payload) and then always responds to PAYMENT-SIGNATURE with a
// recoverable 402 (ErrCumulativeAmountMismatch). Used to exercise the client's
// retry-exhaustion path.
func alwaysStaleRefundHandler(t *testing.T, pipe *batchedPipeline, price string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		req := pipe.requirements(price)

		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Accepts:     []types.PaymentRequirements{req},
		}
		if r.Header.Get("PAYMENT-SIGNATURE") != "" {
			paymentRequired.Error = batchsettlement.ErrCumulativeAmountMismatch
		}

		bytes, _ := json.Marshal(paymentRequired)
		w.Header().Set("PAYMENT-REQUIRED", base64.StdEncoding.EncodeToString(bytes))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write(bytes)
	}
}

// ----------------------------------------------------------------------------
// Scenario 8: tick claim phase — auto-claim fires after ClaimIntervalSecs
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_AutoClaimTick(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	url, shutdown := startBatchedHTTPServer(t, pipe, "/api/auto-claim", "$0.0003")
	defer shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	// Seed channel: deposit + 2 vouchers so signedMaxClaimable > totalClaimed.
	if d := makePaidRequest(ctx, t, pipe, url); d == nil || d.Transaction == "" {
		t.Fatal("deposit tx missing")
	}
	for i := 0; i < 2; i++ {
		_ = makePaidRequest(ctx, t, pipe, url)
	}

	channelId := pipe.channelIdForRequirements(pipe.requirements("300"))
	assertChannelHasBalance(ctx, t, pipe.facilitatorSigner, channelId)

	manager := pipe.serverScheme.CreateChannelManager(pipe.facilitatorClient, batchedTestNetwork)

	claimCh := make(chan batchedserver.ClaimResult, 4)
	errCh := make(chan error, 4)
	manager.Start(batchedserver.AutoSettlementConfig{
		ClaimIntervalSecs: 2,
		MaxClaimsPerBatch: 50,
		OnClaim:           func(r batchedserver.ClaimResult) { claimCh <- r },
		OnError:           func(err error) { errCh <- err },
	})
	defer func() { _ = manager.Stop(context.Background(), nil) }()

	select {
	case r := <-claimCh:
		if r.Transaction == "" {
			t.Fatal("OnClaim fired with empty tx hash")
		}
		t.Logf("auto-claim tx=%s vouchers=%d", r.Transaction, r.Vouchers)
	case err := <-errCh:
		t.Fatalf("auto-claim emitted error: %v", err)
	case <-time.After(45 * time.Second):
		t.Fatal("timed out waiting for auto-claim tick")
	}

	// On-chain totalClaimed should have advanced.
	expected := big.NewInt(900) // 3 requests * 300
	assertTotalClaimedAtLeast(ctx, t, pipe.facilitatorSigner, channelId, expected)
}

// ----------------------------------------------------------------------------
// Scenario 9: tick settle phase — claim then settle on interval triggers
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_AutoClaimAndSettleTick(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	url, shutdown := startBatchedHTTPServer(t, pipe, "/api/auto-settle", "$0.0003")
	defer shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()

	if d := makePaidRequest(ctx, t, pipe, url); d == nil || d.Transaction == "" {
		t.Fatal("deposit tx missing")
	}
	for i := 0; i < 2; i++ {
		_ = makePaidRequest(ctx, t, pipe, url)
	}

	channelId := pipe.channelIdForRequirements(pipe.requirements("300"))
	assertChannelHasBalance(ctx, t, pipe.facilitatorSigner, channelId)

	manager := pipe.serverScheme.CreateChannelManager(pipe.facilitatorClient, batchedTestNetwork)

	claimCh := make(chan batchedserver.ClaimResult, 4)
	settleCh := make(chan batchedserver.SettleResult, 4)
	errCh := make(chan error, 4)
	manager.Start(batchedserver.AutoSettlementConfig{
		ClaimIntervalSecs:  2,
		SettleIntervalSecs: 2,
		OnClaim:            func(r batchedserver.ClaimResult) { claimCh <- r },
		OnSettle:           func(r batchedserver.SettleResult) { settleCh <- r },
		OnError:            func(err error) { errCh <- err },
	})
	defer func() { _ = manager.Stop(context.Background(), nil) }()

	// Wait for claim first.
	select {
	case r := <-claimCh:
		t.Logf("auto-claim tx=%s vouchers=%d", r.Transaction, r.Vouchers)
	case err := <-errCh:
		t.Fatalf("auto-claim error: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("timed out waiting for auto-claim")
	}

	// Then wait for the settle phase to trigger on a subsequent tick.
	select {
	case r := <-settleCh:
		if r.Transaction == "" {
			t.Fatal("OnSettle fired with empty tx hash")
		}
		t.Logf("auto-settle tx=%s", r.Transaction)
	case err := <-errCh:
		t.Fatalf("auto-settle error: %v", err)
	case <-time.After(60 * time.Second):
		t.Fatal("timed out waiting for auto-settle")
	}
}

// ----------------------------------------------------------------------------
// Scenario 10: withdrawal-pending detection + manager refund flow
// ----------------------------------------------------------------------------

func TestBatchSettlementIntegration_WithdrawalPendingRefund(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	url, shutdown := startBatchedHTTPServer(t, pipe, "/api/withdraw-pending", "$0.0004")
	defer shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	// Deposit + 1 voucher so the session has signedMaxClaimable + remainder.
	if d := makePaidRequest(ctx, t, pipe, url); d == nil || d.Transaction == "" {
		t.Fatal("deposit tx missing")
	}
	_ = makePaidRequest(ctx, t, pipe, url)

	channelId := pipe.channelIdForRequirements(pipe.requirements("400"))
	assertChannelHasBalance(ctx, t, pipe.facilitatorSigner, channelId)

	// Simulate an on-chain withdrawal-initiation by stamping the local session's
	// WithdrawRequestedAt field — this is what the deposit hook would do after
	// the payer called BatchSettlement.initiateWithdraw on chain. Real on-chain
	// initiateWithdraw would also work, but it requires payer-side chain writes
	// (out of scope for the helpers exposed in test/integration/).
	storage := pipe.serverScheme.GetStorage()
	session, err := storage.Get(channelId)
	if err != nil || session == nil {
		t.Fatalf("expected session for channel %s: %v", channelId, err)
	}
	session.WithdrawRequestedAt = int(time.Now().Unix())
	if err := storage.Set(channelId, session); err != nil {
		t.Fatalf("update session: %v", err)
	}

	manager := pipe.serverScheme.CreateChannelManager(pipe.facilitatorClient, batchedTestNetwork)

	pending, err := manager.GetWithdrawalPendingSessions()
	if err != nil {
		t.Fatalf("GetWithdrawalPendingSessions: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("expected 1 withdrawal-pending session, got %d", len(pending))
	}
	if !strings.EqualFold(batchsettlement.NormalizeChannelId(pending[0].ChannelId), channelId) {
		t.Fatalf("expected channel %s, got %s", channelId, pending[0].ChannelId)
	}

	// Manager-driven cooperative refund — claims the outstanding voucher and
	// refunds the unclaimed remainder. Produces a real onchain tx.
	results, err := manager.Refund(ctx, []string{channelId})
	if err != nil {
		t.Fatalf("manager.Refund: %v", err)
	}
	if len(results) != 1 || results[0].Transaction == "" {
		t.Fatalf("expected 1 refund result with tx hash, got %+v", results)
	}
	t.Logf("manager refund tx=%s channel=%s", results[0].Transaction, results[0].Channel)

	// Session should be deleted post-refund.
	post, _ := storage.Get(channelId)
	if post != nil {
		t.Fatalf("expected session deleted after refund, still present: %+v", post)
	}
}

func TestBatchSettlementIntegration_RefundRecoverableRetryExhaustion(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildBatchedPipeline(t, keys)

	// Real HTTP server for the deposit (so we have a real on-chain channel to recover from).
	depositURL, depositShutdown := startBatchedHTTPServer(t, pipe, "/api/refund-retry", "$0.0005")
	defer depositShutdown()

	depositSettle := makePaidRequest(context.Background(), t, pipe, depositURL)
	if depositSettle == nil || depositSettle.Transaction == "" {
		t.Fatal("expected deposit tx")
	}
	channelId := pipe.channelIdForRequirements(pipe.requirements("500"))
	assertChannelHasBalance(context.Background(), t, pipe.facilitatorSigner, channelId)

	// Mock URL that always returns the recoverable 402 on signed requests.
	mock := httptest.NewServer(alwaysStaleRefundHandler(t, pipe, "500"))
	defer mock.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	_, err := pipe.clientScheme.Refund(ctx, mock.URL+"/api/refund-retry", nil)
	if err == nil {
		t.Fatal("expected refund to fail after retry exhaustion")
	}
	// The client should retry once and then bail out with "after 2 attempt(s)".
	if !strings.Contains(err.Error(), "after 2 attempt(s)") {
		t.Fatalf("expected retry-exhaustion error, got: %v", err)
	}
	t.Logf("retry exhaustion observed: %v", err)
}
