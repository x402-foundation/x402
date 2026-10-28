package cardano

import (
	"errors"
	"fmt"
	"strings"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/blinklabs-io/bursa"
	"github.com/blinklabs-io/bursa/bip32"
	"github.com/blinklabs-io/gouroboros/ledger/common"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const hardened = 0x80000000

// NewWallet derives the CIP-1852 base-address wallet of one account (payment
// key 1852'/1815'/account'/0/0, stake key .../2/0) from a BIP-39 mnemonic,
// as Cardano wallets and the TypeScript reference signer do.
func NewWallet(mnemonic string, network string, accountIndex uint32) (*apollo.BursaWallet, error) {
	options, err := walletOptions(network, accountIndex)
	if err != nil {
		return nil, err
	}
	return apollo.NewBursaWallet(normalizeMnemonic(mnemonic), options...)
}

func walletOptions(network string, accountIndex uint32) ([]bursa.WalletOption, error) {
	if accountIndex >= hardened {
		return nil, errors.New("account index out of range")
	}
	var name string
	switch x402cardano.NormalizeNetwork(network) {
	case x402cardano.CardanoMainnetCAIP2:
		name = "mainnet"
	case x402cardano.CardanoPreprodCAIP2:
		name = "preprod"
	case x402cardano.CardanoPreviewCAIP2:
		name = "preview"
	default:
		return nil, fmt.Errorf("unsupported Cardano network: %s", network)
	}
	return []bursa.WalletOption{bursa.WithNetwork(name), bursa.WithAccountID(accountIndex)}, nil
}

// paymentKey derives the account's payment signing key and base address.
func paymentKey(mnemonic string, network string, accountIndex uint32) (bip32.XPrv, string, error) {
	wallet, err := NewWallet(mnemonic, network, accountIndex)
	if err != nil {
		return nil, "", err
	}
	root, err := bursa.GetRootKeyFromMnemonic(normalizeMnemonic(mnemonic), "")
	if err != nil {
		return nil, "", err
	}
	account, err := bursa.GetAccountKey(root, accountIndex)
	if err != nil {
		return nil, "", err
	}
	key, err := bursa.GetPaymentKey(account, 0)
	if err != nil {
		return nil, "", err
	}
	if common.Blake2b224Hash(key.PublicKey()) != wallet.PubKeyHash() {
		return nil, "", errors.New("derived payment key does not control the wallet address")
	}
	return key, wallet.Address().String(), nil
}

// normalizeMnemonic accepts any whitespace and letter case, as wallets do.
func normalizeMnemonic(mnemonic string) string {
	return strings.Join(strings.Fields(strings.ToLower(mnemonic)), " ")
}
