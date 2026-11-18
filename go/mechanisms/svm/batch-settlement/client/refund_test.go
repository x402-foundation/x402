package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchSettlementRefundDriver(t *testing.T) {
	req := refundRequirements()
	t.Run("probes the route, sends the close, and returns the settlement", func(t *testing.T) {
		var sent []http.Header
		client := scriptedClient(func(r *http.Request) *http.Response {
			sent = append(sent, r.Header.Clone())
			if r.Header.Get("PAYMENT-SIGNATURE") == "" {
				return headerResponse(402, "PAYMENT-REQUIRED", encodeRequired(t, x402.PaymentRequired{
					Accepts:     []types.PaymentRequirements{req},
					X402Version: 2,
				}))
			}
			return headerResponse(200, "PAYMENT-RESPONSE", encodeSettled(t, &x402.SettleResponse{
				Network:     testNetwork,
				Payer:       testMint,
				Success:     true,
				Transaction: "close-signature",
			}))
		})
		settled, err := RefundBatchChannel(context.Background(), refundBuilder, "https://example.test/paid", &BatchRefundOptions{HTTPClient: client})
		require.NoError(t, err)
		require.True(t, settled.Success)
		require.Equal(t, "close-signature", settled.Transaction)
		require.Len(t, sent, 2)
		decoded := decodeSignature(t, sent[1].Get("PAYMENT-SIGNATURE"))
		require.Equal(t, float64(2), decoded["x402Version"])
		accepted := decoded["accepted"].(map[string]any)
		require.Equal(t, batchsettlement.Scheme, accepted["scheme"])
		payload := decoded["payload"].(map[string]any)
		require.Equal(t, "refund", payload["type"])
		require.Equal(t, "3000", payload["voucher"].(map[string]any)["maxClaimableAmount"])
	})

	t.Run("binds the close to client-signed requirements when the probe lists server-signed first", func(t *testing.T) {
		serverSigned := req
		serverExtra := cloneExtra(req.Extra)
		serverExtra[batchsettlement.ExtraOperator] = svm.USDCMainnetAddress
		serverExtra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
		serverSigned.Extra = serverExtra
		clientSigned := req
		clientExtra := cloneExtra(req.Extra)
		clientExtra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerClient
		clientSigned.Extra = clientExtra
		var accepted map[string]any
		client := scriptedClient(func(r *http.Request) *http.Response {
			if r.Header.Get("PAYMENT-SIGNATURE") == "" {
				return headerResponse(402, "PAYMENT-REQUIRED", encodeRequired(t, x402.PaymentRequired{
					Accepts:     []types.PaymentRequirements{serverSigned, clientSigned},
					X402Version: 2,
				}))
			}
			accepted = decodeSignature(t, r.Header.Get("PAYMENT-SIGNATURE"))["accepted"].(map[string]any)
			return headerResponse(200, "PAYMENT-RESPONSE", encodeSettled(t, &x402.SettleResponse{
				Network: testNetwork, Success: true, Transaction: "close-signature",
			}))
		})
		settled, err := RefundBatchChannel(context.Background(), refundBuilder, "https://example.test/paid", &BatchRefundOptions{HTTPClient: client})
		require.NoError(t, err)
		require.True(t, settled.Success)
		require.Equal(t, batchsettlement.VoucherSignerClient, accepted["extra"].(map[string]any)["voucherSigner"])
		_, hasOperator := accepted["extra"].(map[string]any)["operator"]
		require.False(t, hasOperator)
	})

	t.Run("skips the probe when the caller already holds the requirements", func(t *testing.T) {
		calls := 0
		client := scriptedClient(func(r *http.Request) *http.Response {
			calls++
			return headerResponse(200, "PAYMENT-RESPONSE", encodeSettled(t, &x402.SettleResponse{
				Network: testNetwork, Success: true, Transaction: "close-signature",
			}))
		})
		settled, err := RefundBatchChannel(context.Background(), refundBuilder, "https://example.test/paid", &BatchRefundOptions{
			HTTPClient:   client,
			Requirements: &req,
		})
		require.NoError(t, err)
		require.True(t, settled.Success)
		require.Equal(t, 1, calls)
	})

	t.Run("resends with a request_close when the facilitator has no binding", func(t *testing.T) {
		var payloads []map[string]any
		client := scriptedClient(func(r *http.Request) *http.Response {
			payloads = append(payloads, decodeSignature(t, r.Header.Get("PAYMENT-SIGNATURE"))["payload"].(map[string]any))
			if len(payloads) == 1 {
				return headerResponse(402, "PAYMENT-REQUIRED", encodeRequired(t, x402.PaymentRequired{
					Accepts:     []types.PaymentRequirements{req},
					Error:       batchsettlement.ErrReceiverBindingUnavailable,
					X402Version: 2,
				}))
			}
			return headerResponse(200, "PAYMENT-RESPONSE", encodeSettled(t, &x402.SettleResponse{
				Network: testNetwork, Success: true, Transaction: "request-close-signature",
			}))
		})
		settled, err := RefundBatchChannel(context.Background(), refundBuilder, "https://example.test/paid", &BatchRefundOptions{
			HTTPClient:   client,
			Requirements: &req,
		})
		require.NoError(t, err)
		require.Equal(t, "request-close-signature", settled.Transaction)
		require.Len(t, payloads, 2)
		_, hasTx := payloads[0]["transaction"]
		require.False(t, hasTx)
		require.Equal(t, "request-close-transaction", payloads[1]["transaction"])
	})

	t.Run("surfaces the server's reason when the close is refused", func(t *testing.T) {
		client := scriptedClient(func(r *http.Request) *http.Response {
			return headerResponse(402, "PAYMENT-REQUIRED", encodeRequired(t, x402.PaymentRequired{
				Accepts:     []types.PaymentRequirements{req},
				Error:       "invalid_batch_settlement_svm_close_state",
				X402Version: 2,
			}))
		})
		_, err := RefundBatchChannel(context.Background(), refundBuilder, "https://example.test/paid", &BatchRefundOptions{
			HTTPClient:   client,
			Requirements: &req,
		})
		require.ErrorContains(t, err, "invalid_batch_settlement_svm_close_state")
	})

	t.Run("refuses a route that does not answer with a 402", func(t *testing.T) {
		client := scriptedClient(func(r *http.Request) *http.Response {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}
		})
		_, err := RefundBatchChannel(context.Background(), refundBuilder, "https://example.test/open", &BatchRefundOptions{HTTPClient: client})
		require.ErrorContains(t, err, "expected 402")
	})
}

func TestBatchSettlementRefundDriverEdgeCases(t *testing.T) {
	req := refundRequirements()
	t.Run("rejects a 402 probe that carries no PAYMENT-REQUIRED header", func(t *testing.T) {
		client := scriptedClient(func(r *http.Request) *http.Response {
			return &http.Response{StatusCode: 402, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}
		})
		_, err := ProbeBatchRequirements(context.Background(), "https://example.test/paid", client)
		require.ErrorContains(t, err, "no PAYMENT-REQUIRED header")
	})

	t.Run("selects the Solana accept when an EVM batch-settlement accept is listed first", func(t *testing.T) {
		evm := req
		evm.Extra = map[string]any{}
		evm.Network = "eip155:84532"
		client := scriptedClient(func(r *http.Request) *http.Response {
			return headerResponse(402, "PAYMENT-REQUIRED", encodeRequired(t, x402.PaymentRequired{
				Accepts:     []types.PaymentRequirements{evm, req},
				X402Version: 2,
			}))
		})
		probed, err := ProbeBatchRequirements(context.Background(), "https://example.test/paid", client)
		require.NoError(t, err)
		require.Equal(t, testNetwork, probed.requirements.Network)
		require.Equal(t, svm.USDCMainnetAddress, probed.requirements.Extra[batchsettlement.ExtraFeePayer])
	})

	t.Run("rejects a route that advertises no batch-settlement accept", func(t *testing.T) {
		exact := req
		exact.Scheme = "exact"
		client := scriptedClient(func(r *http.Request) *http.Response {
			return headerResponse(402, "PAYMENT-REQUIRED", encodeRequired(t, x402.PaymentRequired{
				Accepts:     []types.PaymentRequirements{exact},
				X402Version: 2,
			}))
		})
		_, err := ProbeBatchRequirements(context.Background(), "https://example.test/paid", client)
		require.ErrorContains(t, err, "does not offer batch-settlement")
	})

	t.Run("falls back to globalThis.fetch when no fetch is supplied", func(t *testing.T) {
		client := scriptedClient(func(r *http.Request) *http.Response {
			return headerResponse(200, "PAYMENT-RESPONSE", encodeSettled(t, &x402.SettleResponse{
				Network: testNetwork, Success: true, Transaction: "close-signature",
			}))
		})
		previous := refundHTTPClient
		refundHTTPClient = client
		t.Cleanup(func() { refundHTTPClient = previous })
		settled, err := RefundBatchChannel(context.Background(), edgeBuilder, "https://example.test/paid", &BatchRefundOptions{Requirements: &req})
		require.NoError(t, err)
		require.True(t, settled.Success)
		require.Equal(t, "close-signature", settled.Transaction)
	})

	t.Run("fails clearly when no fetch implementation exists at all", func(t *testing.T) {
		previous := refundHTTPClient
		refundHTTPClient = nil
		t.Cleanup(func() { refundHTTPClient = previous })
		_, err := RefundBatchChannel(context.Background(), edgeBuilder, "https://example.test/paid", nil)
		require.ErrorContains(t, err, "requires a fetch implementation")
	})

	t.Run("reports a refusal without a reason when the 402 carries no header", func(t *testing.T) {
		client := scriptedClient(func(r *http.Request) *http.Response {
			return &http.Response{StatusCode: 402, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}
		})
		_, err := RefundBatchChannel(context.Background(), edgeBuilder, "https://example.test/paid", &BatchRefundOptions{
			HTTPClient:   client,
			Requirements: &req,
		})
		require.ErrorContains(t, err, "refund refused: no reason given")
	})

	t.Run("reports a refusal whose 402 header carries no error field", func(t *testing.T) {
		client := scriptedClient(func(r *http.Request) *http.Response {
			return headerResponse(402, "PAYMENT-REQUIRED", encodeRequired(t, x402.PaymentRequired{
				Accepts:     []types.PaymentRequirements{req},
				X402Version: 2,
			}))
		})
		_, err := RefundBatchChannel(context.Background(), edgeBuilder, "https://example.test/paid", &BatchRefundOptions{
			HTTPClient:   client,
			Requirements: &req,
		})
		require.ErrorContains(t, err, "refund refused: no reason given")
	})

	t.Run("rejects a non-402 response that lacks a PAYMENT-RESPONSE header", func(t *testing.T) {
		client := scriptedClient(func(r *http.Request) *http.Response {
			return &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}
		})
		_, err := RefundBatchChannel(context.Background(), edgeBuilder, "https://example.test/paid", &BatchRefundOptions{
			HTTPClient:   client,
			Requirements: &req,
		})
		require.ErrorContains(t, err, "no PAYMENT-RESPONSE header (status 500)")
	})
}

func refundRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Amount: "1000",
		Asset:  testMint,
		Extra: map[string]any{
			batchsettlement.ExtraFeePayer:      svm.USDCMainnetAddress,
			batchsettlement.ExtraTokenProgram:  solanaTokenProgram(),
			batchsettlement.ExtraWithdrawDelay: 900,
		},
		MaxTimeoutSeconds: 300,
		Network:           testNetwork,
		PayTo:             svm.USDCMainnetAddress,
		Scheme:            batchsettlement.Scheme,
	}
}

func solanaTokenProgram() string {
	return "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
}

func closePayload(withTransaction bool) map[string]any {
	payload := map[string]any{
		"channelConfig": map[string]any{
			"openSlot":           1,
			"payer":              testMint,
			"payerAuthorizer":    testMint,
			"receiver":           svm.USDCMainnetAddress,
			"receiverAuthorizer": svm.USDCMainnetAddress,
			"salt":               "0",
			"token":              testMint,
			"withdrawDelay":      900,
		},
		"type": "refund",
		"voucher": map[string]any{
			"channelId":          svm.USDCMainnetAddress,
			"expiresAt":          0,
			"maxClaimableAmount": "3000",
			"signature":          "voucher-signature",
		},
	}
	if withTransaction {
		payload["transaction"] = "request-close-transaction"
	}
	return payload
}

func refundBuilder(_ context.Context, version int, _ types.PaymentRequirements, options RefundPayloadOptions) (types.PaymentPayload, error) {
	return types.PaymentPayload{X402Version: version, Payload: closePayload(options.WithTransaction)}, nil
}

func edgeBuilder(_ context.Context, version int, _ types.PaymentRequirements, _ RefundPayloadOptions) (types.PaymentPayload, error) {
	payload := closePayload(false)
	payload["voucher"].(map[string]any)["maxClaimableAmount"] = "0"
	payload["voucher"].(map[string]any)["signature"] = "sig"
	return types.PaymentPayload{X402Version: version, Payload: payload}, nil
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func scriptedClient(handler func(*http.Request) *http.Response) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return handler(request), nil
	})}
}

func headerResponse(status int, name, value string) *http.Response {
	header := http.Header{}
	header.Set(name, value)
	return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(""))}
}

func encodeRequired(t *testing.T, required x402.PaymentRequired) string {
	t.Helper()
	raw, err := json.Marshal(required)
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(raw)
}

func encodeSettled(t *testing.T, settled *x402.SettleResponse) string {
	t.Helper()
	raw, err := json.Marshal(settled)
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(raw)
}

func decodeSignature(t *testing.T, header string) map[string]any {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(header)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(raw, &decoded))
	return decoded
}

func cloneExtra(extra map[string]any) map[string]any {
	cloned := map[string]any{}
	for key, value := range extra {
		cloned[key] = value
	}
	return cloned
}
