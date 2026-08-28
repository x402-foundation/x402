package main

import (
	"context"

	e2eclient "github.com/x402-foundation/x402/e2e/clients/go"
)

func main() {
	client := e2eclient.CreateClient()
	if client == nil {
		return
	}
	e2eclient.RunScenario(context.Background(), client)
}
