package masumi

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/plutigo/data"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/script"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const (
	maxScriptHashCacheEntries = 256
	plutusV3Tag               = 0x03
)

// DefaultDeployment returns the canonical deployment parameters used on Mainnet
// and Preprod when extra.deployment is absent.
func DefaultDeployment() Deployment {
	return Deployment{
		RequiredAdmins: "2",
		AdminVkeys: []string{
			"fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75",
			"7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6",
			"89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6",
		},
		CooldownPeriod: "420000",
	}
}

// ResolveDeployment returns the declared deployment, else the canonical one;
// ok is false on Preview, which has no canonical deployment.
func ResolveDeployment(network string, declared *Deployment) (deployment Deployment, ok bool) {
	if declared != nil {
		return *declared, true
	}
	if cardano.NormalizeNetwork(network) == cardano.CardanoPreviewCAIP2 {
		return Deployment{}, false
	}
	return DefaultDeployment(), true
}

var scriptHashCache = struct {
	sync.Mutex
	order  []string
	hashes map[string]string
}{hashes: map[string]string{}}

// EscrowScriptHash applies the deployment's three parameters to the canonical
// validator and returns the escrow script hash. Admin key order and duplicates
// are preserved.
func EscrowScriptHash(deployment Deployment) (string, error) {
	cacheKey := deployment.RequiredAdmins + "|" + strings.Join(deployment.AdminVkeys, ",") + "|" + deployment.CooldownPeriod
	scriptHashCache.Lock()
	cached, ok := scriptHashCache.hashes[cacheKey]
	scriptHashCache.Unlock()
	if ok {
		return cached, nil
	}

	required, ok := new(big.Int).SetString(deployment.RequiredAdmins, 10)
	if !ok {
		return "", fmt.Errorf("invalid requiredAdmins %q", deployment.RequiredAdmins)
	}
	cooldown, ok := new(big.Int).SetString(deployment.CooldownPeriod, 10)
	if !ok {
		return "", fmt.Errorf("invalid cooldownPeriod %q", deployment.CooldownPeriod)
	}
	vkeys := make([]data.PlutusData, len(deployment.AdminVkeys))
	for i, vkey := range deployment.AdminVkeys {
		b, err := hex.DecodeString(vkey)
		if err != nil {
			return "", fmt.Errorf("invalid admin vkey %q", vkey)
		}
		vkeys[i] = data.NewByteString(b)
	}
	code, _ := hex.DecodeString(VestedPayCompiledCode)
	applied, err := script.ApplyParams(code, []data.PlutusData{
		data.NewInteger(required), data.NewList(vkeys...), data.NewInteger(cooldown),
	})
	if err != nil {
		return "", err
	}
	hash := hex.EncodeToString(cardano.Blake2b224(append([]byte{plutusV3Tag}, applied...)))

	scriptHashCache.Lock()
	defer scriptHashCache.Unlock()
	if _, exists := scriptHashCache.hashes[cacheKey]; !exists {
		if len(scriptHashCache.order) >= maxScriptHashCacheEntries {
			delete(scriptHashCache.hashes, scriptHashCache.order[0])
			scriptHashCache.order = scriptHashCache.order[1:]
		}
		scriptHashCache.order = append(scriptHashCache.order, cacheKey)
		scriptHashCache.hashes[cacheKey] = hash
	}
	return hash, nil
}

// EscrowAddress is the bech32 enterprise script address of the escrow for a
// deployment on a network.
func EscrowAddress(network string, deployment Deployment) (string, error) {
	networkID, err := cardano.NetworkID(network)
	if err != nil {
		return "", err
	}
	hash, err := EscrowScriptHash(deployment)
	if err != nil {
		return "", err
	}
	raw, _ := hex.DecodeString(hash)
	addr, err := common.NewAddressFromParts(common.AddressTypeScriptNone, uint8(networkID), raw, nil)
	if err != nil {
		return "", err
	}
	return addr.String(), nil
}
