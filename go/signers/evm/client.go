package evm

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	x402evm "github.com/x402-foundation/x402/go/mechanisms/evm"
)

// ClientSigner implements x402evm.ClientEvmSigner using an ECDSA private key.
// This provides client-side EIP-712 signing for creating payment payloads.
type ClientSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
	ethClient  *ethclient.Client
}

// NewClientSignerFromPrivateKey creates a client signer from a hex-encoded private key.
//
// Args:
//
//	privateKeyHex: Hex-encoded private key (with or without "0x" prefix)
//
// Returns:
//
//	ClientEvmSigner implementation ready for use with evm.NewExactEvmClient()
//	Error if private key is invalid
//
// Example:
//
//	signer, err := evm.NewClientSignerFromPrivateKey("0x1234...")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	client := x402.Newx402Client().
//	    Register("eip155:*", evm.NewExactEvmClient(signer))
func NewClientSignerFromPrivateKey(privateKeyHex string) (x402evm.ClientEvmSigner, error) {
	return NewClientSignerFromPrivateKeyWithClient(privateKeyHex, nil)
}

// NewClientSignerFromPrivateKeyWithClient creates a client signer from a private key
// and an optional ethclient for contract reads (e.g., querying EIP-2612 nonces).
//
// If ethClient is nil, ReadContract will return an error when called.
func NewClientSignerFromPrivateKeyWithClient(privateKeyHex string, ethClient *ethclient.Client) (x402evm.ClientEvmSigner, error) {
	// Strip 0x prefix if present
	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0x")

	// Parse hex string to ECDSA private key
	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}

	// Derive Ethereum address from public key
	address := crypto.PubkeyToAddress(privateKey.PublicKey)

	return &ClientSigner{
		privateKey: privateKey,
		address:    address,
		ethClient:  ethClient,
	}, nil
}

// Address returns the Ethereum address of the signer.
func (s *ClientSigner) Address() string {
	return s.address.Hex()
}

// SignTypedData signs EIP-712 typed data.
//
// Args:
//
//	ctx: Context for cancellation and timeout control
//	domain: EIP-712 domain separator
//	types: Type definitions for the structured data
//	primaryType: The primary type being signed
//	message: The message data to sign
//
// Returns:
//
//	65-byte signature (r, s, v)
//	Error if signing fails
func (s *ClientSigner) SignTypedData(
	ctx context.Context,
	domain x402evm.TypedDataDomain,
	types map[string][]x402evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	// Convert x402 types to go-ethereum apitypes
	typedData := apitypes.TypedData{
		Types:       make(apitypes.Types),
		PrimaryType: primaryType,
		Domain: apitypes.TypedDataDomain{
			Name:              domain.Name,
			Version:           domain.Version,
			ChainId:           (*math.HexOrDecimal256)(domain.ChainID),
			VerifyingContract: domain.VerifyingContract,
		},
		Message: message,
	}

	// Convert field types
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

	// Add EIP712Domain type if not present.
	//
	// Domain fields are conditionally declared based on which TypedDataDomain
	// fields are populated. go-ethereum's `apitypes.TypedDataDomain.Map()`
	// drops empty Name/Version/VerifyingContract and nil ChainID; if the type
	// list still names them, `HashStruct("EIP712Domain", ...)` errors with
	// "provided data '<nil>' doesn't match type 'string'" (Permit2's no-version
	// domain is the canonical case). Mirrors viem's `getTypesForEIP712Domain`
	// and the same fix applied to `go/mechanisms/evm/eip712.go`.
	if _, exists := typedData.Types["EIP712Domain"]; !exists {
		domainFields := make([]apitypes.Type, 0, 4)
		if typedData.Domain.Name != "" {
			domainFields = append(domainFields, apitypes.Type{Name: "name", Type: "string"})
		}
		if typedData.Domain.Version != "" {
			domainFields = append(domainFields, apitypes.Type{Name: "version", Type: "string"})
		}
		if typedData.Domain.ChainId != nil {
			domainFields = append(domainFields, apitypes.Type{Name: "chainId", Type: "uint256"})
		}
		if typedData.Domain.VerifyingContract != "" {
			domainFields = append(domainFields, apitypes.Type{Name: "verifyingContract", Type: "address"})
		}
		typedData.Types["EIP712Domain"] = domainFields
	}

	// Hash the struct data
	dataHash, err := typedData.HashStruct(typedData.PrimaryType, typedData.Message)
	if err != nil {
		return nil, fmt.Errorf("failed to hash struct: %w", err)
	}

	// Hash the domain
	domainSeparator, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		return nil, fmt.Errorf("failed to hash domain: %w", err)
	}

	// Create EIP-712 digest: 0x19 0x01 <domainSeparator> <dataHash>
	rawData := []byte{0x19, 0x01}
	rawData = append(rawData, domainSeparator...)
	rawData = append(rawData, dataHash...)
	digest := crypto.Keccak256(rawData)

	// Sign the digest with ECDSA
	signature, err := crypto.Sign(digest, s.privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign: %w", err)
	}

	// Adjust v value for Ethereum (recovery ID 0/1 → 27/28)
	signature[64] += 27

	return signature, nil
}

// GetTransactionCount returns the pending nonce for the given address.
// Requires an ethclient to be provided via NewClientSignerFromPrivateKeyWithClient.
func (s *ClientSigner) GetTransactionCount(ctx context.Context, address string) (uint64, error) {
	if s.ethClient == nil {
		return 0, fmt.Errorf("GetTransactionCount requires an ethclient; use NewClientSignerFromPrivateKeyWithClient")
	}
	nonce, err := s.ethClient.PendingNonceAt(ctx, common.HexToAddress(address))
	if err != nil {
		return 0, fmt.Errorf("failed to get pending nonce: %w", err)
	}
	return nonce, nil
}

// EstimateFeesPerGas returns EIP-1559 fee parameters by querying the connected node.
// Returns maxFeePerGas and maxPriorityFeePerGas. Falls back to 1 gwei / 0.1 gwei on error.
// Requires an ethclient to be provided via NewClientSignerFromPrivateKeyWithClient.
func (s *ClientSigner) EstimateFeesPerGas(ctx context.Context) (maxFeePerGas, maxPriorityFeePerGas *big.Int, err error) {
	gwei := big.NewInt(1_000_000_000)
	fallbackMax := new(big.Int).Mul(big.NewInt(1), gwei)  // 1 gwei
	fallbackTip := new(big.Int).Div(gwei, big.NewInt(10)) // 0.1 gwei

	if s.ethClient == nil {
		return fallbackMax, fallbackTip, nil
	}

	tip, err := s.ethClient.SuggestGasTipCap(ctx)
	if err != nil {
		return fallbackMax, fallbackTip, err
	}

	// Get base fee from the latest block header
	header, err := s.ethClient.HeaderByNumber(ctx, nil)
	if err != nil {
		// Use tip + 1 gwei as maxFee
		maxFee := new(big.Int).Add(tip, gwei)
		return maxFee, tip, err
	}

	// maxFeePerGas = 2 * baseFee + tip (EIP-1559 convention)
	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = gwei // fallback to 1 gwei
	}
	maxFee := new(big.Int).Add(new(big.Int).Mul(big.NewInt(2), baseFee), tip)
	return maxFee, tip, nil
}

// SignTransaction signs an EIP-1559 transaction using the signer's private key
// and returns the RLP-encoded signed transaction bytes.
func (s *ClientSigner) SignTransaction(ctx context.Context, tx *types.Transaction) ([]byte, error) {
	// Derive chain ID from tx
	chainID := tx.ChainId()
	signer := types.LatestSignerForChainID(chainID)

	signedTx, err := types.SignTx(tx, signer, s.privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign transaction: %w", err)
	}

	rlpBytes, err := signedTx.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("failed to RLP-encode transaction: %w", err)
	}

	return rlpBytes, nil
}

// ReadContract reads data from a smart contract.
// Requires an ethclient to be provided via NewClientSignerFromPrivateKeyWithClient.
func (s *ClientSigner) ReadContract(
	ctx context.Context,
	contractAddress string,
	abiBytes []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	if s.ethClient == nil {
		return nil, fmt.Errorf("ReadContract requires an ethclient; use NewClientSignerFromPrivateKeyWithClient")
	}

	// Parse ABI
	contractABI, err := abi.JSON(strings.NewReader(string(abiBytes)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse ABI: %w", err)
	}

	// Pack the method call
	data, err := contractABI.Pack(functionName, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to pack method call: %w", err)
	}

	// Create call message
	addr := common.HexToAddress(contractAddress)
	msg := ethereum.CallMsg{
		To:   &addr,
		Data: data,
	}

	// Execute call
	result, err := s.ethClient.CallContract(ctx, msg, nil)
	if err != nil {
		return nil, fmt.Errorf("contract call failed: %w", err)
	}

	// Unpack result
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
