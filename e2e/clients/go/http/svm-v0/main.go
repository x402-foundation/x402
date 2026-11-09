// Command svm-v0 is an SVM-only net/http e2e client that builds Solana
// version-0 transactions.
//
// Clients build the highest transaction version the facilitator advertises in
// extra.transactionVersions, so every other client exercises version 1 against
// facilitators that advertise [0, 1]. Narrowing to [0] keeps the version-0
// path covered end to end.
package main

import (
	"context"

	e2eclient "github.com/x402-foundation/x402/e2e/clients/go"
)

func main() {
	client := e2eclient.CreateClientWithOptions(e2eclient.PaymentClientOptions{
		SvmOnly:                true,
		SvmTransactionVersions: []int{0},
	})
	if client == nil {
		return
	}
	e2eclient.RunScenario(context.Background(), client)
}
