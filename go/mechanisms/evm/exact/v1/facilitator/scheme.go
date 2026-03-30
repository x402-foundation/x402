package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
	exactfacilitator "github.com/coinbase/x402/go/mechanisms/evm/exact/facilitator"
	evmv1 "github.com/coinbase/x402/go/mechanisms/evm/v1"
	"github.com/coinbase/x402/go/types"
)

// ExactEvmSchemeV1Config holds configuration for the ExactEvmSchemeV1 facilitator
type ExactEvmSchemeV1Config struct {
	// DeployERC4337WithEIP6492 enables automatic deployment of ERC-4337 smart wallets
	// via EIP-6492 when encountering undeployed contract signatures during settlement
	DeployERC4337WithEIP6492 bool
	// SimulateInSettle reruns transfer simulation during settle. Verify always simulates.
	SimulateInSettle bool
}

// ExactEvmSchemeV1 implements the SchemeNetworkFacilitatorV1 interface for EVM exact payments (V1)
type ExactEvmSchemeV1 struct {
	signer evm.FacilitatorEvmSigner
	config ExactEvmSchemeV1Config
}

// NewExactEvmSchemeV1 creates a new ExactEvmSchemeV1
// Args:
//
//	signer: The EVM signer for facilitator operations
//	config: Optional configuration (nil uses defaults)
//
// Returns:
//
//	Configured ExactEvmSchemeV1 instance
func NewExactEvmSchemeV1(signer evm.FacilitatorEvmSigner, config *ExactEvmSchemeV1Config) *ExactEvmSchemeV1 {
	cfg := ExactEvmSchemeV1Config{}
	if config != nil {
		cfg = *config
	}
	return &ExactEvmSchemeV1{
		signer: signer,
		config: cfg,
	}
}

// Scheme returns the scheme identifier
func (f *ExactEvmSchemeV1) Scheme() string {
	return evm.SchemeExact
}

// CaipFamily returns the CAIP family pattern this facilitator supports
func (f *ExactEvmSchemeV1) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// For EVM, no extra data is needed.
func (f *ExactEvmSchemeV1) GetExtra(_ x402.Network) map[string]interface{} {
	return nil
}

// GetSigners returns signer addresses used by this facilitator.
// Returns all addresses this facilitator can use for signing/settling transactions.
func (f *ExactEvmSchemeV1) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a V1 payment payload against requirements
func (f *ExactEvmSchemeV1) Verify(
	ctx context.Context,
	payload types.PaymentPayloadV1,
	requirements types.PaymentRequirementsV1,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	return f.verify(ctx, payload, requirements, fctx, true)
}

func (f *ExactEvmSchemeV1) verify(
	ctx context.Context,
	payload types.PaymentPayloadV1,
	requirements types.PaymentRequirementsV1,
	_ *x402.FacilitatorContext,
	simulate bool,
) (*x402.VerifyResponse, error) {
	// Validate scheme (v1 has scheme at top level)
	if payload.Scheme != evm.SchemeExact || requirements.Scheme != evm.SchemeExact {
		scheme := payload.Scheme
		if scheme == "" {
			scheme = requirements.Scheme
		}
		errorMessage := "invalid scheme"
		if scheme != "" {
			errorMessage = fmt.Sprintf("invalid scheme: %s", scheme)
		}
		return nil, x402.NewVerifyError(ErrUnsupportedScheme, "", errorMessage)
	}

	// Validate network (v1 has network at top level)
	if payload.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, "", fmt.Sprintf("network mismatch: %s != %s", payload.Network, requirements.Network))
	}

	// Parse EVM payload
	evmPayload, err := evm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, "", err.Error())
	}

	// Validate signature exists
	if evmPayload.Signature == "" {
		return nil, x402.NewVerifyError(ErrMissingSignature, "", "missing signature")
	}

	// Parse chain ID from v1 network name
	chainID, err := evmv1.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToGetNetworkConfig, "", err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	// Check EIP-712 domain parameters
	var extraMap map[string]interface{}
	if requirements.Extra != nil {
		if err := json.Unmarshal(*requirements.Extra, &extraMap); err != nil {
			return nil, x402.NewVerifyError(ErrInvalidExtraField, evmPayload.Authorization.From, err.Error())
		}
	}

	if extraMap == nil || extraMap["name"] == nil || extraMap["version"] == nil {
		return nil, x402.NewVerifyError(ErrMissingEip712Domain, evmPayload.Authorization.From, "missing EIP-712 domain parameters")
	}

	// Validate authorization matches requirements
	if !strings.EqualFold(evmPayload.Authorization.To, requirements.PayTo) {
		return nil, x402.NewVerifyError(ErrRecipientMismatch, evmPayload.Authorization.From, fmt.Sprintf("recipient mismatch: %s != %s", evmPayload.Authorization.To, requirements.PayTo))
	}

	parsedAuthorization, err := exactfacilitator.ParseEIP3009Authorization(evmPayload.Authorization)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, evmPayload.Authorization.From, err.Error())
	}

	// V1: Use MaxAmountRequired field
	amountStr := requirements.MaxAmountRequired

	requiredValue, ok := new(big.Int).SetString(amountStr, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidRequiredAmount, evmPayload.Authorization.From, fmt.Sprintf("invalid required amount: %s", amountStr))
	}

	if parsedAuthorization.Value.Cmp(requiredValue) != 0 {
		return nil, x402.NewVerifyError(ErrAuthorizationValueMismatch, evmPayload.Authorization.From, fmt.Sprintf("authorization value mismatch: %s != %s", parsedAuthorization.Value.String(), requiredValue.String()))
	}

	// V1 specific: Check validBefore is in the future (with 6 second buffer for block time)
	now := time.Now().Unix()
	if parsedAuthorization.ValidBefore.Cmp(big.NewInt(now+6)) < 0 {
		return nil, x402.NewVerifyError(ErrAuthorizationValidBeforeExpired, evmPayload.Authorization.From, fmt.Sprintf("valid before expired: %s < %s", parsedAuthorization.ValidBefore.String(), big.NewInt(now+6).String()))
	}

	// V1 specific: Check validAfter is not in the future
	if parsedAuthorization.ValidAfter.Cmp(big.NewInt(now)) > 0 {
		return nil, x402.NewVerifyError(ErrAuthorizationValidAfterInFuture, evmPayload.Authorization.From, fmt.Sprintf("valid after in future: %s > %s", parsedAuthorization.ValidAfter.String(), big.NewInt(now).String()))
	}

	// Extract token info from requirements (already unmarshaled earlier)
	tokenName := extraMap["name"].(string)
	tokenVersion := extraMap["version"].(string)

	// Verify signature
	signatureBytes, err := evm.HexToBytes(evmPayload.Signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidSignatureFormat, evmPayload.Authorization.From, err.Error())
	}

	classification, err := exactfacilitator.ClassifyEIP3009Signature(
		ctx,
		f.signer,
		evmPayload.Authorization,
		signatureBytes,
		chainID,
		tokenAddress,
		tokenName,
		tokenVersion,
	)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, evmPayload.Authorization.From, err.Error())
	}

	if !classification.Valid && classification.IsUndeployed && !exactfacilitator.HasEIP6492Deployment(classification.SigData) {
		return nil, x402.NewVerifyError(ErrUndeployedSmartWallet, evmPayload.Authorization.From, "")
	}

	if !classification.Valid && !classification.IsSmartWallet {
		return nil, x402.NewVerifyError(ErrInvalidSignature, evmPayload.Authorization.From, "invalid signature")
	}

	if simulate {
		simulationSucceeded, err := exactfacilitator.SimulateEIP3009Transfer(
			ctx,
			f.signer,
			tokenAddress,
			parsedAuthorization,
			classification.SigData,
		)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidPayload, evmPayload.Authorization.From, err.Error())
		}
		if !simulationSucceeded {
			reason := exactfacilitator.DiagnoseEIP3009SimulationFailure(
				ctx,
				f.signer,
				tokenAddress,
				evmPayload.Authorization,
				requiredValue,
				tokenName,
				tokenVersion,
			)
			return nil, x402.NewVerifyError(reason, evmPayload.Authorization.From, reason)
		}
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   evmPayload.Authorization.From,
	}, nil
}

// Settle settles a V1 payment on-chain
func (f *ExactEvmSchemeV1) Settle(
	ctx context.Context,
	payload types.PaymentPayloadV1,
	requirements types.PaymentRequirementsV1,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Network)

	// First verify the payment
	verifyResp, err := f.verify(ctx, payload, requirements, fctx, f.config.SimulateInSettle)
	if err != nil {
		// Convert VerifyError to SettleError
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	// Parse EVM payload
	evmPayload, err := evm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	// Parse signature
	signatureBytes, err := evm.HexToBytes(evmPayload.Signature)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidSignatureFormat, verifyResp.Payer, network, "", err.Error())
	}

	// Parse ERC-6492 signature to extract inner signature if needed
	sigData, err := evm.ParseERC6492Signature(signatureBytes)
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToParseSignature, verifyResp.Payer, network, "", err.Error())
	}

	// Check if wallet needs deployment (undeployed smart wallet with ERC-6492)
	zeroFactory := [20]byte{}
	if sigData.Factory != zeroFactory && len(sigData.FactoryCalldata) > 0 {
		code, err := f.signer.GetCode(ctx, evmPayload.Authorization.From)
		if err != nil {
			return nil, x402.NewSettleError(ErrFailedToCheckDeployment, verifyResp.Payer, network, "", err.Error())
		}

		if len(code) == 0 {
			// Wallet not deployed
			if f.config.DeployERC4337WithEIP6492 {
				// Deploy wallet
				err := f.deploySmartWallet(ctx, sigData)
				if err != nil {
					return nil, x402.NewSettleError(ErrSmartWalletDeploymentFailed, verifyResp.Payer, network, "", err.Error())
				}
			} else {
				// Deployment not enabled - fail settlement
				return nil, x402.NewSettleError(ErrUndeployedSmartWallet, verifyResp.Payer, network, "", "")
			}
		}
	}

	parsedAuthorization, err := exactfacilitator.ParseEIP3009Authorization(evmPayload.Authorization)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	txHash, err := exactfacilitator.ExecuteTransferWithAuthorization(ctx, f.signer, tokenAddress, parsedAuthorization, sigData)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, verifyResp.Payer, network, "", err.Error())
	}

	// Wait for transaction confirmation
	receipt, err := f.signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToGetReceipt, verifyResp.Payer, network, txHash, err.Error())
	}

	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrInvalidTransactionState, verifyResp.Payer, network, txHash, "")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       verifyResp.Payer,
	}, nil
}

// deploySmartWallet deploys an ERC-4337 smart wallet using the ERC-6492 factory
//
// This function sends the pre-encoded factory calldata directly as a transaction.
// The factoryCalldata already contains the complete encoded function call with selector.
//
// Args:
//
//	ctx: Context for cancellation
//	sigData: Parsed ERC-6492 signature containing factory address and calldata
//
// Returns:
//
//	error if deployment fails
func (f *ExactEvmSchemeV1) deploySmartWallet(
	ctx context.Context,
	sigData *evm.ERC6492SignatureData,
) error {
	factoryAddr := common.BytesToAddress(sigData.Factory[:])

	// Send the factory calldata directly - it already contains the encoded function call
	txHash, err := f.signer.SendTransaction(
		ctx,
		factoryAddr.Hex(),
		sigData.FactoryCalldata,
	)
	if err != nil {
		return fmt.Errorf("factory deployment transaction failed: %w", err)
	}

	// Wait for deployment transaction
	receipt, err := f.signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return fmt.Errorf("failed to wait for deployment: %w", err)
	}

	if receipt.Status != evm.TxStatusSuccess {
		return fmt.Errorf("deployment transaction reverted")
	}

	return nil
}
