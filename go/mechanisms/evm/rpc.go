package evm

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

// RPCChainConfig configures RPC behavior for a specific chain.
type RPCChainConfig struct {
	RPCURL string
}

// RPCConfig configures RPC behavior for EVM clients that need on-chain reads or fee estimation.
// Chain-specific entries in RPCByChainID take precedence over the top-level RPCURL.
type RPCConfig struct {
	RPCURL       string
	RPCByChainID map[int64]RPCChainConfig
}

// ResolveRPCURL returns the appropriate RPC URL for the given network.
func ResolveRPCURL(config *RPCConfig, network string) string {
	if config == nil {
		return ""
	}
	if len(config.RPCByChainID) > 0 {
		chainID, err := GetEvmChainId(network)
		if err == nil {
			if chainConfig, ok := config.RPCByChainID[chainID.Int64()]; ok && chainConfig.RPCURL != "" {
				return chainConfig.RPCURL
			}
		}
	}
	return config.RPCURL
}

// rpcClientCache is a process-wide cache of ethclient.Client instances keyed by RPC URL.
var rpcClientCache sync.Map // map[string]*ethclient.Client

func getOrCreateRPCClient(ctx context.Context, rpcURL string) (*ethclient.Client, error) {
	if existing, ok := rpcClientCache.Load(rpcURL); ok {
		if cachedClient, ok := existing.(*ethclient.Client); ok {
			return cachedClient, nil
		}
	}
	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, err
	}
	actual, loaded := rpcClientCache.LoadOrStore(rpcURL, client)
	if loaded {
		// Another goroutine stored first; close our duplicate connection.
		client.Close()
		return actual.(*ethclient.Client), nil
	}
	return client, nil
}

type rpcCapabilities struct {
	client *ethclient.Client
}

func newRPCCapabilities(ctx context.Context, rpcURL string) (*rpcCapabilities, error) {
	client, err := getOrCreateRPCClient(ctx, rpcURL)
	if err != nil {
		return nil, err
	}
	return &rpcCapabilities{client: client}, nil
}

func (r *rpcCapabilities) ReadContract(
	ctx context.Context,
	contractAddress string,
	abiBytes []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(abiBytes)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse ABI: %w", err)
	}

	data, err := contractABI.Pack(functionName, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to pack method call: %w", err)
	}

	addr := common.HexToAddress(contractAddress)
	msg := ethereum.CallMsg{
		To:   &addr,
		Data: data,
	}

	result, err := r.client.CallContract(ctx, msg, nil)
	if err != nil {
		return nil, fmt.Errorf("contract call failed: %w", err)
	}

	outputs, err := contractABI.Unpack(functionName, result)
	if err != nil {
		return nil, fmt.Errorf("failed to unpack result: %w", err)
	}
	if len(outputs) == 0 {
		return nil, nil
	}
	if len(outputs) == 1 {
		return outputs[0], nil
	}
	return outputs, nil
}

func (r *rpcCapabilities) GetTransactionCount(ctx context.Context, address string) (uint64, error) {
	nonce, err := r.client.PendingNonceAt(ctx, common.HexToAddress(address))
	if err != nil {
		return 0, fmt.Errorf("failed to get pending nonce: %w", err)
	}
	return nonce, nil
}

func (r *rpcCapabilities) EstimateFeesPerGas(ctx context.Context) (*big.Int, *big.Int, error) {
	gwei := big.NewInt(1_000_000_000)
	fallbackMax := new(big.Int).Mul(big.NewInt(1), gwei)
	fallbackTip := new(big.Int).Div(gwei, big.NewInt(10))

	tip, err := r.client.SuggestGasTipCap(ctx)
	if err != nil {
		return fallbackMax, fallbackTip, err
	}

	header, err := r.client.HeaderByNumber(ctx, nil)
	if err != nil {
		maxFee := new(big.Int).Add(tip, gwei)
		return maxFee, tip, err
	}

	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = gwei
	}
	maxFee := new(big.Int).Add(new(big.Int).Mul(big.NewInt(2), baseFee), tip)
	return maxFee, tip, nil
}

// resolvedReadSigner wraps a base signer with an RPC-backed ReadContract implementation.
type resolvedReadSigner struct {
	base   ClientEvmSigner
	reader func(ctx context.Context, address string, abi []byte, functionName string, args ...interface{}) (interface{}, error)
}

func (s *resolvedReadSigner) Address() string { return s.base.Address() }

func (s *resolvedReadSigner) SignTypedData(
	ctx context.Context,
	domain TypedDataDomain,
	types map[string][]TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	return s.base.SignTypedData(ctx, domain, types, primaryType, message)
}

func (s *resolvedReadSigner) ReadContract(
	ctx context.Context,
	address string,
	abiBytes []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	return s.reader(ctx, address, abiBytes, functionName, args...)
}

// resolvedTxSigner wraps a base signer with RPC-backed nonce and fee estimation.
type resolvedTxSigner struct {
	base         ClientEvmSigner
	signTx       func(ctx context.Context, tx *goethtypes.Transaction) ([]byte, error)
	getNonce     func(ctx context.Context, address string) (uint64, error)
	estimateFees func(ctx context.Context) (maxFeePerGas, maxPriorityFeePerGas *big.Int, err error)
}

func (s *resolvedTxSigner) Address() string { return s.base.Address() }

func (s *resolvedTxSigner) SignTypedData(
	ctx context.Context,
	domain TypedDataDomain,
	types map[string][]TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	return s.base.SignTypedData(ctx, domain, types, primaryType, message)
}

func (s *resolvedTxSigner) SignTransaction(ctx context.Context, tx *goethtypes.Transaction) ([]byte, error) {
	return s.signTx(ctx, tx)
}

func (s *resolvedTxSigner) GetTransactionCount(ctx context.Context, address string) (uint64, error) {
	return s.getNonce(ctx, address)
}

func (s *resolvedTxSigner) EstimateFeesPerGas(ctx context.Context) (*big.Int, *big.Int, error) {
	return s.estimateFees(ctx)
}

// ResolveReadSigner returns a ClientEvmSignerWithReadContract. If the signer already
// implements ReadContract, it is returned as-is. Otherwise an RPC-backed wrapper is
// created using rpcURL; if rpcURL is empty, nil is returned without error.
func ResolveReadSigner(
	ctx context.Context,
	signer ClientEvmSigner,
	rpcURL string,
) (ClientEvmSignerWithReadContract, error) {
	if signerWithRead, ok := signer.(ClientEvmSignerWithReadContract); ok {
		return signerWithRead, nil
	}
	if rpcURL == "" {
		return nil, nil
	}
	rpcCaps, err := newRPCCapabilities(ctx, rpcURL)
	if err != nil {
		return nil, err
	}
	return &resolvedReadSigner{base: signer, reader: rpcCaps.ReadContract}, nil
}

// ResolveTxSigner returns a ClientEvmSignerWithTxSigning. Nonce and fee-estimation
// capabilities are taken from the signer when available, and fall back to the provided
// rpcURL. Returns nil without error when the signer cannot sign transactions or when
// RPC capabilities are needed but rpcURL is empty.
func ResolveTxSigner(
	ctx context.Context,
	signer ClientEvmSigner,
	rpcURL string,
) (ClientEvmSignerWithTxSigning, error) {
	signSigner, ok := signer.(ClientEvmSignerWithSignTransaction)
	if !ok {
		return nil, nil
	}

	var getNonceFn func(ctx context.Context, address string) (uint64, error)
	if nonceSigner, hasNonce := signer.(ClientEvmSignerWithGetTransactionCount); hasNonce {
		getNonceFn = nonceSigner.GetTransactionCount
	}

	var estimateFeesFn func(ctx context.Context) (maxFeePerGas, maxPriorityFeePerGas *big.Int, err error)
	if feeSigner, hasFees := signer.(ClientEvmSignerWithEstimateFeesPerGas); hasFees {
		estimateFeesFn = feeSigner.EstimateFeesPerGas
	}

	if getNonceFn == nil || estimateFeesFn == nil {
		if rpcURL == "" {
			return nil, nil
		}
		rpcCaps, err := newRPCCapabilities(ctx, rpcURL)
		if err != nil {
			return nil, err
		}
		if getNonceFn == nil {
			getNonceFn = rpcCaps.GetTransactionCount
		}
		if estimateFeesFn == nil {
			estimateFeesFn = rpcCaps.EstimateFeesPerGas
		}
	}

	return &resolvedTxSigner{
		base:         signer,
		signTx:       signSigner.SignTransaction,
		getNonce:     getNonceFn,
		estimateFees: estimateFeesFn,
	}, nil
}
