package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// CreateBatchedEIP3009DepositPayload creates a deposit + voucher payload using ERC-3009.
// Signs ReceiveWithAuthorization for the deposit and a cumulative voucher.
func CreateBatchedEIP3009DepositPayload(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	requirements types.PaymentRequirements,
	channelConfig batched.ChannelConfig,
	depositAmount string,
	maxClaimableAmount string,
	voucherSigner evm.ClientEvmSigner,
) (types.PaymentPayload, error) {
	networkStr := string(requirements.Network)

	chainId, err := evm.GetEvmChainId(networkStr)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to get chain ID: %w", err)
	}

	// Get asset info for EIP-712 domain
	assetInfo, err := evm.GetAssetInfo(networkStr, requirements.Asset)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to get asset info: %w", err)
	}

	// Get token domain info
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

	deposit, ok := new(big.Int).SetString(depositAmount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf("invalid deposit amount: %s", depositAmount)
	}

	// Create nonce for ERC-3009
	nonce, err := evm.CreateNonce()
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to create nonce: %w", err)
	}

	// Create validity window
	validAfter, validBefore := evm.CreateValidityWindow(time.Hour)

	// Sign ReceiveWithAuthorization
	// "to" is the ERC3009DepositCollector, which will forward to the BatchSettlement contract
	erc3009Domain := evm.TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainId,
		VerifyingContract: requirements.Asset,
	}

	erc3009Types := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"ReceiveWithAuthorization": batched.ReceiveAuthorizationTypes["ReceiveWithAuthorization"],
	}

	nonceBytes, err := evm.HexToBytes(nonce)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to parse nonce: %w", err)
	}

	erc3009Message := map[string]interface{}{
		"from":        signer.Address(),
		"to":          batched.ERC3009DepositCollectorAddress,
		"value":       deposit,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       nonceBytes,
	}

	erc3009Sig, err := signer.SignTypedData(ctx, erc3009Domain, erc3009Types, "ReceiveWithAuthorization", erc3009Message)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to sign ERC-3009 authorization: %w", err)
	}

	// Compute channel ID
	channelId, err := batched.ComputeChannelId(channelConfig)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to compute channel ID: %w", err)
	}

	// Sign voucher (use voucherSigner if provided)
	actualVoucherSigner := signer
	if voucherSigner != nil {
		actualVoucherSigner = voucherSigner
	}

	voucher, err := SignVoucher(ctx, actualVoucherSigner, channelId, maxClaimableAmount, networkStr)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to sign voucher: %w", err)
	}

	// Build deposit payload
	depositPayload := &batched.BatchedDepositPayload{
		Type: "deposit",
		Deposit: batched.BatchedDepositData{
			ChannelConfig: channelConfig,
			Amount:        depositAmount,
			Authorization: batched.BatchedDepositAuthorization{
				Erc3009Authorization: &batched.BatchedErc3009Authorization{
					ValidAfter:  validAfter.String(),
					ValidBefore: validBefore.String(),
					Salt:        nonce,
					Signature:   evm.BytesToHex(erc3009Sig),
				},
			},
		},
		Voucher: *voucher,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     depositPayload.ToMap(),
	}, nil
}
