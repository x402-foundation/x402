package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"os"
	"strings"
	"time"

	commerceclient "github.com/coinbase/x402/go/mechanisms/evm/commerce/client"
	commercefacilitator "github.com/coinbase/x402/go/mechanisms/evm/commerce/facilitator"
	evmmech "github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
	goeth "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	"github.com/joho/godotenv"
)

const (
	// Base Mainnet network identifier
	Network = "eip155:8453"

	// Contract addresses on Base Mainnet
	EscrowAddress         = "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff"
	TokenCollectorAddress = "0x0E3dF9510de65469C4518D7843919c0b8C7A7757"
	OperatorAddress       = "0x6Ca3B21D18E2B60291413c99DD6969c43d26c3D2"
	USDCAddress           = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
)

func main() {
	// Load .env file if present
	_ = godotenv.Load()

	clientPrivateKey := os.Getenv("CLIENT_PRIVATE_KEY")
	operatorPrivateKey := os.Getenv("OPERATOR_PRIVATE_KEY")
	rpcURL := os.Getenv("RPC_URL")
	receiverAddress := os.Getenv("RECEIVER_ADDRESS")

	if clientPrivateKey == "" || operatorPrivateKey == "" || rpcURL == "" || receiverAddress == "" {
		fmt.Println("Error: Missing required environment variables.")
		fmt.Println("Please set CLIENT_PRIVATE_KEY, OPERATOR_PRIVATE_KEY, RPC_URL, and RECEIVER_ADDRESS")
		fmt.Println("See .env-example for details.")
		os.Exit(1)
	}

	escrowAddress := os.Getenv("ESCROW_ADDRESS")
	if escrowAddress == "" {
		escrowAddress = EscrowAddress
	}
	tokenCollector := os.Getenv("TOKEN_COLLECTOR_ADDRESS")
	if tokenCollector == "" {
		tokenCollector = TokenCollectorAddress
	}

	ctx := context.Background()

	// --- Client Setup ---
	fmt.Println("Setting up client signer...")
	clientSigner, err := newClientEvmSigner(clientPrivateKey, rpcURL)
	if err != nil {
		fmt.Printf("Failed to create client signer: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Client address: %s\n", clientSigner.Address())

	clientScheme := commerceclient.NewCommerceEvmScheme(clientSigner)

	// --- Facilitator Setup ---
	fmt.Println("Setting up facilitator signer...")
	facilitatorSigner, err := newFacilitatorEvmSigner(operatorPrivateKey, rpcURL)
	if err != nil {
		fmt.Printf("Failed to create facilitator signer: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Facilitator/Operator address: %s\n", facilitatorSigner.GetAddresses()[0])

	facilitatorScheme := commercefacilitator.NewCommerceEvmScheme(facilitatorSigner)

	// --- Server: Build Payment Requirements ---
	fmt.Println("\n--- Building Payment Requirements (Server) ---")
	requirements := types.PaymentRequirements{
		Scheme:            evmmech.SchemeCommerce,
		Network:           Network,
		Asset:             USDCAddress,
		Amount:            "100000", // 0.10 USDC (6 decimals)
		PayTo:             receiverAddress,
		MaxTimeoutSeconds: 3600,
		Extra: map[string]interface{}{
			"escrowAddress":   escrowAddress,
			"operatorAddress": OperatorAddress,
			"tokenCollector":  tokenCollector,
			"name":            "USD Coin",
			"version":         "2",
		},
	}
	fmt.Printf("  Amount: %s (smallest unit)\n", requirements.Amount)
	fmt.Printf("  PayTo: %s\n", requirements.PayTo)
	fmt.Printf("  Escrow: %s\n", escrowAddress)
	fmt.Printf("  Token Collector: %s\n", tokenCollector)

	// --- Client: Create Payment Payload ---
	fmt.Println("\n--- Creating Payment Payload (Client) ---")
	payload, err := clientScheme.CreatePaymentPayload(ctx, requirements)
	if err != nil {
		fmt.Printf("Failed to create payment payload: %v\n", err)
		os.Exit(1)
	}
	payload.Accepted = requirements
	fmt.Println("  Payment payload created successfully")
	if auth, ok := payload.Payload["authorization"].(map[string]interface{}); ok {
		fmt.Printf("  Authorization.From: %s\n", auth["from"])
		fmt.Printf("  Authorization.To: %s\n", auth["to"])
		fmt.Printf("  Authorization.Value: %s\n", auth["value"])
		fmt.Printf("  Authorization.Nonce: %s\n", auth["nonce"])
	}

	// --- Facilitator: Verify Payment ---
	fmt.Println("\n--- Verifying Payment (Facilitator) ---")
	verifyResp, err := facilitatorScheme.Verify(ctx, payload, requirements, nil)
	if err != nil {
		fmt.Printf("Verification failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("  IsValid: %v\n", verifyResp.IsValid)
	fmt.Printf("  Payer: %s\n", verifyResp.Payer)

	// --- Facilitator: Settle Payment ---
	fmt.Println("\n--- Settling Payment (Facilitator) ---")
	settleResp, err := facilitatorScheme.Settle(ctx, payload, requirements, nil)
	if err != nil {
		fmt.Printf("Settlement failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("  Success: %v\n", settleResp.Success)
	fmt.Printf("  Transaction: %s\n", settleResp.Transaction)
	fmt.Printf("  Network: %s\n", settleResp.Network)
	fmt.Printf("  Payer: %s\n", settleResp.Payer)
	fmt.Printf("\n  View on BaseScan: https://basescan.org/tx/%s\n", settleResp.Transaction)
}

// ============================================================================
// Client EVM Signer
// ============================================================================

type clientEvmSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
	client     *ethclient.Client
}

func newClientEvmSigner(privateKeyHex string, rpcURL string) (*clientEvmSigner, error) {
	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0x")

	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	address := crypto.PubkeyToAddress(privateKey.PublicKey)

	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC: %w", err)
	}

	return &clientEvmSigner{
		privateKey: privateKey,
		address:    address,
		client:     client,
	}, nil
}

func (s *clientEvmSigner) Address() string {
	return s.address.Hex()
}

func (s *clientEvmSigner) SignTypedData(
	ctx context.Context,
	domain evmmech.TypedDataDomain,
	types map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	// Hash the typed data
	hash, err := evmmech.HashTypedData(domain, types, primaryType, message)
	if err != nil {
		return nil, fmt.Errorf("failed to hash typed data: %w", err)
	}

	// Sign the hash
	signature, err := crypto.Sign(hash, s.privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign: %w", err)
	}

	// Adjust v to be 27 or 28 (EIP-155)
	if signature[64] < 27 {
		signature[64] += 27
	}

	return signature, nil
}

func (s *clientEvmSigner) ReadContract(
	ctx context.Context,
	address string,
	abiJSON []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse ABI: %w", err)
	}

	data, err := contractABI.Pack(functionName, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to pack method call: %w", err)
	}

	to := common.HexToAddress(address)
	msg := goeth.CallMsg{To: &to, Data: data}

	result, err := s.client.CallContract(ctx, msg, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to call contract: %w", err)
	}

	if len(result) == 0 {
		return nil, nil
	}

	methodObj, exists := contractABI.Methods[functionName]
	if !exists {
		return nil, fmt.Errorf("method %s not found", functionName)
	}

	output, err := methodObj.Outputs.Unpack(result)
	if err != nil {
		return nil, fmt.Errorf("failed to unpack result: %w", err)
	}

	if len(output) > 0 {
		return output[0], nil
	}
	return nil, nil
}

// ============================================================================
// Facilitator EVM Signer
// ============================================================================

type facilitatorEvmSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
	client     *ethclient.Client
	chainID    *big.Int
}

func newFacilitatorEvmSigner(privateKeyHex string, rpcURL string) (*facilitatorEvmSigner, error) {
	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0x")

	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	address := crypto.PubkeyToAddress(privateKey.PublicKey)

	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC: %w", err)
	}

	ctx := context.Background()
	chainID, err := client.ChainID(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get chain ID: %w", err)
	}

	return &facilitatorEvmSigner{
		privateKey: privateKey,
		address:    address,
		client:     client,
		chainID:    chainID,
	}, nil
}

func (s *facilitatorEvmSigner) GetAddresses() []string {
	return []string{s.address.Hex()}
}

func (s *facilitatorEvmSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	return s.chainID, nil
}

func (s *facilitatorEvmSigner) VerifyTypedData(
	ctx context.Context,
	address string,
	domain evmmech.TypedDataDomain,
	types map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	chainId := domain.ChainID
	if chainId == nil {
		chainId = big.NewInt(0)
	}

	typedData := apitypes.TypedData{
		Types:       make(apitypes.Types),
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              domain.Name,
			Version:           domain.Version,
			ChainId:           (*math.HexOrDecimal256)(chainId),
			VerifyingContract: domain.VerifyingContract,
		},
		Message: message,
	}

	for typeName, fields := range types {
		typedFields := make([]apitypes.Type, len(fields))
		for i, field := range fields {
			typedFields[i] = apitypes.Type{
				Name: field.Name,
				Type: field.Type,
			}
		}
		typedData.Types[typeName] = typedFields
	}

	if _, exists := typedData.Types["EIP712Domain"]; !exists {
		typedData.Types["EIP712Domain"] = []apitypes.Type{
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		}
	}

	dataHash, err := typedData.HashStruct(typedData.PrimaryType, typedData.Message)
	if err != nil {
		return false, fmt.Errorf("failed to hash struct: %w", err)
	}

	domainSeparator, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		return false, fmt.Errorf("failed to hash domain: %w", err)
	}

	rawData := []byte{0x19, 0x01}
	rawData = append(rawData, domainSeparator...)
	rawData = append(rawData, dataHash...)
	digest := crypto.Keccak256(rawData)

	if len(signature) != 65 {
		return false, fmt.Errorf("invalid signature length: %d", len(signature))
	}

	v := signature[64]
	if v >= 27 {
		v -= 27
	}

	sigCopy := make([]byte, 65)
	copy(sigCopy, signature)
	sigCopy[64] = v

	pubKey, err := crypto.SigToPub(digest, sigCopy)
	if err != nil {
		return false, fmt.Errorf("failed to recover public key: %w", err)
	}

	recoveredAddr := crypto.PubkeyToAddress(*pubKey)
	expectedAddr := common.HexToAddress(address)

	return bytes.Equal(recoveredAddr.Bytes(), expectedAddr.Bytes()), nil
}

func (s *facilitatorEvmSigner) ReadContract(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	args ...interface{},
) (interface{}, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse ABI: %w", err)
	}

	data, err := contractABI.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to pack method call: %w", err)
	}

	to := common.HexToAddress(contractAddress)
	msg := goeth.CallMsg{To: &to, Data: data}

	result, err := s.client.CallContract(ctx, msg, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to call contract: %w", err)
	}

	if len(result) == 0 {
		if method == "authorizationState" {
			return false, nil
		}
		if method == "balanceOf" || method == "allowance" {
			return big.NewInt(0), nil
		}
		return nil, fmt.Errorf("empty result from contract call")
	}

	methodObj, exists := contractABI.Methods[method]
	if !exists {
		return nil, fmt.Errorf("method %s not found in ABI", method)
	}

	output, err := methodObj.Outputs.Unpack(result)
	if err != nil {
		return nil, fmt.Errorf("failed to unpack result: %w", err)
	}

	if len(output) > 0 {
		return output[0], nil
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
	contractABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return "", fmt.Errorf("failed to parse ABI: %w", err)
	}

	data, err := contractABI.Pack(method, args...)
	if err != nil {
		return "", fmt.Errorf("failed to pack method call: %w", err)
	}

	nonce, err := s.client.PendingNonceAt(ctx, s.address)
	if err != nil {
		return "", fmt.Errorf("failed to get nonce: %w", err)
	}

	gasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}

	to := common.HexToAddress(contractAddress)
	tx := ethtypes.NewTransaction(nonce, to, big.NewInt(0), 500000, gasPrice, data)

	signedTx, err := ethtypes.SignTx(tx, ethtypes.LatestSignerForChainID(s.chainID), s.privateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}

	err = s.client.SendTransaction(ctx, signedTx)
	if err != nil {
		return "", fmt.Errorf("failed to send transaction: %w", err)
	}

	return signedTx.Hash().Hex(), nil
}

func (s *facilitatorEvmSigner) SendTransaction(
	ctx context.Context,
	to string,
	data []byte,
) (string, error) {
	nonce, err := s.client.PendingNonceAt(ctx, s.address)
	if err != nil {
		return "", fmt.Errorf("failed to get nonce: %w", err)
	}

	gasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}

	toAddr := common.HexToAddress(to)
	tx := ethtypes.NewTransaction(nonce, toAddr, big.NewInt(0), 500000, gasPrice, data)

	signedTx, err := ethtypes.SignTx(tx, ethtypes.LatestSignerForChainID(s.chainID), s.privateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}

	err = s.client.SendTransaction(ctx, signedTx)
	if err != nil {
		return "", fmt.Errorf("failed to send transaction: %w", err)
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
		time.Sleep(1 * time.Second)
	}

	return nil, fmt.Errorf("transaction receipt not found after 60 seconds")
}

func (s *facilitatorEvmSigner) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	if tokenAddress == "" || tokenAddress == "0x0000000000000000000000000000000000000000" {
		balance, err := s.client.BalanceAt(ctx, common.HexToAddress(address), nil)
		if err != nil {
			return nil, fmt.Errorf("failed to get balance: %w", err)
		}
		return balance, nil
	}

	result, err := s.ReadContract(ctx, tokenAddress, evmmech.ERC20BalanceOfABI, "balanceOf", common.HexToAddress(address))
	if err != nil {
		return nil, err
	}

	if balance, ok := result.(*big.Int); ok {
		return balance, nil
	}
	return nil, fmt.Errorf("unexpected balance type: %T", result)
}

func (s *facilitatorEvmSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	addr := common.HexToAddress(address)
	code, err := s.client.CodeAt(ctx, addr, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to get code: %w", err)
	}
	return code, nil
}

// Ensure interfaces are satisfied
var _ evmmech.ClientEvmSigner = (*clientEvmSigner)(nil)
var _ evmmech.FacilitatorEvmSigner = (*facilitatorEvmSigner)(nil)
