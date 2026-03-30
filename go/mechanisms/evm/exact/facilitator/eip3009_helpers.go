package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	"github.com/coinbase/x402/go/mechanisms/evm"
)

// ParsedEIP3009Authorization contains the parsed transfer arguments used by verify and settle.
type ParsedEIP3009Authorization struct {
	From        common.Address
	To          common.Address
	Value       *big.Int
	ValidAfter  *big.Int
	ValidBefore *big.Int
	Nonce       [32]byte
}

// EIP3009SignatureClassification captures how the signature should be treated.
type EIP3009SignatureClassification struct {
	Valid         bool
	IsSmartWallet bool
	IsUndeployed  bool
	SigData       *evm.ERC6492SignatureData
}

// ParseEIP3009Authorization parses authorization fields into contract-call arguments.
func ParseEIP3009Authorization(
	authorization evm.ExactEIP3009Authorization,
) (*ParsedEIP3009Authorization, error) {
	value, ok := new(big.Int).SetString(authorization.Value, 10)
	if !ok {
		return nil, fmt.Errorf("invalid authorization value: %s", authorization.Value)
	}

	validAfter, ok := new(big.Int).SetString(authorization.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.ValidAfter)
	}

	validBefore, ok := new(big.Int).SetString(authorization.ValidBefore, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validBefore: %s", authorization.ValidBefore)
	}

	nonceBytes, err := evm.HexToBytes(authorization.Nonce)
	if err != nil {
		return nil, fmt.Errorf("invalid nonce: %w", err)
	}
	if len(nonceBytes) != 32 {
		return nil, fmt.Errorf("invalid nonce length: got %d bytes, want 32", len(nonceBytes))
	}

	var nonce [32]byte
	copy(nonce[:], nonceBytes)

	return &ParsedEIP3009Authorization{
		From:        common.HexToAddress(authorization.From),
		To:          common.HexToAddress(authorization.To),
		Value:       value,
		ValidAfter:  validAfter,
		ValidBefore: validBefore,
		Nonce:       nonce,
	}, nil
}

// ClassifyEIP3009Signature checks the signature directly when possible, while preserving
// smart-wallet signatures for simulation-first verification.
func ClassifyEIP3009Signature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	authorization evm.ExactEIP3009Authorization,
	signature []byte,
	chainID *big.Int,
	tokenAddress string,
	tokenName string,
	tokenVersion string,
) (*EIP3009SignatureClassification, error) {
	hash, err := evm.HashEIP3009Authorization(
		authorization,
		chainID,
		tokenAddress,
		tokenName,
		tokenVersion,
	)
	if err != nil {
		return nil, err
	}

	var hash32 [32]byte
	copy(hash32[:], hash)

	valid, sigData, err := evm.VerifyUniversalSignature(
		ctx,
		signer,
		authorization.From,
		hash32,
		signature,
		true,
	)
	if err != nil {
		return nil, err
	}
	if sigData == nil {
		sigData = &evm.ERC6492SignatureData{InnerSignature: signature}
	}

	classification := &EIP3009SignatureClassification{
		Valid:   valid,
		SigData: sigData,
	}

	if HasEIP6492Deployment(sigData) || len(sigData.InnerSignature) != 65 {
		classification.IsSmartWallet = true
	}
	if valid {
		return classification, nil
	}

	code, err := signer.GetCode(ctx, authorization.From)
	if err != nil {
		return nil, err
	}
	if len(code) > 0 {
		classification.IsSmartWallet = true
		return classification, nil
	}

	if HasEIP6492Deployment(sigData) {
		classification.IsSmartWallet = true
		classification.IsUndeployed = true
		return classification, nil
	}

	if len(sigData.InnerSignature) != 65 {
		classification.IsSmartWallet = true
		classification.IsUndeployed = true
	}

	return classification, nil
}

// SimulateEIP3009Transfer runs the transfer via eth_call.
func SimulateEIP3009Transfer(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	parsed *ParsedEIP3009Authorization,
	sigData *evm.ERC6492SignatureData,
) (bool, error) {
	if sigData == nil {
		return false, fmt.Errorf("missing signature data")
	}

	if HasEIP6492Deployment(sigData) {
		transferCalldata, err := buildTransferWithAuthorizationBytesCalldata(parsed, sigData.InnerSignature)
		if err != nil {
			return false, err
		}

		results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
			{
				Address:  common.BytesToAddress(sigData.Factory[:]).Hex(),
				CallData: sigData.FactoryCalldata,
			},
			{
				Address:  tokenAddress,
				CallData: transferCalldata,
			},
		})
		if err != nil {
			return false, err
		}
		if len(results) < 2 {
			return false, nil
		}

		return results[1].Success(), nil
	}

	if len(sigData.InnerSignature) == 65 {
		v, r, s := splitSignatureParts(sigData.InnerSignature)
		_, err := signer.ReadContract(
			ctx,
			tokenAddress,
			evm.TransferWithAuthorizationVRSABI,
			evm.FunctionTransferWithAuthorization,
			parsed.From,
			parsed.To,
			parsed.Value,
			parsed.ValidAfter,
			parsed.ValidBefore,
			parsed.Nonce,
			v,
			r,
			s,
		)
		if err != nil {
			return false, err
		}

		return true, nil
	}

	_, err := signer.ReadContract(
		ctx,
		tokenAddress,
		evm.TransferWithAuthorizationBytesABI,
		evm.FunctionTransferWithAuthorization,
		parsed.From,
		parsed.To,
		parsed.Value,
		parsed.ValidAfter,
		parsed.ValidBefore,
		parsed.Nonce,
		sigData.InnerSignature,
	)
	if err != nil {
		return false, err
	}

	return true, nil
}

// DiagnoseEIP3009SimulationFailure resolves a failed simulation into the most specific error.
func DiagnoseEIP3009SimulationFailure(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	authorization evm.ExactEIP3009Authorization,
	requiredAmount *big.Int,
	tokenName string,
	tokenVersion string,
) string {
	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
		{
			Address:      tokenAddress,
			ABI:          evm.ERC20BalanceOfABI,
			FunctionName: "balanceOf",
			Args:         []interface{}{common.HexToAddress(authorization.From)},
		},
		{
			Address:      tokenAddress,
			ABI:          evm.ERC20NameABI,
			FunctionName: "name",
		},
		{
			Address:      tokenAddress,
			ABI:          evm.ERC20VersionABI,
			FunctionName: "version",
		},
		{
			Address:      tokenAddress,
			ABI:          evm.AuthorizationStateABI,
			FunctionName: evm.FunctionAuthorizationState,
			Args:         []interface{}{common.HexToAddress(authorization.From), mustNonce(authorization.Nonce)},
		},
	})
	if err != nil || len(results) < 4 {
		return ErrEip3009SimulationFailed
	}

	authStateResult := results[3]
	if !authStateResult.Success() {
		return ErrEip3009NotSupported
	}

	if nonceUsed, ok := authStateResult.Result.(bool); ok && nonceUsed {
		return ErrNonceAlreadyUsed
	}

	nameResult := results[1]
	if tokenName != "" && nameResult.Success() {
		if actualName, ok := nameResult.Result.(string); ok && actualName != tokenName {
			return ErrEip3009TokenNameMismatch
		}
	}

	versionResult := results[2]
	if tokenVersion != "" && versionResult.Success() {
		if actualVersion, ok := versionResult.Result.(string); ok && actualVersion != tokenVersion {
			return ErrEip3009TokenVersionMismatch
		}
	}

	balanceResult := results[0]
	if balanceResult.Success() {
		if balance := asBigInt(balanceResult.Result); balance != nil && balance.Cmp(requiredAmount) < 0 {
			return ErrInsufficientBalance
		}
	}

	return ErrEip3009SimulationFailed
}

// ExecuteTransferWithAuthorization executes the actual transfer onchain.
func ExecuteTransferWithAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	tokenAddress string,
	parsed *ParsedEIP3009Authorization,
	sigData *evm.ERC6492SignatureData,
) (string, error) {
	if sigData == nil {
		return "", fmt.Errorf("missing signature data")
	}

	if len(sigData.InnerSignature) == 65 {
		v, r, s := splitSignatureParts(sigData.InnerSignature)
		return signer.WriteContract(
			ctx,
			tokenAddress,
			evm.TransferWithAuthorizationVRSABI,
			evm.FunctionTransferWithAuthorization,
			parsed.From,
			parsed.To,
			parsed.Value,
			parsed.ValidAfter,
			parsed.ValidBefore,
			parsed.Nonce,
			v,
			r,
			s,
		)
	}

	return signer.WriteContract(
		ctx,
		tokenAddress,
		evm.TransferWithAuthorizationBytesABI,
		evm.FunctionTransferWithAuthorization,
		parsed.From,
		parsed.To,
		parsed.Value,
		parsed.ValidAfter,
		parsed.ValidBefore,
		parsed.Nonce,
		sigData.InnerSignature,
	)
}

// DeploySmartWallet sends the ERC-6492 factory deployment transaction when enabled.
func DeploySmartWallet(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	sigData *evm.ERC6492SignatureData,
) error {
	if !HasEIP6492Deployment(sigData) {
		return nil
	}

	txHash, err := signer.SendTransaction(
		ctx,
		common.BytesToAddress(sigData.Factory[:]).Hex(),
		sigData.FactoryCalldata,
	)
	if err != nil {
		return fmt.Errorf("factory deployment transaction failed: %w", err)
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return fmt.Errorf("failed to wait for deployment: %w", err)
	}
	if receipt.Status != evm.TxStatusSuccess {
		return fmt.Errorf("deployment transaction reverted")
	}

	return nil
}

func buildTransferWithAuthorizationBytesCalldata(
	parsed *ParsedEIP3009Authorization,
	signature []byte,
) ([]byte, error) {
	return packCallData(
		evm.TransferWithAuthorizationBytesABI,
		evm.FunctionTransferWithAuthorization,
		parsed.From,
		parsed.To,
		parsed.Value,
		parsed.ValidAfter,
		parsed.ValidBefore,
		parsed.Nonce,
		signature,
	)
}

func packCallData(abiBytes []byte, functionName string, args ...interface{}) ([]byte, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(abiBytes)))
	if err != nil {
		return nil, err
	}

	data, err := contractABI.Pack(functionName, args...)
	if err != nil {
		return nil, err
	}

	return data, nil
}

func splitSignatureParts(signature []byte) (uint8, [32]byte, [32]byte) {
	var r [32]byte
	var s [32]byte
	copy(r[:], signature[0:32])
	copy(s[:], signature[32:64])

	v := signature[64]
	if v == 0 || v == 1 {
		v += 27
	}

	return v, r, s
}

func HasEIP6492Deployment(sigData *evm.ERC6492SignatureData) bool {
	if sigData == nil {
		return false
	}

	var zeroFactory [20]byte
	return sigData.Factory != zeroFactory && len(sigData.FactoryCalldata) > 0
}

func mustNonce(nonce string) [32]byte {
	nonceBytes, _ := evm.HexToBytes(nonce)
	var nonceArray [32]byte
	copy(nonceArray[:], nonceBytes)
	return nonceArray
}

func asBigInt(value interface{}) *big.Int {
	switch v := value.(type) {
	case *big.Int:
		return v
	case big.Int:
		return &v
	default:
		return nil
	}
}
