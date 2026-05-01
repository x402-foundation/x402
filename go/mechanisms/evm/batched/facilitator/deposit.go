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
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// resolveDepositTransferMethod inspects the payload + requirements to pick the
// deposit transport. Defaults to ERC-3009 to preserve historical behavior;
// callers opt into Permit2 by setting `accepts.extra.assetTransferMethod`
// (matches the TS facilitator's `resolveDepositTransferMethod`).
func resolveDepositTransferMethod(
	payload *batched.BatchedDepositPayload,
	requirements types.PaymentRequirements,
) batched.AssetTransferMethod {
	if payload.Deposit.Authorization.Permit2Authorization != nil {
		return batched.AssetTransferMethodPermit2
	}
	if requirements.Extra != nil {
		if v, ok := requirements.Extra["assetTransferMethod"].(string); ok && v != "" {
			return batched.AssetTransferMethod(v)
		}
	}
	return batched.AssetTransferMethodEip3009
}

// VerifyDeposit verifies a batched deposit payload.
// Dispatches on the deposit transfer method (ERC-3009 or Permit2), validates
// the matching authorization, voucher signature, payer balance, and
// maxClaimableAmount, then simulates the onchain deposit to surface revert
// reasons before settle.
//
// `extensions` is the top-level `payment.extensions` envelope and `fctx` is the
// facilitator's registered extension context. Together they enable the EIP-2612
// and ERC-20 approval gas-sponsoring branches for Permit2 deposits (mirrors TS
// `resolvePermit2DepositBranch`). Both may be nil for the standard Permit2
// path or for ERC-3009 deposits.
func VerifyDeposit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedDepositPayload,
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
	case batched.AssetTransferMethodEip3009:
		auth := payload.Deposit.Authorization.Erc3009Authorization
		if auth == nil {
			return nil, x402.NewVerifyError(ErrErc3009AuthorizationRequired, config.Payer,
				"erc3009 authorization required for assetTransferMethod=eip3009")
		}
		if reason, err := verifyErc3009DepositAuthorization(
			ctx, signer, config, channelId, depositAmount, auth, chainId,
		); err != nil {
			return nil, err
		} else if reason != "" {
			return nil, x402.NewVerifyError(reason, config.Payer, "ERC-3009 authorization invalid")
		}
	case batched.AssetTransferMethodPermit2:
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
	// extension signer in `SettleDeposit`); skip the eth_call here. TS does the
	// same in `verifyDepositPermit2WithExtensions` when no
	// `simulateTransactions` capability is present.
	skipSimulation := permit2Branch != nil && permit2Branch.kind == permit2BranchErc20Approval
	if !skipSimulation {
		_, simErr := signer.ReadContract(
			ctx,
			batched.BatchSettlementAddress,
			batched.BatchSettlementDepositABI,
			"deposit",
			configTuple,
			depositAmount,
			collectorAddr,
			collectorData,
		)
		if simErr != nil {
			return &x402.VerifyResponse{ //nolint:nilerr // simulation failure → error encoded in response
				IsValid:       false,
				InvalidReason: ErrDepositSimulationFailed,
				Payer:         config.Payer,
			}, nil
		}
	}

	// Build response with projected state after deposit
	projectedState := &batched.ChannelState{
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
	payload *batched.BatchedDepositPayload,
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
	if transferMethod == batched.AssetTransferMethodPermit2 {
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
			Address:  batched.BatchSettlementAddress,
			ABI:      batched.BatchSettlementDepositABI,
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
			batched.BatchSettlementAddress,
			batched.BatchSettlementDepositABI,
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
	// server's `enrichSettlementResponse` hook (matching TS), and emitting
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
	optimisticState := &batched.ChannelState{
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

// verifyReceiveWithAuthorization verifies an ERC-3009 ReceiveWithAuthorization signature.
func verifyReceiveWithAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	from string,
	token string,
	value *big.Int,
	validAfter *big.Int,
	validBefore *big.Int,
	salt string,
	signature string,
	chainId *big.Int,
) (bool, error) {
	// Get token name and version for EIP-712 domain
	tokenName, tokenVersion, err := getTokenDomainInfo(ctx, signer, token)
	if err != nil {
		return false, fmt.Errorf("failed to get token domain info: %w", err)
	}

	domain := evm.TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainId,
		VerifyingContract: token,
	}

	saltBytes, err := evm.HexToBytes(salt)
	if err != nil {
		return false, fmt.Errorf("invalid salt: %w", err)
	}

	sigBytes, err := evm.HexToBytes(signature)
	if err != nil {
		return false, fmt.Errorf("invalid signature: %w", err)
	}

	message := map[string]interface{}{
		"from":        from,
		"to":          batched.ERC3009DepositCollectorAddress,
		"value":       value,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       saltBytes,
	}

	return signer.VerifyTypedData(
		ctx,
		from,
		domain,
		batched.ReceiveAuthorizationTypes,
		"ReceiveWithAuthorization",
		message,
		sigBytes,
	)
}

// getTokenDomainInfo reads the EIP-712 domain name and version from the token contract.
func getTokenDomainInfo(ctx context.Context, signer evm.FacilitatorEvmSigner, token string) (string, string, error) {
	nameResult, err := signer.ReadContract(ctx, token, evm.ERC20NameABI, "name")
	if err != nil {
		return "", "", fmt.Errorf("failed to read token name: %w", err)
	}
	name, ok := nameResult.(string)
	if !ok {
		return "", "", fmt.Errorf("token name is not a string")
	}

	versionResult, versionErr := signer.ReadContract(ctx, token, evm.ERC20VersionABI, "version")
	if versionErr != nil {
		return name, "1", nil //nolint:nilerr // version() is optional, default to "1"
	}
	version, ok := versionResult.(string)
	if !ok {
		return name, "1", nil
	}

	return name, version, nil
}

// buildERC3009CollectorData encodes the ERC-3009 authorization data for the collector contract.
// The collector ABI is (uint256 validAfter, uint256 validBefore, uint256 salt, bytes signature).
func buildERC3009CollectorData(payload *batched.BatchedDepositPayload) ([]byte, error) {
	auth := payload.Deposit.Authorization.Erc3009Authorization
	if auth == nil {
		return nil, fmt.Errorf("no ERC-3009 authorization provided")
	}
	return batched.BuildErc3009CollectorData(auth.ValidAfter, auth.ValidBefore, auth.Salt, auth.Signature)
}

// buildDepositCollectorCall returns the onchain `(collector, collectorData)`
// pair needed by the BatchSettlement `deposit` call for the given transfer
// method. For Permit2, a non-nil `branch` provides the resolved
// gas-sponsorship execution path (standard / EIP-2612 / ERC-20 approval) and
// its pre-encoded `collectorData` (with EIP-2612 permit bytes appended where
// applicable). When `branch` is nil for Permit2 (legacy callers), the standard
// path is used. Mirrors the dispatch in TS `verifyDeposit` / `settleDeposit`.
func buildDepositCollectorCall(
	payload *batched.BatchedDepositPayload,
	method batched.AssetTransferMethod,
	branch *permit2DepositBranch,
) (common.Address, []byte, error) {
	switch method {
	case batched.AssetTransferMethodEip3009:
		data, err := buildERC3009CollectorData(payload)
		if err != nil {
			return common.Address{}, nil, err
		}
		return common.HexToAddress(batched.ERC3009DepositCollectorAddress), data, nil
	case batched.AssetTransferMethodPermit2:
		auth := payload.Deposit.Authorization.Permit2Authorization
		if auth == nil {
			return common.Address{}, nil, fmt.Errorf("no Permit2 authorization provided")
		}
		var data []byte
		var err error
		if branch != nil {
			data = branch.collectorData
		} else {
			data, err = batched.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, nil)
			if err != nil {
				return common.Address{}, nil, err
			}
		}
		return common.HexToAddress(batched.Permit2DepositCollectorAddress), data, nil
	default:
		return common.Address{}, nil, fmt.Errorf("unsupported assetTransferMethod: %s", method)
	}
}

// verifyErc3009DepositAuthorization validates the time window and signature on
// an ERC-3009 ReceiveWithAuthorization. Returns ("invalidReason", nil) when the
// authorization is well-formed but invalid, ("", err) when an RPC/parse error
// blocked verification entirely, or ("", nil) when the authorization is valid.
func verifyErc3009DepositAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	config batched.ChannelConfig,
	channelId string,
	depositAmount *big.Int,
	auth *batched.BatchedErc3009Authorization,
	chainId *big.Int,
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
	erc3009Nonce, err := batched.BuildErc3009DepositNonce(channelId, auth.Salt)
	if err != nil {
		return "", x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("failed to derive ERC-3009 nonce: %s", err))
	}
	valid, err := verifyReceiveWithAuthorization(
		ctx, signer, config.Payer, config.Token, depositAmount,
		validAfter, validBefore, erc3009Nonce, auth.Signature, chainId,
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
// Mirrors TS Permit2 reason codes: token mismatch, spender mismatch, deadline
// expired, amount mismatch, signature invalid each map to a dedicated error
// string so cross-SDK clients see the same machine-readable failure cause.
func verifyPermit2DepositAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	config batched.ChannelConfig,
	channelId string,
	depositAmount *big.Int,
	auth *batched.BatchedPermit2Authorization,
	chainId *big.Int,
) (string, error) {
	if !strings.EqualFold(auth.Permitted.Token, config.Token) {
		return ErrTokenMismatch, nil
	}
	if !strings.EqualFold(auth.Witness.ChannelId, channelId) {
		return ErrChannelIdMismatch, nil
	}
	if !strings.EqualFold(auth.Spender, batched.Permit2DepositCollectorAddress) {
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
		Name:              batched.Permit2DomainName,
		ChainID:           chainId,
		VerifyingContract: batched.Permit2Address,
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
		batched.BatchPermit2WitnessTypes,
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
