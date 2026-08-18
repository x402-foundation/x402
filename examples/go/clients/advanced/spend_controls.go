package main

import (
	"context"
	"fmt"
	"net/http"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

/**
 * Spend Controls Example
 *
 * Demonstrates client-side spend controls: the default $1 USD cap on
 * recognized pegged assets, opt-in AllowedAssets (atomic per-asset caps or
 * uncapped), and ticker overrides for a default asset.
 */

func runSpendControlsExample(ctx context.Context, evmPrivateKey, url string) error {
	fmt.Println("🛡️  Creating client with spend controls...\n")

	evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return fmt.Errorf("failed to create EVM signer: %w", err)
	}

	client := x402.Newx402Client().
		SetSpendControls(x402.SpendControls{
			MaxAmountPerPayment: "$1", // default USD cap on recognized pegged assets
			AllowedAssets: []x402.SpendControlAsset{
				// opt-in non-default with atomic cap
				{Network: "eip155:*", Asset: "0xCustomToken", MaxAmountPerPayment: "2000000"},
				// opt-in non-default uncapped
				{Network: "eip155:*", Asset: "0xOtherToken"},
				// override USD cap for a default asset by ticker (or on-chain id)
				{Network: "eip155:*", Asset: "USDC", MaxAmountPerPayment: "1000000"},
			},
		}).
		Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil)).
		Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, nil))

	httpClient := x402http.Newx402HTTPClient(client)
	wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	fmt.Printf("🌐 Making request to: %s\n\n", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	start := time.Now()
	resp, err := wrappedClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	printDuration(start, "Request")
	if err := printResponse(resp, "Response with spend controls"); err != nil {
		return err
	}

	printPaymentDetails(resp.Header)
	fmt.Println("✅ Request completed with spend controls\n")

	return nil
}
