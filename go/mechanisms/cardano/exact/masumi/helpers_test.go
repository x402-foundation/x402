package masumi

import (
	"github.com/blinklabs-io/gouroboros/ledger/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

func cardanoEnterpriseKeyAddress(keyHash []byte, network string) (string, error) {
	id, err := cardano.NetworkID(network)
	if err != nil {
		return "", err
	}
	addr, err := common.NewAddressFromParts(common.AddressTypeKeyNone, uint8(id), keyHash, nil)
	if err != nil {
		return "", err
	}
	return addr.String(), nil
}
