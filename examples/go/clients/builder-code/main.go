package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/buildercode"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

/**
 * Builder Code Example Client
 *
 * Makes a paid request to a builder-code resource server and verifies that
 * ERC-8021 builder-code attribution was appended to the settlement transaction
 * calldata.
 */

func main() {
	if err := godotenv.Load(); err != nil {
		fmt.Println("No .env file found, using environment variables")
	}

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("❌ EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	evmRpcURL := os.Getenv("EVM_RPC_URL")
	if evmRpcURL == "" {
		evmRpcURL = "https://sepolia.base.org"
	}

	clientBuilderCode := os.Getenv("CLIENT_BUILDER_CODE")

	url := os.Getenv("SERVER_URL")
	if url == "" {
		url = "http://localhost:4021/weather"
	}

	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		fmt.Printf("❌ Failed to create EVM signer: %v\n", err)
		os.Exit(1)
	}

	var rpcConfig *exactevm.ExactEvmSchemeConfig
	if evmRpcURL != "" {
		rpcConfig = &exactevm.ExactEvmSchemeConfig{RPCURL: evmRpcURL}
	}

	client := x402.Newx402Client()
	client.Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, rpcConfig))
	if clientBuilderCode != "" {
		client.RegisterExtension(buildercode.NewBuilderCodeClientExtension(clientBuilderCode))	
	}

	httpClient := x402http.WrapHTTPClientWithPayment(
		http.DefaultClient,
		x402http.Newx402HTTPClient(client),
	)

	fmt.Printf("Making request to: %s\n\n", url)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		fmt.Printf("❌ Failed to create request: %v\n", err)
		os.Exit(1)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		fmt.Printf("❌ Request failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		fmt.Printf("❌ Failed to decode response: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Response body:", responseData)

	settleResp, err := extractPaymentResponse(resp.Header)
	if err != nil {
		fmt.Printf("❌ Failed to parse payment response: %v\n", err)
		os.Exit(1)
	}

	paymentJSON, _ := json.MarshalIndent(settleResp, "", "  ")
	fmt.Printf("\nPayment response: %s\n", string(paymentJSON))

	if settleResp == nil || !settleResp.Success || settleResp.Transaction == "" {
		fmt.Println("❌ Settlement did not return a transaction hash")
		os.Exit(1)
	}

	ethClient, err := ethclient.Dial(evmRpcURL)
	if err != nil {
		fmt.Printf("❌ Failed to connect to RPC: %v\n", err)
		os.Exit(1)
	}
	defer ethClient.Close()

	tx, _, err := ethClient.TransactionByHash(ctx, common.HexToHash(settleResp.Transaction))
	if err != nil {
		fmt.Printf("❌ Failed to fetch transaction: %v\n", err)
		os.Exit(1)
	}

	attribution, ok := buildercode.ParseBuilderCodeSuffixFromCalldata(common.Bytes2Hex(tx.Data()))
	if !ok {
		fmt.Printf("❌ ERC-8021 builder-code suffix not found in calldata for %s\n", settleResp.Transaction)
		os.Exit(1)
	}

	b, _ := json.MarshalIndent(attribution, "", "  ")
	fmt.Printf("\nBuilder-code attribution verified onchain: %s\n", b)
	fmt.Printf("Explorer: https://sepolia.basescan.org/tx/%s\n", settleResp.Transaction)
}

func extractPaymentResponse(headers http.Header) (*x402.SettleResponse, error) {
	paymentHeader := headers.Get("PAYMENT-RESPONSE")
	if paymentHeader == "" {
		paymentHeader = headers.Get("X-PAYMENT-RESPONSE")
	}
	if paymentHeader == "" {
		return nil, nil
	}

	decoded, err := base64.StdEncoding.DecodeString(paymentHeader)
	if err != nil {
		return nil, err
	}

	var settleResp x402.SettleResponse
	if err := json.Unmarshal(decoded, &settleResp); err != nil {
		return nil, err
	}

	return &settleResp, nil
}
