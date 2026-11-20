package cardano

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"

	"github.com/Salvionied/apollo/v2/backend"
	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/gouroboros/ledger/mary"
	"github.com/blinklabs-io/gouroboros/ledger/shelley"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// errProviderUnsupported marks a chain operation the client signer never uses.
var errProviderUnsupported = errors.New("not supported by the x402 Blockfrost provider")

// NewBlockfrostProvider returns a ClientSignerConfig.Provider that reads a
// Blockfrost-compatible API at baseURL exactly as given, e.g.
// DefaultBlockfrostURL(network) or a compatible API served at its root.
// Only protocol parameters and wallet UTxOs are read; the client never submits.
func NewBlockfrostProvider(baseURL, projectID, network string) (backend.ChainContext, error) {
	networkID, err := x402cardano.NetworkID(network)
	if err != nil {
		return nil, err
	}
	return &blockfrostProvider{bf: NewBlockfrost(baseURL, projectID, 0), networkID: uint8(networkID)}, nil
}

var (
	_ backend.ChainContext        = (*blockfrostProvider)(nil)
	_ backend.ContextChainContext = (*blockfrostProvider)(nil)
)

type blockfrostProvider struct {
	bf        *Blockfrost
	networkID uint8
}

func (p *blockfrostProvider) ProtocolParamsContext(ctx context.Context) (backend.ProtocolParameters, error) {
	params, err := p.bf.ProtocolParameters(ctx)
	if err != nil {
		return backend.ProtocolParameters{}, err
	}
	if params.MinFeeA > uint64(1<<62) || params.MinFeeB > uint64(1<<62) {
		return backend.ProtocolParameters{}, errors.New("blockfrost fee parameters out of range")
	}
	return backend.ProtocolParameters{
		MinFeeCoefficient:    int64(params.MinFeeA),
		MinFeeConstant:       int64(params.MinFeeB),
		MaxTxSize:            params.MaxTxSize,
		CoinsPerUtxoByte:     strconv.FormatUint(params.CoinsPerUtxoByte, 10),
		MaxValSize:           strconv.FormatUint(params.MaxValueSize, 10),
		CollateralPercent:    int(params.CollateralPercentage),
		MaxCollateralInputs:  int(params.MaxCollateralInputs),
		ProtocolMajorVersion: int(params.ProtocolMajor),
		ProtocolMinorVersion: int(params.ProtocolMinor),
	}, nil
}

// UtxosContext returns the address's UTxOs, leaving out those carrying a
// reference script, whose script this provider does not fetch.
func (p *blockfrostProvider) UtxosContext(ctx context.Context, address common.Address) ([]common.Utxo, error) {
	raw, err := p.bf.utxosAt(ctx, address.String(), 0)
	if err != nil {
		return nil, err
	}
	utxos := make([]common.Utxo, 0, len(raw))
	for _, u := range raw {
		if u.HasReferenceScript {
			continue
		}
		utxo, err := ledgerUtxoOf(u, address)
		if err != nil {
			return nil, err
		}
		utxos = append(utxos, utxo)
	}
	return utxos, nil
}

func ledgerUtxoOf(u Utxo, address common.Address) (common.Utxo, error) {
	in, err := shelley.NewShelleyTransactionInput(u.TxHash, int(u.Index))
	if err != nil {
		return common.Utxo{}, err
	}
	value := mary.MaryTransactionOutputValue{Amount: u.Coin}
	if len(u.Assets) > 0 {
		assets := map[common.Blake2b224]map[cbor.ByteString]*big.Int{}
		for unit, quantity := range u.Assets {
			policy, name, err := x402cardano.ParseAssetUnit(unit)
			if err != nil || policy == "" {
				return common.Utxo{}, fmt.Errorf("invalid asset unit %q", unit)
			}
			id, nameBytes, err := assetKey(policy, name)
			if err != nil {
				return common.Utxo{}, err
			}
			if assets[id] == nil {
				assets[id] = map[cbor.ByteString]*big.Int{}
			}
			assets[id][cbor.NewByteString(nameBytes)] = new(big.Int).SetUint64(quantity)
		}
		multi := common.NewMultiAsset[common.MultiAssetTypeOutput](assets)
		value.Assets = &multi
	}
	return common.Utxo{Id: in, Output: &babbage.BabbageTransactionOutput{OutputAddress: address, OutputAmount: value}}, nil
}

func (p *blockfrostProvider) ProtocolParams() (backend.ProtocolParameters, error) {
	return p.ProtocolParamsContext(context.Background())
}

func (p *blockfrostProvider) Utxos(address common.Address) ([]common.Utxo, error) {
	return p.UtxosContext(context.Background(), address)
}

func (p *blockfrostProvider) NetworkId() uint8 { return p.networkID }

func (p *blockfrostProvider) GenesisParams() (backend.GenesisParameters, error) {
	return backend.GenesisParameters{}, errProviderUnsupported
}

func (p *blockfrostProvider) GenesisParamsContext(context.Context) (backend.GenesisParameters, error) {
	return backend.GenesisParameters{}, errProviderUnsupported
}

func (p *blockfrostProvider) CurrentEpoch() (uint64, error) { return 0, errProviderUnsupported }

func (p *blockfrostProvider) CurrentEpochContext(context.Context) (uint64, error) {
	return 0, errProviderUnsupported
}

func (p *blockfrostProvider) MaxTxFee() (uint64, error) { return 0, errProviderUnsupported }

func (p *blockfrostProvider) MaxTxFeeContext(context.Context) (uint64, error) {
	return 0, errProviderUnsupported
}

func (p *blockfrostProvider) Tip() (uint64, error) { return 0, errProviderUnsupported }

func (p *blockfrostProvider) TipContext(context.Context) (uint64, error) {
	return 0, errProviderUnsupported
}

func (p *blockfrostProvider) SubmitTx([]byte) (common.Blake2b256, error) {
	return common.Blake2b256{}, errProviderUnsupported
}

func (p *blockfrostProvider) SubmitTxContext(context.Context, []byte) (common.Blake2b256, error) {
	return common.Blake2b256{}, errProviderUnsupported
}

func (p *blockfrostProvider) EvaluateTx([]byte, []common.Utxo) (map[common.RedeemerKey]common.ExUnits, error) {
	return nil, errProviderUnsupported
}

func (p *blockfrostProvider) EvaluateTxContext(context.Context, []byte, []common.Utxo) (map[common.RedeemerKey]common.ExUnits, error) {
	return nil, errProviderUnsupported
}

func (p *blockfrostProvider) UtxoByRef(common.Blake2b256, uint32) (*common.Utxo, error) {
	return nil, errProviderUnsupported
}

func (p *blockfrostProvider) UtxoByRefContext(context.Context, common.Blake2b256, uint32) (*common.Utxo, error) {
	return nil, errProviderUnsupported
}

func (p *blockfrostProvider) ScriptCbor(common.Blake2b224) ([]byte, error) {
	return nil, errProviderUnsupported
}

func (p *blockfrostProvider) ScriptCborContext(context.Context, common.Blake2b224) ([]byte, error) {
	return nil, errProviderUnsupported
}
