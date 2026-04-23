package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/ethereum/go-ethereum/ethclient"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	batchedclient "github.com/x402-foundation/x402/go/mechanisms/evm/batched/client"
	exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	exactevmv1 "github.com/x402-foundation/x402/go/mechanisms/evm/exact/v1/client"
	uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/client"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/client"
	svmv1 "github.com/x402-foundation/x402/go/mechanisms/svm/exact/v1/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
	svmsigners "github.com/x402-foundation/x402/go/signers/svm"
)

// Result structure for e2e test output
type Result struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
	Error           string      `json:"error,omitempty"`
	// Multi-request aggregate fields (populated when MULTI_REQUEST_COUNT > 1).
	Requests     []Result `json:"requests,omitempty"`
	RequestCount int      `json:"request_count,omitempty"`
}

func main() {
	// Get configuration from environment
	serverURL := os.Getenv("RESOURCE_SERVER_URL")
	if serverURL == "" {
		log.Fatal("RESOURCE_SERVER_URL is required")
	}

	endpointPath := os.Getenv("ENDPOINT_PATH")
	if endpointPath == "" {
		endpointPath = "/protected"
	}

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		log.Fatal("❌ EVM_PRIVATE_KEY environment variable is required")
	}

	svmPrivateKey := os.Getenv("SVM_PRIVATE_KEY")
	if svmPrivateKey == "" {
		log.Fatal("❌ SVM_PRIVATE_KEY environment variable is required")
	}

	// Connect to EVM RPC for on-chain reads (needed for EIP-2612 extension)
	evmRpcURL := os.Getenv("EVM_RPC_URL")
	if evmRpcURL == "" {
		evmRpcURL = "https://sepolia.base.org"
	}
	ethClient, err := ethclient.Dial(evmRpcURL)
	if err != nil {
		outputError(fmt.Sprintf("Failed to connect to EVM RPC: %v", err))
		return
	}

	evmSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(evmPrivateKey, ethClient)
	if err != nil {
		outputError(fmt.Sprintf("Failed to create EVM signer: %v", err))
		return
	}

	svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
	if err != nil {
		outputError(fmt.Sprintf("Failed to create SVM signer: %v", err))
		return
	}

	var evmConfig *exactevm.ExactEvmSchemeConfig
	if evmRpcURL != "" {
		evmConfig = &exactevm.ExactEvmSchemeConfig{RPCURL: evmRpcURL}
	}

	var uptoConfig *uptoevm.UptoEvmSchemeConfig
	if evmRpcURL != "" {
		uptoConfig = &uptoevm.UptoEvmSchemeConfig{RPCURL: evmRpcURL}
	}

	// Batch-settlement scheme uses a per-scenario salt (CHANNEL_SALT) so concurrent
	// e2e runs don't collide on the same on-chain channel id. An optional voucher
	// signer (EVM_VOUCHER_SIGNER_PRIVATE_KEY) exercises the alt-EOA voucher branch
	// while deposits keep using the main client signer.
	batchedCfg := &batchedclient.BatchedEvmSchemeConfig{}
	if salt := os.Getenv("CHANNEL_SALT"); salt != "" {
		batchedCfg.Salt = salt
	}
	if voucherKey := os.Getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY"); voucherKey != "" {
		voucherSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(voucherKey, ethClient)
		if err != nil {
			outputError(fmt.Sprintf("Failed to create voucher signer: %v", err))
			return
		}
		batchedCfg.VoucherSigner = voucherSigner
	}
	batchedScheme := batchedclient.NewBatchedEvmScheme(evmSigner, batchedCfg)

	x402Client := x402.Newx402Client().
		Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, evmConfig)).
		Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, uptoConfig)).
		Register("eip155:*", batchedScheme).
		Register("solana:*", svm.NewExactSvmScheme(svmSigner)).
		RegisterV1("base-sepolia", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("base", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("solana-devnet", svmv1.NewExactSvmSchemeV1(svmSigner)).
		RegisterV1("solana", svmv1.NewExactSvmSchemeV1(svmSigner))

	// Create HTTP client wrapper
	httpClient := x402http.Newx402HTTPClient(x402Client)

	// Wrap standard HTTP client with payment handling
	client := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	// Make the request(s)
	url := serverURL + endpointPath
	ctx := context.Background()

	// Multi-request scenarios (batch-settlement). Defaults match the TS fetch client:
	// MULTI_REQUEST_COUNT=1, REFUND_ON_LAST="true" (truthy when unset).
	numberOfRequests := 1
	if v := os.Getenv("MULTI_REQUEST_COUNT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			numberOfRequests = n
		}
	}
	refundOnLast := os.Getenv("REFUND_ON_LAST")
	if refundOnLast == "" {
		refundOnLast = "true"
	}

	results := make([]Result, 0, numberOfRequests+1)
	for i := 0; i < numberOfRequests; i++ {
		results = append(results, issueRequest(ctx, client, httpClient, url))
	}

	if refundOnLast == "true" {
		results = append(results, issueRefund(ctx, batchedScheme, url))
	}

	last := results[len(results)-1]
	if numberOfRequests > 1 {
		last.Requests = results
		last.RequestCount = numberOfRequests
	}
	outputResult(last)
}

// settleResponseExtractor reads PAYMENT-RESPONSE headers and returns a typed SettleResponse.
type settleResponseExtractor interface {
	GetPaymentSettleResponse(headers map[string]string) (*x402.SettleResponse, error)
}

// issueRequest performs a single paid GET, mirroring the TS fetch client output.
func issueRequest(
	ctx context.Context,
	client *http.Client,
	httpClient settleResponseExtractor,
	url string,
) Result {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return Result{Success: false, Error: fmt.Sprintf("Failed to create request: %v", err)}
	}
	resp, err := client.Do(req)
	if err != nil {
		return Result{Success: false, Error: fmt.Sprintf("Request failed: %v", err)}
	}
	defer resp.Body.Close()

	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		return Result{Success: false, Error: fmt.Sprintf("Failed to decode response: %v", err), StatusCode: resp.StatusCode}
	}

	var paymentResponse interface{}
	if header := resp.Header.Get("PAYMENT-RESPONSE"); header != "" {
		if settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{"PAYMENT-RESPONSE": header}); err == nil {
			paymentResponse = settleResp
		}
	} else if header := resp.Header.Get("X-PAYMENT-RESPONSE"); header != "" {
		if settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{"X-PAYMENT-RESPONSE": header}); err == nil {
			paymentResponse = settleResp
		}
	}

	success := true
	if resp.StatusCode == 402 {
		success = false
	} else if settleResp, ok := paymentResponse.(*x402.SettleResponse); ok && settleResp != nil {
		success = settleResp.Success
	}

	return Result{
		Success:         success,
		Data:            responseData,
		StatusCode:      resp.StatusCode,
		PaymentResponse: paymentResponse,
	}
}

// issueRefund triggers a cooperative refund on the batch-settlement channel.
// Mirrors the TS fetch client's `batchSettlementScheme.refund(url)` call.
func issueRefund(ctx context.Context, scheme *batchedclient.BatchedEvmScheme, url string) Result {
	settle, err := scheme.Refund(ctx, url, &batchedclient.RefundOptions{})
	if err != nil {
		return Result{Success: false, Error: fmt.Sprintf("Refund failed: %v", err), StatusCode: 200, Data: map[string]bool{"refund": true}}
	}
	return Result{
		Success:         settle.Success,
		Data:            map[string]bool{"refund": true},
		StatusCode:      200,
		PaymentResponse: settle,
	}
}

func outputResult(result Result) {
	data, err := json.Marshal(result)
	if err != nil {
		log.Fatalf("Failed to marshal result: %v", err)
	}
	fmt.Println(string(data))
	os.Exit(0)
}

func outputError(errorMsg string) {
	result := Result{
		Success: false,
		Error:   errorMsg,
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	os.Exit(1)
}
