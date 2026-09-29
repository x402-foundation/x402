package main

import (
	"fmt"
	"os"

	"github.com/joho/godotenv"
)

/**
 * Advanced Facilitator Examples
 *
 * This package demonstrates advanced patterns for production-ready x402 facilitators:
 *
 * - all-networks: Facilitator with all supported networks
 * - bazaar: Facilitator with bazaar discovery extension
 * - payment-identifier: Facilitator with payment identifier idempotency
 * - gas-extensions: Base Sepolia exact + upto with EIP-2612 and ERC-20 approval gas sponsoring
 *
 * Usage:
 *   go run . all-networks
 *   go run . bazaar
 *   go run . payment-identifier
 *   go run . gas-extensions
 */

func main() {
	// Load .env file if it exists
	if err := godotenv.Load(); err != nil {
		fmt.Println("No .env file found, using environment variables")
	}

	pattern := "all-networks"
	if len(os.Args) > 1 {
		pattern = os.Args[1]
	}

	fmt.Printf("\n🚀 Running facilitator example: %s\n\n", pattern)

	// Get configuration
	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	svmPrivateKey := os.Getenv("SVM_PRIVATE_KEY")

	if pattern == "gas-extensions" {
		if evmPrivateKey == "" {
			fmt.Println("❌ EVM_PRIVATE_KEY environment variable is required for gas-extensions")
			os.Exit(1)
		}
		if err := runGasExtensionsExample(evmPrivateKey); err != nil {
			fmt.Printf("❌ Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Validate at least one private key is provided
	if evmPrivateKey == "" && svmPrivateKey == "" {
		fmt.Println("❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
		os.Exit(1)
	}

	// Run the selected example
	switch pattern {
	case "all-networks":
		if err := runAllNetworksExample(evmPrivateKey, svmPrivateKey); err != nil {
			fmt.Printf("❌ Error: %v\n", err)
			os.Exit(1)
		}

	case "bazaar":
		if err := runBazaarExample(evmPrivateKey, svmPrivateKey); err != nil {
			fmt.Printf("❌ Error: %v\n", err)
			os.Exit(1)
		}

	case "payment-identifier":
		if err := runPaymentIdentifierExample(evmPrivateKey, svmPrivateKey); err != nil {
			fmt.Printf("❌ Error: %v\n", err)
			os.Exit(1)
		}

	default:
		fmt.Printf("❌ Unknown pattern: %s\n", pattern)
		fmt.Println("Available patterns: all-networks, bazaar, payment-identifier, gas-extensions")
		os.Exit(1)
	}
}
