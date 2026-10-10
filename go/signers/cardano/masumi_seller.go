package cardano

import (
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
)

// NewMasumiSellerSigner returns the seller's base address and a Masumi terms
// signer using the account's CIP-1852 payment key, as the TypeScript
// toMasumiSellerSigner does.
func NewMasumiSellerSigner(mnemonic, network string, accountIndex uint32) (sellerAddress string, signer masumi.TermsSigner, err error) {
	wallet, err := NewWalletFromMnemonic(mnemonic, network, accountIndex)
	if err != nil {
		return "", nil, err
	}
	return wallet.Address(), masumi.NewTermsSigner(wallet.PaymentPublicKey(), wallet.payment.sign), nil
}
