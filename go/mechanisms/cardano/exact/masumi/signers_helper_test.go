package masumi

import (
	"crypto/ed25519"
	"errors"

	"github.com/blinklabs-io/gouroboros/ledger/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// Test-only Ed25519 signers; production signing lives in signers/cardano.

// SignData produces the CIP-30 signData COSE pair for payload under sellerAddress
// with an Ed25519 key, byte-identical to the TypeScript SDK's signer.
func SignData(privateKey ed25519.PrivateKey, sellerAddress string, payload []byte) (SellerAuthorization, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return SellerAuthorization{}, errors.New("invalid ed25519 private key")
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	return signData(publicKey, func(m []byte) []byte { return ed25519.Sign(privateKey, m) }, sellerAddress, payload)
}

// NewSellerSigner derives the seller's enterprise key address on network from
// an Ed25519 key and returns it with a TermsSigner using the same key.
func NewSellerSigner(privateKey ed25519.PrivateKey, network string) (sellerAddress string, signer TermsSigner, err error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return "", nil, errors.New("invalid ed25519 private key")
	}
	networkID, err := cardano.NetworkID(network)
	if err != nil {
		return "", nil, err
	}
	publicKey := privateKey.Public().(ed25519.PublicKey)
	addr, err := common.NewAddressFromParts(common.AddressTypeKeyNone, uint8(networkID), cardano.Blake2b224(publicKey), nil)
	if err != nil {
		return "", nil, err
	}
	return addr.String(), NewTermsSigner(publicKey, func(m []byte) []byte { return ed25519.Sign(privateKey, m) }), nil
}
