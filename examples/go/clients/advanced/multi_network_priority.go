package main

import (
	"context"
	"fmt"
	"net/http"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/coinbase/x402/go/signers/evm"
)

/**
 * Multi-Network Priority Example
 *
 * This example demonstrates how to configure network-specific signers
 * with priority and fallback logic:
 * - Specific networks get dedicated signers
 * - Wildcard registration for fallback
 * - Network-specific configuration
 * - Demonstrating registration precedence
 */

func runMultiNetworkPriorityExample(ctx context.Context, evmPrivateKey, url string) error {
	fmt.Println("🌐 Configuring multi-network client with priority...\n")

	// Create primary signer (for most networks)
	primarySigner, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
	if err != nil {
		return err
	}

	// In a real scenario, you might have different signers for different networks
	// For demo purposes, we'll use the same signer but show the pattern
	mainnetSigner := primarySigner   // Would be different in production
	testnetSigner := primarySigner   // Would be different in production
	baseSigner := primarySigner      // Would be different in production

	fmt.Println("📝 Registering networks with priority:")
	fmt.Println("   1. Specific networks (highest priority)")
	fmt.Println("   2. Network category wildcards")
	fmt.Println("   3. Global wildcard (lowest priority/fallback)\n")

	// Create client with prioritized network registration
	// More specific registrations take precedence over wildcards
	client := x402.Newx402Client()

	// Level 1: Specific networks (highest priority)
	fmt.Println("✅ Registering Ethereum Mainnet (eip155:1) with mainnet signer")
	client.Register("eip155:1", evm.NewExactEvmScheme(mainnetSigner, nil))

	fmt.Println("✅ Registering Base Mainnet (eip155:8453) with base signer")
	client.Register("eip155:8453", evm.NewExactEvmScheme(baseSigner, nil))

	fmt.Println("✅ Registering Base Sepolia (eip155:84532) with testnet signer")
	client.Register("eip155:84532", evm.NewExactEvmScheme(testnetSigner, nil))

	// Level 2: Wildcard for all other EVM networks (fallback)
	fmt.Println("✅ Registering all other EVM networks (eip155:*) with primary signer\n")
	client.Register("eip155:*", evm.NewExactEvmScheme(primarySigner, nil))

	// Add logging to show which network is being used
	client.OnBeforePaymentCreation(func(ctx x402.PaymentCreationContext) (*x402.BeforePaymentCreationHookResult, error) {
		fmt.Printf("💰 Creating payment for network: %s\n", ctx.SelectedRequirements.GetNetwork())
		fmt.Printf("   Scheme: %s\n", ctx.SelectedRequirements.GetScheme())
		
		// Show which signer would be used based on network
		var signerType string
		switch ctx.SelectedRequirements.GetNetwork() {
		case "eip155:1":
			signerType = "Mainnet-specific signer"
		case "eip155:8453":
			signerType = "Base-specific signer"
		case "eip155:84532":
			signerType = "Testnet-specific signer"
		default:
			signerType = "Fallback signer (wildcard)"
		}
		fmt.Printf("   Using: %s\n\n", signerType)

		return nil, nil
	})

	// Wrap HTTP client
	httpClient := x402http.Newx402HTTPClient(client)
	wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	// Make request
	fmt.Printf("🌐 Making request to: %s\n", url)
	fmt.Println("   (Server will determine which network to use)\n")

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}

	resp, err := wrappedClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	fmt.Println("\n📋 Network Priority Configuration:")
	fmt.Println("   Priority 1: eip155:1 (Ethereum Mainnet) → mainnet signer")
	fmt.Println("   Priority 2: eip155:8453 (Base Mainnet) → base signer")
	fmt.Println("   Priority 3: eip155:84532 (Base Sepolia) → testnet signer")
	fmt.Println("   Priority 4: eip155:* (All others) → primary signer\n")

	fmt.Println("ℹ️  More specific registrations always override wildcards")
	fmt.Println("   This allows fine-grained control per network while having")
	fmt.Println("   sensible defaults for unknown networks.\n")

	if err := printResponse(resp, "Response with multi-network priority"); err != nil {
		return err
	}
	printPaymentDetails(resp.Header)
	return nil
}

