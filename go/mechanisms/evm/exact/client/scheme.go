package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
	"github.com/coinbase/x402/go/extensions/erc20approvalgassponsor"
	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// ExactEvmScheme implements the SchemeNetworkClient interface for EVM exact payments (V2)
type ExactEvmScheme struct {
	signer evm.ClientEvmSigner
	config *ExactEvmSchemeConfig
}

// NewExactEvmScheme creates a new ExactEvmScheme.
// Base flows only require a signer that can sign typed data.
// Extension enrichment paths use optional runtime capabilities.
func NewExactEvmScheme(signer evm.ClientEvmSigner, config *ExactEvmSchemeConfig) *ExactEvmScheme {
	return &ExactEvmScheme{
		signer: signer,
		config: config,
	}
}

// Scheme returns the scheme identifier
func (c *ExactEvmScheme) Scheme() string {
	return evm.SchemeExact
}

// CreatePaymentPayload creates a V2 payment payload for the exact scheme.
// Routes to EIP-3009 or Permit2 based on requirements.Extra["assetTransferMethod"].
// Defaults to EIP-3009 for backward compatibility.
func (c *ExactEvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	assetTransferMethod := evm.AssetTransferMethodEIP3009 // default
	if requirements.Extra != nil {
		if method, ok := requirements.Extra["assetTransferMethod"].(string); ok {
			assetTransferMethod = evm.AssetTransferMethod(method)
		}
	}
	if assetTransferMethod == evm.AssetTransferMethodPermit2 {
		return CreatePermit2Payload(ctx, c.signer, requirements)
	}
	return c.createEIP3009Payload(ctx, requirements)
}

// CreatePaymentPayloadWithExtensions creates a payment payload with extension awareness.
// For Permit2 flows, if the server advertises eip2612GasSponsoring and the signer
// supports ReadContract, automatically signs an EIP-2612 permit when Permit2
// allowance is insufficient.
func (c *ExactEvmScheme) CreatePaymentPayloadWithExtensions(
	ctx context.Context,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
) (types.PaymentPayload, error) {
	assetTransferMethod := evm.AssetTransferMethodEIP3009
	if requirements.Extra != nil {
		if method, ok := requirements.Extra["assetTransferMethod"].(string); ok {
			assetTransferMethod = evm.AssetTransferMethod(method)
		}
	}
	if assetTransferMethod == evm.AssetTransferMethodPermit2 {
		result, err := CreatePermit2Payload(ctx, c.signer, requirements)
		if err != nil {
			return types.PaymentPayload{}, err
		}

		extData, err := c.trySignEip2612Permit(ctx, requirements, result, extensions)
		if extData != nil {
			result.Extensions = extData
		} else if err == nil {
			// EIP-2612 not applicable — try ERC-20 approval fallback
			erc20ExtData, erc20Err := c.trySignErc20Approval(ctx, requirements, extensions)
			if erc20Err == nil && erc20ExtData != nil {
				result.Extensions = erc20ExtData
			}
		}

		return result, nil
	}

	return c.createEIP3009Payload(ctx, requirements)
}

// trySignEip2612Permit attempts to sign an EIP-2612 permit for gasless Permit2 approval.
func (c *ExactEvmScheme) trySignEip2612Permit(
	ctx context.Context,
	requirements types.PaymentRequirements,
	result types.PaymentPayload,
	extensions map[string]interface{},
) (map[string]interface{}, error) {
	if extensions == nil {
		return nil, nil
	}
	if _, ok := extensions[eip2612gassponsor.EIP2612GasSponsoring.Key()]; !ok {
		return nil, nil
	}

	tokenName, _ := requirements.Extra["name"].(string)
	tokenVersion, _ := requirements.Extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		return nil, nil
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, err
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	readSigner, err := c.resolveReadSigner(ctx, requirements.Network)
	if err != nil {
		return nil, err
	}
	if readSigner == nil {
		return nil, nil
	}

	// Check if user already has sufficient Permit2 allowance
	allowanceResult, err := readSigner.ReadContract(
		ctx,
		tokenAddress,
		evm.ERC20AllowanceABI,
		"allowance",
		common.HexToAddress(c.signer.Address()),
		common.HexToAddress(evm.PERMIT2Address),
	)
	if err == nil {
		if allowanceBig, ok := allowanceResult.(*big.Int); ok {
			requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
			if ok && allowanceBig.Cmp(requiredAmount) >= 0 {
				return nil, nil // Already approved
			}
		}
	}

	// Determine deadline from Permit2 authorization
	deadline := ""
	if result.Payload != nil {
		if auth, ok := result.Payload["permit2Authorization"].(map[string]interface{}); ok {
			if d, ok := auth["deadline"].(string); ok {
				deadline = d
			}
		}
	}
	if deadline == "" {
		deadline = fmt.Sprintf("%d", time.Now().Unix()+int64(requirements.MaxTimeoutSeconds))
	}

	// Sign the EIP-2612 permit with the exact Permit2 permitted amount
	// (the contract enforces permit2612.value == permit.permitted.amount)
	info, err := SignEip2612Permit(ctx, readSigner, tokenAddress, tokenName, tokenVersion, chainID, deadline, requirements.Amount)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}, nil
}

// trySignErc20Approval attempts to sign an ERC-20 approve(Permit2, MaxUint256) transaction
// for tokens that do not support EIP-2612. The signed transaction is attached as an extension
// so the facilitator can broadcast it before calling settle().
func (c *ExactEvmScheme) trySignErc20Approval(
	ctx context.Context,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
) (map[string]interface{}, error) {
	if extensions == nil {
		return nil, nil
	}
	if _, ok := extensions[erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()]; !ok {
		return nil, nil
	}

	txSigner, err := c.resolveTxSigner(ctx, requirements.Network)
	if err != nil {
		return nil, err
	}
	if txSigner == nil {
		return nil, nil
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, err
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	// If read capability exists, skip signing when Permit2 allowance is already sufficient.
	if readSigner, hasRead := c.signer.(evm.ClientEvmSignerWithReadContract); hasRead {
		allowanceResult, err := readSigner.ReadContract(
			ctx,
			tokenAddress,
			evm.ERC20AllowanceABI,
			"allowance",
			common.HexToAddress(c.signer.Address()),
			common.HexToAddress(evm.PERMIT2Address),
		)
		if err == nil {
			if allowanceBig, ok := allowanceResult.(*big.Int); ok {
				requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
				if ok && allowanceBig.Cmp(requiredAmount) >= 0 {
					return nil, nil // Already approved
				}
			}
		}
	}

	// Sign the approve transaction
	info, err := SignErc20ApprovalTransaction(ctx, txSigner, tokenAddress, chainID)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}, nil
}

// createEIP3009Payload creates an EIP-3009 (transferWithAuthorization) payload.
func (c *ExactEvmScheme) createEIP3009Payload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	networkStr := string(requirements.Network)

	// Get chain ID - works for any EIP-155 network (eip155:CHAIN_ID)
	chainID, err := evm.GetEvmChainId(networkStr)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// Get asset info - works for any explicit address, or uses default if configured
	assetInfo, err := evm.GetAssetInfo(networkStr, requirements.Asset)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// Requirements.Amount is already in the smallest unit
	value, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAmount+": %s", requirements.Amount)
	}

	// Create nonce
	nonce, err := evm.CreateNonce()
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// V2 specific: No buffer on validAfter (can use immediately)
	validAfter, validBefore := evm.CreateValidityWindow(time.Hour)

	// Extract extra fields for EIP-3009
	tokenName := assetInfo.Name
	tokenVersion := assetInfo.Version
	if requirements.Extra != nil {
		if name, ok := requirements.Extra["name"].(string); ok {
			tokenName = name
		}
		if ver, ok := requirements.Extra["version"].(string); ok {
			tokenVersion = ver
		}
	}

	// Create authorization
	authorization := evm.ExactEIP3009Authorization{
		From:        c.signer.Address(),
		To:          requirements.PayTo,
		Value:       value.String(),
		ValidAfter:  validAfter.String(),
		ValidBefore: validBefore.String(),
		Nonce:       nonce,
	}

	// Sign the authorization
	signature, err := c.signAuthorization(ctx, authorization, chainID, assetInfo.Address, tokenName, tokenVersion)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignAuthorization+": %w", err)
	}

	// Create EVM payload
	evmPayload := &evm.ExactEIP3009Payload{
		Signature:     evm.BytesToHex(signature),
		Authorization: authorization,
	}

	// Return partial V2 payload (core will add accepted, resource, extensions)
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     evmPayload.ToMap(),
	}, nil
}

// signAuthorization signs the EIP-3009 authorization using EIP-712
func (c *ExactEvmScheme) signAuthorization(
	ctx context.Context,
	authorization evm.ExactEIP3009Authorization,
	chainID *big.Int,
	verifyingContract string,
	tokenName string,
	tokenVersion string,
) ([]byte, error) {
	// Create EIP-712 domain
	domain := evm.TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainID,
		VerifyingContract: verifyingContract,
	}

	// Define EIP-712 types
	types := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"TransferWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	// Parse values for message (these are set by us in createEIP3009Payload, but validate for safety)
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

	// Create message
	message := map[string]interface{}{
		"from":        authorization.From,
		"to":          authorization.To,
		"value":       value,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       nonceBytes,
	}

	// Sign the typed data
	return c.signer.SignTypedData(ctx, domain, types, "TransferWithAuthorization", message)
}
