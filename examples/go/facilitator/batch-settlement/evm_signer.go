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
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	evmmech "github.com/x402-foundation/x402/go/mechanisms/evm"
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
	out, err := s.client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
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
	return s.SendTransaction(ctx, contractAddress, data)
}

func (s *facilitatorEvmSigner) SendTransaction(ctx context.Context, to string, data []byte) (string, error) {
	nonce, err := s.client.PendingNonceAt(ctx, s.address)
	if err != nil {
		return "", fmt.Errorf("get nonce: %w", err)
	}
	gasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("suggest gas price: %w", err)
	}
	toAddr := common.HexToAddress(to)
	tx := types.NewTransaction(nonce, toAddr, big.NewInt(0), 500000, gasPrice, data)
	signedTx, err := types.SignTx(tx, types.LatestSignerForChainID(s.chainID), s.privateKey)
	if err != nil {
		return "", fmt.Errorf("sign tx: %w", err)
	}
	if err := s.client.SendTransaction(ctx, signedTx); err != nil {
		return "", fmt.Errorf("send tx: %w", err)
	}
	return signedTx.Hash().Hex(), nil
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
