package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// verifyEIP3009 verifies an EIP-3009 payment payload.
func (f *ExactEvmScheme) verifyEIP3009(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	simulate bool,
) (*x402.VerifyResponse, error) {
	if payload.Accepted.Scheme != evm.SchemeExact {
		return nil, x402.NewVerifyError(ErrInvalidScheme, "", fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}

	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, "", fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}

	evmPayload, err := evm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, "", fmt.Sprintf("failed to parse EVM payload: %s", err.Error()))
	}

	if evmPayload.Signature == "" {
		return nil, x402.NewVerifyError(ErrMissingSignature, "", "missing signature")
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToGetNetworkConfig, "", err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	if !strings.EqualFold(evmPayload.Authorization.To, requirements.PayTo) {
		return nil, x402.NewVerifyError(ErrRecipientMismatch, "", fmt.Sprintf("recipient mismatch: %s != %s", evmPayload.Authorization.To, requirements.PayTo))
	}

	parsedAuthorization, err := ParseEIP3009Authorization(evmPayload.Authorization)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, evmPayload.Authorization.From, err.Error())
	}

	requiredValue, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidRequiredAmount, "", fmt.Sprintf("invalid required amount: %s", requirements.Amount))
	}

	if parsedAuthorization.Value.Cmp(requiredValue) != 0 {
		return nil, x402.NewVerifyError(ErrAuthorizationValueMismatch, evmPayload.Authorization.From, fmt.Sprintf("authorization value mismatch: %s != %s", parsedAuthorization.Value.String(), requiredValue.String()))
	}

	now := time.Now().Unix()
	if parsedAuthorization.ValidBefore.Cmp(big.NewInt(now+6)) < 0 {
		return nil, x402.NewVerifyError(ErrValidBeforeExpired, evmPayload.Authorization.From, fmt.Sprintf("valid before expired: %s", parsedAuthorization.ValidBefore.String()))
	}

	if parsedAuthorization.ValidAfter.Cmp(big.NewInt(now)) > 0 {
		return nil, x402.NewVerifyError(ErrValidAfterInFuture, evmPayload.Authorization.From, fmt.Sprintf("valid after in future: %s", parsedAuthorization.ValidAfter.String()))
	}

	tokenName, _ := requirements.Extra["name"].(string)
	tokenVersion, _ := requirements.Extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		return nil, x402.NewVerifyError(ErrMissingEip712Domain, evmPayload.Authorization.From, "missing EIP-712 domain name/version in requirements.extra")
	}

	signatureBytes, err := evm.HexToBytes(evmPayload.Signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidSignatureFormat, evmPayload.Authorization.From, err.Error())
	}

	classification, err := ClassifyEIP3009Signature(
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

	if !classification.Valid && classification.IsUndeployed && !HasEIP6492Deployment(classification.SigData) {
		return nil, x402.NewVerifyError(ErrUndeployedSmartWallet, evmPayload.Authorization.From, "")
	}

	if !classification.Valid && !classification.IsSmartWallet {
		return nil, x402.NewVerifyError(ErrInvalidSignature, evmPayload.Authorization.From, fmt.Sprintf("invalid signature: %s", evmPayload.Signature))
	}

	if simulate {
		simulationSucceeded, err := SimulateEIP3009Transfer(
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
			reason := DiagnoseEIP3009SimulationFailure(
				ctx,
				f.signer,
				tokenAddress,
				evmPayload.Authorization,
				requiredValue,
				tokenName,
				tokenVersion,
			)
			return nil, x402.NewVerifyError(reason, evmPayload.Authorization.From, "")
		}
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   evmPayload.Authorization.From,
	}, nil
}

// settleEIP3009 settles an EIP-3009 payment on-chain.
func (f *ExactEvmScheme) settleEIP3009(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	verifyResp, err := f.verifyEIP3009(ctx, payload, requirements, f.config.SimulateInSettle)
	if err != nil {
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	evmPayload, err := evm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	signatureBytes, err := evm.HexToBytes(evmPayload.Signature)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidSignatureFormat, verifyResp.Payer, network, "", err.Error())
	}

	sigData, err := evm.ParseERC6492Signature(signatureBytes)
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToParseSignature, verifyResp.Payer, network, "", err.Error())
	}

	if HasEIP6492Deployment(sigData) {
		code, err := f.signer.GetCode(ctx, evmPayload.Authorization.From)
		if err != nil {
			return nil, x402.NewSettleError(ErrFailedToCheckDeployment, verifyResp.Payer, network, "", err.Error())
		}

		if len(code) == 0 {
			if !f.config.DeployERC4337WithEIP6492 {
				return nil, x402.NewSettleError(ErrUndeployedSmartWallet, verifyResp.Payer, network, "", "")
			}

			if err := DeploySmartWallet(ctx, f.signer, sigData); err != nil {
				return nil, x402.NewSettleError(ErrSmartWalletDeploymentFailed, verifyResp.Payer, network, "", err.Error())
			}
		}
	}

	parsedAuthorization, err := ParseEIP3009Authorization(evmPayload.Authorization)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	txHash, err := ExecuteTransferWithAuthorization(ctx, f.signer, tokenAddress, parsedAuthorization, sigData)
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToExecuteTransfer, verifyResp.Payer, network, "", err.Error())
	}

	receipt, err := f.signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToGetReceipt, verifyResp.Payer, network, txHash, err.Error())
	}

	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionFailed, verifyResp.Payer, network, txHash, "")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       verifyResp.Payer,
	}, nil
}
