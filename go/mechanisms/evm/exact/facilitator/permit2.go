package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// VerifyPermit2Options controls optional behaviour for VerifyPermit2.
type VerifyPermit2Options struct {
	// Simulate enables onchain simulation. Defaults to true when zero-value.
	Simulate *bool
	// EnableParallelSimulation starts the standard settle() simulation concurrently with the
	// signature check rather than after it, removing one RPC round trip. Opt-in, because the
	// cost is one wasted eth_call for payments rejected on signature grounds.
	EnableParallelSimulation bool
}

type simulationResult struct {
	succeeded bool
	err       error
}

// startSimulation runs simulate in the background. Cancelling stops the in-flight eth_call, so
// a payment rejected before the result is read does not leave one running.
func startSimulation(
	ctx context.Context,
	simulate func(context.Context) (bool, error),
) (chan simulationResult, context.CancelFunc) {
	simulationCtx, cancel := context.WithCancel(ctx)
	results := make(chan simulationResult, 1)
	go func() {
		succeeded, err := simulate(simulationCtx)
		results <- simulationResult{succeeded: succeeded, err: err}
	}()
	return results, cancel
}

// awaitSimulation reads the result of a simulation started by startSimulation, or runs simulate
// inline when none was started.
func awaitSimulation(started chan simulationResult, simulate func() (bool, error)) (bool, error) {
	if started == nil {
		return simulate()
	}
	result := <-started
	return result.succeeded, result.err
}

func (o *VerifyPermit2Options) shouldSimulate() bool {
	if o == nil || o.Simulate == nil {
		return true
	}
	return *o.Simulate
}

func (o *VerifyPermit2Options) shouldSimulateInParallel() bool {
	return o != nil && o.EnableParallelSimulation && o.shouldSimulate()
}

// resolveErc20ApprovalSponsor extracts the ERC-20 approval gas-sponsoring info and resolves the
// extension signer for the payment's network. A nil signer means the ERC-20 approval branch does
// not apply even when info is present, matching the fall-through to standard settle.
func resolveErc20ApprovalSponsor(
	payload types.PaymentPayload,
	facilCtx *x402.FacilitatorContext,
) (*erc20approvalgassponsor.Info, erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner) {
	info, _ := erc20approvalgassponsor.ExtractInfo(payload.Extensions)
	if info == nil || facilCtx == nil {
		return nil, nil
	}

	ext, ok := facilCtx.GetExtension(
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(),
	).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension)
	if !ok || ext == nil {
		return info, nil
	}

	return info, ext.ResolveSigner(payload.Accepted.Network)
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

	// Run the asset-contract check concurrently with the signature check below.
	assetCheck := evm.StartAssetContractCheck(ctx, signer, string(requirements.Network), requirements.Asset)

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

	// Both inputs are local, so the applicable simulation branch is known before any RPC.
	eip2612Info, _ := eip2612gassponsor.ExtractEip2612GasSponsoringInfo(payload.Extensions)
	erc20Info, erc20Signer := resolveErc20ApprovalSponsor(payload, facilCtx)

	// The standard settle() simulation depends only on permit2Payload, never on the eth_getCode
	// that verifyPermit2Signature issues, so it can start concurrently. The result is still read
	// after the signature and asset checks below, leaving error precedence unchanged. The
	// gas-sponsoring branches simulate different calls and stay sequential.
	var simulationCh chan simulationResult
	if eip2612Info == nil && erc20Signer == nil && opts.shouldSimulateInParallel() {
		var cancelSimulation context.CancelFunc
		simulationCh, cancelSimulation = startSimulation(ctx, func(ctx context.Context) (bool, error) {
			return SimulatePermit2Settle(ctx, signer, permit2Payload)
		})
		defer cancelSimulation()
	}

	sigValid, sigData, sigErr := verifyPermit2Signature(ctx, signer, permit2Payload.Permit2Authorization, signatureBytes, chainID)

	assetReason, assetErr := assetCheck.Await()
	if assetErr != nil {
		return nil, fmt.Errorf("asset contract check failed: %w", assetErr)
	}
	if assetReason != "" {
		return nil, x402.NewVerifyError(assetReason, payer, fmt.Sprintf("asset %s is not a deployed contract", requirements.Asset))
	}

	if sigErr != nil || !sigValid {
		// Check if payer is a deployed smart contract.
		deployed := false
		if sigData != nil {
			deployed = sigData.CodeDeployed
		} else if code, codeErr := signer.GetCode(ctx, payer); codeErr == nil {
			deployed = len(code) > 0
		}
		if !deployed {
			return nil, x402.NewVerifyError(ErrPermit2InvalidSignature, payer, "invalid signature")
		}
		// Deployed smart contract: fall through to simulation
	}

	// Early return when simulation is disabled
	if !opts.shouldSimulate() {
		return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
	}

	// EIP-2612 gas sponsoring (atomic settleWithPermit via contract)
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
	if erc20Signer != nil {
		if reason, msg := ValidateErc20ApprovalForPayment(erc20Info, payer, tokenAddress); reason != "" {
			return nil, x402.NewVerifyError(reason, payer, msg)
		}

		// If the signer supports SimulateTransactions, use it for the approve+settle bundle
		if simulator, ok := erc20Signer.(erc20approvalgassponsor.Erc20ApprovalGasSponsoringSimulator); ok {
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

	// Standard settle (allowance already on-chain)
	simOk, simErr := awaitSimulation(simulationCh, func() (bool, error) {
		return SimulatePermit2Settle(ctx, signer, permit2Payload)
	})
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
	// PendingSettlementStore lets a retried settle for the same payload
	// reconcile against an already-broadcast transaction instead of
	// re-verifying and re-broadcasting. A nil value falls back to a fresh
	// in-memory store (equivalent to no cross-call sharing).
	PendingSettlementStore x402.PendingSettlementStore
	// EnableParallelSimulation is forwarded to VerifyPermit2 as
	// VerifyPermit2Options.EnableParallelSimulation. It only has an effect when
	// SimulateInSettle is true, since otherwise settle runs no simulation at all.
	EnableParallelSimulation bool
}

// ResolvePermit2ReceiptWaitSigner returns the signer that should wait for the
// settlement receipt: the ERC-20-approval-gas-sponsoring extension's signer
// when that extension provided the transaction (it may have broadcast via a
// different account), otherwise the facilitator's own signer. Depends only on
// payload.Extensions/facilCtx, so it can be resolved before verify runs (the
// pending-settlement fast path skips verify entirely). Exported so the upto
// EVM facilitator (which shares the same ERC-20-approval-gas-sponsoring
// extension) can reuse the same resolution logic.
func ResolvePermit2ReceiptWaitSigner(
	signer evm.FacilitatorEvmSigner,
	facilCtx *x402.FacilitatorContext,
	extensions map[string]interface{},
	network string,
) evm.FacilitatorEvmSigner {
	if facilCtx == nil {
		return signer
	}
	erc20Info, _ := erc20approvalgassponsor.ExtractInfo(extensions)
	if erc20Info == nil {
		return signer
	}
	ext, ok := facilCtx.GetExtension(erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension)
	if !ok || ext == nil {
		return signer
	}
	if extensionSigner := ext.ResolveSigner(network); extensionSigner != nil {
		return extensionSigner
	}
	return signer
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
	enableParallelSimulation := false
	var store x402.PendingSettlementStore
	if config != nil {
		simulate = config.SimulateInSettle
		store = config.PendingSettlementStore
		enableParallelSimulation = config.EnableParallelSimulation
	}
	if store == nil {
		store = x402.NewInMemoryPendingSettlementStore()
	}

	// Fast path: a prior settle attempt for this exact payload already
	// broadcast a transaction whose receipt wait failed (settlement_pending).
	// Reconcile against it instead of re-verifying/re-broadcasting.
	if permit2Payload.Signature != "" {
		if txHash, ok, _ := store.Get(ctx, permit2Payload.Signature); ok {
			// Remove before reconciling (rather than after) so a concurrent retry
			// of the same payload misses here instead of also reconciling: it
			// falls through to the normal broadcast path, which independently
			// rejects it as an on-chain replay (nonce already consumed).
			_ = store.Delete(ctx, permit2Payload.Signature)
			receiptWaitSigner := ResolvePermit2ReceiptWaitSigner(signer, facilCtx, payload.Extensions, payload.Accepted.Network)
			return AwaitPermit2Settlement(ctx, store, receiptWaitSigner, permit2Payload.Signature, txHash, payer, network, ErrTransactionFailed, "")
		}
	}

	verifyOpts := &VerifyPermit2Options{Simulate: &simulate, EnableParallelSimulation: enableParallelSimulation}
	if _, err := VerifyPermit2(ctx, signer, payload, requirements, permit2Payload, facilCtx, verifyOpts); err != nil {
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

	dataSuffix, err := evm.ResolveDataSuffix(facilCtx, evm.DataSuffixContext{Payload: payload, Requirements: requirements})
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, payer, network, "", err.Error())
	}

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
			dataSuffix,
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
				Address:    evm.X402ExactPermit2ProxyAddress,
				ABI:        evm.X402ExactPermit2ProxySettleABI,
				Function:   evm.FunctionSettle,
				Args:       []interface{}{permitStruct, args.Owner, witnessStruct, args.Signature},
				DataSuffix: dataSuffix,
			}
			txHashes, sendErr := extensionSigner.SendTransactions(ctx, []erc20approvalgassponsor.TransactionRequest{
				{Serialized: erc20Info.SignedTransaction},
				{Call: &settle},
			})
			if sendErr != nil {
				err = sendErr
			} else if finalHash, hashOk := evm.FinalHashFromTwoRequestSend(txHashes); !hashOk || !evm.IsValidTxHash(finalHash) {
				err = fmt.Errorf("%s: extension signer returned no valid settlement transaction hash", ErrErc20ApprovalTxFailed)
			} else {
				txHash = finalHash
			}
		} else {
			txHash, err = signer.WriteContract(
				ctx,
				evm.X402ExactPermit2ProxyAddress,
				evm.X402ExactPermit2ProxySettleABI,
				evm.FunctionSettle,
				dataSuffix,
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
			dataSuffix,
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
	receiptWaitSigner := ResolvePermit2ReceiptWaitSigner(signer, facilCtx, payload.Extensions, payload.Accepted.Network)
	return AwaitPermit2Settlement(ctx, store, receiptWaitSigner, permit2Payload.Signature, txHash, payer, network, ErrTransactionFailed, "")
}

// AwaitPermit2Settlement waits for the broadcast transaction's receipt (with
// PendingSettlementStore bookkeeping) and builds the settle response, shared
// by both the pending-settlement reconciliation fast path and the normal
// broadcast path above, and reused by the upto Permit2 scheme (which shares
// this settlement shape modulo a variable amount and error reason). pendingKey
// may be "" (no signature available), which disables the bookkeeping while
// still waiting for the receipt. amount may be "" for schemes without a
// variable settlement amount (e.g. exact) — SettleResponse.Amount has
// `omitempty`, so this is a no-op.
func AwaitPermit2Settlement(
	ctx context.Context,
	store x402.PendingSettlementStore,
	receiptWaitSigner evm.FacilitatorEvmSigner,
	pendingKey string,
	txHash string,
	payer string,
	network x402.Network,
	failedReason string,
	amount string,
) (*x402.SettleResponse, error) {
	if _, err := evm.WaitForSettleReceiptWithPendingStore(ctx, store, pendingKey, receiptWaitSigner, txHash, payer, network,
		failedReason, failedReason); err != nil {
		return nil, err
	}
	return &x402.SettleResponse{Success: true, Transaction: txHash, Network: network, Payer: payer, Amount: amount}, nil
}

// verifyPermit2Signature verifies the Permit2 EIP-712 signature.
func verifyPermit2Signature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	authorization evm.Permit2Authorization,
	signature []byte,
	chainID *big.Int,
) (bool, *evm.ERC6492SignatureData, error) {
	hash, err := evm.HashPermit2Authorization(authorization, chainID)
	if err != nil {
		return false, nil, err
	}

	var hash32 [32]byte
	copy(hash32[:], hash)

	// Use universal verification (supports EOA and EIP-1271)
	return evm.VerifyUniversalSignature(ctx, signer, authorization.From, hash32, signature, true)
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
