package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/types"
)

// CreatePermit2Payload creates a Permit2 payload using the x402Permit2Proxy witness pattern.
// The spender is set to x402Permit2Proxy, which enforces that funds
// can only be sent to the witness.to address.
func CreatePermit2Payload(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	networkStr := string(requirements.Network)

	// Get chain ID
	chainID, err := evm.GetEvmChainId(networkStr)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// Create nonce (uint256)
	nonce, err := evm.CreatePermit2Nonce()
	if err != nil {
		return types.PaymentPayload{}, err
	}

	now := time.Now().Unix()
	validAfter := fmt.Sprintf("%d", now-600) // 10 minutes buffer for clock skew
	deadline := fmt.Sprintf("%d", now+int64(requirements.MaxTimeoutSeconds))

	// Normalize addresses
	tokenAddress := evm.NormalizeAddress(requirements.Asset)
	payTo := evm.NormalizeAddress(requirements.PayTo)

	// Build authorization
	authorization := evm.Permit2Authorization{
		From: signer.Address(),
		Permitted: evm.Permit2TokenPermissions{
			Token:  tokenAddress,
			Amount: requirements.Amount,
		},
		Spender:  evm.X402ExactPermit2ProxyAddress,
		Nonce:    nonce,
		Deadline: deadline,
		Witness: evm.Permit2Witness{
			To:         payTo,
			ValidAfter: validAfter,
		},
	}

	// Sign the authorization
	signature, err := signPermit2Authorization(ctx, signer, authorization, chainID)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignPermit2Authorization+": %w", err)
	}

	// Create payload
	permit2Payload := &evm.ExactPermit2Payload{
		Signature:            evm.BytesToHex(signature),
		Permit2Authorization: authorization,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     permit2Payload.ToMap(),
	}, nil
}

// signPermit2Authorization signs the Permit2 authorization using EIP-712.
func signPermit2Authorization(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	authorization evm.Permit2Authorization,
	chainID *big.Int,
) ([]byte, error) {
	// Create EIP-712 domain (Permit2 uses fixed name, no version)
	domain := evm.TypedDataDomain{
		Name:              "Permit2",
		ChainID:           chainID,
		VerifyingContract: evm.PERMIT2Address,
	}

	// Use shared EIP-712 types to ensure consistency with on-chain contract
	types := evm.GetPermit2EIP712Types()

	// Parse values (these are set by us in CreatePermit2Payload, but validate for safety)
	amount, ok := new(big.Int).SetString(authorization.Permitted.Amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permitted amount: %s", authorization.Permitted.Amount)
	}
	nonce, ok := new(big.Int).SetString(authorization.Nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce: %s", authorization.Nonce)
	}
	deadline, ok := new(big.Int).SetString(authorization.Deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid deadline: %s", authorization.Deadline)
	}
	validAfter, ok := new(big.Int).SetString(authorization.Witness.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.Witness.ValidAfter)
	}

	// Create message with nested structs
	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  authorization.Permitted.Token,
			"amount": amount,
		},
		"spender":  authorization.Spender,
		"nonce":    nonce,
		"deadline": deadline,
		"witness":  evm.BuildPermit2WitnessMap(authorization.Witness.To, validAfter),
	}

	return signer.SignTypedData(ctx, domain, types, "PermitWitnessTransferFrom", message)
}

// Permit2AllowanceParams contains parameters for checking Permit2 allowance.
type Permit2AllowanceParams struct {
	TokenAddress string
	OwnerAddress string
}

// GetPermit2AllowanceReadParams returns contract read parameters for checking Permit2 allowance.
// Use with a signer's ReadContract method to check if the user has approved Permit2.
func GetPermit2AllowanceReadParams(params Permit2AllowanceParams) (address string, abi []byte, functionName string, args []interface{}) {
	return evm.NormalizeAddress(params.TokenAddress),
		evm.ERC20AllowanceABI,
		"allowance",
		[]interface{}{params.OwnerAddress, evm.PERMIT2Address}
}

// CreatePermit2ApprovalTxData creates transaction data to approve Permit2 to spend tokens.
// The user sends this transaction (paying gas) before using Permit2 flow.
// Returns the target address and calldata.
func CreatePermit2ApprovalTxData(tokenAddress string) (to string, abi []byte, functionName string, args []interface{}) {
	return evm.NormalizeAddress(tokenAddress),
		evm.ERC20ApproveABI,
		"approve",
		[]interface{}{evm.PERMIT2Address, evm.MaxUint256()}
}
