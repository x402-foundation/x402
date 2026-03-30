package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
	"github.com/coinbase/x402/go/extensions/erc20approvalgassponsor"
	"github.com/coinbase/x402/go/mechanisms/evm"
	exactfacilitator "github.com/coinbase/x402/go/mechanisms/evm/exact/facilitator"
	"github.com/coinbase/x402/go/types"
)

// VerifyUptoPermit2 verifies an upto Permit2 payment payload against the given requirements.
// simulate controls whether to run an eth_call simulation as part of verification.
func VerifyUptoPermit2(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	permit2Payload *evm.UptoPermit2Payload,
	facilCtx *x402.FacilitatorContext,
	simulate bool,
) (*x402.VerifyResponse, error) {
	payer := permit2Payload.Permit2Authorization.From

	if payload.Accepted.Scheme != evm.SchemeUpto || requirements.Scheme != evm.SchemeUpto {
		return nil, x402.NewVerifyError(ErrUptoInvalidScheme, payer, "scheme mismatch")
	}

	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrUptoNetworkMismatch, payer, "network mismatch")
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, x402.NewVerifyError(ErrUptoFailedToGetNetworkConfig, payer, err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	if !strings.EqualFold(permit2Payload.Permit2Authorization.Spender, evm.X402UptoPermit2ProxyAddress) {
		return nil, x402.NewVerifyError(ErrPermit2InvalidSpender, payer, "invalid spender")
	}

	if !strings.EqualFold(permit2Payload.Permit2Authorization.Witness.To, requirements.PayTo) {
		return nil, x402.NewVerifyError(ErrPermit2RecipientMismatch, payer, "recipient mismatch")
	}

	// Verify the facilitator address in the witness matches one of our signer addresses
	facilitatorAddresses := signer.GetAddresses()
	witnessFacilitator := permit2Payload.Permit2Authorization.Witness.Facilitator
	isFacilitatorMatch := false
	for _, addr := range facilitatorAddresses {
		if strings.EqualFold(addr, witnessFacilitator) {
			isFacilitatorMatch = true
			break
		}
	}
	if !isFacilitatorMatch {
		return nil, x402.NewVerifyError(ErrUptoFacilitatorMismatch, payer, "facilitator mismatch")
	}

	now := time.Now().Unix()
	deadline, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Deadline, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrUptoInvalidPayload, payer, "invalid deadline format")
	}
	if deadline.Cmp(big.NewInt(now+evm.Permit2DeadlineBuffer)) < 0 {
		return nil, x402.NewVerifyError(ErrPermit2DeadlineExpired, payer, "deadline expired")
	}

	validAfter, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Witness.ValidAfter, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrUptoInvalidPayload, payer, "invalid validAfter format")
	}
	if validAfter.Cmp(big.NewInt(now)) > 0 {
		return nil, x402.NewVerifyError(ErrPermit2NotYetValid, payer, "not yet valid")
	}

	authAmount, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Permitted.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrUptoInvalidPayload, payer, "invalid permitted amount format")
	}
	requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidRequiredAmount, payer, "invalid required amount format")
	}
	if authAmount.Cmp(requiredAmount) != 0 {
		return nil, x402.NewVerifyError(ErrPermit2AmountMismatch, payer, "amount mismatch")
	}

	if !strings.EqualFold(permit2Payload.Permit2Authorization.Permitted.Token, requirements.Asset) {
		return nil, x402.NewVerifyError(ErrPermit2TokenMismatch, payer, "token mismatch")
	}

	signatureBytes, err := evm.HexToBytes(permit2Payload.Signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidSignatureFormat, payer, err.Error())
	}

	sigValid, sigErr := verifyUptoPermit2Signature(ctx, signer, permit2Payload.Permit2Authorization, signatureBytes, chainID)
	if sigErr != nil || !sigValid {
		code, codeErr := signer.GetCode(ctx, payer)
		if codeErr != nil || len(code) == 0 {
			return nil, x402.NewVerifyError(ErrPermit2InvalidSignature, payer, "invalid signature")
		}
	}

	if !simulate {
		return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
	}

	// Simulate against requirements.amount (worst-case charge). From must equal the
	// facilitator address: the upto proxy enforces msg.sender == witness.facilitator.
	eip2612Info, _ := eip2612gassponsor.ExtractEip2612GasSponsoringInfo(payload.Extensions)
	if eip2612Info != nil {
		if validErr := validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress); validErr != "" {
			return nil, x402.NewVerifyError(validErr, payer, "eip2612 validation failed")
		}

		simOk, simErr := SimulateUptoPermit2SettleWithPermit(ctx, signer, permit2Payload, requiredAmount, eip2612Info.Signature, eip2612Info.Amount, eip2612Info.Deadline)
		if simErr != nil || !simOk {
			resp := DiagnoseUptoPermit2SimulationFailure(ctx, signer, tokenAddress, permit2Payload, requirements.Amount)
			return nil, x402.NewVerifyError(resp.InvalidReason, payer, "simulation failed")
		}
		return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
	}

	erc20Info, _ := erc20approvalgassponsor.ExtractInfo(payload.Extensions)
	if erc20Info != nil && facilCtx != nil {
		ext, ok := facilCtx.GetExtension(erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension)
		var extensionSigner erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner
		if ok && ext != nil {
			extensionSigner = ext.ResolveSigner(payload.Accepted.Network)
		}

		if extensionSigner != nil {
			if reason, msg := exactfacilitator.ValidateErc20ApprovalForPayment(erc20Info, payer, tokenAddress); reason != "" {
				return nil, x402.NewVerifyError(reason, payer, msg)
			}

			if simulator, ok := extensionSigner.(erc20approvalgassponsor.Erc20ApprovalGasSponsoringSimulator); ok {
				simArgs, buildErr := BuildUptoPermit2SettleArgs(permit2Payload, requiredAmount)
				if buildErr == nil {
					simOk, simErr := simulator.SimulateTransactions(ctx, []erc20approvalgassponsor.TransactionRequest{
						{Serialized: erc20Info.SignedTransaction},
						{Call: &erc20approvalgassponsor.WriteContractCall{
							Address:  evm.X402UptoPermit2ProxyAddress,
							ABI:      evm.X402UptoPermit2ProxySettleABI,
							Function: evm.FunctionSettle,
							Args:     []interface{}{simArgs.permitStruct(), simArgs.SettlementAmount, simArgs.Owner, simArgs.witnessStruct(), simArgs.Signature},
						}},
					})
					if simErr == nil && simOk {
						return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
					}
				}
				resp := DiagnoseUptoPermit2SimulationFailure(ctx, signer, tokenAddress, permit2Payload, requirements.Amount)
				return nil, x402.NewVerifyError(resp.InvalidReason, payer, "simulation failed")
			}

			prereqResp := CheckUptoPermit2Prerequisites(ctx, signer, tokenAddress, payer, requirements.Amount)
			if !prereqResp.IsValid {
				return nil, x402.NewVerifyError(prereqResp.InvalidReason, payer, "prerequisites check failed")
			}
			return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
		}
	}

	simOk, simErr := SimulateUptoPermit2Settle(ctx, signer, permit2Payload, requiredAmount)
	if simErr != nil || !simOk {
		resp := DiagnoseUptoPermit2SimulationFailure(ctx, signer, tokenAddress, permit2Payload, requirements.Amount)
		return nil, x402.NewVerifyError(resp.InvalidReason, payer, "simulation failed")
	}

	return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
}

// SettleUptoPermit2 settles an upto Permit2 payment by calling x402UptoPermit2Proxy.settle().
// simulateInSettle controls whether to run an eth_call simulation as part of pre-settle verification.
func SettleUptoPermit2(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	permit2Payload *evm.UptoPermit2Payload,
	facilCtx *x402.FacilitatorContext,
	simulateInSettle bool,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	payer := permit2Payload.Permit2Authorization.From

	settlementAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrUptoInvalidPayload, payer, network, "", "invalid settlement amount")
	}

	// Re-verify with permitted.amount as requirements.Amount (the authorized max)
	verifyRequirements := requirements
	verifyRequirements.Amount = permit2Payload.Permit2Authorization.Permitted.Amount

	verifyResp, err := VerifyUptoPermit2(ctx, signer, payload, verifyRequirements, permit2Payload, facilCtx, simulateInSettle)
	if err != nil {
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrUptoVerificationFailed, payer, network, "", err.Error())
	}

	// Zero settlement — no on-chain tx needed
	if settlementAmount.Sign() == 0 {
		return &x402.SettleResponse{
			Success:     true,
			Transaction: "",
			Network:     network,
			Payer:       verifyResp.Payer,
			Amount:      "0",
		}, nil
	}

	// Guard: settlement amount must not exceed authorized maximum
	permittedAmount, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Permitted.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrUptoInvalidPayload, payer, network, "", "invalid permitted amount")
	}
	if settlementAmount.Cmp(permittedAmount) > 0 {
		return nil, x402.NewSettleError(ErrUptoSettlementExceedsAmount, payer, network, "", "settlement exceeds permitted amount")
	}

	args, buildErr := BuildUptoPermit2SettleArgs(permit2Payload, settlementAmount)
	if buildErr != nil {
		return nil, x402.NewSettleError(ErrUptoInvalidPayload, payer, network, "", buildErr.Error())
	}

	permitStruct := args.permitStruct()
	witnessStruct := args.witnessStruct()

	eip2612Info, _ := eip2612gassponsor.ExtractEip2612GasSponsoringInfo(payload.Extensions)
	erc20Info, _ := erc20approvalgassponsor.ExtractInfo(payload.Extensions)

	var txHash string

	switch {
	case eip2612Info != nil:
		v, r, s, splitErr := splitEip2612Signature(eip2612Info.Signature)
		if splitErr != nil {
			return nil, x402.NewSettleError(ErrUptoInvalidPayload, payer, network, "", "invalid eip2612 signature format")
		}

		eip2612Value, ok := new(big.Int).SetString(eip2612Info.Amount, 10)
		if !ok {
			return nil, x402.NewSettleError(ErrUptoInvalidPayload, payer, network, "", "invalid eip2612 amount")
		}
		eip2612Deadline, ok := new(big.Int).SetString(eip2612Info.Deadline, 10)
		if !ok {
			return nil, x402.NewSettleError(ErrUptoInvalidPayload, payer, network, "", "invalid eip2612 deadline")
		}

		permit2612Struct := EIP2612PermitData{
			Value:    eip2612Value,
			Deadline: eip2612Deadline,
			R:        r,
			S:        s,
			V:        v,
		}

		txHash, err = signer.WriteContract(
			ctx,
			evm.X402UptoPermit2ProxyAddress,
			evm.X402UptoPermit2ProxySettleWithPermitABI,
			evm.FunctionSettleWithPermit,
			permit2612Struct,
			permitStruct,
			args.SettlementAmount,
			args.Owner,
			witnessStruct,
			args.Signature,
		)

	case erc20Info != nil && facilCtx != nil:
		ext, ok := facilCtx.GetExtension(erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension)
		var extensionSigner erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner
		if ok && ext != nil {
			extensionSigner = ext.ResolveSigner(payload.Accepted.Network)
		}
		if extensionSigner != nil {
			settle := erc20approvalgassponsor.WriteContractCall{
				Address:  evm.X402UptoPermit2ProxyAddress,
				ABI:      evm.X402UptoPermit2ProxySettleABI,
				Function: evm.FunctionSettle,
				Args:     []interface{}{permitStruct, args.SettlementAmount, args.Owner, witnessStruct, args.Signature},
			}
			txHashes, sendErr := extensionSigner.SendTransactions(ctx, []erc20approvalgassponsor.TransactionRequest{
				{Serialized: erc20Info.SignedTransaction},
				{Call: &settle},
			})
			if sendErr != nil {
				err = sendErr
			} else if len(txHashes) > 0 {
				txHash = txHashes[len(txHashes)-1]
			}
		} else {
			txHash, err = signer.WriteContract(
				ctx,
				evm.X402UptoPermit2ProxyAddress,
				evm.X402UptoPermit2ProxySettleABI,
				evm.FunctionSettle,
				permitStruct,
				args.SettlementAmount,
				args.Owner,
				witnessStruct,
				args.Signature,
			)
		}

	default:
		txHash, err = signer.WriteContract(
			ctx,
			evm.X402UptoPermit2ProxyAddress,
			evm.X402UptoPermit2ProxySettleABI,
			evm.FunctionSettle,
			permitStruct,
			args.SettlementAmount,
			args.Owner,
			witnessStruct,
			args.Signature,
		)
	}

	if err != nil {
		errorReason := parseUptoPermit2Error(err)
		return nil, x402.NewSettleError(errorReason, payer, network, "", err.Error())
	}

	receiptWaitSigner := signer
	if erc20Info != nil && facilCtx != nil {
		if ext, ok := facilCtx.GetExtension(erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension); ok && ext != nil {
			if extensionSigner := ext.ResolveSigner(payload.Accepted.Network); extensionSigner != nil {
				receiptWaitSigner = extensionSigner
			}
		}
	}
	receipt, err := receiptWaitSigner.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrUptoFailedToGetReceipt, payer, network, txHash, err.Error())
	}

	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrUptoTransactionFailed, payer, network, txHash, "")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       verifyResp.Payer,
		Amount:      settlementAmount.String(),
	}, nil
}

func verifyUptoPermit2Signature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	authorization evm.UptoPermit2Authorization,
	signature []byte,
	chainID *big.Int,
) (bool, error) {
	hash, err := evm.HashUptoPermit2Authorization(authorization, chainID)
	if err != nil {
		return false, err
	}

	var hash32 [32]byte
	copy(hash32[:], hash)

	valid, _, err := evm.VerifyUniversalSignature(ctx, signer, authorization.From, hash32, signature, true)
	return valid, err
}

var validateEip2612PermitForPayment = evm.ValidateEip2612PermitForPayment

func parseUptoPermit2Error(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "Permit2612AmountMismatch"):
		return ErrPermit2612AmountMismatch
	case strings.Contains(msg, "InvalidAmount"):
		return ErrPermit2InvalidAmount
	case strings.Contains(msg, "InvalidDestination"):
		return ErrPermit2InvalidDestination
	case strings.Contains(msg, "InvalidOwner"):
		return ErrPermit2InvalidOwner
	case strings.Contains(msg, "PaymentTooEarly"):
		return ErrPermit2PaymentTooEarly
	case strings.Contains(msg, "InvalidSignature"), strings.Contains(msg, "SignatureExpired"):
		return ErrPermit2InvalidSignature
	case strings.Contains(msg, "InvalidNonce"):
		return ErrPermit2InvalidNonce
	case strings.Contains(msg, "erc20_approval_tx_failed"):
		return ErrErc20ApprovalBroadcastFailed
	case strings.Contains(msg, "AmountExceedsPermitted"):
		return ErrUptoAmountExceedsPermitted
	case strings.Contains(msg, "UnauthorizedFacilitator"):
		return ErrUptoUnauthorizedFacilitator
	default:
		return ErrUptoTransactionFailed
	}
}
