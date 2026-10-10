package cardano

import (
	"encoding/hex"
	"fmt"

	"github.com/blinklabs-io/gouroboros/ledger/common"
	"golang.org/x/crypto/blake2b"
)

// Credential is a 28-byte payment or stake credential.
type Credential struct {
	Hash     []byte
	IsScript bool
}

// HashHex returns the lowercase hex of the credential hash.
func (c Credential) HashHex() string { return hex.EncodeToString(c.Hash) }

// ParseAddress decodes a bech32 Shelley address. Byron addresses are rejected.
func ParseAddress(address string) (common.Address, error) {
	addr, err := common.NewAddress(address)
	if err != nil {
		return common.Address{}, fmt.Errorf("invalid Cardano address: %w", err)
	}
	if addr.Type() == common.AddressTypeByron {
		return common.Address{}, fmt.Errorf("byron addresses are not supported: %s", address)
	}
	return addr, nil
}

// AddressFromBytes encodes raw address bytes as bech32.
func AddressFromBytes(raw []byte) (string, error) {
	addr, err := common.NewAddressFromBytes(raw)
	if err != nil {
		return "", err
	}
	return addr.String(), nil
}

// PaymentCredential returns the payment credential of a bech32 address.
func PaymentCredential(address string) (Credential, error) {
	addr, err := ParseAddress(address)
	if err != nil {
		return Credential{}, err
	}
	return paymentCredentialOf(addr)
}

func paymentCredentialOf(addr common.Address) (Credential, error) {
	switch p := addr.PayloadPayload().(type) {
	case common.AddressPayloadKeyHash:
		return Credential{Hash: p.Hash.Bytes()}, nil
	case common.AddressPayloadScriptHash:
		return Credential{Hash: p.Hash.Bytes(), IsScript: true}, nil
	}
	return Credential{}, fmt.Errorf("address has no payment credential")
}

// AddressNetworkID returns the network id encoded in a bech32 address.
func AddressNetworkID(address string) (int, error) {
	addr, err := ParseAddress(address)
	if err != nil {
		return 0, err
	}
	return int(addr.NetworkId()), nil
}

// Blake2b224 hashes data to 28 bytes (key and script hashes).
func Blake2b224(data []byte) []byte {
	h, _ := blake2b.New(28, nil)
	h.Write(data)
	return h.Sum(nil)
}

// Blake2b256 hashes data to 32 bytes (transaction ids).
func Blake2b256(data []byte) []byte {
	sum := blake2b.Sum256(data)
	return sum[:]
}
