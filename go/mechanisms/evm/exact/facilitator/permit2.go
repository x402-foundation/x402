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
	"github.com/coinbase/x402/go/types"
)

// VerifyPermit2Options controls optional behaviour for VerifyPermit2.
type VerifyPermit2Options struct {
	// Simulate enables onchain simulation. Defaults to true when zero-value.
	Simulate *bool
}

func (o *VerifyPermit2Options) shouldSimulate() bool {
	if o == nil || o.Simulate == nil {
		return true
	}
	return *o.Simulate
}

// VerifyPermit2 verifies a Permit2 payment payload.
func VerifyPermit2(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	permit2Payload *evm.ExactPermit2Payload,
	facilCtx *x402.FacilitatorContext,
	opts *VerifyPermit2Options,
) (*x402.VerifyResponse, error) {
	payer := permit2Payload.Permit2Authorization.From

	// Verify scheme matches
	if payload.Accepted.Scheme != evm.SchemeExact || requirements.Scheme != evm.SchemeExact {
		return nil, x402.NewVerifyError(ErrUnsupportedPayloadType, payer, "scheme mismatch")
	}

	// Verify network matches
	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, payer, "network mismatch")
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToGetNetworkConfig, payer, err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	// Verify spender is x402ExactPermit2Proxy
	if !strings.EqualFold(permit2Payload.Permit2Authorization.Spender, evm.X402ExactPermit2ProxyAddress) {
		return nil, x402.NewVerifyError(ErrPermit2InvalidSpender, payer, "invalid spender")
	}

	// Verify witness.to matches payTo
	if !strings.EqualFold(permit2Payload.Permit2Authorization.Witness.To, requirements.PayTo) {
		return nil, x402.NewVerifyError(ErrPermit2RecipientMismatch, payer, "recipient mismatch")
	}

	// Parse and verify deadline not expired (with buffer for block time)
	now := time.Now().Unix()
	deadline, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Deadline, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, payer, "invalid deadline format")
	}
	if deadline.Cmp(big.NewInt(now+evm.Permit2DeadlineBuffer)) < 0 {
		return nil, x402.NewVerifyError(ErrPermit2DeadlineExpired, payer, "deadline expired")
	}

	// Parse and verify validAfter is not in the future
	validAfter, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Witness.ValidAfter, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, payer, "invalid validAfter format")
	}
	if validAfter.Cmp(big.NewInt(now)) > 0 {
		return nil, x402.NewVerifyError(ErrPermit2NotYetValid, payer, "not yet valid")
	}

	// Parse and verify amount is sufficient
	authAmount, ok := new(big.Int).SetString(permit2Payload.Permit2Authorization.Permitted.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, payer, "invalid permitted amount format")
	}
	requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidRequiredAmount, payer, "invalid required amount format")
	}
	if authAmount.Cmp(requiredAmount) != 0 {
		return nil, x402.NewVerifyError(ErrPermit2AmountMismatch, payer, "amount mismatch")
	}

	// Verify token matches
	if !strings.EqualFold(permit2Payload.Permit2Authorization.Permitted.Token, requirements.Asset) {
		return nil, x402.NewVerifyError(ErrPermit2TokenMismatch, payer, "token mismatch")
	}

	// Verify signature
	signatureBytes, err := evm.HexToBytes(permit2Payload.Signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidSignatureFormat, payer, err.Error())
	}

	sigValid, sigErr := verifyPermit2Signature(ctx, signer, permit2Payload.Permit2Authorization, signatureBytes, chainID)
	if sigErr != nil || !sigValid {
		// Check if payer is a deployed smart contract
		// ERC-1271 signatures may not be verifiable by all signer implementations
		code, codeErr := signer.GetCode(ctx, payer)
		if codeErr != nil || len(code) == 0 {
			return nil, x402.NewVerifyError(ErrPermit2InvalidSignature, payer, "invalid signature")
		}
		// Deployed smart contract: fall through to simulation
	}

	// Early return when simulation is disabled
	if !opts.shouldSimulate() {
		return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
	}

	// EIP-2612 gas sponsoring (atomic settleWithPermit via contract)
	eip2612Info, _ := eip2612gassponsor.ExtractEip2612GasSponsoringInfo(payload.Extensions)
	if eip2612Info != nil {
		if validErr := validateEip2612PermitForPayment(eip2612Info, payer, tokenAddress); validErr != "" {
			return nil, x402.NewVerifyError(validErr, payer, "eip2612 validation failed")
		}

		simOk, simErr := SimulatePermit2SettleWithPermit(ctx, signer, permit2Payload, eip2612Info.Signature, eip2612Info.Amount, eip2612Info.Deadline)
		if simErr != nil || !simOk {
			resp := DiagnosePermit2SimulationFailure(ctx, signer, tokenAddress, permit2Payload, requirements.Amount)
			return nil, x402.NewVerifyError(resp.InvalidReason, payer, "simulation failed")
		}
		return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
	}

	// ERC-20 approval gas sponsoring
	erc20Info, _ := erc20approvalgassponsor.ExtractInfo(payload.Extensions)
	if erc20Info != nil && facilCtx != nil {
		ext, ok := facilCtx.GetExtension(erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension)
		var extensionSigner erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner
		if ok && ext != nil {
			extensionSigner = ext.ResolveSigner(payload.Accepted.Network)
		}

		if extensionSigner != nil {
			if reason, msg := ValidateErc20ApprovalForPayment(erc20Info, payer, tokenAddress); reason != "" {
				return nil, x402.NewVerifyError(reason, payer, msg)
			}

			// If the signer supports SimulateTransactions, use it for the approve+settle bundle
			if simulator, ok := extensionSigner.(erc20approvalgassponsor.Erc20ApprovalGasSponsoringSimulator); ok {
				simArgs, buildErr := BuildPermit2SettleArgs(permit2Payload)
				if buildErr == nil {
					simOk, simErr := simulator.SimulateTransactions(ctx, []erc20approvalgassponsor.TransactionRequest{
						{Serialized: erc20Info.SignedTransaction},
						{Call: &erc20approvalgassponsor.WriteContractCall{
							Address:  evm.X402ExactPermit2ProxyAddress,
							ABI:      evm.X402ExactPermit2ProxySettleABI,
							Function: evm.FunctionSettle,
							Args:     []interface{}{simArgs.permitStruct(), simArgs.Owner, simArgs.witnessStruct(), simArgs.Signature},
						}},
					})
					if simErr == nil && simOk {
						return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
					}
				}
				resp := DiagnosePermit2SimulationFailure(ctx, signer, tokenAddress, permit2Payload, requirements.Amount)
				return nil, x402.NewVerifyError(resp.InvalidReason, payer, "simulation failed")
			}

			// Fallback: signer does not support simulation; check prerequisites only
			prereqResp := CheckPermit2Prerequisites(ctx, signer, tokenAddress, payer, requirements.Amount)
			if !prereqResp.IsValid {
				return nil, x402.NewVerifyError(prereqResp.InvalidReason, payer, "prerequisites check failed")
			}
			return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
		}
	}

	// Standard settle (allowance already on-chain)
	simOk, simErr := SimulatePermit2Settle(ctx, signer, permit2Payload)
	if simErr != nil || !simOk {
		resp := DiagnosePermit2SimulationFailure(ctx, signer, tokenAddress, permit2Payload, requirements.Amount)
		return nil, x402.NewVerifyError(resp.InvalidReason, payer, "simulation failed")
	}

	return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
}

// Permit2FacilitatorConfig holds optional settlement-time configuration.
type Permit2FacilitatorConfig struct {
	// SimulateInSettle re-runs simulation during settle
	// When false (default), the settle path skips simulation since verify already ran it
	SimulateInSettle bool
}

// SettlePermit2 settles a Permit2 payment by calling x402ExactPermit2Proxy.settle().
func SettlePermit2(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	permit2Payload *evm.ExactPermit2Payload,
	facilCtx *x402.FacilitatorContext,
	config *Permit2FacilitatorConfig,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	payer := permit2Payload.Permit2Authorization.From

	simulate := false
	if config != nil {
		simulate = config.SimulateInSettle
	}

	verifyResp, err := VerifyPermit2(ctx, signer, payload, requirements, permit2Payload, facilCtx, &VerifyPermit2Options{Simulate: &simulate})
	if err != nil {
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, payer, network, "", err.Error())
	}

	args, buildErr := BuildPermit2SettleArgs(permit2Payload)
	if buildErr != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, payer, network, "", buildErr.Error())
	}

	permitStruct := args.permitStruct()
	witnessStruct := args.witnessStruct()

	eip2612Info, _ := eip2612gassponsor.ExtractEip2612GasSponsoringInfo(payload.Extensions)
	erc20Info, _ := erc20approvalgassponsor.ExtractInfo(payload.Extensions)

	var txHash string

	switch {
	case eip2612Info != nil:
		// Use settleWithPermit - includes the EIP-2612 permit
		v, r, s, splitErr := splitEip2612Signature(eip2612Info.Signature)
		if splitErr != nil {
			return nil, x402.NewSettleError(ErrInvalidPayload, payer, network, "", "invalid eip2612 signature format")
		}

		eip2612Value, ok := new(big.Int).SetString(eip2612Info.Amount, 10)
		if !ok {
			return nil, x402.NewSettleError(ErrInvalidPayload, payer, network, "", "invalid eip2612 amount")
		}
		eip2612Deadline, ok := new(big.Int).SetString(eip2612Info.Deadline, 10)
		if !ok {
			return nil, x402.NewSettleError(ErrInvalidPayload, payer, network, "", "invalid eip2612 deadline")
		}

		permit2612Struct := struct {
			Value    *big.Int
			Deadline *big.Int
			R        [32]byte
			S        [32]byte
			V        uint8
		}{
			Value:    eip2612Value,
			Deadline: eip2612Deadline,
			R:        r,
			S:        s,
			V:        v,
		}

		txHash, err = signer.WriteContract(
			ctx,
			evm.X402ExactPermit2ProxyAddress,
			evm.X402ExactPermit2ProxySettleWithPermitABI,
			evm.FunctionSettleWithPermit,
			permit2612Struct,
			permitStruct,
			args.Owner,
			witnessStruct,
			args.Signature,
		)

	case erc20Info != nil && facilCtx != nil:
		// Branch: ERC-20 approval gas sponsoring (broadcast approval + settle via extension signer)
		ext, ok := facilCtx.GetExtension(erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension)
		var extensionSigner erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner
		if ok && ext != nil {
			extensionSigner = ext.ResolveSigner(payload.Accepted.Network)
		}
		if extensionSigner != nil {
			settle := erc20approvalgassponsor.WriteContractCall{
				Address:  evm.X402ExactPermit2ProxyAddress,
				ABI:      evm.X402ExactPermit2ProxySettleABI,
				Function: evm.FunctionSettle,
				Args:     []interface{}{permitStruct, args.Owner, witnessStruct, args.Signature},
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
				evm.X402ExactPermit2ProxyAddress,
				evm.X402ExactPermit2ProxySettleABI,
				evm.FunctionSettle,
				permitStruct,
				args.Owner,
				witnessStruct,
				args.Signature,
			)
		}

	default:
		txHash, err = signer.WriteContract(
			ctx,
			evm.X402ExactPermit2ProxyAddress,
			evm.X402ExactPermit2ProxySettleABI,
			evm.FunctionSettle,
			permitStruct,
			args.Owner,
			witnessStruct,
			args.Signature,
		)
	}

	if err != nil {
		errorReason := parsePermit2Error(err)
		return nil, x402.NewSettleError(errorReason, payer, network, "", err.Error())
	}

	// Wait for transaction confirmation
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
		return nil, x402.NewSettleError(ErrFailedToGetReceipt, payer, network, txHash, err.Error())
	}

	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionFailed, payer, network, txHash, "")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       verifyResp.Payer,
	}, nil
}

// verifyPermit2Signature verifies the Permit2 EIP-712 signature.
func verifyPermit2Signature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	authorization evm.Permit2Authorization,
	signature []byte,
	chainID *big.Int,
) (bool, error) {
	hash, err := evm.HashPermit2Authorization(authorization, chainID)
	if err != nil {
		return false, err
	}

	var hash32 [32]byte
	copy(hash32[:], hash)

	// Use universal verification (supports EOA and EIP-1271)
	valid, _, err := evm.VerifyUniversalSignature(ctx, signer, authorization.From, hash32, signature, true)
	return valid, err
}

var validateEip2612PermitForPayment = evm.ValidateEip2612PermitForPayment
var splitEip2612Signature = evm.SplitEip2612Signature

// parsePermit2Error extracts meaningful error codes from contract reverts.
func parsePermit2Error(err error) string {
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
	default:
		return ErrFailedToExecuteTransfer
	}
}
