package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	batchedclient "github.com/x402-foundation/x402/go/mechanisms/evm/batched/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

// Sequential batch-settlement client demo. Sends N requests against the same
// channel; the first request opens a deposit, subsequent requests are pure
// off-chain vouchers.
func main() {
	_ = godotenv.Load()

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	baseURL := envOr("RESOURCE_SERVER_URL", "http://localhost:4021")
	endpointPath := envOr("ENDPOINT_PATH", "/api/generate")
	url := baseURL + endpointPath

	channelSalt := envOr("CHANNEL_SALT", batchedclient.DefaultSalt)
	storageDir := os.Getenv("STORAGE_DIR")
	numberOfRequests := atoiOr("NUMBER_OF_REQUESTS", 3)
	refundAfterRequests := os.Getenv("REFUND_AFTER_REQUESTS") == "true"
	refundAmount := os.Getenv("REFUND_AMOUNT")

	signer, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		fmt.Printf("Failed to create signer: %v\n", err)
		os.Exit(1)
	}

	cfg := &batchedclient.BatchedEvmSchemeConfig{
		MaxDeposit:        "1000000",
		DepositMultiplier: 5,
		Salt:              channelSalt,
	}

	// Optional dedicated voucher-signing key (matches TS EVM_VOUCHER_SIGNER_PRIVATE_KEY).
	if voucherKey := os.Getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY"); voucherKey != "" {
		voucherSigner, err := evmsigners.NewClientSignerFromPrivateKey(voucherKey)
		if err != nil {
			fmt.Printf("Failed to create voucher signer: %v\n", err)
			os.Exit(1)
		}
		cfg.VoucherSigner = voucherSigner
	}

	if storageDir != "" {
		cfg.Storage = batchedclient.NewFileClientChannelStorage(batched.FileChannelStorageOptions{
			Directory: storageDir,
		})
	}

	scheme := batchedclient.NewBatchedEvmScheme(signer, cfg)

	x402Client := x402.Newx402Client()
	x402Client.Register("eip155:*", scheme)

	httpClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, x402http.Newx402HTTPClient(x402Client))

	fmt.Printf("Base URL: %s, endpoint: %s\n", baseURL, endpointPath)
	fmt.Printf("payer: %s\n", signer.Address())
	if cfg.VoucherSigner != nil {
		fmt.Printf("payerAuthorizer: %s\n\n", cfg.VoucherSigner.Address())
	} else {
		fmt.Printf("payerAuthorizer: %s\n\n", signer.Address())
	}

	for i := 0; i < numberOfRequests; i++ {
		t0 := time.Now()

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
		resp, err := httpClient.Do(req)
		cancel()
		if err != nil {
			fmt.Printf("Request %d failed: %v\n", i+1, err)
			os.Exit(1)
		}

		body, _ := readJSON(resp)
		fmt.Printf("Request %d — RESPONSE\n%s\n", i+1, indent(body))

		if settle, _ := extractSettleResponse(resp); settle != nil {
			fmt.Println(indent(settle))
		}

		_ = resp.Body.Close()
		fmt.Printf("Request %d — completed in %.3fs\n\n", i+1, time.Since(t0).Seconds())
	}

	if refundAfterRequests {
		if refundAmount != "" {
			fmt.Printf("REQUESTING PARTIAL REFUND of %s base units\n", refundAmount)
		} else {
			fmt.Println("REQUESTING FULL REFUND of remaining channel balance")
		}
		opts := &batchedclient.RefundOptions{}
		if refundAmount != "" {
			opts.Amount = refundAmount
		}
		refundCtx, refundCancel := context.WithTimeout(context.Background(), 60*time.Second)
		settle, err := scheme.Refund(refundCtx, url, opts)
		refundCancel()
		if err != nil {
			fmt.Printf("Refund failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(indent(settle))
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func atoiOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
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

func extractSettleResponse(resp *http.Response) (*map[string]interface{}, error) {
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
	var out map[string]interface{}
	if err := json.Unmarshal(decoded, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func indent(v interface{}) string {
	b, _ := json.MarshalIndent(v, "  ", "  ")
	return "  " + string(b)
}
