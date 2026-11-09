package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	evmmech "github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapturefac "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
)

// facilitatorEvmSigner implements evmmech.FacilitatorEvmSigner.
type facilitatorEvmSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
	client     *ethclient.Client
	chainID    *big.Int
}

func newFacilitatorEvmSigner(privateKeyHex string, rpcURL string) (*facilitatorEvmSigner, error) {
	pk, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial RPC: %w", err)
	}
	chainID, err := client.ChainID(context.Background())
	if err != nil {
		return nil, fmt.Errorf("get chain ID: %w", err)
	}
	return &facilitatorEvmSigner{
		privateKey: pk,
		address:    crypto.PubkeyToAddress(pk.PublicKey),
		client:     client,
		chainID:    chainID,
	}, nil
}

func (s *facilitatorEvmSigner) GetAddresses() []string {
	return []string{s.address.Hex()}
}

func (s *facilitatorEvmSigner) GetChainID(_ context.Context) (*big.Int, error) {
	return s.chainID, nil
}

func (s *facilitatorEvmSigner) VerifyTypedData(
	_ context.Context,
	address string,
	domain evmmech.TypedDataDomain,
	types map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	td := buildTypedData(domain, types, primaryType, message)

	dataHash, err := td.HashStruct(td.PrimaryType, td.Message)
	if err != nil {
		return false, fmt.Errorf("hash struct: %w", err)
	}
	domainSep, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		return false, fmt.Errorf("hash domain: %w", err)
	}
	digest := crypto.Keccak256(append([]byte{0x19, 0x01}, append(domainSep, dataHash...)...))

	if len(signature) != 65 {
		return false, fmt.Errorf("invalid signature length: %d", len(signature))
	}
	sig := make([]byte, 65)
	copy(sig, signature)
	if sig[64] >= 27 {
		sig[64] -= 27
	}

	pub, err := crypto.SigToPub(digest, sig)
	if err != nil {
		return false, fmt.Errorf("recover pubkey: %w", err)
	}
	return bytes.Equal(crypto.PubkeyToAddress(*pub).Bytes(), common.HexToAddress(address).Bytes()), nil
}

func (s *facilitatorEvmSigner) ReadContract(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	args ...interface{},
) (interface{}, error) {
	return s.ReadContractFrom(ctx, s.address.Hex(), contractAddress, abiJSON, method, args...)
}

// ReadContractFrom implements the auth-capture facilitator's SenderReader: the escrow gates
// capture and void on msg.sender, so simulations must call as the operator.
func (s *facilitatorEvmSigner) ReadContractFrom(
	ctx context.Context,
	from string,
	contractAddress string,
	abiJSON []byte,
	method string,
	args ...interface{},
) (interface{}, error) {
	parsedABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return nil, fmt.Errorf("parse ABI: %w", err)
	}
	methodObj, ok := parsedABI.Methods[method]
	if !ok {
		return nil, fmt.Errorf("method %s not found", method)
	}
	data, err := parsedABI.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("pack call: %w", err)
	}
	to := common.HexToAddress(contractAddress)
	out, err := s.client.CallContract(ctx, ethereum.CallMsg{From: common.HexToAddress(from), To: &to, Data: data}, nil)
	if err != nil {
		return nil, fmt.Errorf("call contract: %w", err)
	}
	if len(methodObj.Outputs) == 0 {
		return nil, nil
	}
	results, err := methodObj.Outputs.Unpack(out)
	if err != nil {
		return nil, fmt.Errorf("unpack: %w", err)
	}
	if len(results) > 0 {
		return results[0], nil
	}
	return nil, nil
}

func (s *facilitatorEvmSigner) WriteContract(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	dataSuffix []byte,
	args ...interface{},
) (string, error) {
	return s.WriteContractWithGas(ctx, contractAddress, abiJSON, method, dataSuffix, 500_000, args...)
}

func (s *facilitatorEvmSigner) WriteContractWithGas(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	dataSuffix []byte,
	gas uint64,
	args ...interface{},
) (string, error) {
	parsedABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return "", fmt.Errorf("parse ABI: %w", err)
	}
	data, err := parsedABI.Pack(method, args...)
	if err != nil {
		return "", fmt.Errorf("pack call: %w", err)
	}
	data = evmmech.AppendDataSuffix(data, dataSuffix)
	if gas == 0 {
		gas = 500_000
	}
	return s.sendTransactionWithGas(ctx, contractAddress, data, gas)
}

func (s *facilitatorEvmSigner) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	return s.sendTransactionWithGas(ctx, to, data, 500_000)
}

func (s *facilitatorEvmSigner) sendTransactionWithGas(ctx context.Context, to string, data []byte, gas uint64) (string, error) {
	nonce, err := s.client.PendingNonceAt(ctx, s.address)
	if err != nil {
		return "", fmt.Errorf("get nonce: %w", err)
	}
	gasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("suggest gas price: %w", err)
	}
	toAddr := common.HexToAddress(to)
	tx := types.NewTransaction(nonce, toAddr, big.NewInt(0), gas, gasPrice, data)
	signedTx, err := types.SignTx(tx, types.LatestSignerForChainID(s.chainID), s.privateKey)
	if err != nil {
		return "", fmt.Errorf("sign tx: %w", err)
	}
	if err := s.client.SendTransaction(ctx, signedTx); err != nil {
		return "", fmt.Errorf("send tx: %w", err)
	}
	return signedTx.Hash().Hex(), nil
}

type rpcSimulateCall struct {
	From string `json:"from"`
	To   string `json:"to"`
	Data string `json:"data"`
	Gas  string `json:"gas,omitempty"`
}

type rpcSimulateLog struct {
	Address string   `json:"address"`
	Topics  []string `json:"topics"`
	Data    string   `json:"data"`
}

type rpcSimulateCallOutcome struct {
	Status     string           `json:"status"`
	ReturnData string           `json:"returnData"`
	GasUsed    string           `json:"gasUsed"`
	Logs       []rpcSimulateLog `json:"logs"`
	Error      *struct {
		Data string `json:"data"`
	} `json:"error,omitempty"`
}

type rpcSimulatedBlock struct {
	Calls []rpcSimulateCallOutcome `json:"calls"`
}

func (s *facilitatorEvmSigner) SimulateCalls(
	ctx context.Context,
	from string,
	calls []authcapturefac.SimulatedCall,
) ([]authcapturefac.SimulatedCallResult, error) {
	rpcCalls := make([]rpcSimulateCall, len(calls))
	for i, call := range calls {
		data := call.Data
		if len(data) == 0 {
			data = []byte{}
		}
		entry := rpcSimulateCall{
			From: common.HexToAddress(from).Hex(),
			To:   common.HexToAddress(call.To).Hex(),
			Data: hexutil.Encode(data),
		}
		if call.Gas > 0 {
			entry.Gas = hexutil.EncodeUint64(call.Gas)
		}
		rpcCalls[i] = entry
	}

	var blocks []rpcSimulatedBlock
	err := s.client.Client().CallContext(ctx, &blocks, "eth_simulateV1", []interface{}{
		map[string]interface{}{
			"blockStateCalls": []map[string]interface{}{
				{"calls": rpcCalls},
			},
		},
		"latest",
	}...)
	if err != nil {
		return nil, fmt.Errorf("eth_simulateV1 failed: %w", err)
	}
	if len(blocks) == 0 || len(blocks[0].Calls) != len(calls) {
		return nil, fmt.Errorf("eth_simulateV1 returned unexpected call count")
	}

	results := make([]authcapturefac.SimulatedCallResult, len(calls))
	for i, outcome := range blocks[0].Calls {
		returnData := outcome.ReturnData
		if outcome.Error != nil && outcome.Error.Data != "" {
			returnData = outcome.Error.Data
		}
		if returnData == "" {
			returnData = "0x"
		}
		data, err := hexutil.Decode(returnData)
		if err != nil {
			return nil, fmt.Errorf("invalid simulate return data: %w", err)
		}
		var gasUsed uint64
		if outcome.GasUsed != "" {
			gasUsed, err = hexutil.DecodeUint64(outcome.GasUsed)
			if err != nil {
				return nil, fmt.Errorf("invalid simulate gasUsed: %w", err)
			}
		}
		results[i] = authcapturefac.SimulatedCallResult{
			Success:    outcome.Status == "0x1",
			ReturnData: data,
			GasUsed:    gasUsed,
			Logs:       parseSimulateLogs(outcome.Logs),
		}
	}
	return results, nil
}

func parseSimulateLogs(logs []rpcSimulateLog) []*types.Log {
	parsed := make([]*types.Log, 0, len(logs))
	for _, log := range logs {
		topics := make([]common.Hash, len(log.Topics))
		for i, topic := range log.Topics {
			topics[i] = common.HexToHash(topic)
		}
		data, err := hexutil.Decode(log.Data)
		if err != nil {
			data = []byte{}
		}
		parsed = append(parsed, &types.Log{
			Address: common.HexToAddress(log.Address),
			Topics:  topics,
			Data:    data,
		})
	}
	return parsed
}

func (s *facilitatorEvmSigner) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evmmech.TransactionReceipt, error) {
	hash := common.HexToHash(txHash)
	for i := 0; i < 60; i++ {
		receipt, err := s.client.TransactionReceipt(ctx, hash)
		if err == nil && receipt != nil {
			return &evmmech.TransactionReceipt{
				Status:      uint64(receipt.Status),
				BlockNumber: receipt.BlockNumber.Uint64(),
				TxHash:      receipt.TxHash.Hex(),
				Logs:        receipt.Logs,
			}, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return nil, fmt.Errorf("transaction receipt not found")
}

func (s *facilitatorEvmSigner) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	if tokenAddress == "" || tokenAddress == "0x0000000000000000000000000000000000000000" {
		return s.client.BalanceAt(ctx, common.HexToAddress(address), nil)
	}
	const erc20ABI = `[{"constant":true,"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}]`
	out, err := s.ReadContract(ctx, tokenAddress, []byte(erc20ABI), "balanceOf", common.HexToAddress(address))
	if err != nil {
		return nil, err
	}
	if balance, ok := out.(*big.Int); ok {
		return balance, nil
	}
	return nil, fmt.Errorf("unexpected balance type: %T", out)
}

func (s *facilitatorEvmSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	return s.client.CodeAt(ctx, common.HexToAddress(address), nil)
}

func buildTypedData(
	domain evmmech.TypedDataDomain,
	in map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
) apitypes.TypedData {
	td := apitypes.TypedData{
		Types:       apitypes.Types{},
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              toString(domain.Name),
			Version:           toString(domain.Version),
			ChainId:           toHexBigInt(domain.ChainID),
			VerifyingContract: toString(domain.VerifyingContract),
		},
		Message: message,
	}
	for name, fields := range in {
		conv := make([]apitypes.Type, len(fields))
		for i, f := range fields {
			conv[i] = apitypes.Type{Name: f.Name, Type: f.Type}
		}
		td.Types[name] = conv
	}
	if _, ok := td.Types["EIP712Domain"]; !ok {
		td.Types["EIP712Domain"] = []apitypes.Type{
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		}
	}
	return td
}

func toString(v interface{}) string {
	switch s := v.(type) {
	case string:
		return s
	case *string:
		if s != nil {
			return *s
		}
	}
	return ""
}

func toHexBigInt(v interface{}) *math.HexOrDecimal256 {
	switch n := v.(type) {
	case *big.Int:
		return (*math.HexOrDecimal256)(n)
	case int64:
		return (*math.HexOrDecimal256)(big.NewInt(n))
	case string:
		b, ok := new(big.Int).SetString(n, 10)
		if ok {
			return (*math.HexOrDecimal256)(b)
		}
	}
	return (*math.HexOrDecimal256)(big.NewInt(0))
}

// WriteContractFrom ignores from: this signer holds a single address.
func (r *facilitatorEvmSigner) WriteContractFrom(ctx context.Context, _, address string, abiJSON []byte, functionName string, dataSuffix []byte, args ...interface{}) (string, error) {
	return r.WriteContract(ctx, address, abiJSON, functionName, dataSuffix, args...)
}
