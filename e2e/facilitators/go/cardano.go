package main

import (
	"log"
	"os"
	"strings"

	cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/facilitator"
	cardanosigners "github.com/x402-foundation/x402/go/v2/signers/cardano"
)

// newCardanoFacilitatorScheme builds the Blockfrost-backed Cardano exact facilitator.
func newCardanoFacilitatorScheme(network, rpcURL, projectID string) *cardano.ExactCardanoScheme {
	log.Printf("🌐 Cardano Network: %s", network)
	var addresses []string
	if mnemonic := os.Getenv("FACILITATOR_CARDANO_MNEMONIC"); mnemonic != "" {
		wallet, err := cardanosigners.NewWalletFromMnemonic(mnemonic, network, 0)
		if err != nil {
			log.Fatalf("Invalid FACILITATOR_CARDANO_MNEMONIC: %v", err)
		}
		addresses = []string{wallet.Address()}
	}
	signer, err := cardanosigners.NewFacilitatorSigner(cardanosigners.FacilitatorSignerConfig{
		Network:   network,
		Provider:  cardanosigners.NewBlockfrost(rpcURL, projectID, 0),
		Addresses: addresses,
	})
	if err != nil {
		log.Fatalf("Failed to create Cardano signer: %v", err)
	}
	account := "(provider-only, no wallet)"
	if addresses := signer.GetAddresses(); len(addresses) > 0 {
		account = addresses[0]
	}
	log.Printf("Cardano Facilitator account: %s", account)
	return cardano.NewExactCardanoScheme(signer.AsFacilitatorSigner(), &cardano.Config{
		AcceptMempool: strings.TrimSpace(os.Getenv("CARDANO_L1_CONFIRMATIONS")) == "-1",
	})
}
