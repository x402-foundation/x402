package facilitatorclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/x402-foundation/x402/go/pkg/types"
)

// DefaultFacilitatorURL is the default URL for the x402 facilitator service
const DefaultFacilitatorURL = "https://x402.org/facilitator"

// FacilitatorClient represents a facilitator client for verifying and settling payments
type FacilitatorClient struct {
	URL               string
	HTTPClient        *http.Client
	CreateAuthHeaders func() (map[string]map[string]string, error)
}

// NewFacilitatorClient creates a new facilitator client
func NewFacilitatorClient(config *types.FacilitatorConfig) *FacilitatorClient {
	if config == nil {
		config = &types.FacilitatorConfig{
			URL: DefaultFacilitatorURL,
		}
	}

	httpCli := &http.Client{}
	if config.Timeout != nil {
		httpCli.Timeout = config.Timeout()
	}

	return &FacilitatorClient{
		URL:               config.URL,
		HTTPClient:        httpCli,
		CreateAuthHeaders: config.CreateAuthHeaders,
	}
}

// Verify sends a payment verification request to the facilitator
func (c *FacilitatorClient) Verify(payload *types.PaymentPayload, requirements *types.PaymentRequirements) (*types.VerifyResponse, error) {
	reqBody := map[string]any{
		"x402Version":         1,
		"paymentPayload":      payload,
		"paymentRequirements": requirements,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/verify", c.URL), bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// Add auth headers if available
	if c.CreateAuthHeaders != nil {
		headers, err := c.CreateAuthHeaders()
		if err != nil {
			return nil, fmt.Errorf("failed to create auth headers: %w", err)
		}
		if verifyHeaders, ok := headers["verify"]; ok {
			for key, value := range verifyHeaders {
				req.Header.Set(key, value)
			}
		}
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send verify request: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var verifyResp types.VerifyResponse
	if err := json.Unmarshal(responseBody, &verifyResp); err != nil {
		return nil, fmt.Errorf("facilitator verify failed (%d): %s", resp.StatusCode, string(responseBody))
	}

	if resp.StatusCode != http.StatusOK {
		if verifyResp.InvalidReason != nil {
			return nil, &types.VerifyError{
				Reason:  *verifyResp.InvalidReason,
				Payer:   *verifyResp.Payer,
				Network: "",
				Err:     fmt.Errorf("facilitator returned %d", resp.StatusCode),
			}
		}
		return nil, fmt.Errorf("facilitator verify failed (%d): %s", resp.StatusCode, string(responseBody))
	}

	return &verifyResp, nil
}

// Settle sends a payment settlement request to the facilitator
func (c *FacilitatorClient) Settle(payload *types.PaymentPayload, requirements *types.PaymentRequirements) (*types.SettleResponse, error) {
	reqBody := map[string]any{
		"x402Version":         1,
		"paymentPayload":      payload,
		"paymentRequirements": requirements,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", fmt.Sprintf("%s/settle", c.URL), bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// Add auth headers if available
	if c.CreateAuthHeaders != nil {
		headers, err := c.CreateAuthHeaders()
		if err != nil {
			return nil, fmt.Errorf("failed to create auth headers: %w", err)
		}
		if settleHeaders, ok := headers["settle"]; ok {
			for key, value := range settleHeaders {
				req.Header.Set(key, value)
			}
		}
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send settle request: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	var settleResp types.SettleResponse
	if err := json.Unmarshal(responseBody, &settleResp); err != nil {
		return nil, fmt.Errorf("facilitator settle failed (%d): %s", resp.StatusCode, string(responseBody))
	}

	if resp.StatusCode != http.StatusOK {
		if settleResp.ErrorReason != nil && settleResp.Payer != nil {
			return nil, &types.SettleError{
				Reason:      *settleResp.ErrorReason,
				Payer:       *settleResp.Payer,
				Network:     settleResp.Network,
				Transaction: settleResp.Transaction,
				Err:         fmt.Errorf("facilitator returned %d", resp.StatusCode),
			}
		}
		return nil, fmt.Errorf("facilitator settle failed (%d): %s", resp.StatusCode, string(responseBody))
	}

	return &settleResp, nil
}
