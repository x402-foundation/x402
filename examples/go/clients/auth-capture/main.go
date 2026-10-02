package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	authcaptureclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

// Auth-capture client demo: signs an authorize payload that the facilitator escrows
// before the server handles the request.
func main() {
	_ = godotenv.Load()

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	baseURL := envOr("RESOURCE_SERVER_URL", "http://localhost:4021")
	endpointPath := envOr("ENDPOINT_PATH", "/weather")
	url := baseURL + endpointPath

	signer, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		fmt.Printf("Failed to create signer: %v\n", err)
		os.Exit(1)
	}

	scheme := authcaptureclient.NewAuthCaptureEvmScheme(signer)

	x402Client := x402.Newx402Client()
	x402Client.Register("eip155:*", scheme)

	httpClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, x402http.Newx402HTTPClient(x402Client))

	fmt.Printf("Base URL: %s, endpoint: %s\n", baseURL, endpointPath)
	fmt.Printf("payer: %s\n\n", signer.Address())

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		fmt.Printf("Request failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	fmt.Printf("Response — %s\n", resp.Status)
	body, errBody := readJSON(resp)
	if errBody != nil {
		fmt.Printf("  body: <not JSON: %v>\n", errBody)
	} else {
		fmt.Println(indent(body))
	}

	if settle, _ := extractSettleResponse(resp); settle != nil {
		fmt.Println(indent(settle))
	} else if resp.StatusCode != http.StatusOK {
		fmt.Printf("  no PAYMENT-RESPONSE (%s) — payment did not settle\n", resp.Status)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func readJSON(resp *http.Response) (interface{}, error) {
	var out interface{}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func extractSettleResponse(resp *http.Response) (*x402.SettleResponse, error) {
	header := resp.Header.Get("PAYMENT-RESPONSE")
	if header == "" {
		header = resp.Header.Get("X-PAYMENT-RESPONSE")
	}
	if header == "" {
		return nil, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, err
	}
	var out x402.SettleResponse
	if err := json.Unmarshal(decoded, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func indent(v interface{}) string {
	b, _ := json.MarshalIndent(v, "  ", "  ")
	return "  " + string(b)
}
