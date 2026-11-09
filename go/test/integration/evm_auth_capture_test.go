// This file tests the EVM auth-capture mechanism end to end with REAL Base Sepolia
// transactions: the client signs a collect payload, the facilitator (escrow operator)
// authorizes it before the handler runs, and the resource server's signed Capture or
// Void releases the escrowed funds. Tests skip when the env vars below are missing.
//
// Required env vars (shared with the other EVM integration tests):
//   - EVM_CLIENT_PRIVATE_KEY, EVM_FACILITATOR_PRIVATE_KEY, EVM_RESOURCE_SERVER_ADDRESS
//
// Optional: EVM_RPC_URL (defaults to https://sepolia.base.org).
package integration_test

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	nethttpmw "github.com/x402-foundation/x402/go/v2/http/nethttp"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	authcaptureclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/client"
	authcapturefacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
	authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

const authCaptureAmount = 1000

// permit2AllowanceFloor is the allowance we top up to; Permit2 transfers draw it down.
var permit2AllowanceFloor = new(big.Int).Lsh(big.NewInt(1), 128)

type authCapturePipeline struct {
	keys         *batchedTestKeys
	clientSigner evm.ClientEvmSigner
	facilitator  *realFacilitatorEvmSigner
	x402Client   *x402.X402Client
	x402Server   *x402.X402ResourceServer
}

func buildAuthCapturePipeline(t *testing.T, keys *batchedTestKeys) *authCapturePipeline {
	t.Helper()

	clientSigner, err := evmsigners.NewClientSignerFromPrivateKey(keys.clientPK)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	facilitatorSigner, err := newRealFacilitatorEvmSigner(keys.facilitatorPK, keys.rpcURL)
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}
	receiverAuthorizerKey := newEphemeralPrivateKeyHex(t)
	receiverAuthorizer, err := evmsigners.NewClientSignerFromPrivateKey(receiverAuthorizerKey)
	if err != nil {
		t.Fatalf("receiver authorizer signer: %v", err)
	}

	x402Client := x402.Newx402Client()
	x402Client.Register(batchedTestNetwork, authcaptureclient.NewAuthCaptureEvmScheme(clientSigner))

	x402Facilitator := x402.Newx402Facilitator()
	x402Facilitator.Register([]x402.Network{batchedTestNetwork}, authcapturefacilitator.NewAuthCaptureEvmScheme(
		facilitatorSigner,
		authcapturefacilitator.AuthCaptureEvmSchemeConfig{CaptureAuthorizer: facilitatorSigner.GetAddresses()[0]},
	))

	x402Server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(&localEvmFacilitatorClient{facilitator: x402Facilitator}))
	x402Server.Register(batchedTestNetwork, authcaptureserver.NewAuthCaptureEvmScheme(&authcaptureserver.Config{
		ReceiverAuthorizerSigner: receiverAuthorizer,
	}))
	if err := x402Server.Initialize(context.Background()); err != nil {
		t.Fatalf("server initialize: %v", err)
	}

	return &authCapturePipeline{
		keys:         keys,
		clientSigner: clientSigner,
		facilitator:  facilitatorSigner,
		x402Client:   x402Client,
		x402Server:   x402Server,
	}
}

func newEphemeralPrivateKeyHex(t *testing.T) string {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return hex.EncodeToString(crypto.FromECDSA(key))
}

// serve starts the paid endpoint. handlerStatus is what the handler returns once the payment is
// authorized; the counter records how many times the handler ran.
func (p *authCapturePipeline) serve(transferMethod evm.AssetTransferMethod, handlerStatus int) (*httptest.Server, *atomic.Int32) {
	handlerCalls := &atomic.Int32{}
	var price interface{} = "$0.001"
	if transferMethod == evm.AssetTransferMethodPermit2 {
		price = map[string]interface{}{
			"amount": "1000",
			"asset":  batchedTestUSDC,
			"extra": map[string]interface{}{
				"assetTransferMethod": string(evm.AssetTransferMethodPermit2),
				"name":                "USDC",
				"version":             "2",
			},
		}
	}

	routes := x402http.RoutesConfig{
		"GET /paid": {
			Accepts: x402http.PaymentOptions{{
				Scheme:            authcapture.SchemeAuthCapture,
				Price:             price,
				Network:           batchedTestNetwork,
				PayTo:             p.keys.receiver,
				MaxTimeoutSeconds: 300,
			}},
			Description: "auth-capture integration test",
			MimeType:    "application/json",
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /paid", func(w http.ResponseWriter, _ *http.Request) {
		handlerCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(handlerStatus)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "done"})
	})

	handler := nethttpmw.PaymentMiddlewareFromHTTPServer(
		x402http.Wrappedx402HTTPResourceServer(routes, p.x402Server),
		nethttpmw.WithTimeout(90*time.Second),
		nethttpmw.WithSyncFacilitatorOnStart(false),
	)(mux)
	return httptest.NewServer(handler), handlerCalls
}

// get performs the paid request and returns the status, headers and body with the body already read.
func (p *authCapturePipeline) get(t *testing.T, url string) (int, http.Header, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()

	httpClient := x402http.WrapHTTPClientWithPayment(&http.Client{}, x402http.Newx402HTTPClient(p.x402Client))
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("HTTP request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, body
}

func (p *authCapturePipeline) balance(t *testing.T, holder string) *big.Int {
	t.Helper()
	out, err := p.facilitator.ReadContract(context.Background(), batchedTestUSDC, evm.ERC20BalanceOfABI, "balanceOf", common.HexToAddress(holder))
	if err != nil {
		t.Fatalf("balanceOf(%s): %v", holder, err)
	}
	balance, ok := out.(*big.Int)
	if !ok {
		t.Fatalf("unexpected balanceOf result type %T", out)
	}
	return balance
}

// waitForBalance polls until holder's balance equals want, since the RPC can trail the receipt.
func (p *authCapturePipeline) waitForBalance(t *testing.T, holder string, want *big.Int) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	for {
		if got := p.balance(t, holder); got.Cmp(want) == 0 {
			return
		} else if time.Now().After(deadline) {
			t.Fatalf("balance of %s = %s, want %s", holder, got, want)
		}
		time.Sleep(2 * time.Second)
	}
}

func decodeSettleHeader(t *testing.T, headers http.Header) x402.SettleResponse {
	t.Helper()
	header := headers.Get("PAYMENT-RESPONSE")
	if header == "" {
		t.Fatal("expected PAYMENT-RESPONSE header")
	}
	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		t.Fatalf("decode PAYMENT-RESPONSE: %v", err)
	}
	var settle x402.SettleResponse
	if err := json.Unmarshal(raw, &settle); err != nil {
		t.Fatalf("unmarshal PAYMENT-RESPONSE: %v", err)
	}
	return settle
}

func (p *authCapturePipeline) prepare(t *testing.T, transferMethod evm.AssetTransferMethod) {
	t.Helper()
	ctx := context.Background()
	waitForPendingTransactions(t, ctx, p.keys.facilitatorPK, p.keys.rpcURL)
	if transferMethod == evm.AssetTransferMethodPermit2 {
		setPermit2Allowance(t, ctx, p.keys.clientPK, batchedTestUSDC, p.keys.rpcURL, permit2AllowanceFloor)
	}
}

// revokePermit2AfterTest leaves the payer without a Permit2 allowance, the state the other EVM
// integration tests assume when they exercise the EIP-2612 gas-sponsoring path.
func revokePermit2AfterTest(t *testing.T, keys *batchedTestKeys) {
	t.Helper()
	t.Cleanup(func() {
		revokePermit2Approval(t, context.Background(), keys.clientPK, batchedTestUSDC, keys.rpcURL)
	})
}

func authCaptureTransferMethods() []evm.AssetTransferMethod {
	return []evm.AssetTransferMethod{evm.AssetTransferMethodEIP3009, evm.AssetTransferMethodPermit2}
}

func TestAuthCaptureIntegration_AuthorizeThenCapture(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	revokePermit2AfterTest(t, keys)
	if strings.EqualFold(keys.receiver, mustAddressOf(t, keys.clientPK)) {
		t.Skip("EVM_RESOURCE_SERVER_ADDRESS must differ from the payer to observe the capture")
	}

	for _, method := range authCaptureTransferMethods() {
		t.Run(string(method), func(t *testing.T) {
			pipe := buildAuthCapturePipeline(t, keys)
			pipe.prepare(t, method)
			srv, handlerCalls := pipe.serve(method, http.StatusOK)
			defer srv.Close()

			payer := pipe.clientSigner.Address()
			payerBefore := pipe.balance(t, payer)
			receiverBefore := pipe.balance(t, keys.receiver)

			status, header, body := pipe.get(t, srv.URL+"/paid")
			if status != http.StatusOK {
				t.Fatalf("expected 200 after payment, got %d: %s", status, body)
			}
			if got := handlerCalls.Load(); got != 1 {
				t.Fatalf("handler ran %d times, want 1", got)
			}
			settle := decodeSettleHeader(t, header)
			if !settle.Success || settle.Transaction == "" {
				t.Fatalf("expected successful capture settlement, got %+v", settle)
			}
			if !strings.EqualFold(settle.Payer, payer) {
				t.Fatalf("settlement payer = %s, want %s", settle.Payer, payer)
			}
			t.Logf("captured, tx=%s", settle.Transaction)

			amount := big.NewInt(authCaptureAmount)
			pipe.waitForBalance(t, payer, new(big.Int).Sub(payerBefore, amount))
			pipe.waitForBalance(t, keys.receiver, new(big.Int).Add(receiverBefore, amount))
		})
	}
}

func TestAuthCaptureIntegration_VoidOnHandlerFailure(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	revokePermit2AfterTest(t, keys)
	if strings.EqualFold(keys.receiver, mustAddressOf(t, keys.clientPK)) {
		t.Skip("EVM_RESOURCE_SERVER_ADDRESS must differ from the payer to observe the void")
	}

	for _, method := range authCaptureTransferMethods() {
		t.Run(string(method), func(t *testing.T) {
			pipe := buildAuthCapturePipeline(t, keys)
			pipe.prepare(t, method)
			srv, handlerCalls := pipe.serve(method, http.StatusInternalServerError)
			defer srv.Close()

			payer := pipe.clientSigner.Address()
			payerBefore := pipe.balance(t, payer)
			receiverBefore := pipe.balance(t, keys.receiver)

			status, _, _ := pipe.get(t, srv.URL+"/paid")
			if status == http.StatusOK {
				t.Fatalf("expected a failure status when the handler fails, got %d", status)
			}

			if got := handlerCalls.Load(); got != 1 {
				t.Fatalf("handler ran %d times, want 1 (payment must be authorized before the handler)", got)
			}

			// The escrow hold is voided back to the payer; the receiver is never paid.
			pipe.waitForBalance(t, payer, payerBefore)
			if got := pipe.balance(t, keys.receiver); got.Cmp(receiverBefore) != 0 {
				t.Fatalf("receiver balance changed on void: %s -> %s", receiverBefore, got)
			}
		})
	}
}

func mustAddressOf(t *testing.T, privateKeyHex string) string {
	t.Helper()
	signer, err := evmsigners.NewClientSignerFromPrivateKey(privateKeyHex)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	return signer.Address()
}
