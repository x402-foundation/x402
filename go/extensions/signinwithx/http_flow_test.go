package signinwithx

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/types"
)

// The fixture uses real HTTP processing and local SIWE verification. The only
// fake payment component is the inert facilitator; no RPC or money is involved.
type siwxFlowScheme struct{}

func (*siwxFlowScheme) Scheme() string                     { return "exact" }
func (*siwxFlowScheme) DefaultAssetTransferMethod() string { return x402.SDKDefaultAssetTransferMethod }
func (*siwxFlowScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	return map[string]x402.PaymentFlowConfig{x402.SDKDefaultAssetTransferMethod: {
		Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization, x402.PaymentFlowUpfront, x402.PaymentFlowEscrow},
		Default:   x402.PaymentFlowAuthorization,
	}}
}
func (*siwxFlowScheme) ParsePrice(price x402.Price, _ x402.Network) (x402.AssetAmount, error) {
	return x402.AssetAmount{Asset: "USDC", Amount: fmt.Sprint(price)}, nil
}
func (*siwxFlowScheme) EnhancePaymentRequirements(_ context.Context, base types.PaymentRequirements, _ types.SupportedKind, _ []string) (types.PaymentRequirements, error) {
	return base, nil
}
func (*siwxFlowScheme) SettleOnCancel(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453", Asset: "USDC", Amount: "1000", PayTo: "0xrecipient"}
	return &requirements, nil
}

type siwxFlowFacilitator struct {
	payer       string
	settlements int
}

func (m *siwxFlowFacilitator) Identifier() string { return "siwx-flow-test" }
func (m *siwxFlowFacilitator) Verify(context.Context, []byte, []byte) (*x402.VerifyResponse, error) {
	return &x402.VerifyResponse{IsValid: true, Payer: m.payer}, nil
}
func (m *siwxFlowFacilitator) Settle(context.Context, []byte, []byte) (*x402.SettleResponse, error) {
	m.settlements++
	return &x402.SettleResponse{Success: true, Payer: m.payer, Transaction: "0xfixture", Network: "eip155:8453"}, nil
}
func (*siwxFlowFacilitator) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{Kinds: []types.SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:8453"}}, Extensions: []string{}, Signers: map[string][]string{}}, nil
}

func siwxFlowHeader(t *testing.T, key *ecdsa.PrivateKey, path, nonce string) string {
	t.Helper()
	uri := testSIWXOrigin + path
	payload := Payload{Domain: "api.example.com", Address: crypto.PubkeyToAddress(key.PublicKey).Hex(),
		Statement: "Sign in to access your purchased content", URI: uri, Version: Version,
		ChainID: "eip155:8453", Type: SignatureTypeEIP191, Nonce: nonce,
		IssuedAt:       time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
		ExpirationTime: time.Now().Add(time.Minute).UTC().Format(time.RFC3339), Resources: []string{uri}}
	message, err := FormatSIWEMessage(payload)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := crypto.Sign(accounts.TextHash([]byte(message)), key)
	if err != nil {
		t.Fatal(err)
	}
	signature[64] += 27
	payload.Signature = "0x" + common.Bytes2Hex(signature)
	header, err := EncodeHeader(payload)
	if err != nil {
		t.Fatal(err)
	}
	return header
}

func TestSIWXHTTPSettlementFlowsUseServerPath(t *testing.T) {
	for _, tc := range []struct {
		name        string
		flow        x402.PaymentFlowName
		cancel      bool
		settlements int
	}{
		{"authorization", x402.PaymentFlowAuthorization, false, 1},
		{"upfront", x402.PaymentFlowUpfront, false, 1},
		{"escrow", x402.PaymentFlowEscrow, false, 2},
		{"upfront-cancel", x402.PaymentFlowUpfront, true, 2},
		{"escrow-cancel", x402.PaymentFlowEscrow, true, 2},
	} {
		for _, payloadPath := range []string{"/joke", "/weather"} {
			t.Run(tc.name+payloadPath, func(t *testing.T) {
				ctx := context.Background()
				key, err := crypto.GenerateKey()
				if err != nil {
					t.Fatal(err)
				}
				payer := crypto.PubkeyToAddress(key.PublicKey).Hex()
				storage := NewInMemoryStorage()
				var recorded []string
				extension := MustCreateResourceServerExtension(ServerOptions{Storage: storage, Origin: testSIWXOrigin,
					OnEvent: func(e HookEvent) {
						if e.Type == "payment_recorded" {
							recorded = append(recorded, e.Resource)
						}
					}})
				facilitator := &siwxFlowFacilitator{payer: payer}
				routes := x402http.RoutesConfig{}
				for path, amount := range map[string]string{"/weather": "1000", "/joke": "1000000"} {
					routes["GET "+path] = x402http.RouteConfig{
						Accepts: x402http.PaymentOptions{{Scheme: "exact", Network: "eip155:8453", PayTo: "0xrecipient", Price: amount,
							Extra: map[string]interface{}{"paymentFlow": string(tc.flow)}}},
						Extensions: map[string]interface{}{ExtensionKey: DeclareExtension(DeclareOptions{})[ExtensionKey]},
					}
				}
				server := x402http.Newx402HTTPResourceServer(routes, x402.WithFacilitatorClient(facilitator), x402.WithSchemeServer("eip155:8453", &siwxFlowScheme{}))
				server.RegisterExtension(extension)
				if err := server.Initialize(ctx); err != nil {
					t.Fatal(err)
				}
				request := func(path string, headers map[string]string) x402http.HTTPRequestContext {
					return x402http.HTTPRequestContext{Method: "GET", Path: path,
						Adapter: &testHTTPAdapter{method: "GET", path: path, url: testSIWXOrigin + path, headers: headers}}
				}
				challenge := server.ProcessHTTPRequest(ctx, request("/weather", nil), nil)
				if challenge.Response == nil || challenge.Response.Status != 402 {
					t.Fatalf("challenge = %#v", challenge)
				}
				required, err := decodePaymentRequiredForTest(challenge.Response.Headers["PAYMENT-REQUIRED"])
				if err != nil || len(required.Accepts) != 1 {
					t.Fatalf("decode challenge: %v, %#v", err, required)
				}
				if required.Accepts[0].Amount != "1000" {
					t.Fatalf("wrong fixture amount: %v", required.Accepts[0].Amount)
				}
				payload := types.PaymentPayload{X402Version: 2, Accepted: required.Accepts[0], Payload: map[string]interface{}{}, Resource: &types.ResourceInfo{URL: testSIWXOrigin + payloadPath}}
				encoded, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				reqCtx := request("/weather", map[string]string{"PAYMENT-SIGNATURE": base64.StdEncoding.EncodeToString(encoded)})
				result := server.ProcessHTTPRequest(ctx, reqCtx, nil)
				if result.Type != x402http.ResultPaymentVerified {
					t.Fatalf("payment result = %#v", result)
				}
				if tc.cancel {
					cancel := result.CancellationDispatcher.Cancel(x402.VerifiedPaymentCancelOptions{Reason: x402.CancellationReasonHandlerFailed, ResponseStatus: 500})
					if cancel == nil || !cancel.Success {
						t.Fatalf("cancel settle = %#v", cancel)
					}
					result.CancellationDispatcher.Cancel(x402.VerifiedPaymentCancelOptions{Reason: x402.CancellationReasonHandlerFailed, ResponseStatus: 500})
				} else if tc.flow != x402.PaymentFlowUpfront {
					settled := server.ProcessSettlement(ctx, *result.PaymentPayload, *result.PaymentRequirements, nil,
						&x402http.HTTPTransportContext{Request: &reqCtx}, result.DeclaredExtensions, result.BeforeHandlerSettlement, x402.SettlePhaseAfterHandler)
					if !settled.Success {
						t.Fatalf("after settle = %#v", settled)
					}
				}
				if facilitator.settlements != tc.settlements || len(recorded) != tc.settlements {
					t.Errorf("settlements=%d events=%v want=%d", facilitator.settlements, recorded, tc.settlements)
				}
				for _, path := range recorded {
					if path != "/weather" {
						t.Errorf("wrong resource became paid: %s", path)
					}
				}
				weather, _ := storage.HasPaid(ctx, "/weather", payer)
				joke, _ := storage.HasPaid(ctx, "/joke", payer)
				if !weather || joke {
					t.Errorf("paid map weather=%v joke=%v", weather, joke)
				}
				// These are real subsequent HTTP requests, not direct hook calls.
				paid := server.ProcessHTTPRequest(ctx, request("/weather", map[string]string{HeaderName: siwxFlowHeader(t, key, "/weather", "nonceweather")}), nil)
				if paid.Type != x402http.ResultNoPaymentRequired {
					t.Errorf("paid route denied: %#v", paid)
				}
				unpaid := server.ProcessHTTPRequest(ctx, request("/joke", map[string]string{HeaderName: siwxFlowHeader(t, key, "/joke", "noncejoke")}), nil)
				if unpaid.Response == nil || unpaid.Response.Status != 402 {
					t.Errorf("unpaid expensive route bypass: %#v", unpaid)
				}
			})
		}
	}
}
