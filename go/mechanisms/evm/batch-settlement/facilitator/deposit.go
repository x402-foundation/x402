package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// resolveDepositTransferMethod inspects the requirements + payload to pick the
// deposit transport. The resource server's `accepts.extra.assetTransferMethod`
// hint is authoritative when present; otherwise we fall back to the payload
// shape (a Permit2 authorization implies Permit2), defaulting to ERC-3009.
//
// Precedence is requirements-hint-first to match the TypeScript and Python SDKs
// (see deposit.ts / deposit.py `resolveDepositTransferMethod`); routing the same
// request differently per SDK would let a payment verify on one and revert on another.
func resolveDepositTransferMethod(
	payload *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
) batchsettlement.AssetTransferMethod {
	if requirements.Extra != nil {
		if v, ok := requirements.Extra["assetTransferMethod"].(string); ok && v != "" {
			return batchsettlement.AssetTransferMethod(v)
		}
	}
	if payload.Deposit.Authorization.Permit2Authorization != nil {
		return batchsettlement.AssetTransferMethodPermit2
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
	allowedFactories []string,
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
	// erc3009Counterfactual is non-nil when the ERC-3009 deposit comes from an
	// undeployed ERC-6492 wallet with an allowlisted factory. In that case the
	// signature cannot be validated by ecrecover/EIP-1271 yet (no code), so it is
	// validated by the deploy+deposit Multicall3 simulation below.
	var erc3009Counterfactual *evm.ERC6492SignatureData
	switch transferMethod {
	case batchsettlement.AssetTransferMethodEip3009:
		auth := payload.Deposit.Authorization.Erc3009Authorization
		if auth == nil {
			return nil, x402.NewVerifyError(ErrErc3009AuthorizationRequired, config.Payer,
				"erc3009 authorization required for assetTransferMethod=eip3009")
		}
		counterfactual, reason, err := verifyErc3009DepositAuthorization(
			ctx, signer, config, channelId, depositAmount, auth, chainId, requirements.Extra, allowedFactories,
		)
		if err != nil {
			return nil, err
		} else if reason != "" {
			return nil, x402.NewVerifyError(reason, config.Payer, "ERC-3009 authorization invalid")
		}
		erc3009Counterfactual = counterfactual
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
	// Counterfactual ERC-6492 deposit: the payer wallet is not yet deployed, so a
	// plain deposit() eth_call would revert (no code → isValidSignature reverts).
	// Simulate factory-deploy + deposit atomically in one Multicall3 eth_call so the
	// inner signature is validated against the just-deployed wallet — mirroring how
	// settle will deploy then deposit.
	if erc3009Counterfactual != nil {
		ok, simErr := simulateCounterfactualErc3009Deposit(
			ctx, signer, erc3009Counterfactual, configTuple, depositAmount, collectorAddr, collectorData,
		)
		if simErr != nil || !ok {
			return &x402.VerifyResponse{ //nolint:nilerr // simulation failure → error encoded in response
				IsValid:       false,
				InvalidReason: ErrDepositSimulationFailed,
				Payer:         config.Payer,
			}, nil
		}
	}

	// ERC-20 approval branch: the user has not yet approved Permit2, so the
	// standalone deposit() simulation would always revert with insufficient
	// allowance. The execution path is multi-tx (approve+deposit handled by the
	// extension signer in `SettleDeposit`); skip the eth_call here.
	// Counterfactual deposits are simulated above via Multicall3, so skip the plain
	// eth_call too (the wallet has no code yet and a bare deposit() would revert).
	skipSimulation := erc3009Counterfactual != nil ||
		(permit2Branch != nil && permit2Branch.kind == permit2BranchErc20Approval)
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

	// Return current onchain state
	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   config.Payer,
		Extra:   BuildVerifyExtra(channelId, state),
	}, nil
}

// depositSettlementCacheKey returns the unique-per-payload key used to key the
// PendingSettlementStore for a deposit settle: the payer's authorization
// signature (ERC-3009 or Permit2, whichever the payload carries). Returns ""
// when no signature is available (malformed payload), disabling the pending-
// settlement fast path for that call — the normal broadcast path still runs
// and surfaces the appropriate validation error.
func depositSettlementCacheKey(
	payload *batchsettlement.BatchSettlementDepositPayload,
	transferMethod batchsettlement.AssetTransferMethod,
) string {
	switch transferMethod {
	case batchsettlement.AssetTransferMethodEip3009:
		if auth := payload.Deposit.Authorization.Erc3009Authorization; auth != nil {
			return auth.Signature
		}
	case batchsettlement.AssetTransferMethodPermit2:
		if auth := payload.Deposit.Authorization.Permit2Authorization; auth != nil {
			return auth.Signature
		}
	}
	return ""
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
//
// `store` is consulted first (keyed by depositSettlementCacheKey) to reconcile
// a previously-broadcast-but-unconfirmed deposit transaction from a prior
// settlement_pending response, instead of re-broadcasting. A nil store
// disables this fast path.
func SettleDeposit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
	fctx *x402.FacilitatorContext,
	dataSuffix []byte,
	allowedFactories []string,
	store x402.PendingSettlementStore,
) (*x402.SettleResponse, error) {
	config := payload.ChannelConfig
	network := x402.Network(requirements.Network)

	depositAmount, ok := new(big.Int).SetString(payload.Deposit.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidDepositPayload, config.Payer, network, "",
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
			return nil, x402.NewSettleError(ErrPermit2AuthorizationRequired, config.Payer, network, "",
				"permit2 authorization required for assetTransferMethod=permit2")
		}
		branch, reason, branchErr := resolvePermit2DepositBranch(
			ctx, auth, payload.Deposit.Amount,
			payerAssetView{Payer: config.Payer, Token: config.Token},
			extensions, fctx, string(requirements.Network),
		)
		if branchErr != nil {
			return nil, x402.NewSettleError(ErrInvalidDepositPayload, config.Payer, network, "",
				fmt.Sprintf("failed to resolve permit2 deposit branch: %s", branchErr))
		}
		if reason != "" {
			return nil, x402.NewSettleError(reason, config.Payer, network, "",
				"Permit2 deposit extension invalid at settle")
		}
		permit2Branch = branch
	}

	cacheKey := depositSettlementCacheKey(payload, transferMethod)
	receiptWaitSigner := signer
	if permit2Branch != nil && permit2Branch.kind == permit2BranchErc20Approval {
		receiptWaitSigner = permit2Branch.extensionSigner
	}

	// Pending-settlement fast path: a prior settle for this exact authorization
	// broadcast a transaction but couldn't confirm it in time. Reconcile against
	// that transaction instead of re-broadcasting (which would revert on replay
	// — the authorization's nonce/signature has already been consumed onchain).
	if store != nil && cacheKey != "" {
		if txHash, hit, _ := store.Get(ctx, cacheKey); hit {
			// Remove before reconciling (rather than after) so a concurrent retry
			// of the same payload misses here instead of also reconciling: it
			// falls through to the normal broadcast path, which independently
			// rejects it as an on-chain replay (nonce already consumed).
			_ = store.Delete(ctx, cacheKey)
			return reconcilePendingDeposit(ctx, depositSettleContext{
				signer:            signer,
				receiptWaitSigner: receiptWaitSigner,
				config:            config,
				channelId:         payload.Voucher.ChannelId,
				network:           network,
				txHash:            txHash,
				amountStr:         payload.Deposit.Amount,
				store:             store,
				cacheKey:          cacheKey,
			})
		}
	}

	collectorAddr, collectorData, err := buildDepositCollectorCall(payload, transferMethod, permit2Branch)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidDepositPayload, config.Payer, network, "",
			fmt.Sprintf("failed to build collector data: %s", err))
	}

	// Build channel config tuple for contract call
	configTuple := ToContractChannelConfig(config)

	// ERC-6492 counterfactual deposit: if the ERC-3009 authorization is wrapped with
	// factory deployment info and the payer has no code yet, deploy the wallet (gated
	// by the factory allowlist) before the deposit. After deploying, simulate the
	// deposit with the inner signature to catch wallets whose validator is installed
	// lazily — submitting a doomed deposit would waste gas and misreport the failure.
	if transferMethod == batchsettlement.AssetTransferMethodEip3009 {
		if err := deployErc3009CounterfactualIfNeeded(
			ctx, signer, payload, requirements, allowedFactories,
		); err != nil {
			return nil, err
		}
	}

	// Read pre-submit onchain state. Used as the baseline for the optimistic
	// post-deposit fallback (priorBalance + depositAmount). Reading after the
	// receipt would already include the deposit when the RPC is current, and
	// adding depositAmount again would double-count.
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

	// Branch on extension settlement strategy:
	//   erc20Approval → broadcast pre-signed approve() then deposit() via the
	//                   facilitator extension signer's SendTransactions.
	//   else          → single deposit() write through the facilitator signer.
	var txHash string
	// A single hash from the two-request (approve + deposit) send means the signer
	// bundled them atomically, but a non-conforming signer could return one hash
	// after broadcasting only the approve. Its receipt then proves some transaction
	// didn't revert, not that the deposit ran, so success requires the balance
	// check below.
	unconfirmedBundleHash := false
	if permit2Branch != nil && permit2Branch.kind == permit2BranchErc20Approval {
		settleCall := erc20approvalgassponsor.WriteContractCall{
			Address:    batchsettlement.BatchSettlementAddress,
			ABI:        batchsettlement.BatchSettlementDepositABI,
			Function:   "deposit",
			Args:       []interface{}{configTuple, depositAmount, collectorAddr, collectorData},
			DataSuffix: dataSuffix,
		}
		txHashes, sendErr := permit2Branch.extensionSigner.SendTransactions(ctx, []erc20approvalgassponsor.TransactionRequest{
			{Serialized: permit2Branch.erc20Info.SignedTransaction},
			{Call: &settleCall},
		})
		if sendErr != nil {
			return nil, x402.NewSettleError(ErrErc20ApprovalBroadcastFailed, config.Payer, network, "",
				fmt.Sprintf("erc20 approval + deposit send failed: %s", sendErr))
		}
		var ok bool
		if txHash, ok = evm.FinalHashFromTwoRequestSend(txHashes); !ok {
			return nil, x402.NewSettleError(ErrDepositTransactionFailed, config.Payer, network, "",
				fmt.Sprintf("expected 1 (atomic bundle) or 2 (sequential) tx hashes from extension signer, got %d", len(txHashes)))
		}
		unconfirmedBundleHash = len(txHashes) == 1
	} else {
		txHash, err = signer.WriteContract(
			ctx,
			batchsettlement.BatchSettlementAddress,
			batchsettlement.BatchSettlementDepositABI,
			"deposit",
			dataSuffix,
			configTuple,
			depositAmount,
			collectorAddr,
			collectorData,
		)
		if err != nil {
			return nil, x402.NewSettleError(ErrDepositTransactionFailed, config.Payer, network, "",
				fmt.Sprintf("deposit transaction failed: %s", err))
		}
	}

	return finishDepositSettle(ctx, depositSettleContext{
		signer:            signer,
		receiptWaitSigner: receiptWaitSigner,
		config:            config,
		channelId:         payload.Voucher.ChannelId,
		network:           network,
		txHash:            txHash,
		amountStr:         payload.Deposit.Amount,
		store:             store,
		cacheKey:          cacheKey,
	}, depositAmount, unconfirmedBundleHash, priorChannelState{
		balance:             priorBalance,
		totalClaimed:        priorTotalClaimed,
		withdrawRequestedAt: priorWithdrawRequestedAt,
		refundNonce:         priorRefundNonce,
	})
}

// depositSettleContext holds the fields common to finishDepositSettle and
// reconcilePendingDeposit — the two ways a deposit settle attempt resolves:
// a fresh broadcast this call just made, or a pending-settlement store hit
// reconciling against one broadcast by a prior call.
type depositSettleContext struct {
	signer            evm.FacilitatorEvmSigner
	receiptWaitSigner evm.FacilitatorEvmSigner
	config            batchsettlement.ChannelConfig
	channelId         string
	network           x402.Network
	txHash            string
	amountStr         string
	store             x402.PendingSettlementStore
	cacheKey          string
}

// priorChannelState is the pre-broadcast channel-state snapshot used by
// finishDepositSettle's optimistic post-deposit fallback (see its doc comment
// for why it must be read strictly before the deposit broadcast).
type priorChannelState struct {
	balance             *big.Int
	totalClaimed        *big.Int
	withdrawRequestedAt int
	refundNonce         *big.Int
}

// finishDepositSettle waits for the deposit transaction to confirm, updates the
// PendingSettlementStore accordingly (recording the broadcast hash on a
// non-terminal wait failure so a subsequent settle attempt for the same
// authorization can reconcile instead of re-broadcasting, and clearing it once
// the receipt is observed), then polls channel state and builds the success
// response.
//
// prior must be read strictly before the deposit transaction was broadcast —
// it anchors the optimistic post-deposit fallback used when the post-receipt
// RPC read hasn't caught up yet. Reading it after broadcast could double-count
// (or under-count, for the erc20-approval-bundle ambiguity check) the deposit.
func finishDepositSettle(
	ctx context.Context,
	sc depositSettleContext,
	depositAmount *big.Int,
	unconfirmedBundleHash bool,
	prior priorChannelState,
) (*x402.SettleResponse, error) {
	if _, err := evm.WaitForSettleReceiptWithPendingStore(ctx, sc.store, sc.cacheKey, sc.receiptWaitSigner, sc.txHash, sc.config.Payer, sc.network,
		ErrDepositTransactionFailed, ErrTransactionReverted); err != nil {
		return nil, err
	}

	// Optimistic post-deposit extra (fallback if RPC hasn't caught up to
	// the just-confirmed tx). Anchored to the pre-submit read above so we
	// add depositAmount exactly once. The settle response intentionally
	// omits `chargedCumulativeAmount` — that field is added by the resource
	// server's `enrichSettlementResponse` hook, and emitting it from the
	// facilitator violates the additive-enrichment policy.
	optimisticBalance := new(big.Int).Add(prior.balance, depositAmount)
	optimisticState := &batchsettlement.ChannelState{
		Balance:             optimisticBalance,
		TotalClaimed:        prior.totalClaimed,
		WithdrawRequestedAt: prior.withdrawRequestedAt,
		RefundNonce:         prior.refundNonce,
	}

	// Poll the RPC until it reflects the just-confirmed deposit, so subsequent
	// verify reads are guaranteed to see this balance.
	expectedMinBalance := new(big.Int).Set(optimisticBalance)
	deadline := time.Now().Add(channelStatePollDeadline)
	postState, readErr := ReadChannelState(ctx, sc.signer, sc.channelId)
	for postState == nil || postState.Balance == nil || postState.Balance.Cmp(expectedMinBalance) < 0 {
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(channelStatePollInterval)
		postState, readErr = ReadChannelState(ctx, sc.signer, sc.channelId)
	}

	balanceConfirmed := postState != nil && postState.Balance != nil && postState.Balance.Cmp(expectedMinBalance) >= 0
	// A read showing the deposit missing (readErr == nil) is terminal; a failed read leaves
	// it unconfirmed, so report settlement_pending for the caller to reconcile. Sequential
	// and base-signer paths leave unconfirmedBundleHash false, so a read failure there falls
	// through to the optimistic state below.
	if unconfirmedBundleHash && !balanceConfirmed {
		if readErr == nil {
			return nil, x402.NewSettleError(ErrDepositTransactionFailed, sc.config.Payer, sc.network, sc.txHash,
				"extension signer returned a single transaction hash for the erc20 approval + deposit "+
					"bundle, but the resulting channel balance does not reflect the deposit")
		}
		if sc.store != nil && sc.cacheKey != "" {
			if setErr := sc.store.Set(ctx, sc.cacheKey, sc.txHash); setErr != nil {
				// Can't guarantee a later retry will find this to reconcile against — a
				// blind retry could re-verify/re-broadcast and double-send. Downgrade to
				// terminal, preserving the transaction hash for manual reconciliation.
				return nil, x402.NewSettleError(ErrDepositTransactionFailed, sc.config.Payer, sc.network, sc.txHash,
					fmt.Sprintf("settlement_pending, but failed to persist for retry: %s", setErr.Error()))
			}
		}
		return nil, x402.NewSettleError(ErrSettlementPending, sc.config.Payer, sc.network, sc.txHash,
			"extension signer returned a single transaction hash for the erc20 approval + deposit "+
				"bundle and the post-deposit balance read failed, so the deposit could not be confirmed")
	}

	finalState := optimisticState
	if balanceConfirmed {
		finalState = postState
	}

	extra := BuildSettleExtra(sc.channelId, finalState)

	return &x402.SettleResponse{
		Success:     true,
		Transaction: sc.txHash,
		Network:     sc.network,
		Payer:       sc.config.Payer,
		Amount:      sc.amountStr,
		Extra:       extra,
	}, nil
}

// reconcilePendingDeposit handles a PendingSettlementStore cache hit for
// SettleDeposit: a prior call already broadcast sc.txHash (its nonce/signature
// is now consumed onchain, so re-broadcasting is not an option) but couldn't
// confirm it before returning settlement_pending. Unlike finishDepositSettle,
// there is no reliable pre-broadcast channel-state snapshot available here (it
// lived in the earlier, now-returned call), so this path skips the optimistic
// balance-add fallback entirely: on confirmation it reports whatever the RPC
// currently reads (a short poll only guards against read-after-write lag), and
// on failure to confirm it re-records the pending entry and returns another
// settlement_pending for the caller to retry again later.
//
// Known limitation: finishDepositSettle's unconfirmedBundleHash check (guarding
// against a non-conforming ERC-20-approval extension signer that bundles a single
// hash covering only approve(), never running deposit()) has no equivalent here,
// since it needs the pre-broadcast channel state this path doesn't have — a
// receipt success here is trusted at face value. Only affects a non-conforming
// extension signer combined with a confirm-timeout on the original request.
func reconcilePendingDeposit(ctx context.Context, sc depositSettleContext) (*x402.SettleResponse, error) {
	if _, err := evm.WaitForSettleReceiptWithPendingStore(ctx, sc.store, sc.cacheKey, sc.receiptWaitSigner, sc.txHash, sc.config.Payer, sc.network,
		ErrDepositTransactionFailed, ErrTransactionReverted); err != nil {
		return nil, err
	}

	deadline := time.Now().Add(channelStatePollDeadline)
	state, err := ReadChannelState(ctx, sc.signer, sc.channelId)
	for state == nil && err != nil {
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(channelStatePollInterval)
		state, err = ReadChannelState(ctx, sc.signer, sc.channelId)
	}

	var extra map[string]interface{}
	if state != nil {
		extra = BuildSettleExtra(sc.channelId, state)
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: sc.txHash,
		Network:     sc.network,
		Payer:       sc.config.Payer,
		Amount:      sc.amountStr,
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
// Returns (sigData, "", nil) when the authorization is valid; sigData is non-nil
// only for undeployed ERC-6492 wallets whose factory is allowlisted, signalling that
// the inner signature must be validated via the deploy+deposit Multicall3 simulation
// (the wallet has no code yet, so a direct ecrecover/EIP-1271 check cannot succeed).
// Returns (nil, "invalidReason", nil) for a well-formed but rejected authorization,
// or (nil, "", err) when an RPC or parse error blocks verification.
func verifyErc3009DepositAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	config batchsettlement.ChannelConfig,
	channelId string,
	depositAmount *big.Int,
	auth *batchsettlement.BatchSettlementErc3009Authorization,
	chainId *big.Int,
	extra map[string]interface{},
	allowedFactories []string,
) (*evm.ERC6492SignatureData, string, error) {
	validAfter, ok := new(big.Int).SetString(auth.ValidAfter, 10)
	if !ok {
		return nil, "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid validAfter")
	}
	validBefore, ok := new(big.Int).SetString(auth.ValidBefore, 10)
	if !ok {
		return nil, "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid validBefore")
	}
	if reason := Erc3009AuthorizationTimeInvalidReason(validAfter, validBefore); reason != "" {
		return nil, reason, nil
	}

	// Token EIP-712 domain — required to recompute the
	// `ReceiveWithAuthorization` digest. Read from `requirements.extra`
	// (populated by the resource server's GetExtra hook); missing fields are
	// reported as a structured ErrMissingEip712Domain rejection.
	tokenName, _ := extra["name"].(string)
	tokenVersion, _ := extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		return nil, ErrMissingEip712Domain, nil
	}

	erc3009Nonce, err := batchsettlement.BuildErc3009DepositNonce(channelId, auth.Salt)
	if err != nil {
		return nil, "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("failed to derive ERC-3009 nonce: %s", err))
	}
	saltBytes, err := evm.HexToBytes(erc3009Nonce)
	if err != nil {
		return nil, "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("invalid erc3009 nonce: %s", err))
	}
	sigBytes, err := evm.HexToBytes(auth.Signature)
	if err != nil {
		return nil, "", x402.NewVerifyError(ErrErc3009SignatureInvalid, config.Payer,
			fmt.Sprintf("invalid erc3009 signature: %s", err))
	}

	// Parse the ERC-6492 wrapper (a no-op for unwrapped signatures, which return the
	// signature unchanged as InnerSignature).
	sigData, err := evm.ParseERC6492Signature(sigBytes)
	if err != nil {
		return nil, "", x402.NewVerifyError(ErrErc3009SignatureInvalid, config.Payer,
			fmt.Sprintf("failed to parse signature: %s", err))
	}

	// Counterfactual detection: only fetch code when there is deployment info, so the
	// common (already-deployed / plain EOA) path keeps a single RPC round-trip.
	if evm.HasEIP6492Deployment(sigData) {
		code, codeErr := signer.GetCode(ctx, config.Payer)
		if codeErr != nil {
			return nil, "", x402.NewVerifyError(ErrChannelStateReadFailed, config.Payer,
				fmt.Sprintf("failed to read payer code: %s", codeErr))
		}
		if len(code) == 0 {
			// Undeployed ERC-6492 wallet. Gate the factory before deferring signature
			// validation to the deploy+deposit simulation.
			if !evm.IsFactoryAllowed(sigData.Factory, allowedFactories) {
				return nil, ErrFactoryNotAllowed, nil
			}
			return sigData, "", nil
		}
		// Wallet already deployed despite the wrapper — fall through and validate the
		// inner signature via EIP-1271 like any other deployed wallet.
	}

	// Uses the strict code-routed primitive so pre-verify mirrors on-chain
	// SignatureChecker (USDC v2.2 uses code-routing for ERC-3009 authorization).
	// The inner signature is used so a deployed wallet that happened to send a wrapped
	// signature is still verified against its EIP-1271 validator.
	valid, err := evm.VerifyTypedDataStrict(
		ctx,
		signer,
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
		sigData.InnerSignature,
	)
	if err != nil {
		return nil, "", x402.NewVerifyError(ErrErc3009SignatureInvalid, config.Payer,
			fmt.Sprintf("ERC-3009 signature verification failed: %s", err))
	}
	if !valid {
		return nil, ErrErc3009SignatureInvalid, nil
	}
	return nil, "", nil
}

// simulateCounterfactualErc3009Deposit simulates the factory deploy + deposit atomically
// via a single Multicall3 eth_call. The deposit succeeds only if, after the wallet is
// deployed in the first sub-call, its isValidSignature accepts the inner ERC-3009 signature
// that the (already-stripped) collectorData carries. Returns the success of the deposit call.
func simulateCounterfactualErc3009Deposit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	sigData *evm.ERC6492SignatureData,
	configTuple interface{},
	depositAmount *big.Int,
	collectorAddr common.Address,
	collectorData []byte,
) (bool, error) {
	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
		{
			Address:  common.BytesToAddress(sigData.Factory[:]).Hex(),
			CallData: sigData.FactoryCalldata,
		},
		{
			Address:      batchsettlement.BatchSettlementAddress,
			ABI:          batchsettlement.BatchSettlementDepositABI,
			FunctionName: "deposit",
			Args:         []interface{}{configTuple, depositAmount, collectorAddr, collectorData},
		},
	})
	if err != nil {
		return false, err
	}
	if len(results) < 2 {
		return false, nil
	}
	return results[1].Success(), nil
}

// deployErc3009CounterfactualIfNeeded deploys an undeployed ERC-6492 wallet before an
// ERC-3009 deposit when the authorization is wrapped with allowlisted factory deployment
// info. Returns nil when no deployment is needed or the wallet deployed successfully (the
// caller proceeds to the real deposit), or a settle error when the factory is disallowed or
// the deploy transaction reverts. The inner signature is validated by the verify-side
// deploy+deposit Multicall3 simulation and, definitively, by the on-chain deposit() that
// follows — so no post-deploy re-simulation is performed here.
func deployErc3009CounterfactualIfNeeded(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
	allowedFactories []string,
) error {
	config := payload.ChannelConfig
	network := x402.Network(requirements.Network)

	auth := payload.Deposit.Authorization.Erc3009Authorization
	if auth == nil {
		return nil
	}
	sigBytes, err := evm.HexToBytes(auth.Signature)
	if err != nil {
		return x402.NewSettleError(ErrErc3009SignatureInvalid, config.Payer, network, "",
			fmt.Sprintf("invalid erc3009 signature: %s", err))
	}
	sigData, err := evm.ParseERC6492Signature(sigBytes)
	if err != nil {
		return x402.NewSettleError(ErrErc3009SignatureInvalid, config.Payer, network, "",
			fmt.Sprintf("failed to parse signature: %s", err))
	}
	if !evm.HasEIP6492Deployment(sigData) {
		return nil
	}

	code, err := signer.GetCode(ctx, config.Payer)
	if err != nil {
		return x402.NewSettleError(ErrChannelStateReadFailed, config.Payer, network, "",
			fmt.Sprintf("failed to read payer code: %s", err))
	}
	if len(code) != 0 {
		// Already deployed — nothing to do; proceed with the standard deposit.
		return nil
	}

	if !evm.IsFactoryAllowed(sigData.Factory, allowedFactories) {
		return x402.NewSettleError(ErrFactoryNotAllowed, config.Payer, network, "",
			"factory not in EIP6492AllowedFactories allowlist")
	}

	if err := evm.SendFactoryDeployTransaction(ctx, signer, sigData); err != nil {
		return x402.NewSettleError(ErrSmartWalletDeploymentFailed, config.Payer, network, "", err.Error())
	}

	// Do NOT re-simulate the deposit here. The single authoritative pre-check is the
	// atomic Multicall3 deploy+isValidSignature simulation that runs in VerifyDeposit
	// (one eth_call, state shared across both sub-calls). A second standalone eth_call
	// after the real deploy tx is unreliable — the read can race the deploy's state
	// propagation across load-balanced RPC nodes — and was producing false
	// inner-signature-unsupported rejections for valid wallets
	// (e.g. Coinbase Smart Wallet v1.1). The real deposit() transaction that follows
	// is itself the definitive signature check; a genuinely unsupported inner
	// signature will revert there and be surfaced as ErrDepositTransactionFailed.
	return nil
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
	// Uses the strict code-routed primitive so pre-verify mirrors Permit2's
	// on-chain SignatureVerification (routes by code.length).
	valid, err := evm.VerifyTypedDataStrict(
		ctx,
		signer,
		config.Payer,
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
