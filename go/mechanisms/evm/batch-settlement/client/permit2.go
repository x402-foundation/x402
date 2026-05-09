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

// CreateBatchedPermit2DepositPayload builds a deposit + voucher payload that
// funds the channel via the universal Permit2 contract using a channel-bound
// `PermitWitnessTransferFrom` authorization. The witness binds the transfer to
// the derived channelId so the Permit2DepositCollector can verify which
// channel the funds belong to.
func CreateBatchedPermit2DepositPayload(
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

	depositBig, ok := new(big.Int).SetString(depositAmount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf("invalid deposit amount: %s", depositAmount)
	}

	nonce, err := evm.CreatePermit2Nonce()
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to create permit2 nonce: %w", err)
	}
	nonceBig, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf("invalid permit2 nonce: %s", nonce)
	}

	deadline := fmt.Sprintf("%d", time.Now().Unix()+int64(requirements.MaxTimeoutSeconds))
	deadlineBig, ok := new(big.Int).SetString(deadline, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf("invalid permit2 deadline: %s", deadline)
	}

	channelId, err := batchsettlement.ComputeChannelId(channelConfig, chainId)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to compute channel ID: %w", err)
	}
	channelIdBytes, err := evm.HexToBytes(channelId)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to parse channel id: %w", err)
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)
	spenderAddress := evm.NormalizeAddress(batchsettlement.Permit2DepositCollectorAddress)

	domain := evm.TypedDataDomain{
		Name:              batchsettlement.Permit2DomainName,
		ChainID:           chainId,
		VerifyingContract: batchsettlement.Permit2Address,
	}

	// EIP-712 type definitions: include EIP712Domain alongside the witness types
	// so the signer can hash the domain separator the same way Permit2 does.
	typedDataTypes := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"PermitWitnessTransferFrom": batchsettlement.BatchPermit2WitnessTypes["PermitWitnessTransferFrom"],
		"TokenPermissions":          batchsettlement.BatchPermit2WitnessTypes["TokenPermissions"],
		"DepositWitness":            batchsettlement.BatchPermit2WitnessTypes["DepositWitness"],
	}

	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  tokenAddress,
			"amount": depositBig,
		},
		"spender":  spenderAddress,
		"nonce":    nonceBig,
		"deadline": deadlineBig,
		"witness": map[string]interface{}{
			"channelId": channelIdBytes,
		},
	}

	signature, err := signer.SignTypedData(ctx, domain, typedDataTypes, "PermitWitnessTransferFrom", message)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to sign permit2 authorization: %w", err)
	}

	actualVoucherSigner := signer
	if voucherSigner != nil {
		actualVoucherSigner = voucherSigner
	}
	voucher, err := SignVoucher(ctx, actualVoucherSigner, channelId, maxClaimableAmount, networkStr)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to sign voucher: %w", err)
	}

	depositPayload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: channelConfig,
		Voucher:       *voucher,
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: depositAmount,
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Permit2Authorization: &batchsettlement.BatchSettlementPermit2Authorization{
					From: signer.Address(),
					Permitted: batchsettlement.BatchSettlementPermit2TokenPermissions{
						Token:  tokenAddress,
						Amount: depositAmount,
					},
					Spender:  spenderAddress,
					Nonce:    nonce,
					Deadline: deadline,
					Witness: batchsettlement.BatchSettlementPermit2Witness{
						ChannelId: channelId,
					},
					Signature: evm.BytesToHex(signature),
				},
			},
		},
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     depositPayload.ToMap(),
	}, nil
}
