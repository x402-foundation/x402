package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// SubmitClaimInput is the network, claims, optional pre-signed authorizer
// signature, and data suffix for SubmitClaim. OnClaimed, when set, receives the row keys that
// emitted Claimed once the claim confirms.
type SubmitClaimInput struct {
	Network    string
	Claims     []batchsettlement.BatchSettlementVoucherClaim
	Signature  string
	DataSuffix []byte
	OnClaimed  OnClaimedRows
}

// ExecuteClaimWithSignature executes a batch claim with receiverAuthorizer signature.
// If ClaimAuthorizerSignature is absent from the payload, the authorizerSigner
// auto-signs the ClaimBatch digest. An optional onClaimed callback receives the row keys that
// emitted Claimed once the claim confirms.
func ExecuteClaimWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementClaimPayload,
	requirements types.PaymentRequirements,
	authorizerSigner batchsettlement.AuthorizerSigner,
	dataSuffix []byte,
	onClaimed ...OnClaimedRows,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	if len(payload.Claims) == 0 {
		return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
			"no claims provided")
	}

	var sigBytes []byte
	if payload.ClaimAuthorizerSignature != "" {
		var err error
		sigBytes, err = evm.HexToBytes(payload.ClaimAuthorizerSignature)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
				fmt.Sprintf("invalid claim authorizer signature: %s", err))
		}
	} else {
		if authorizerSigner == nil {
			return nil, x402.NewSettleError(ErrAuthorizerNotConfigured, "", network, "",
				"no claim authorizer signature in payload and no authorizer signer configured")
		}
		for _, claim := range payload.Claims {
			if !strings.EqualFold(claim.Voucher.Channel.ReceiverAuthorizer, authorizerSigner.Address()) {
				return nil, x402.NewSettleError(ErrAuthorizerAddressMismatch, "", network, "",
					fmt.Sprintf("claim receiverAuthorizer %s does not match authorizerSigner %s",
						claim.Voucher.Channel.ReceiverAuthorizer, authorizerSigner.Address()))
			}
		}
		var err error
		sigBytes, err = authorizerSigner.SignClaimBatch(ctx, payload.Claims, string(network))
		if err != nil {
			return nil, x402.NewSettleError(ErrClaimTransactionFailed, "", network, "",
				fmt.Sprintf("failed to sign claim batch: %s", err))
		}
	}

	return submitClaimTransaction(ctx, signer, string(network), "claimWithSignature",
		batchsettlement.BatchSettlementClaimWithSignatureABI,
		[]interface{}{buildVoucherClaimArgs(payload.Claims), sigBytes},
		dataSuffix, firstOnClaimed(onClaimed))
}

// ExecuteClaim submits a batch claim via claim() as msg.sender. An optional onClaimed callback
// receives the row keys that emitted Claimed once the claim confirms.
func ExecuteClaim(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementClaimPayload,
	network string,
	dataSuffix []byte,
	onClaimed ...OnClaimedRows,
) (*x402.SettleResponse, error) {
	return submitClaimTransaction(ctx, signer, network, "claim",
		batchsettlement.BatchSettlementClaimABI,
		[]interface{}{buildVoucherClaimArgs(payload.Claims)},
		dataSuffix, firstOnClaimed(onClaimed))
}

// SubmitClaim dispatches a claim through the relay or direct submit path.
// A payload signature always uses claimWithSignature. Otherwise SubmitMode
// selects the path ("relay" when omitted). Direct mode requires AuthorizerSubmitter.
func SubmitClaim(ctx context.Context, input SubmitClaimInput, submitCtx SubmitContext) (*x402.SettleResponse, error) {
	payload := &batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: input.Claims,
	}
	if input.Signature != "" {
		payload.ClaimAuthorizerSignature = input.Signature
	}

	reqs := types.PaymentRequirements{Network: input.Network}
	if ShouldRelaySubmit(submitCtx.SubmitMode, input.Signature != "") {
		return ExecuteClaimWithSignature(ctx, submitCtx.Signer, payload, reqs, submitCtx.AuthorizerSigner, input.DataSuffix, input.OnClaimed)
	}
	if submitCtx.AuthorizerSubmitter == nil {
		return &x402.SettleResponse{
			Success:     false,
			ErrorReason: ErrAuthorizerNotConfigured,
			Transaction: "",
			Network:     x402.Network(input.Network),
		}, nil
	}
	return ExecuteClaim(ctx, submitCtx.AuthorizerSubmitter, payload, input.Network, input.DataSuffix, input.OnClaimed)
}

func submitClaimTransaction(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	network string,
	functionName string,
	abiJSON []byte,
	args []interface{},
	dataSuffix []byte,
	onClaimed OnClaimedRows,
) (*x402.SettleResponse, error) {
	net := x402.Network(network)
	if _, simErr := signer.ReadContract(ctx, batchsettlement.BatchSettlementAddress, abiJSON, functionName, args...); simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:      false,
			ErrorReason:  ErrClaimSimulationFailed,
			ErrorMessage: simErr.Error(),
			Transaction:  "",
			Network:      net,
		}, nil
	}

	txHash, err := signer.WriteContract(ctx, batchsettlement.BatchSettlementAddress, abiJSON, functionName, dataSuffix, args...)
	if err != nil {
		return nil, x402.NewSettleError(ErrClaimTransactionFailed, "", net, "",
			fmt.Sprintf("%s transaction failed: %s", functionName, err))
	}
	receipt, err := evm.WaitForSettleReceipt(ctx, signer, txHash, "", net,
		ErrClaimTransactionFailed, ErrTransactionReverted)
	if err != nil {
		return nil, err
	}
	notifyClaimed(onClaimed, receipt)

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     net,
	}, nil
}

// buildVoucherClaimArgs builds the Solidity-compatible VoucherClaim[] argument for claim calls.
func buildVoucherClaimArgs(claims []batchsettlement.BatchSettlementVoucherClaim) interface{} {
	type VoucherStruct struct {
		Channel            ContractChannelConfigTuple
		MaxClaimableAmount *big.Int
	}
	type VoucherClaimStruct struct {
		Voucher      VoucherStruct
		Signature    []byte
		TotalClaimed *big.Int
	}

	result := make([]VoucherClaimStruct, len(claims))
	for i, claim := range claims {
		maxClaimable, _ := new(big.Int).SetString(claim.Voucher.MaxClaimableAmount, 10)
		totalClaimed, _ := new(big.Int).SetString(claim.TotalClaimed, 10)
		sigBytes, _ := evm.HexToBytes(claim.Signature)

		channelTuple := ToContractChannelConfig(claim.Voucher.Channel)

		result[i] = VoucherClaimStruct{
			Voucher: VoucherStruct{
				Channel:            channelTuple,
				MaxClaimableAmount: maxClaimable,
			},
			Signature:    sigBytes,
			TotalClaimed: totalClaimed,
		}
	}
	return result
}
