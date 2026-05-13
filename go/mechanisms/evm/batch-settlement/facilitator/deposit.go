package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// resolveDepositTransferMethod inspects the payload + requirements to pick the
// deposit transport. Defaults to ERC-3009 to preserve historical behavior;
// callers opt into Permit2 by setting `accepts.extra.assetTransferMethod`
// or by sending a Permit2 authorization.
func resolveDepositTransferMethod(
	payload *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
) batchsettlement.AssetTransferMethod {
	if payload.Deposit.Authorization.Permit2Authorization != nil {
		return batchsettlement.AssetTransferMethodPermit2
	}
	if requirements.Extra != nil {
		if v, ok := requirements.Extra["assetTransferMethod"].(string); ok && v != "" {
			return batchsettlement.AssetTransferMethod(v)
		}
	}
	return batchsettlement.AssetTransferMethodEip3009
}

// VerifyDeposit verifies a batched deposit payload.
// Dispatches on the deposit transfer method (ERC-3009 or Permit2), validates
// the matching authorization, voucher signature, payer balance, and
// maxClaimableAmount, then simulates the onchain deposit to surface revert
// reasons before settle.
//
// `extensions` is the top-level `payment.extensions` envelope and `fctx` is the
// facilitator's registered extension context. Together they enable the EIP-2612
// and ERC-20 approval gas-sponsoring branches for Permit2 deposits. Both may
// be nil for the standard Permit2 path or for ERC-3009 deposits.
func VerifyDeposit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	config := payload.ChannelConfig
	channelId := payload.Voucher.ChannelId

	// Validate channel config
	if err := ValidateChannelConfig(config, channelId, requirements); err != nil {
		return nil, err
	}

	// Validate deposit amount
	depositAmount, ok := new(big.Int).SetString(payload.Deposit.Amount, 10)
	if !ok || depositAmount.Sign() <= 0 {
		return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("invalid deposit amount: %s", payload.Deposit.Amount))
	}

	// Get chain ID
	chainId, err := signer.GetChainID(ctx)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, config.Payer,
			fmt.Sprintf("failed to get chain ID: %s", err))
	}

	transferMethod := resolveDepositTransferMethod(payload, requirements)

	// Permit2 branch may consult extensions to choose between standard /
	// EIP-2612 / ERC-20 approval execution; resolved once here and reused by
	// both the simulation below and the eventual SettleDeposit call.
	var permit2Branch *permit2DepositBranch
	switch transferMethod {
	case batchsettlement.AssetTransferMethodEip3009:
		auth := payload.Deposit.Authorization.Erc3009Authorization
		if auth == nil {
			return nil, x402.NewVerifyError(ErrErc3009AuthorizationRequired, config.Payer,
				"erc3009 authorization required for assetTransferMethod=eip3009")
		}
		if reason, err := verifyErc3009DepositAuthorization(
			ctx, signer, config, channelId, depositAmount, auth, chainId, requirements.Extra,
		); err != nil {
			return nil, err
		} else if reason != "" {
			return nil, x402.NewVerifyError(reason, config.Payer, "ERC-3009 authorization invalid")
		}
	case batchsettlement.AssetTransferMethodPermit2:
		auth := payload.Deposit.Authorization.Permit2Authorization
		if auth == nil {
			return nil, x402.NewVerifyError(ErrPermit2AuthorizationRequired, config.Payer,
				"permit2 authorization required for assetTransferMethod=permit2")
		}
		if reason, err := verifyPermit2DepositAuthorization(
			ctx, signer, config, channelId, depositAmount, auth, chainId,
		); err != nil {
			return nil, err
		} else if reason != "" {
			return nil, x402.NewVerifyError(reason, config.Payer, "Permit2 authorization invalid")
		}
		// Resolve the gas-sponsorship branch (standard / eip2612 / erc20Approval)
		// once and reuse it during simulation. Errors here are well-formed
		// rejections (e.g. EIP-2612 amount mismatch); internal failures bubble.
		branch, reason, branchErr := resolvePermit2DepositBranch(
			ctx, auth, payload.Deposit.Amount,
			payerAssetView{Payer: config.Payer, Token: config.Token},
			extensions, fctx, string(requirements.Network),
		)
		if branchErr != nil {
			return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
				fmt.Sprintf("failed to resolve permit2 deposit branch: %s", branchErr))
		}
		if reason != "" {
			return nil, x402.NewVerifyError(reason, config.Payer, "Permit2 deposit extension invalid")
		}
		permit2Branch = branch
	default:
		return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("unsupported assetTransferMethod: %s", transferMethod))
	}

	// Verify voucher signature
	voucherValid, err := VerifyBatchedVoucherTypedData(
		ctx, signer,
		channelId,
		payload.Voucher.MaxClaimableAmount,
		config.PayerAuthorizer,
		config.Payer,
		payload.Voucher.Signature,
		chainId,
	)
	if err != nil {
		return nil, x402.NewVerifyError(ErrVoucherSignatureInvalid, config.Payer,
			fmt.Sprintf("voucher signature verification failed: %s", err))
	}
	if !voucherValid {
		return nil, x402.NewVerifyError(ErrVoucherSignatureInvalid, config.Payer,
			"voucher signature is invalid")
	}

	// Check payer balance
	payerBalance, err := signer.GetBalance(ctx, config.Payer, config.Token)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, config.Payer,
			fmt.Sprintf("failed to read payer balance: %s", err))
	}
	if payerBalance.Cmp(depositAmount) < 0 {
		return nil, x402.NewVerifyError(ErrInsufficientBalance, config.Payer,
			fmt.Sprintf("payer balance %s is less than deposit amount %s", payerBalance.String(), depositAmount.String()))
	}

	// Read existing channel state.
	// For brand-new channels the contract returns zero values for all fields;
	// ReadChannelState returns those zeros successfully — a nil error with
	// Balance=0, TotalClaimed=0 etc.  A non-nil error means an actual RPC
	// failure, which we surface rather than silently masking.
	state, err := ReadChannelState(ctx, signer, channelId)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, config.Payer,
			fmt.Sprintf("failed to read channel state: %s", err))
	}

	// Validate maxClaimableAmount <= balance + deposit
	maxClaimable, ok := new(big.Int).SetString(payload.Voucher.MaxClaimableAmount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid maxClaimableAmount")
	}
	effectiveBalance := new(big.Int).Add(state.Balance, depositAmount)
	if maxClaimable.Cmp(effectiveBalance) > 0 {
		return nil, x402.NewVerifyError(ErrMaxClaimableExceedsBal, config.Payer,
			fmt.Sprintf("maxClaimableAmount %s exceeds effective balance %s", maxClaimable.String(), effectiveBalance.String()))
	}

	// Validate maxClaimableAmount > totalClaimed (monotonic increase)
	if maxClaimable.Cmp(state.TotalClaimed) < 0 {
		return nil, x402.NewVerifyError(ErrMaxClaimableTooLow, config.Payer,
			fmt.Sprintf("maxClaimableAmount %s is below totalClaimed %s", maxClaimable.String(), state.TotalClaimed.String()))
	}

	// Simulate the deposit transaction to catch onchain errors early.
	configTuple := ToContractChannelConfig(config)
	collectorAddr, collectorData, err := buildDepositCollectorCall(payload, transferMethod, permit2Branch)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("failed to build collector data for simulation: %s", err))
	}
	// ERC-20 approval branch: the user has not yet approved Permit2, so the
	// standalone deposit() simulation would always revert with insufficient
	// allowance. The execution path is multi-tx (approve+deposit handled by the
	// extension signer in `SettleDeposit`); skip the eth_call here.
	skipSimulation := permit2Branch != nil && permit2Branch.kind == permit2BranchErc20Approval
	if !skipSimulation {
		_, simErr := signer.ReadContract(
			ctx,
			batchsettlement.BatchSettlementAddress,
			batchsettlement.BatchSettlementDepositABI,
			"deposit",
			configTuple,
			depositAmount,
			collectorAddr,
			collectorData,
		)
		if simErr != nil {
			// Diagnose the most common standard-Permit2-path simulation
			// revert: the user hasn't approved Permit2. We probe
			// `allowance(payer, Permit2)` and surface the dedicated reason
			// when it's below the deposit amount; any other revert (signature
			// invalidation, balance, etc.) passes through as the generic
			// ErrDepositSimulationFailed. Mirrors exact's
			// `CheckPermit2Prerequisites` diagnosis. RPC failures during the
			// probe also fall through to the generic reason.
			invalidReason := ErrDepositSimulationFailed
			if transferMethod == batchsettlement.AssetTransferMethodPermit2 &&
				(permit2Branch == nil || permit2Branch.kind == permit2BranchStandard) {
				if allowanceResult, allowErr := signer.ReadContract(
					ctx,
					config.Token,
					evm.ERC20AllowanceABI,
					"allowance",
					common.HexToAddress(config.Payer),
					common.HexToAddress(evm.PERMIT2Address),
				); allowErr == nil {
					if allowance, ok := allowanceResult.(*big.Int); ok && allowance != nil &&
						allowance.Cmp(depositAmount) < 0 {
						invalidReason = ErrPermit2AllowanceRequired
					}
				}
			}
			return &x402.VerifyResponse{ //nolint:nilerr // simulation failure → error encoded in response
				IsValid:       false,
				InvalidReason: invalidReason,
				Payer:         config.Payer,
			}, nil
		}
	}

	// Build response with projected state after deposit
	projectedState := &batchsettlement.ChannelState{
		Balance:             effectiveBalance,
		TotalClaimed:        state.TotalClaimed,
		WithdrawRequestedAt: state.WithdrawRequestedAt,
		RefundNonce:         state.RefundNonce,
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   config.Payer,
		Extra:   BuildVerifyExtra(channelId, projectedState),
	}, nil
}

// SettleDeposit executes a deposit onchain.
// Calls deposit(config, amount, collector, collectorData) on the BatchSettlement contract.
//
// `extensions` is the top-level `payment.extensions` envelope and `fctx` is the
// facilitator's registered extension context. They activate the ERC-20 approval
// gas-sponsoring branch (which broadcasts a pre-signed approve() before the
// deposit() via `Erc20ApprovalGasSponsoringSigner.SendTransactions`) and the
// EIP-2612 permit segment (encoded into `collectorData`). Both may be nil for
// the standard Permit2 path or for ERC-3009 deposits.
func SettleDeposit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	config := payload.ChannelConfig
	network := x402.Network(requirements.Network)

	depositAmount, ok := new(big.Int).SetString(payload.Deposit.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, config.Payer,
			fmt.Sprintf("invalid deposit amount: %s", payload.Deposit.Amount))
	}

	// Dispatch on transfer method (ERC-3009 vs Permit2) and build the matching
	// collector address + data for the onchain `deposit(config, amount,
	// collector, collectorData)` call. For Permit2, also resolve the
	// gas-sponsorship branch so settle uses the same execution path verify
	// already greenlit.
	transferMethod := resolveDepositTransferMethod(payload, requirements)
	var permit2Branch *permit2DepositBranch
	if transferMethod == batchsettlement.AssetTransferMethodPermit2 {
		auth := payload.Deposit.Authorization.Permit2Authorization
		if auth == nil {
			return nil, x402.NewSettleError(ErrPermit2AuthorizationRequired, "", network, config.Payer,
				"permit2 authorization required for assetTransferMethod=permit2")
		}
		branch, reason, branchErr := resolvePermit2DepositBranch(
			ctx, auth, payload.Deposit.Amount,
			payerAssetView{Payer: config.Payer, Token: config.Token},
			extensions, fctx, string(requirements.Network),
		)
		if branchErr != nil {
			return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, config.Payer,
				fmt.Sprintf("failed to resolve permit2 deposit branch: %s", branchErr))
		}
		if reason != "" {
			return nil, x402.NewSettleError(reason, "", network, config.Payer,
				"Permit2 deposit extension invalid at settle")
		}
		permit2Branch = branch
	}

	collectorAddr, collectorData, err := buildDepositCollectorCall(payload, transferMethod, permit2Branch)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, config.Payer,
			fmt.Sprintf("failed to build collector data: %s", err))
	}

	// Build channel config tuple for contract call
	configTuple := ToContractChannelConfig(config)

	// Branch on extension settlement strategy:
	//   erc20Approval → broadcast pre-signed approve() then deposit() via the
	//                   facilitator extension signer's SendTransactions.
	//   else          → single deposit() write through the facilitator signer.
	var txHash string
	if permit2Branch != nil && permit2Branch.kind == permit2BranchErc20Approval {
		settleCall := erc20approvalgassponsor.WriteContractCall{
			Address:  batchsettlement.BatchSettlementAddress,
			ABI:      batchsettlement.BatchSettlementDepositABI,
			Function: "deposit",
			Args:     []interface{}{configTuple, depositAmount, collectorAddr, collectorData},
		}
		txHashes, sendErr := permit2Branch.extensionSigner.SendTransactions(ctx, []erc20approvalgassponsor.TransactionRequest{
			{Serialized: permit2Branch.erc20Info.SignedTransaction},
			{Call: &settleCall},
		})
		if sendErr != nil {
			return nil, x402.NewSettleError(ErrErc20ApprovalBroadcastFailed, "", network, config.Payer,
				fmt.Sprintf("erc20 approval + deposit send failed: %s", sendErr))
		}
		if len(txHashes) < 2 {
			return nil, x402.NewSettleError(ErrDepositTransactionFailed, "", network, config.Payer,
				fmt.Sprintf("expected 2 tx hashes from extension signer, got %d", len(txHashes)))
		}
		// The deposit tx is the second; this is what we wait on and report
		// back as the settlement transaction.
		txHash = txHashes[1]
	} else {
		txHash, err = signer.WriteContract(
			ctx,
			batchsettlement.BatchSettlementAddress,
			batchsettlement.BatchSettlementDepositABI,
			"deposit",
			configTuple,
			depositAmount,
			collectorAddr,
			collectorData,
		)
		if err != nil {
			return nil, x402.NewSettleError(ErrDepositTransactionFailed, "", network, config.Payer,
				fmt.Sprintf("deposit transaction failed: %s", err))
		}
	}

	// Wait for receipt
	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, config.Payer,
			fmt.Sprintf("failed waiting for deposit receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, config.Payer,
			"deposit transaction reverted")
	}

	// Optimistic post-deposit extra (fallback if RPC hasn't caught up to
	// the just-confirmed tx). The settle response intentionally omits
	// `chargedCumulativeAmount` — that field is added by the resource
	// server's `enrichSettlementResponse` hook, and emitting
	// it from the facilitator violates the additive-enrichment policy.
	priorState, _ := ReadChannelState(ctx, signer, payload.Voucher.ChannelId)
	priorBalance := big.NewInt(0)
	priorTotalClaimed := big.NewInt(0)
	priorWithdrawRequestedAt := 0
	priorRefundNonce := big.NewInt(0)
	if priorState != nil {
		if priorState.Balance != nil {
			priorBalance = priorState.Balance
		}
		if priorState.TotalClaimed != nil {
			priorTotalClaimed = priorState.TotalClaimed
		}
		priorWithdrawRequestedAt = priorState.WithdrawRequestedAt
		if priorState.RefundNonce != nil {
			priorRefundNonce = priorState.RefundNonce
		}
	}
	optimisticBalance := new(big.Int).Add(priorBalance, depositAmount)
	optimisticState := &batchsettlement.ChannelState{
		Balance:             optimisticBalance,
		TotalClaimed:        priorTotalClaimed,
		WithdrawRequestedAt: priorWithdrawRequestedAt,
		RefundNonce:         priorRefundNonce,
	}

	// Poll the RPC until it reflects the just-confirmed deposit, so subsequent
	// verify reads are guaranteed to see this balance.
	expectedMinBalance := new(big.Int).Set(optimisticBalance)
	deadline := time.Now().Add(2 * time.Second)
	postState, _ := ReadChannelState(ctx, signer, payload.Voucher.ChannelId)
	for postState == nil || postState.Balance == nil || postState.Balance.Cmp(expectedMinBalance) < 0 {
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(150 * time.Millisecond)
		postState, _ = ReadChannelState(ctx, signer, payload.Voucher.ChannelId)
	}

	finalState := optimisticState
	if postState != nil && postState.Balance != nil && postState.Balance.Cmp(expectedMinBalance) >= 0 {
		finalState = postState
	}

	extra := BuildSettleExtra(payload.Voucher.ChannelId, finalState)

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       config.Payer,
		Amount:      payload.Deposit.Amount,
		Extra:       extra,
	}, nil
}

// buildDepositCollectorCall returns the onchain `(collector, collectorData)`
// pair needed by the BatchSettlement `deposit` call for the given transfer
// method. For Permit2, a non-nil `branch` provides the resolved
// gas-sponsorship execution path (standard / EIP-2612 / ERC-20 approval) and
// its pre-encoded `collectorData` (with EIP-2612 permit bytes appended where
// applicable). When `branch` is nil for Permit2 (legacy callers), the standard
// path is used.
func buildDepositCollectorCall(
	payload *batchsettlement.BatchSettlementDepositPayload,
	method batchsettlement.AssetTransferMethod,
	branch *permit2DepositBranch,
) (common.Address, []byte, error) {
	switch method {
	case batchsettlement.AssetTransferMethodEip3009:
		auth := payload.Deposit.Authorization.Erc3009Authorization
		if auth == nil {
			return common.Address{}, nil, fmt.Errorf("no ERC-3009 authorization provided")
		}
		data, err := batchsettlement.BuildErc3009CollectorData(auth.ValidAfter, auth.ValidBefore, auth.Salt, auth.Signature)
		if err != nil {
			return common.Address{}, nil, err
		}
		return common.HexToAddress(batchsettlement.ERC3009DepositCollectorAddress), data, nil
	case batchsettlement.AssetTransferMethodPermit2:
		auth := payload.Deposit.Authorization.Permit2Authorization
		if auth == nil {
			return common.Address{}, nil, fmt.Errorf("no Permit2 authorization provided")
		}
		var data []byte
		var err error
		if branch != nil {
			data = branch.collectorData
		} else {
			data, err = batchsettlement.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, nil)
			if err != nil {
				return common.Address{}, nil, err
			}
		}
		return common.HexToAddress(batchsettlement.Permit2DepositCollectorAddress), data, nil
	default:
		return common.Address{}, nil, fmt.Errorf("unsupported assetTransferMethod: %s", method)
	}
}

// verifyErc3009DepositAuthorization validates the time window and EIP-712
// `ReceiveWithAuthorization` signature for an ERC-3009 deposit.
//
// The token's EIP-712 domain (`name` / `version`) is consumed from
// `extra.name` / `extra.version`. Resource servers populate these from cached
// asset metadata when constructing payment requirements (see
// `BatchSettlementEvmScheme.GetExtra` in the server package); a missing or
// blank field is reported as `ErrMissingEip712Domain`.
//
// Returns ("invalidReason", nil) when the authorization is well-formed but
// invalid, ("", err) when an RPC/parse error blocked verification entirely,
// or ("", nil) when the authorization is valid.
func verifyErc3009DepositAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	config batchsettlement.ChannelConfig,
	channelId string,
	depositAmount *big.Int,
	auth *batchsettlement.BatchSettlementErc3009Authorization,
	chainId *big.Int,
	extra map[string]interface{},
) (string, error) {
	validAfter, ok := new(big.Int).SetString(auth.ValidAfter, 10)
	if !ok {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid validAfter")
	}
	validBefore, ok := new(big.Int).SetString(auth.ValidBefore, 10)
	if !ok {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid validBefore")
	}
	if reason := Erc3009AuthorizationTimeInvalidReason(validAfter, validBefore); reason != "" {
		return reason, nil
	}

	// Token EIP-712 domain — required to recompute the
	// `ReceiveWithAuthorization` digest. Read from `requirements.extra`
	// (populated by the resource server's GetExtra hook); missing fields are
	// reported as a structured ErrMissingEip712Domain rejection.
	tokenName, _ := extra["name"].(string)
	tokenVersion, _ := extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		return ErrMissingEip712Domain, nil
	}

	erc3009Nonce, err := batchsettlement.BuildErc3009DepositNonce(channelId, auth.Salt)
	if err != nil {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("failed to derive ERC-3009 nonce: %s", err))
	}
	saltBytes, err := evm.HexToBytes(erc3009Nonce)
	if err != nil {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("invalid erc3009 nonce: %s", err))
	}
	sigBytes, err := evm.HexToBytes(auth.Signature)
	if err != nil {
		return "", x402.NewVerifyError(ErrErc3009SignatureInvalid, config.Payer,
			fmt.Sprintf("invalid erc3009 signature: %s", err))
	}

	valid, err := signer.VerifyTypedData(
		ctx,
		config.Payer,
		evm.TypedDataDomain{
			Name:              tokenName,
			Version:           tokenVersion,
			ChainID:           chainId,
			VerifyingContract: config.Token,
		},
		batchsettlement.ReceiveAuthorizationTypes,
		"ReceiveWithAuthorization",
		map[string]interface{}{
			"from":        config.Payer,
			"to":          batchsettlement.ERC3009DepositCollectorAddress,
			"value":       depositAmount,
			"validAfter":  validAfter,
			"validBefore": validBefore,
			"nonce":       saltBytes,
		},
		sigBytes,
	)
	if err != nil {
		return "", x402.NewVerifyError(ErrErc3009SignatureInvalid, config.Payer,
			fmt.Sprintf("ERC-3009 signature verification failed: %s", err))
	}
	if !valid {
		return ErrErc3009SignatureInvalid, nil
	}
	return "", nil
}

// verifyPermit2DepositAuthorization validates the channel-bound Permit2
// PermitWitnessTransferFrom signature for a deposit. Verifies that:
//   - permitted.token == channelConfig.token
//   - witness.channelId == voucher.channelId
//   - spender == Permit2DepositCollectorAddress
//   - permitted.amount == deposit.amount
//   - the EIP-712 signature recovers to channelConfig.payer
//
// Returns ("invalidReason", nil) on a well-formed but rejected authorization.
// Token mismatch, spender mismatch, deadline expiry, amount mismatch, and
// signature failure each map to a dedicated machine-readable error string.
func verifyPermit2DepositAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	config batchsettlement.ChannelConfig,
	channelId string,
	depositAmount *big.Int,
	auth *batchsettlement.BatchSettlementPermit2Authorization,
	chainId *big.Int,
) (string, error) {
	if !strings.EqualFold(auth.Permitted.Token, config.Token) {
		return ErrTokenMismatch, nil
	}
	if !strings.EqualFold(auth.Witness.ChannelId, channelId) {
		return ErrChannelIdMismatch, nil
	}
	if !strings.EqualFold(auth.Spender, batchsettlement.Permit2DepositCollectorAddress) {
		return ErrPermit2InvalidSpender, nil
	}
	if auth.Permitted.Amount != depositAmount.String() {
		return ErrPermit2AmountMismatch, nil
	}
	if !strings.EqualFold(auth.From, config.Payer) {
		return ErrInvalidDepositPayload, nil
	}

	nonceBig, ok := new(big.Int).SetString(auth.Nonce, 10)
	if !ok {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid permit2 nonce")
	}
	deadlineBig, ok := new(big.Int).SetString(auth.Deadline, 10)
	if !ok {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid permit2 deadline")
	}
	if deadlineBig.Sign() > 0 && deadlineBig.Cmp(big.NewInt(currentTimestamp())) < 0 {
		return ErrPermit2DeadlineExpired, nil
	}
	channelIdBytes, err := evm.HexToBytes(channelId)
	if err != nil {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid channel id")
	}
	sigBytes, err := evm.HexToBytes(auth.Signature)
	if err != nil {
		return "", x402.NewVerifyError(ErrPermit2InvalidSignature, config.Payer,
			fmt.Sprintf("invalid permit2 signature: %s", err))
	}

	domain := evm.TypedDataDomain{
		Name:              batchsettlement.Permit2DomainName,
		ChainID:           chainId,
		VerifyingContract: batchsettlement.Permit2Address,
	}
	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  evm.NormalizeAddress(auth.Permitted.Token),
			"amount": depositAmount,
		},
		"spender":  evm.NormalizeAddress(auth.Spender),
		"nonce":    nonceBig,
		"deadline": deadlineBig,
		"witness": map[string]interface{}{
			"channelId": channelIdBytes,
		},
	}
	valid, err := signer.VerifyTypedData(
		ctx, config.Payer,
		domain,
		batchsettlement.BatchPermit2WitnessTypes,
		"PermitWitnessTransferFrom",
		message,
		sigBytes,
	)
	if err != nil {
		return "", x402.NewVerifyError(ErrPermit2InvalidSignature, config.Payer,
			fmt.Sprintf("permit2 signature verification failed: %s", err))
	}
	if !valid {
		return ErrPermit2InvalidSignature, nil
	}
	return "", nil
}
