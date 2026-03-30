package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/ethereum/go-ethereum/ethclient"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	exactevm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	exactevmv1 "github.com/coinbase/x402/go/mechanisms/evm/exact/v1/client"
	uptoevm "github.com/coinbase/x402/go/mechanisms/evm/upto/client"
	svm "github.com/coinbase/x402/go/mechanisms/svm/exact/client"
	svmv1 "github.com/coinbase/x402/go/mechanisms/svm/exact/v1/client"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
	svmsigners "github.com/coinbase/x402/go/signers/svm"
)

// Result structure for e2e test output
type Result struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
	Error           string      `json:"error,omitempty"`
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

	x402Client := x402.Newx402Client().
		Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, evmConfig)).
		Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, uptoConfig)).
		Register("solana:*", svm.NewExactSvmScheme(svmSigner)).
		RegisterV1("base-sepolia", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("base", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("solana-devnet", svmv1.NewExactSvmSchemeV1(svmSigner)).
		RegisterV1("solana", svmv1.NewExactSvmSchemeV1(svmSigner))

	// Create HTTP client wrapper
	httpClient := x402http.Newx402HTTPClient(x402Client)

	// Wrap standard HTTP client with payment handling
	client := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	// Make the request
	url := serverURL + endpointPath
	ctx := context.Background()

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		outputError(fmt.Sprintf("Failed to create request: %v", err))
		return
	}

	// Perform the request (payment will be handled)
	resp, err := client.Do(req)
	if err != nil {
		outputError(fmt.Sprintf("Request failed: %v", err))
		return
	}
	defer resp.Body.Close()

	// Read response body
	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		outputError(fmt.Sprintf("Failed to decode response: %v", err))
		return
	}

	// Extract payment response from headers if present
	var paymentResponse interface{}
	if paymentHeader := resp.Header.Get("PAYMENT-RESPONSE"); paymentHeader != "" {
		settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{
			"PAYMENT-RESPONSE": paymentHeader,
		})
		if err == nil {
			paymentResponse = settleResp
		}
	} else if paymentHeader := resp.Header.Get("X-PAYMENT-RESPONSE"); paymentHeader != "" {
		settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{
			"X-PAYMENT-RESPONSE": paymentHeader,
		})
		if err == nil {
			paymentResponse = settleResp
		}
	}

	// Check if payment was successful (if a payment was required)
	success := true
	if resp.StatusCode == 402 {
		// Payment was required but we got a 402, so payment failed
		success = false
	} else if settleResp, ok := paymentResponse.(*x402.SettleResponse); ok && paymentResponse != nil {
		// Payment was attempted, check if it succeeded
		success = settleResp.Success
	}

	// Output result
	result := Result{
		Success:         success,
		Data:            responseData,
		StatusCode:      resp.StatusCode,
		PaymentResponse: paymentResponse,
	}

	outputResult(result)
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
