package main

import (
	"fmt"
	"os"
)

// MCP Client Example Entry Point
//
// Routes to either simple or advanced example based on CLI arguments.
//
// Usage:
//
//	go run . simple           - Run simple example (NewX402MCPClient with x402Client)
//	go run . advanced         - Run advanced example (X402MCPClient with manual setup)

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
	default:
		if err := runSimple(); err != nil {
			fmt.Printf("Fatal error: %v\n", err)
			os.Exit(1)
		}
	}
}
