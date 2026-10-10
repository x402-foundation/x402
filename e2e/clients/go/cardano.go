package client

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/client"
	cardanosigners "github.com/x402-foundation/x402/go/v2/signers/cardano"
)

// cardanoClientMnemonic is CLIENT_CARDANO_MNEMONIC when the Blockfrost
// endpoint is configured too, as the TypeScript client requires; else "".
func cardanoClientMnemonic() string {
	mnemonic := os.Getenv("CLIENT_CARDANO_MNEMONIC")
	if mnemonic == "" || os.Getenv("CARDANO_RPC_URL") == "" || os.Getenv("BLOCKFROST_PROJECT_ID") == "" {
		return ""
	}
	return mnemonic
}

// newCardanoClientScheme builds the Blockfrost-backed Cardano exact client.
func newCardanoClientScheme(mnemonic string) *cardano.ExactCardanoScheme {
	signer, err := cardanosigners.NewClientSigner(cardanosigners.ClientSignerConfig{
		Mnemonic: mnemonic,
		Network:  resolveNetworkCaip2("cardano"),
		Provider: cardanosigners.NewBlockfrost(os.Getenv("CARDANO_RPC_URL"), os.Getenv("BLOCKFROST_PROJECT_ID"), 0),
	})
	if err != nil {
		OutputError(fmt.Sprintf("Failed to create Cardano signer: %v", err))
	}
	return cardano.NewExactCardanoScheme(signer)
}

// awaitCardanoWalletSettled waits until Blockfrost lists the payment's change
// output. Sequential e2e clients are separate processes and Blockfrost cannot
// see mempool spends, so the next client would otherwise reuse the same input.
func awaitCardanoWalletSettled(ctx context.Context, result StepResult) {
	receipt, ok := result.PaymentResponse.(*x402.SettleResponse)
	if !ok || receipt == nil || !strings.HasPrefix(string(receipt.Network), "cardano:") {
		return
	}
	baseURL, projectID := os.Getenv("CARDANO_RPC_URL"), os.Getenv("BLOCKFROST_PROJECT_ID")
	if receipt.Transaction == "" || receipt.Payer == "" || baseURL == "" || projectID == "" {
		return
	}
	provider := cardanosigners.NewBlockfrost(baseURL, projectID, 0)
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		if utxos, err := provider.UtxosAt(ctx, receipt.Payer); err == nil {
			for _, u := range utxos {
				if u.TxHash == receipt.Transaction {
					return
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}
