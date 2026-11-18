package gin_test

import (
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"

	x402gin "github.com/x402-foundation/x402/go/pkg/gin"
	"github.com/x402-foundation/x402/go/pkg/types"
)

// TestServerConfig configures how the test facilitator server responds.
type TestServerConfig struct {
	PaymentPayload *types.PaymentPayload

	// Verification response
	VerifySuccess bool
	InvalidReason *string

	// Settlement response
	SettleSuccess     bool
	SettleErrorReason *string
	Transaction       string
	Network           string
	Payer             *string

	// Server behavior
	VerifyStatusCode int
	SettleStatusCode int
}

// NewTestConfig returns a default test configuration with successful responses.
func NewTestConfig() TestServerConfig {
	invalidReason := "Invalid payment"
	settleErrorReason := "Settlement failed"
	payer := "0xvalidPayer"

	return TestServerConfig{
		PaymentPayload: &types.PaymentPayload{
			X402Version: 1,
			Scheme:      "exact",
			Network:     "base-sepolia",
			Payload: &types.ExactEvmPayload{
				Signature: "0xvalidSignature",
				Authorization: &types.ExactEvmPayloadAuthorization{
					From:        "0xvalidFrom",
					To:          "0xvalidTo",
					Value:       "1000000",
					ValidAfter:  "1745323800",
					ValidBefore: "1745323985",
					Nonce:       "0xvalidNonce",
				},
			},
		},
		VerifySuccess:     true,
		InvalidReason:     &invalidReason,
		SettleSuccess:     true,
		SettleErrorReason: &settleErrorReason,
		Transaction:       "0xtesthash",
		Network:           "base-sepolia",
		Payer:             &payer,
		VerifyStatusCode:  http.StatusOK,
		SettleStatusCode:  http.StatusOK,
	}
}

// setupTest creates a test environment with configurable facilitator server.
func setupTest(t *testing.T, amount *big.Float, address string, config TestServerConfig, opts ...x402gin.Options) (*gin.Engine, *httptest.ResponseRecorder, *http.Request) {
	t.Helper()

	// Create a test facilitator server
	facilitatorServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/verify":
			w.WriteHeader(config.VerifyStatusCode)
			json.NewEncoder(w).Encode(types.VerifyResponse{
				IsValid:       config.VerifySuccess,
				InvalidReason: config.InvalidReason,
				Payer:         config.Payer,
			})
		case "/settle":
			w.WriteHeader(config.SettleStatusCode)
			json.NewEncoder(w).Encode(types.SettleResponse{
				Success:     config.SettleSuccess,
				ErrorReason: config.SettleErrorReason,
				Transaction: config.Transaction,
				Network:     config.Network,
				Payer:       config.Payer,
			})
		}
	}))
	t.Cleanup(func() { facilitatorServer.Close() })

	gin.SetMode(gin.TestMode)
	router := gin.New()

	facilitatorConfig := &types.FacilitatorConfig{
		URL: facilitatorServer.URL,
	}
	allOpts := append([]x402gin.Options{x402gin.WithFacilitatorConfig(facilitatorConfig)}, opts...)

	router.GET("/protected", x402gin.PaymentMiddleware(amount, address, allOpts...), func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)

	return router, w, req
}

func TestPaymentMiddleware_NoPaymentHeader(t *testing.T) {
	router, w, req := setupTest(t, big.NewFloat(1.0), "0xTestAddress", NewTestConfig())

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusPaymentRequired, w.Code)

	var response map[string]any
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.Contains(t, response, "error")
	assert.Contains(t, response, "accepts")
}

func TestPaymentMiddleware_WebBrowserRequest(t *testing.T) {
	router, w, req := setupTest(t, big.NewFloat(1.0), "0xTestAddress", NewTestConfig())

	req.Header.Set("Accept", "text/html")
	req.Header.Set("User-Agent", "Mozilla/5.0")
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusPaymentRequired, w.Code)
	assert.Contains(t, w.Body.String(), "<html>")
	assert.Equal(t, "text/html", w.Header().Get("Content-Type"))
}

func TestPaymentMiddleware_ValidPayment(t *testing.T) {
	config := NewTestConfig()

	router, w, req := setupTest(t, big.NewFloat(1.0), "0xTestAddress", config)

	paymentPayloadJson, err := json.Marshal(config.PaymentPayload)
	assert.NoError(t, err, "marshaling payment payload should not fail")

	paymentPayloadBase64 := base64.StdEncoding.EncodeToString(paymentPayloadJson)
	req.Header.Set("X-PAYMENT", paymentPayloadBase64)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "success")
	assert.NotEmpty(t, w.Header().Get("X-PAYMENT-RESPONSE"))

	responseStr := w.Header().Get("X-PAYMENT-RESPONSE")
	responseBytes, err := base64.StdEncoding.DecodeString(responseStr)
	assert.NoError(t, err)

	var settleResponse types.SettleResponse
	err = json.Unmarshal(responseBytes, &settleResponse)
	assert.NoError(t, err)
	assert.True(t, settleResponse.Success)
	assert.Equal(t, "0xtesthash", settleResponse.Transaction)
}

func TestPaymentMiddleware_VerificationFails(t *testing.T) {
	config := NewTestConfig()
	config.VerifySuccess = false
	config.PaymentPayload.Payload.Signature = "0xInvalidSignature"

	router, w, req := setupTest(t, big.NewFloat(1.0), "0xTestAddress", config)

	paymentPayloadJson, err := json.Marshal(config.PaymentPayload)
	assert.NoError(t, err, "marshaling payment payload should not fail")

	paymentPayloadBase64 := base64.StdEncoding.EncodeToString(paymentPayloadJson)
	req.Header.Set("X-PAYMENT", paymentPayloadBase64)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusPaymentRequired, w.Code)

	var response map[string]any
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.Contains(t, response, "error")
	assert.Contains(t, response, "accepts")
	assert.Equal(t, *config.InvalidReason, response["error"])
}

func TestPaymentMiddleware_VerificationServerError(t *testing.T) {
	config := NewTestConfig()
	config.VerifyStatusCode = http.StatusInternalServerError

	router, w, req := setupTest(t, big.NewFloat(1.0), "0xTestAddress", config)

	paymentPayloadJson, err := json.Marshal(config.PaymentPayload)
	assert.NoError(t, err, "marshaling payment payload should not fail")

	paymentPayloadBase64 := base64.StdEncoding.EncodeToString(paymentPayloadJson)
	req.Header.Set("X-PAYMENT", paymentPayloadBase64)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)

	var response map[string]any
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.Contains(t, response, "error")
}

func TestPaymentMiddleware_SettlementFails(t *testing.T) {
	config := NewTestConfig()
	config.SettleSuccess = false

	router, w, req := setupTest(t, big.NewFloat(1.0), "0xTestAddress", config)

	paymentPayloadJson, err := json.Marshal(config.PaymentPayload)
	assert.NoError(t, err, "marshaling payment payload should not fail")

	paymentPayloadBase64 := base64.StdEncoding.EncodeToString(paymentPayloadJson)
	req.Header.Set("X-PAYMENT", paymentPayloadBase64)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "success")

	assert.NotEmpty(t, w.Header().Get("X-PAYMENT-RESPONSE"))

	responseStr := w.Header().Get("X-PAYMENT-RESPONSE")
	responseBytes, err := base64.StdEncoding.DecodeString(responseStr)
	assert.NoError(t, err)

	var settleResponse types.SettleResponse
	err = json.Unmarshal(responseBytes, &settleResponse)
	assert.NoError(t, err)
	assert.False(t, settleResponse.Success)
}

func TestPaymentMiddleware_SettlementServerError(t *testing.T) {
	config := NewTestConfig()
	config.SettleStatusCode = http.StatusInternalServerError

	router, w, req := setupTest(t, big.NewFloat(1.0), "0xTestAddress", config)

	paymentPayloadJson, err := json.Marshal(config.PaymentPayload)
	assert.NoError(t, err, "marshaling payment payload should not fail")

	paymentPayloadBase64 := base64.StdEncoding.EncodeToString(paymentPayloadJson)
	req.Header.Set("X-PAYMENT", paymentPayloadBase64)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusPaymentRequired, w.Code)
	assert.Contains(t, w.Body.String(), "failed to settle payment:")

	assert.Empty(t, w.Header().Get("X-PAYMENT-RESPONSE"))
}

func TestPaymentMiddleware_Options(t *testing.T) {
	testCases := []struct {
		name    string
		opts    []x402gin.Options
		amount  *big.Float
		address string
	}{
		{
			name: "with custom description",
			opts: []x402gin.Options{
				x402gin.WithDescription("Test Description"),
				x402gin.WithMimeType("application/json"),
				x402gin.WithMaxTimeoutSeconds(120),
				x402gin.WithTestnet(true),
			},
			amount:  big.NewFloat(1.0),
			address: "0xTestAddress",
		},
		{
			name: "with custom paywall HTML",
			opts: []x402gin.Options{
				x402gin.WithCustomPaywallHTML("<html><body>Custom Paywall</body></html>"),
				x402gin.WithResource("test-resource"),
			},
			amount:  big.NewFloat(2.0),
			address: "0xTestAddress2",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			config := NewTestConfig()

			router, w, req := setupTest(t, tc.amount, tc.address, config, tc.opts...)

			paymentPayloadJson, err := json.Marshal(config.PaymentPayload)
			assert.NoError(t, err, "marshaling payment payload should not fail")

			paymentPayloadBase64 := base64.StdEncoding.EncodeToString(paymentPayloadJson)
			req.Header.Set("X-PAYMENT", paymentPayloadBase64)
			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code)
			assert.Contains(t, w.Body.String(), "success")
			assert.NotEmpty(t, w.Header().Get("X-PAYMENT-RESPONSE"))
		})
	}
}

func TestPaymentMiddleware_NetworkSelection(t *testing.T) {
	testCases := []struct {
		name    string
		testnet bool
	}{
		{
			name:    "base-sepolia",
			testnet: true,
		},
		{
			name:    "base",
			testnet: false,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			router, w, req := setupTest(
				t,
				big.NewFloat(1.0),
				"0xTestAddress",
				NewTestConfig(),
				x402gin.WithTestnet(tc.testnet),
			)

			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusPaymentRequired, w.Code)

			var response map[string]any
			err := json.Unmarshal(w.Body.Bytes(), &response)
			assert.NoError(t, err)

			requirementsSlice, ok := response["accepts"].([]any)
			assert.True(t, ok)

			requirements, ok := requirementsSlice[0].(map[string]any)
			assert.True(t, ok)

			expectedNetwork := "base"
			if tc.testnet {
				expectedNetwork = "base-sepolia"
			}

			assert.Equal(t, expectedNetwork, requirements["network"])
		})
	}
}
