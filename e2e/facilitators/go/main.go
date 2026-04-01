package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/bazaar"
	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
	"github.com/coinbase/x402/go/extensions/erc20approvalgassponsor"
	exttypes "github.com/coinbase/x402/go/extensions/types"
	evmmech "github.com/coinbase/x402/go/mechanisms/evm"
	exactevm "github.com/coinbase/x402/go/mechanisms/evm/exact/facilitator"
	exactevmv1 "github.com/coinbase/x402/go/mechanisms/evm/exact/v1/facilitator"
	uptoevm "github.com/coinbase/x402/go/mechanisms/evm/upto/facilitator"
	svmmech "github.com/coinbase/x402/go/mechanisms/svm"
	svm "github.com/coinbase/x402/go/mechanisms/svm/exact/facilitator"
	svmv1 "github.com/coinbase/x402/go/mechanisms/svm/exact/v1/facilitator"
	x402types "github.com/coinbase/x402/go/types"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/gin-gonic/gin"
)

const (
	DefaultPort = "4022"
)

// Request/Response types
type VerifyRequest struct {
	X402Version         int             `json:"x402Version"`
	PaymentPayload      json.RawMessage `json:"paymentPayload"`
	PaymentRequirements json.RawMessage `json:"paymentRequirements"`
}

type SettleRequest struct {
	X402Version         int             `json:"x402Version"`
	PaymentPayload      json.RawMessage `json:"paymentPayload"`
	PaymentRequirements json.RawMessage `json:"paymentRequirements"`
}

// Real EVM signer for facilitator using ethclient
type realFacilitatorEvmSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
	client     *ethclient.Client
	chainID    *big.Int
}

func newRealFacilitatorEvmSigner(privateKeyHex string, rpcURL string) (*realFacilitatorEvmSigner, error) {
	// Remove 0x prefix if present
	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0x")

	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	address := crypto.PubkeyToAddress(privateKey.PublicKey)

	// Connect to blockchain
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC: %w", err)
	}

	// Get chain ID
	ctx := context.Background()
	chainID, err := client.ChainID(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get chain ID: %w", err)
	}

	return &realFacilitatorEvmSigner{
		privateKey: privateKey,
		address:    address,
		client:     client,
		chainID:    chainID,
	}, nil
}

func (s *realFacilitatorEvmSigner) GetAddresses() []string {
	return []string{s.address.Hex()}
}

func (s *realFacilitatorEvmSigner) GetChainID(ctx context.Context) (*big.Int, error) {
	return s.chainID, nil
}

func (s *realFacilitatorEvmSigner) VerifyTypedData(
	ctx context.Context,
	address string,
	domain evmmech.TypedDataDomain,
	types map[string][]evmmech.TypedDataField,
	primaryType string,
	message map[string]interface{},
	signature []byte,
) (bool, error) {
	// Convert to apitypes for EIP-712 verification
	chainId := getBigIntFromInterface(domain.ChainID)
	typedData := apitypes.TypedData{
		Types:       make(apitypes.Types),
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              getStringFromInterface(domain.Name),
			Version:           getStringFromInterface(domain.Version),
			ChainId:           (*math.HexOrDecimal256)(chainId),
			VerifyingContract: getStringFromInterface(domain.VerifyingContract),
		},
		Message: message,
	}

	// Convert types
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

	// Add EIP712Domain if not present
	if _, exists := typedData.Types["EIP712Domain"]; !exists {
		typedData.Types["EIP712Domain"] = []apitypes.Type{
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		}
	}

	// Hash the data
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

	// Recover the address from signature
	if len(signature) != 65 {
		return false, fmt.Errorf("invalid signature length: %d", len(signature))
	}

	// Adjust v value
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

func (s *realFacilitatorEvmSigner) ReadContract(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	args ...interface{},
) (interface{}, error) {
	// Parse ABI
	contractABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse ABI: %w", err)
	}

	methodObj, exists := contractABI.Methods[method]
	if !exists {
		return nil, fmt.Errorf("method %s not found in ABI", method)
	}

	// Pack the method call
	data, err := contractABI.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to pack method call: %w", err)
	}

	// Set From to the facilitator address — required by the upto proxy which enforces
	// msg.sender == witness.facilitator in settle().
	to := common.HexToAddress(contractAddress)
	msg := ethereum.CallMsg{
		From: s.address,
		To:   &to,
		Data: data,
	}

	result, err := s.client.CallContract(ctx, msg, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to call contract: %w", err)
	}

	if len(methodObj.Outputs) == 0 {
		return nil, nil
	}

	// Unpack the result based on method
	output, err := methodObj.Outputs.Unpack(result)
	if err != nil {
		return nil, fmt.Errorf("failed to unpack result: %w", err)
	}

	// Return the first output (most contract reads return a single value)
	if len(output) > 0 {
		return output[0], nil
	}

	return nil, nil
}

func (s *realFacilitatorEvmSigner) WriteContract(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	args ...interface{},
) (string, error) {
	// Parse ABI
	contractABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return "", fmt.Errorf("failed to parse ABI: %w", err)
	}

	// Pack the method call
	data, err := contractABI.Pack(method, args...)
	if err != nil {
		return "", fmt.Errorf("failed to pack method call: %w", err)
	}

	// Get nonce
	nonce, err := s.client.PendingNonceAt(ctx, s.address)
	if err != nil {
		return "", fmt.Errorf("failed to get nonce: %w", err)
	}

	// Get gas price
	gasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}

	// Create transaction
	to := common.HexToAddress(contractAddress)
	tx := types.NewTransaction(
		nonce,
		to,
		big.NewInt(0), // value
		300000,        // gas limit
		gasPrice,
		data,
	)

	// Sign transaction
	signedTx, err := types.SignTx(tx, types.LatestSignerForChainID(s.chainID), s.privateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}

	// Send transaction
	err = s.client.SendTransaction(ctx, signedTx)
	if err != nil {
		return "", fmt.Errorf("failed to send transaction: %w", err)
	}

	return signedTx.Hash().Hex(), nil
}

func (s *realFacilitatorEvmSigner) SendTransaction(
	ctx context.Context,
	to string,
	data []byte,
) (string, error) {
	// Get nonce
	nonce, err := s.client.PendingNonceAt(ctx, s.address)
	if err != nil {
		return "", fmt.Errorf("failed to get nonce: %w", err)
	}

	// Get gas price
	gasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}

	// Create transaction with raw data
	toAddr := common.HexToAddress(to)
	tx := types.NewTransaction(
		nonce,
		toAddr,
		big.NewInt(0), // value
		300000,        // gas limit
		gasPrice,
		data,
	)

	// Sign transaction
	signedTx, err := types.SignTx(tx, types.LatestSignerForChainID(s.chainID), s.privateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}

	// Send transaction
	err = s.client.SendTransaction(ctx, signedTx)
	if err != nil {
		return "", fmt.Errorf("failed to send transaction: %w", err)
	}

	return signedTx.Hash().Hex(), nil
}

func (s *realFacilitatorEvmSigner) WaitForTransactionReceipt(ctx context.Context, txHash string) (*evmmech.TransactionReceipt, error) {
	hash := common.HexToHash(txHash)

	// Poll for receipt
	for i := 0; i < 30; i++ { // 30 seconds timeout
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

	return nil, fmt.Errorf("transaction receipt not found after 30 seconds")
}

func (s *realFacilitatorEvmSigner) GetBalance(ctx context.Context, address string, tokenAddress string) (*big.Int, error) {
	if tokenAddress == "" || tokenAddress == "0x0000000000000000000000000000000000000000" {
		// Native balance
		balance, err := s.client.BalanceAt(ctx, common.HexToAddress(address), nil)
		if err != nil {
			return nil, fmt.Errorf("failed to get balance: %w", err)
		}
		return balance, nil
	}

	// ERC20 balance - need to call balanceOf
	// Minimal ERC20 ABI for balanceOf
	const erc20ABI = `[{"constant":true,"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}]`

	// Convert address to common.Address for ABI packing
	result, err := s.ReadContract(ctx, tokenAddress, []byte(erc20ABI), "balanceOf", common.HexToAddress(address))
	if err != nil {
		return nil, err
	}

	if balance, ok := result.(*big.Int); ok {
		return balance, nil
	}

	return nil, fmt.Errorf("unexpected balance type: %T", result)
}

func (s *realFacilitatorEvmSigner) GetCode(ctx context.Context, address string) ([]byte, error) {
	addr := common.HexToAddress(address)
	code, err := s.client.CodeAt(ctx, addr, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to get code: %w", err)
	}
	return code, nil
}

func (s *realFacilitatorEvmSigner) decodeRawTransaction(serialized string) (*types.Transaction, error) {
	txBytes, err := hexutil.Decode(serialized)
	if err != nil {
		return nil, fmt.Errorf("failed to decode signed transaction: %w", err)
	}
	tx := new(types.Transaction)
	if err := tx.UnmarshalBinary(txBytes); err != nil {
		return nil, fmt.Errorf("failed to unmarshal transaction: %w", err)
	}
	return tx, nil
}

func (s *realFacilitatorEvmSigner) sendRawTransaction(ctx context.Context, tx *types.Transaction) (string, error) {
	if err := s.client.SendTransaction(ctx, tx); err != nil {
		return "", fmt.Errorf("failed to send raw transaction: %w", err)
	}
	return tx.Hash().Hex(), nil
}

func (s *realFacilitatorEvmSigner) fundPayerGasIfNeeded(ctx context.Context, decodedTx *types.Transaction) error {
	chainSigner := types.LatestSignerForChainID(s.chainID)
	payerAddr, err := types.Sender(chainSigner, decodedTx)
	if err != nil {
		return fmt.Errorf("failed to recover sender: %w", err)
	}

	gasFeeCap := decodedTx.GasFeeCap()
	if gasFeeCap == nil {
		gasFeeCap = decodedTx.GasPrice()
	}
	gasCost := new(big.Int).Mul(new(big.Int).SetUint64(decodedTx.Gas()), gasFeeCap)

	payerBalance, err := s.client.BalanceAt(ctx, payerAddr, nil)
	if err != nil {
		return fmt.Errorf("failed to get payer balance: %w", err)
	}
	if payerBalance.Cmp(gasCost) >= 0 {
		return nil
	}

	deficit := new(big.Int).Sub(gasCost, payerBalance)
	log.Printf("⛽ Funding payer %s with %s wei for gas", payerAddr.Hex(), deficit.String())

	fundNonce, err := s.client.PendingNonceAt(ctx, s.address)
	if err != nil {
		return fmt.Errorf("failed to get funding nonce: %w", err)
	}
	fundGasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return fmt.Errorf("failed to get gas price: %w", err)
	}

	fundTx := types.NewTransaction(fundNonce, payerAddr, deficit, 21000, fundGasPrice, nil)
	signedFundTx, err := types.SignTx(fundTx, chainSigner, s.privateKey)
	if err != nil {
		return fmt.Errorf("failed to sign funding tx: %w", err)
	}
	if err := s.client.SendTransaction(ctx, signedFundTx); err != nil {
		return fmt.Errorf("failed to send funding tx: %w", err)
	}

	fundReceipt, err := s.WaitForTransactionReceipt(ctx, signedFundTx.Hash().Hex())
	if err != nil || fundReceipt.Status != evmmech.TxStatusSuccess {
		return fmt.Errorf("gas funding failed: %s", signedFundTx.Hash().Hex())
	}
	log.Printf("⛽ Gas funding confirmed: %s", signedFundTx.Hash().Hex())
	return nil
}

func (s *realFacilitatorEvmSigner) SendTransactions(ctx context.Context, transactions []erc20approvalgassponsor.TransactionRequest) ([]string, error) {
	var hashes []string
	for _, tx := range transactions {
		var hash string
		var err error
		if tx.Serialized != "" {
			decodedTx, decErr := s.decodeRawTransaction(tx.Serialized)
			if decErr != nil {
				return hashes, fmt.Errorf("transaction_failed: %w", decErr)
			}
			if fundErr := s.fundPayerGasIfNeeded(ctx, decodedTx); fundErr != nil {
				return hashes, fmt.Errorf("transaction_failed: %w", fundErr)
			}
			hash, err = s.sendRawTransaction(ctx, decodedTx)
		} else if tx.Call != nil {
			hash, err = s.WriteContract(ctx, tx.Call.Address, tx.Call.ABI, tx.Call.Function, tx.Call.Args...)
		} else {
			return hashes, fmt.Errorf("transaction_failed: empty transaction request")
		}
		if err != nil {
			return hashes, fmt.Errorf("transaction_failed: %w", err)
		}
		receipt, err := s.WaitForTransactionReceipt(ctx, hash)
		if err != nil || receipt.Status != evmmech.TxStatusSuccess {
			return hashes, fmt.Errorf("transaction_failed: %s", hash)
		}
		hashes = append(hashes, hash)
	}
	return hashes, nil
}

// Helper functions for type conversion
func getStringFromInterface(v interface{}) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	case *string:
		if val != nil {
			return *val
		}
	}
	return ""
}

func getBigIntFromInterface(v interface{}) *big.Int {
	if v == nil {
		return big.NewInt(0)
	}
	switch val := v.(type) {
	case *big.Int:
		return val
	case int64:
		return big.NewInt(val)
	case string:
		n, _ := new(big.Int).SetString(val, 10)
		return n
	}
	return big.NewInt(0)
}

var (
	bazaarCatalog     = NewBazaarCatalog()
	verifiedPayments  = make(map[string]int64)
	verificationMutex = &sync.RWMutex{}
)

func createPaymentHash(paymentPayload x402.PaymentPayload) string {
	data, _ := json.Marshal(paymentPayload)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func hashBytes(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// Real SVM facilitator signer
type realFacilitatorSvmSigner struct {
	privateKey solana.PrivateKey
	rpcClients map[string]*rpc.Client
	rpcURL     string
}

func newRealFacilitatorSvmSigner(privateKeyBase58 string, rpcURL string) (*realFacilitatorSvmSigner, error) {
	privateKey, err := solana.PrivateKeyFromBase58(privateKeyBase58)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Solana private key: %w", err)
	}

	return &realFacilitatorSvmSigner{
		privateKey: privateKey,
		rpcClients: make(map[string]*rpc.Client),
		rpcURL:     rpcURL,
	}, nil
}

// getRPC is a private helper method to get RPC client for a network
func (s *realFacilitatorSvmSigner) getRPC(ctx context.Context, network string) (*rpc.Client, error) {
	if client, ok := s.rpcClients[network]; ok {
		return client, nil
	}

	rpcURL := s.rpcURL
	if rpcURL == "" {
		config, err := svmmech.GetNetworkConfig(network)
		if err != nil {
			return nil, err
		}
		rpcURL = config.RPCURL
	}

	client := rpc.New(rpcURL)
	s.rpcClients[network] = client
	return client, nil
}

func (s *realFacilitatorSvmSigner) SignTransaction(ctx context.Context, tx *solana.Transaction, feePayer solana.PublicKey, network string) error {
	// Verify feePayer matches our key
	if feePayer != s.privateKey.PublicKey() {
		return fmt.Errorf("no signer for feePayer %s. Available: %s", feePayer, s.privateKey.PublicKey())
	}

	messageBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	signature, err := s.privateKey.Sign(messageBytes)
	if err != nil {
		return fmt.Errorf("failed to sign: %w", err)
	}

	accountIndex, err := tx.GetAccountIndex(s.privateKey.PublicKey())
	if err != nil {
		return fmt.Errorf("failed to get account index: %w", err)
	}

	if len(tx.Signatures) <= int(accountIndex) {
		newSignatures := make([]solana.Signature, accountIndex+1)
		copy(newSignatures, tx.Signatures)
		tx.Signatures = newSignatures
	}

	tx.Signatures[accountIndex] = signature
	return nil
}

func (s *realFacilitatorSvmSigner) SimulateTransaction(ctx context.Context, tx *solana.Transaction, network string) error {
	rpcClient, err := s.getRPC(ctx, network)
	if err != nil {
		return err
	}

	opts := rpc.SimulateTransactionOpts{
		SigVerify:              true,
		ReplaceRecentBlockhash: false,
		Commitment:             svmmech.DefaultCommitment,
	}

	simResult, err := rpcClient.SimulateTransactionWithOpts(ctx, tx, &opts)
	if err != nil {
		return fmt.Errorf("simulation failed: %w", err)
	}

	if simResult != nil && simResult.Value != nil && simResult.Value.Err != nil {
		return fmt.Errorf("simulation failed: transaction would fail on-chain")
	}

	return nil
}

func (s *realFacilitatorSvmSigner) SendTransaction(ctx context.Context, tx *solana.Transaction, network string) (solana.Signature, error) {
	rpcClient, err := s.getRPC(ctx, network)
	if err != nil {
		return solana.Signature{}, err
	}

	sig, err := rpcClient.SendTransactionWithOpts(ctx, tx, rpc.TransactionOpts{
		SkipPreflight:       true,
		PreflightCommitment: svmmech.DefaultCommitment,
	})
	if err != nil {
		return solana.Signature{}, fmt.Errorf("failed to send transaction: %w", err)
	}

	return sig, nil
}

func (s *realFacilitatorSvmSigner) ConfirmTransaction(ctx context.Context, signature solana.Signature, network string) error {
	rpcClient, err := s.getRPC(ctx, network)
	if err != nil {
		return err
	}

	for attempt := 0; attempt < svmmech.MaxConfirmAttempts; attempt++ {
		// Check for context cancellation
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Try getSignatureStatuses first (faster)
		statuses, err := rpcClient.GetSignatureStatuses(ctx, true, signature)
		if err == nil && statuses != nil && statuses.Value != nil && len(statuses.Value) > 0 {
			status := statuses.Value[0]
			if status != nil {
				if status.Err != nil {
					return fmt.Errorf("transaction failed on-chain")
				}
				if status.ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
					status.ConfirmationStatus == rpc.ConfirmationStatusFinalized {
					return nil
				}
			}
		}

		// Fallback to getTransaction
		if err != nil {
			txResult, txErr := rpcClient.GetTransaction(ctx, signature, &rpc.GetTransactionOpts{
				Encoding:   solana.EncodingBase58,
				Commitment: svmmech.DefaultCommitment,
			})

			if txErr == nil && txResult != nil && txResult.Meta != nil {
				if txResult.Meta.Err != nil {
					return fmt.Errorf("transaction failed on-chain")
				}
				return nil
			}
		}

		// Wait before retrying
		time.Sleep(svmmech.ConfirmRetryDelay)
	}

	return fmt.Errorf("transaction confirmation timed out after %d attempts", svmmech.MaxConfirmAttempts)
}

func (s *realFacilitatorSvmSigner) GetAddresses(ctx context.Context, network string) []solana.PublicKey {
	return []solana.PublicKey{s.privateKey.PublicKey()}
}

// Network configuration helpers
func getEvmRpcUrl(network string) string {
	// Check for custom RPC URL first
	if url := os.Getenv("EVM_RPC_URL"); url != "" {
		return url
	}
	// Default RPC URLs based on network
	switch network {
	case "eip155:8453":
		return "https://mainnet.base.org"
	case "eip155:84532":
		return "https://sepolia.base.org"
	default:
		return "https://sepolia.base.org"
	}
}

func getSvmRpcUrl(network string) string {
	// Check for custom RPC URL first
	if url := os.Getenv("SVM_RPC_URL"); url != "" {
		return url
	}
	// Default RPC URLs based on network
	switch network {
	case "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp":
		return "https://api.mainnet-beta.solana.com"
	case "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1":
		return "https://api.devnet.solana.com"
	default:
		return "https://api.devnet.solana.com"
	}
}

// Map v2 CAIP-2 network to v1 network name
func getV1EvmNetwork(network string) string {
	switch network {
	case "eip155:8453":
		return "base"
	case "eip155:84532":
		return "base-sepolia"
	default:
		return "base-sepolia"
	}
}

func getV1SvmNetwork(network string) string {
	switch network {
	case "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp":
		return "solana"
	case "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1":
		return "solana-devnet"
	default:
		return "solana-devnet"
	}
}

func main() {
	// Get configuration from environment
	port := os.Getenv("PORT")
	if port == "" {
		port = DefaultPort
	}

	// Network configuration from environment
	evmNetwork := os.Getenv("EVM_NETWORK")
	if evmNetwork == "" {
		evmNetwork = "eip155:84532" // Default: Base Sepolia
	}
	svmNetwork := os.Getenv("SVM_NETWORK")
	if svmNetwork == "" {
		svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" // Default: Solana Devnet
	}

	log.Printf("🌐 EVM Network: %s", evmNetwork)
	log.Printf("🌐 SVM Network: %s", svmNetwork)

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		log.Fatal("❌ EVM_PRIVATE_KEY environment variable is required")
	}

	svmPrivateKey := os.Getenv("SVM_PRIVATE_KEY")
	if svmPrivateKey == "" {
		log.Fatal("❌ SVM_PRIVATE_KEY environment variable is required")
	}

	// Initialize the real EVM blockchain signer with dynamic RPC URL
	evmRpcUrl := getEvmRpcUrl(evmNetwork)
	log.Printf("🌐 EVM RPC URL: %s", evmRpcUrl)
	evmSigner, err := newRealFacilitatorEvmSigner(evmPrivateKey, evmRpcUrl)
	if err != nil {
		log.Fatalf("Failed to create EVM signer: %v", err)
	}

	chainID, _ := evmSigner.GetChainID(context.Background())
	addresses := evmSigner.GetAddresses()
	log.Printf("EVM Facilitator account: %s", addresses[0])
	log.Printf("Connected to chain ID: %s", chainID.String())

	// Initialize the real SVM blockchain signer with dynamic RPC URL
	svmRpcUrl := getSvmRpcUrl(svmNetwork)
	log.Printf("🌐 SVM RPC URL: %s", svmRpcUrl)
	svmSigner, err := newRealFacilitatorSvmSigner(svmPrivateKey, svmRpcUrl)
	if err != nil {
		log.Fatalf("Failed to create SVM signer: %v", err)
	}

	svmAddresses := svmSigner.GetAddresses(context.Background(), svmNetwork)
	log.Printf("SVM Facilitator account: %s", svmAddresses[0].String())

	// Initialize the x402 Facilitator with EVM and SVM support
	facilitator := x402.Newx402Facilitator()

	// Register EVM schemes with dynamic network
	// Enable smart wallet deployment via EIP-6492
	evmConfig := &exactevm.ExactEvmSchemeConfig{
		DeployERC4337WithEIP6492: true,
	}
	evmFacilitatorScheme := exactevm.NewExactEvmScheme(evmSigner, evmConfig)
	facilitator.Register([]x402.Network{x402.Network(evmNetwork)}, evmFacilitatorScheme)

	// Register upto EVM scheme
	uptoEvmFacilitatorScheme := uptoevm.NewUptoEvmScheme(evmSigner, nil)
	facilitator.Register([]x402.Network{x402.Network(evmNetwork)}, uptoEvmFacilitatorScheme)

	evmV1Config := &exactevmv1.ExactEvmSchemeV1Config{
		DeployERC4337WithEIP6492: true,
	}
	evmFacilitatorV1Scheme := exactevmv1.NewExactEvmSchemeV1(evmSigner, evmV1Config)
	facilitator.RegisterV1([]x402.Network{x402.Network(getV1EvmNetwork(evmNetwork))}, evmFacilitatorV1Scheme)

	// Register SVM schemes with dynamic network
	svmFacilitatorScheme := svm.NewExactSvmScheme(svmSigner)
	facilitator.Register([]x402.Network{x402.Network(svmNetwork)}, svmFacilitatorScheme)

	svmFacilitatorV1Scheme := svmv1.NewExactSvmSchemeV1(svmSigner)
	facilitator.RegisterV1([]x402.Network{x402.Network(getV1SvmNetwork(svmNetwork))}, svmFacilitatorV1Scheme)

	// Register the Bazaar discovery extension
	facilitator.RegisterExtension(exttypes.BAZAAR)

	// Register the EIP-2612 Gas Sponsoring extension
	facilitator.RegisterExtension(eip2612gassponsor.EIP2612GasSponsoring)

	// Register the ERC-20 Approval Gas Sponsoring extension
	erc20Ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: evmSigner}
	facilitator.RegisterExtension(erc20Ext)

	// Lifecycle hooks for payment tracking and discovery
	facilitator.
		OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
			// Hook 1: Track verified payment for verify→settle flow validation
			if ctx.Result.IsValid {
				paymentHash := hashBytes(ctx.PayloadBytes)
				verificationMutex.Lock()
				verifiedPayments[paymentHash] = time.Now().Unix()
				verificationMutex.Unlock()

				log.Printf("✅ Payment verified: %s", paymentHash)

				// Hook 2: Extract and catalog Bazaar discovery info using bazaar package
				discovered, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(
					ctx.PayloadBytes,
					ctx.RequirementsBytes,
					true, // validate
				)
				if err != nil {
					log.Printf("Warning: Failed to extract discovery info: %v", err)
				} else if discovered != nil {
					log.Printf("📝 Cataloging discovered resource: %s %s", discovered.Method, discovered.ResourceURL)

					// Unmarshal requirements for cataloging based on version
					version := ctx.Payload.GetVersion()
					if version == 2 {
						var requirements x402.PaymentRequirements
						if err := json.Unmarshal(ctx.RequirementsBytes, &requirements); err == nil {
							bazaarCatalog.CatalogResource(
								discovered.ResourceURL,
								discovered.Method,
								version,
								discovered.DiscoveryInfo,
								requirements,
								discovered.RouteTemplate,
							)
						}
					} else if version == 1 {
						var requirementsV1 x402types.PaymentRequirementsV1
						if err := json.Unmarshal(ctx.RequirementsBytes, &requirementsV1); err == nil {
							// Convert V1 requirements to V2 format for catalog
							// This is acceptable for e2e testing as catalog interface expects V2
							requirements := x402.PaymentRequirements{
								Scheme:            requirementsV1.Scheme,
								Network:           requirementsV1.Network,
								Asset:             requirementsV1.Asset,
								Amount:            requirementsV1.MaxAmountRequired, // V1 uses maxAmountRequired
								PayTo:             requirementsV1.PayTo,
								MaxTimeoutSeconds: requirementsV1.MaxTimeoutSeconds,
							}
							bazaarCatalog.CatalogResource(
								discovered.ResourceURL,
								discovered.Method,
								version,
								discovered.DiscoveryInfo,
								requirements,
								discovered.RouteTemplate,
							)
						}
					}
				}
			}
			return nil
		}).
		OnBeforeSettle(func(ctx x402.FacilitatorSettleContext) (*x402.FacilitatorBeforeHookResult, error) {
			// Hook 3: Validate payment was previously verified
			paymentHash := hashBytes(ctx.PayloadBytes)
			verificationMutex.RLock()
			verificationTimestamp, verified := verifiedPayments[paymentHash]
			verificationMutex.RUnlock()

			if !verified {
				return &x402.FacilitatorBeforeHookResult{
					Abort:  true,
					Reason: "Payment must be verified before settlement",
				}, nil
			}

			// Check verification isn't too old (5 minute timeout)
			age := time.Now().Unix() - verificationTimestamp
			if age > 5*60 {
				verificationMutex.Lock()
				delete(verifiedPayments, paymentHash)
				verificationMutex.Unlock()

				return &x402.FacilitatorBeforeHookResult{
					Abort:  true,
					Reason: "Payment verification expired (must settle within 5 minutes)",
				}, nil
			}

			return nil, nil
		}).
		OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
			// Hook 4: Clean up verified payment tracking after successful settlement
			paymentHash := hashBytes(ctx.PayloadBytes)
			verificationMutex.Lock()
			delete(verifiedPayments, paymentHash)
			verificationMutex.Unlock()

			if ctx.Result.Success {
				log.Printf("✅ Settlement completed: %s", ctx.Result.Transaction)
			}
			return nil
		}).
		OnSettleFailure(func(ctx x402.FacilitatorSettleFailureContext) (*x402.FacilitatorSettleFailureHookResult, error) {
			// Hook 5: Clean up verified payment tracking on failure too
			paymentHash := hashBytes(ctx.PayloadBytes)
			verificationMutex.Lock()
			delete(verifiedPayments, paymentHash)
			verificationMutex.Unlock()

			log.Printf("❌ Settlement failed: %v", ctx.Error)
			return nil, nil
		})

	// Set up Gin router
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	// POST /verify - Verify a payment against requirements
	// Note: Payment tracking and bazaar discovery are handled by lifecycle hooks
	router.POST("/verify", func(c *gin.Context) {
		bodyBytes, err := c.GetRawData()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Failed to read request body: %v", err),
			})
			return
		}

		var req VerifyRequest
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		// Hooks will automatically:
		// - Track verified payment (OnAfterVerify)
		// - Extract and catalog discovery info (OnAfterVerify)

		// json.RawMessage is already []byte, so we can use it directly
		// This preserves the exact JSON without re-marshaling (important for v1/v2 compatibility)
		response, err := facilitator.Verify(
			context.Background(),
			[]byte(req.PaymentPayload),
			[]byte(req.PaymentRequirements),
		)
		if err != nil {
			log.Printf("Verify error: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, response)
	})

	// POST /settle - Settle a payment on-chain
	// Note: Verification validation and cleanup are handled by lifecycle hooks
	router.POST("/settle", func(c *gin.Context) {
		bodyBytes, err := c.GetRawData()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Failed to read request body: %v", err),
			})
			return
		}

		var req SettleRequest
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		// json.RawMessage is already []byte, so we can use it directly
		// This preserves the exact JSON without re-marshaling (important for v1/v2 compatibility)
		response, err := facilitator.Settle(
			context.Background(),
			[]byte(req.PaymentPayload),
			[]byte(req.PaymentRequirements),
		)

		if err != nil {
			log.Printf("Settle error: %v", err)

			// Check if this was an abort from hook
			if strings.Contains(err.Error(), "settlement aborted:") {
				// Return a proper SettleResponse instead of 500 error
				c.JSON(http.StatusOK, x402.SettleResponse{
					Success:     false,
					ErrorReason: strings.TrimPrefix(err.Error(), "settlement aborted: "),
					Network:     "", // Network not available in error case since we don't parse the raw JSON
				})
				return
			}

			c.JSON(http.StatusInternalServerError, gin.H{
				"error": err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, response)
	})

	// GET /supported - Get supported payment kinds and extensions
	router.GET("/supported", func(c *gin.Context) {
		// Get supported kinds - networks already registered
		response := facilitator.GetSupported()
		c.JSON(http.StatusOK, response)
	})

	// GET /discovery/resources - List all discovered resources from bazaar extensions
	router.GET("/discovery/resources", func(c *gin.Context) {
		limit := 100
		if limitParam := c.Query("limit"); limitParam != "" {
			fmt.Sscanf(limitParam, "%d", &limit)
		}

		offset := 0
		if offsetParam := c.Query("offset"); offsetParam != "" {
			fmt.Sscanf(offsetParam, "%d", &offset)
		}

		items, total := bazaarCatalog.GetResources(limit, offset)

		c.JSON(http.StatusOK, gin.H{
			"x402Version": 1,
			"items":       items,
			"pagination": gin.H{
				"limit":  limit,
				"offset": offset,
				"total":  total,
			},
		})
	})

	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":              "ok",
			"evmNetwork":          evmNetwork,
			"svmNetwork":          svmNetwork,
			"facilitator":         "go",
			"version":             "2.0.0",
			"extensions":          []string{exttypes.BAZAAR.Key()},
			"discoveredResources": bazaarCatalog.GetCount(),
		})
	})

	// POST /close - Graceful shutdown endpoint
	router.POST("/close", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"message": "Facilitator shutting down gracefully",
		})
		log.Println("Received shutdown request")

		// Give time for response to be sent, then exit
		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	// Start the server
	fmt.Printf(`
╔════════════════════════════════════════════════════════╗
║              x402 Go Facilitator                       ║
╠════════════════════════════════════════════════════════╣
║  Server:     http://localhost:%s                      ║
║  EVM Network:    %s                       ║
║  SVM Network:    %s                       ║
║  Address:    %s     ║
║  Extensions: bazaar                                    ║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)         ║
║  • POST /settle              (settle payment)         ║
║  • GET  /supported           (get supported kinds)    ║
║  • GET  /discovery/resources (list discovered)        ║
║  • GET  /health              (health check)           ║
║  • POST /close               (shutdown server)        ║
╚════════════════════════════════════════════════════════╝
`, port, evmNetwork, svmNetwork, evmSigner.GetAddresses()[0])

	// Log that facilitator is ready (needed for e2e test discovery)
	log.Println("Facilitator listening")

	// Start server
	if err := router.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
