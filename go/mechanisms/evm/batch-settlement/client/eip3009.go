package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// CreateBatchedEIP3009DepositPayload creates a deposit + voucher payload using ERC-3009.
// Signs ReceiveWithAuthorization for the deposit and a cumulative voucher.
func CreateBatchedEIP3009DepositPayload(
	ctx context.Context,
	signer evm.ClientEvmSigner,
	requirements types.PaymentRequirements,
	channelConfig batchsettlement.ChannelConfig,
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

	// Salt is a random per-deposit value; the actual ERC-3009 nonce is derived
	// from (channelId, salt) — the deposit collector reproduces the same hash.
	salt, err := evm.CreateNonce()
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to create salt: %w", err)
	}

	validAfter, validBefore := evm.CreateValidityWindow(time.Hour)

	// Compute channel ID
	channelId, err := batchsettlement.ComputeChannelId(channelConfig, chainId)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to compute channel ID: %w", err)
	}

	// Derive the onchain ERC-3009 nonce: keccak256(abi.encode(channelId, salt)).
	erc3009Nonce, err := batchsettlement.BuildErc3009DepositNonce(channelId, salt)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to build ERC-3009 nonce: %w", err)
	}
	nonceBytes, err := evm.HexToBytes(erc3009Nonce)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to parse derived nonce: %w", err)
	}

	// Sign ReceiveWithAuthorization
	// "to" is the ERC3009DepositCollector, which forwards into the BatchSettlement contract.
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
		"ReceiveWithAuthorization": batchsettlement.ReceiveAuthorizationTypes["ReceiveWithAuthorization"],
	}

	erc3009Message := map[string]interface{}{
		"from":        signer.Address(),
		"to":          batchsettlement.ERC3009DepositCollectorAddress,
		"value":       deposit,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       nonceBytes,
	}

	erc3009Sig, err := signer.SignTypedData(ctx, erc3009Domain, erc3009Types, "ReceiveWithAuthorization", erc3009Message)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to sign ERC-3009 authorization: %w", err)
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
	depositPayload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: channelConfig,
		Voucher:       *voucher,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: depositAmount,
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: &batchsettlement.BatchSettlementErc3009Authorization{
					ValidAfter:  validAfter.String(),
					ValidBefore: validBefore.String(),
					Salt:        salt,
					Signature:   evm.BytesToHex(erc3009Sig),
				},
			},
		},
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     depositPayload.ToMap(),
	}, nil
}
