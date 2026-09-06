package main

import (
	"fmt"
	"os"
)

// MCP Server Example Entry Point
//
// Routes to simple, advanced, or existing-server example based on CLI arguments.
//
// Usage:
//
//	go run . simple           - Run simple example (NewPaymentWrapper)
//	go run . advanced         - Run advanced example (NewPaymentWrapper with hooks)
//	go run . existing         - Run existing server example (NewPaymentWrapper with existing server)

func main() {
	mode := "simple"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}

	switch mode {
	case "advanced":
		if err := runAdvanced(); err != nil {
			fmt.Printf("Fatal error: %v\n", err)
			os.Exit(1)
		}
	case "existing":
		if err := runExisting(); err != nil {
			fmt.Printf("Fatal error: %v\n", err)
			os.Exit(1)
		}
	default:
		if err := runSimple(); err != nil {
			fmt.Printf("Fatal error: %v\n", err)
			os.Exit(1)
		}
	}
}
