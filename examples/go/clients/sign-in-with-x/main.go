package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/signinwithx"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	evmsigner "github.com/x402-foundation/x402/go/v2/signers/evm"
)

func main() {
	privateKey := os.Getenv("EVM_PRIVATE_KEY")
	if privateKey == "" {
		log.Fatal("EVM_PRIVATE_KEY is required")
	}

	targetURL := os.Getenv("SERVER_URL")
	if targetURL == "" {
		targetURL = "http://localhost:4021/profile"
	}

	signer, err := evmsigner.NewClientSignerFromPrivateKey(privateKey)
	if err != nil {
		log.Fatalf("create signer: %v", err)
	}
	siwxSigner, ok := signer.(signinwithx.EVMSigner)
	if !ok {
		log.Fatal("EVM signer does not support SIWX message signing")
	}

	x402Client := x402http.Newx402HTTPClient(x402.Newx402Client()).
		OnPaymentRequired(signinwithx.CreateClientHook(siwxSigner))
	httpClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, x402Client)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		log.Fatalf("create request: %v", err)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	var body interface{}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		log.Fatalf("decode response: %v", err)
	}

	pretty, _ := json.MarshalIndent(body, "", "  ")
	fmt.Printf("status: %d\n%s\n", resp.StatusCode, pretty)
}
