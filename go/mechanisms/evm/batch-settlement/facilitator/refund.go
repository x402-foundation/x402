package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

func getRefundableAmount(
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	preState *batchsettlement.ChannelState,
	channelId string,
	network string,
	requestedAmount *big.Int,
) (*big.Int, bool) {
	if preState == nil || preState.Balance == nil || preState.TotalClaimed == nil {
		return nil, false
	}
	if requestedAmount.Sign() == 0 {
		return nil, false
	}

	postClaimTotalClaimed := new(big.Int).Set(preState.TotalClaimed)
	for _, claim := range payload.Claims {
		claimChannelId, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil || !strings.EqualFold(claimChannelId, channelId) {
			continue
		}

		totalClaimed, ok := new(big.Int).SetString(claim.TotalClaimed, 10)
		if !ok {
			return nil, false
		}
		if totalClaimed.Cmp(postClaimTotalClaimed) > 0 {
			postClaimTotalClaimed = totalClaimed
		}
	}
	if postClaimTotalClaimed.Cmp(preState.Balance) > 0 {
		return nil, false
	}

	available := new(big.Int).Sub(preState.Balance, postClaimTotalClaimed)
	if requestedAmount.Cmp(available) > 0 {
		return available, true
	}
	return new(big.Int).Set(requestedAmount), true
}

// ExecuteRefundWithSignature executes a cooperative refund using receiverAuthorizer signature.
// If RefundAuthorizerSignature or ClaimAuthorizerSignature are absent, the
// authorizerSigner auto-signs them. An optional onClaimed callback receives the row keys that
// emitted Claimed in a bundled claim once the refund confirms.
func ExecuteRefundWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	requirements types.PaymentRequirements,
	authorizerSigner batchsettlement.AuthorizerSigner,
	dataSuffix []byte,
	onClaimed ...OnClaimedRows,
) (*x402.SettleResponse, error) {
	return executeRefundWithSignature(ctx, signer, payload, requirements, authorizerSigner, dataSuffix, firstOnClaimed(onClaimed), nil, nil)
}

func executeRefundWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	requirements types.PaymentRequirements,
	authorizerSigner batchsettlement.AuthorizerSigner,
	dataSuffix []byte,
	onClaimed OnClaimedRows,
	store x402.PendingSettlementStore,
	preState *onchainChannelState,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	refundAmount, ok := new(big.Int).SetString(payload.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid refund amount: %s", payload.Amount))
	}

	nonce, ok := new(big.Int).SetString(payload.RefundNonce, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid nonce: %s", payload.RefundNonce))
	}

	// Resolve refund authorizer signature — auto-sign if absent
	var refundSig []byte
	if payload.RefundAuthorizerSignature != "" {
		var err error
		refundSig, err = evm.HexToBytes(payload.RefundAuthorizerSignature)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("invalid refund authorizer signature: %s", err))
		}
	} else {
		if authorizerSigner == nil {
			return nil, x402.NewSettleError(ErrAuthorizerNotConfigured, "", network, "",
				"no refund authorizer signature in payload and no authorizer signer configured")
		}
		// Verify authorizer address matches config's receiverAuthorizer
		if !strings.EqualFold(payload.ChannelConfig.ReceiverAuthorizer, authorizerSigner.Address()) {
			return nil, x402.NewSettleError(ErrAuthorizerAddressMismatch, "", network, "",
				fmt.Sprintf("config receiverAuthorizer %s does not match authorizerSigner %s",
					payload.ChannelConfig.ReceiverAuthorizer, authorizerSigner.Address()))
		}
		channelId, err := batchsettlement.ComputeChannelId(payload.ChannelConfig, string(network))
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to compute channel id: %s", err))
		}
		refundSig, err = authorizerSigner.SignRefund(ctx, channelId, payload.Amount, payload.RefundNonce, string(network))
		if err != nil {
			return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
				fmt.Sprintf("failed to sign refund: %s", err))
		}
	}

	configTuple := ToContractChannelConfig(payload.ChannelConfig)

	// Compute the canonical channel id once — used for ABI encoding,
	// pre/post-state reads, and the response Extra.channelState.
	channelId, err := batchsettlement.ComputeChannelId(payload.ChannelConfig, string(network))
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, payload.ChannelConfig.Payer, network, "",
			fmt.Sprintf("failed to compute channel id: %s", err))
	}

	refundKey := refundSettlementCacheKey(channelId, payload.RefundNonce)

	preState, err = refundPreState(ctx, signer, channelId, payload.ChannelConfig.Payer, network, preState)
	if err != nil {
		return nil, err
	}
	if refundableAmount, ok := getRefundableAmount(payload, &preState.ChannelState, channelId, string(network), refundAmount); ok && refundableAmount.Sign() == 0 {
		return &x402.SettleResponse{ //nolint:nilerr // no-op refund -> error encoded in response
			Success:      false,
			ErrorReason:  ErrRefundNoBalance,
			ErrorMessage: "Nothing to refund",
			Transaction:  "",
			Network:      network,
		}, nil
	}

	// Handle claims + refund atomically if claims are present
	if len(payload.Claims) > 0 {
		claimArgs, err := buildVoucherClaimArgs(payload.Claims)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "", err.Error())
		}
		var claimSig []byte
		if payload.ClaimAuthorizerSignature != "" {
			claimSig, err = evm.HexToBytes(payload.ClaimAuthorizerSignature)
			if err != nil {
				return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
					fmt.Sprintf("invalid claim authorizer signature: %s", err))
			}
		} else {
			if authorizerSigner == nil {
				return nil, x402.NewSettleError(ErrAuthorizerNotConfigured, "", network, "",
					"no claim authorizer signature in payload and no authorizer signer configured")
			}
			claimSig, err = authorizerSigner.SignClaimBatch(ctx, payload.Claims, string(network))
			if err != nil {
				return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
					fmt.Sprintf("failed to sign claim batch for refund: %s", err))
			}
		}

		// ABI-encode both calls for multicall.
		claimAbi, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementClaimWithSignatureABI)))
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to load claim ABI: %s", err))
		}
		claimCalldata, err := claimAbi.Pack("claimWithSignature", claimArgs, claimSig)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to encode claim calldata: %s", err))
		}

		refundAbi, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementRefundWithSignatureABI)))
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to load refund ABI: %s", err))
		}
		refundCalldata, err := refundAbi.Pack("refundWithSignature", configTuple, refundAmount, nonce, refundSig)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to encode refund calldata: %s", err))
		}

		// Simulate via readContract
		_, simErr := signer.ReadContract(
			ctx,
			batchsettlement.BatchSettlementAddress,
			batchsettlement.BatchSettlementMulticallABI,
			"multicall",
			[][]byte{claimCalldata, refundCalldata},
		)
		if simErr != nil {
			return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
				Success:      false,
				ErrorReason:  ErrRefundSimulationFailed,
				ErrorMessage: simErr.Error(),
				Transaction:  "",
				Network:      network,
			}, nil
		}

		txHash, err := signer.WriteContract(
			ctx,
			batchsettlement.BatchSettlementAddress,
			batchsettlement.BatchSettlementMulticallABI,
			"multicall",
			dataSuffix,
			[][]byte{claimCalldata, refundCalldata},
		)
		if err != nil {
			return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
				fmt.Sprintf("multicall (claim+refund) transaction failed: %s", err))
		}
		receipt, err := evm.WaitForSettleReceiptWithPendingStore(ctx, store, refundKey, signer, txHash, payload.ChannelConfig.Payer, network,
			ErrRefundTransactionFailed, ErrTransactionReverted)
		if err != nil {
			return nil, err
		}
		notifyClaimed(onClaimed, receipt)

		return finishRefundAfterReceipt(payload, channelId, preState, nonce, txHash, network, receipt), nil
	}

	// No claims — direct refundWithSignature

	// Simulate
	_, simErr := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementRefundWithSignatureABI,
		"refundWithSignature",
		configTuple,
		refundAmount,
		nonce,
		refundSig,
	)
	if simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:      false,
			ErrorReason:  ErrRefundSimulationFailed,
			ErrorMessage: simErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementRefundWithSignatureABI,
		"refundWithSignature",
		dataSuffix,
		configTuple,
		refundAmount,
		nonce,
		refundSig,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
			fmt.Sprintf("refundWithSignature transaction failed: %s", err))
	}
	receipt, err := evm.WaitForSettleReceiptWithPendingStore(ctx, store, refundKey, signer, txHash, payload.ChannelConfig.Payer, network,
		ErrRefundTransactionFailed, ErrTransactionReverted)
	if err != nil {
		return nil, err
	}

	return finishRefundAfterReceipt(payload, channelId, preState, nonce, txHash, network, receipt), nil
}

// refundSettlementCacheKey keys a refund in the PendingSettlementStore. Every refund
// consumes the channel's refundNonce, so channel and nonce identify one refund whatever
// amount a retry recomputes.
func refundSettlementCacheKey(channelId, refundNonce string) string {
	return "batch-settlement-refund:" + strings.ToLower(channelId) + ":" + refundNonce
}

// pendingRefundTx returns the transaction an earlier attempt recorded for refundKey.
// Store read errors fail closed so a retry cannot broadcast a second direct refund().
func pendingRefundTx(
	ctx context.Context,
	store x402.PendingSettlementStore,
	refundKey string,
	payer string,
	network x402.Network,
) (string, bool, error) {
	if store == nil {
		return "", false, nil
	}
	txHash, hit, err := store.Get(ctx, refundKey)
	if err != nil {
		return "", false, x402.NewSettleError(ErrRefundTransactionFailed, payer, network, "",
			evm.TruncateErrorMessage(fmt.Sprintf("failed to read pending refund store: %s", err)))
	}
	return txHash, hit, nil
}

// reconcilePendingRefund resolves txHash, a refund an earlier attempt broadcast but could not
// confirm. The entry stays while the refund is settlement_pending, so a concurrent retry waits
// on the same transaction: a second direct refund() broadcast would refund again. That
// attempt's pre-state is gone, so the refund stays pending until a read shows the consumed
// refund nonce advanced.
func reconcilePendingRefund(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	store x402.PendingSettlementStore,
	refundKey string,
	input SubmitRefundInput,
	channelId string,
	txHash string,
) (resp *x402.SettleResponse, err error) {
	defer func() {
		var settleErr *x402.SettleError
		if errors.As(err, &settleErr) && settleErr.ErrorReason == ErrSettlementPending {
			return
		}
		_ = store.Delete(ctx, refundKey)
	}()

	network := x402.Network(input.Network)
	payer := input.Payload.ChannelConfig.Payer
	receipt, err := evm.WaitForSettleReceipt(ctx, signer, txHash, payer, network, ErrRefundTransactionFailed, ErrTransactionReverted)
	if err != nil {
		return nil, err
	}
	notifyClaimed(input.OnClaimed, receipt)

	refunded, failed := refundedAmount(receipt, channelId, txHash, network)
	if failed != nil {
		return failed, nil
	}

	consumedNonce, _ := new(big.Int).SetString(input.Payload.RefundNonce, 10)
	state, readErr := ReadChannelState(ctx, signer, channelId)
	if readErr != nil || (consumedNonce != nil && state.RefundNonce.Cmp(consumedNonce) <= 0) {
		return nil, x402.NewSettleError(ErrSettlementPending, payer, network, txHash,
			"refund confirmed but the channel state is not visible yet")
	}
	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       payer,
		Amount:      refunded.String(),
		Extra:       BuildSettleExtra(channelId, state),
	}, nil
}

func refundPreState(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	channelId string,
	payer string,
	network x402.Network,
	preState *onchainChannelState,
) (*onchainChannelState, error) {
	if preState != nil {
		return preState, nil
	}
	state, err := readOnchainChannelState(ctx, signer, channelId)
	if err != nil {
		return nil, x402.NewSettleError(ErrRpcReadFailed, payer, network, "",
			fmt.Sprintf("failed to read channel state: %s", err))
	}
	return state, nil
}

func finishRefundAfterReceipt(
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	channelId string,
	preState *onchainChannelState,
	consumedNonce *big.Int,
	txHash string,
	network x402.Network,
	receipt *evm.TransactionReceipt,
) *x402.SettleResponse {
	refunded, failed := refundedAmount(receipt, channelId, txHash, network)
	if failed != nil {
		return failed
	}
	// Claimed is emitted only when totalClaimed rises, so the channel's last event is the new total.
	var claimedTotal *big.Int
	if logs := claimedLogs(receipt, channelId); len(logs) > 0 {
		claimedTotal = logs[len(logs)-1].newTotalClaimed
	}
	state := deriveRefundState(preState, refunded, claimedTotal, consumedNonce)
	if bal, ok := eventRefundBalance(receipt, channelId); ok {
		state.Balance = bal
	}
	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       payload.ChannelConfig.Payer,
		Amount:      refunded.String(),
		Extra:       BuildSettleExtra(channelId, state),
	}
}

func refundedAmount(
	receipt *evm.TransactionReceipt,
	channelId string,
	txHash string,
	network x402.Network,
) (*big.Int, *x402.SettleResponse) {
	if receipt.Logs == nil {
		return nil, &x402.SettleResponse{
			Success:      false,
			ErrorReason:  ErrReceiptLogsUnavailable,
			ErrorMessage: receiptLogsUnavailableMessage,
			Transaction:  txHash,
			Network:      network,
		}
	}
	if logs := refundedLogs(receipt, channelId); len(logs) > 0 {
		if amount := logs[0].amount; amount != nil && amount.Sign() > 0 {
			return amount, nil
		}
	}
	return nil, &x402.SettleResponse{
		Success:      false,
		ErrorReason:  ErrRefundedEventMismatch,
		ErrorMessage: "refund receipt missing Refunded event with positive amount (possible no-op early return)",
		Transaction:  txHash,
		Network:      network,
	}
}

// deriveRefundState derives the post-refund channel state from the receipt events and the
// pre-transaction state, following the contract's _executeRefund.
//
// Refunded carries no post-refund balance. A same-receipt Deposited.newBalance replaces the
// result via eventRefundBalance. Otherwise balance is the pre-read minus the refund, and a
// negative result is omitted: clamping it to 0 deletes a channel a deposit already funded.
// withdrawRequestedAt misses a withdrawal initiated in that window, and without a bundled
// claim totalClaimed is a lower bound.
func deriveRefundState(
	preState *onchainChannelState,
	refunded *big.Int,
	claimedTotal *big.Int,
	consumedNonce *big.Int,
) *batchsettlement.ChannelState {
	var balance *big.Int
	if preState.Balance != nil && refunded != nil {
		balance = new(big.Int).Sub(preState.Balance, refunded)
		if balance.Sign() < 0 {
			balance = nil
		}
	}
	totalClaimed := preState.TotalClaimed
	if claimedTotal != nil {
		totalClaimed = claimedTotal
	}
	withdrawRequestedAt := preState.WithdrawRequestedAt
	if refunded.Cmp(preState.withdrawAmount) >= 0 {
		withdrawRequestedAt = 0
	}
	return &batchsettlement.ChannelState{
		Balance:             balance,
		TotalClaimed:        totalClaimed,
		WithdrawRequestedAt: withdrawRequestedAt,
		RefundNonce:         new(big.Int).Add(consumedNonce, big.NewInt(1)),
	}
}

// SubmitRefundInput is the network, refund payload, and optional data suffix. OnClaimed, when
// set, receives the row keys that emitted Claimed in a bundled claim once the refund confirms.
type SubmitRefundInput struct {
	Network    string
	Payload    *batchsettlement.BatchSettlementEnrichedRefundPayload
	DataSuffix []byte
	OnClaimed  OnClaimedRows
	cappedRead *onchainChannelState
}

// ExecuteRefund executes a cooperative refund via refund() as msg.sender. An optional onClaimed
// callback receives the row keys that emitted Claimed in a bundled claim once the refund
// confirms.
func ExecuteRefund(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	network string,
	dataSuffix []byte,
	onClaimed ...OnClaimedRows,
) (*x402.SettleResponse, error) {
	return executeRefund(ctx, signer, payload, network, dataSuffix, firstOnClaimed(onClaimed), nil, nil)
}

func executeRefund(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	network string,
	dataSuffix []byte,
	onClaimed OnClaimedRows,
	store x402.PendingSettlementStore,
	preState *onchainChannelState,
) (*x402.SettleResponse, error) {
	reqs := types.PaymentRequirements{Network: network}
	refundAmount, ok := new(big.Int).SetString(payload.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", x402.Network(network), "",
			fmt.Sprintf("invalid refund amount: %s", payload.Amount))
	}
	configTuple := ToContractChannelConfig(payload.ChannelConfig)
	call, err := buildDirectRefundCall(payload, configTuple, refundAmount)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", x402.Network(network), "", err.Error())
	}
	return submitRefundCall(ctx, signer, payload, reqs, call.abiJSON, call.functionName, call.args, dataSuffix, refundAmount, onClaimed, store, preState)
}

// SubmitRefund dispatches a refund through the relay or direct submit path, or reconciles
// the transaction an earlier attempt recorded as pending for the same refund.
// A payload that already has an authorizer signature always uses the relay
// functions. Otherwise SubmitMode selects the path ("relay" when omitted).
func SubmitRefund(ctx context.Context, input SubmitRefundInput, submitCtx SubmitContext) (*x402.SettleResponse, error) {
	channelId, err := batchsettlement.ComputeChannelId(input.Payload.ChannelConfig, input.Network)
	if err != nil {
		return submitRefund(ctx, input, submitCtx)
	}
	refundKey := refundSettlementCacheKey(channelId, input.Payload.RefundNonce)
	txHash, pending, err := pendingRefundTx(ctx, submitCtx.PendingStore, refundKey, input.Payload.ChannelConfig.Payer, x402.Network(input.Network))
	if err != nil {
		return nil, err
	}
	if !pending {
		return submitRefund(ctx, input, submitCtx)
	}
	return reconcilePendingRefund(ctx, submitCtx.Signer, submitCtx.PendingStore, refundKey, input, channelId, txHash)
}

func submitRefund(ctx context.Context, input SubmitRefundInput, submitCtx SubmitContext) (*x402.SettleResponse, error) {
	hasAuthorizerSignature := input.Payload.RefundAuthorizerSignature != "" || input.Payload.ClaimAuthorizerSignature != ""
	reqs := types.PaymentRequirements{Network: input.Network}
	if ShouldRelaySubmit(submitCtx.SubmitMode, hasAuthorizerSignature) {
		return executeRefundWithSignature(ctx, submitCtx.Signer, input.Payload, reqs, submitCtx.AuthorizerSigner, input.DataSuffix, input.OnClaimed, submitCtx.PendingStore, input.cappedRead)
	}
	if submitCtx.AuthorizerSubmitter == nil {
		return &x402.SettleResponse{
			Success:     false,
			ErrorReason: ErrAuthorizerNotConfigured,
			Transaction: "",
			Network:     x402.Network(input.Network),
		}, nil
	}
	return executeRefund(ctx, submitCtx.AuthorizerSubmitter, input.Payload, input.Network, input.DataSuffix, input.OnClaimed, submitCtx.PendingStore, input.cappedRead)
}

type refundCall struct {
	functionName string
	abiJSON      []byte
	args         []interface{}
}

func buildDirectRefundCall(
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	configTuple ContractChannelConfigTuple,
	refundAmount *big.Int,
) (refundCall, error) {
	if len(payload.Claims) == 0 {
		return refundCall{
			functionName: "refund",
			abiJSON:      batchsettlement.BatchSettlementRefundABI,
			args:         []interface{}{configTuple, refundAmount},
		}, nil
	}

	claimAbi, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementClaimABI)))
	if err != nil {
		return refundCall{}, fmt.Errorf("failed to load claim ABI: %s", err)
	}
	claimArgs, err := buildVoucherClaimArgs(payload.Claims)
	if err != nil {
		return refundCall{}, err
	}
	claimCalldata, err := claimAbi.Pack("claim", claimArgs)
	if err != nil {
		return refundCall{}, fmt.Errorf("failed to encode claim calldata: %s", err)
	}

	refundAbi, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementRefundABI)))
	if err != nil {
		return refundCall{}, fmt.Errorf("failed to load refund ABI: %s", err)
	}
	refundCalldata, err := refundAbi.Pack("refund", configTuple, refundAmount)
	if err != nil {
		return refundCall{}, fmt.Errorf("failed to encode refund calldata: %s", err)
	}
	return refundCall{
		functionName: "multicall",
		abiJSON:      batchsettlement.BatchSettlementMulticallABI,
		args:         []interface{}{[][]byte{claimCalldata, refundCalldata}},
	}, nil
}

func submitRefundCall(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	requirements types.PaymentRequirements,
	abiJSON []byte,
	functionName string,
	args []interface{},
	dataSuffix []byte,
	refundAmount *big.Int,
	onClaimed OnClaimedRows,
	store x402.PendingSettlementStore,
	preState *onchainChannelState,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)
	channelId, err := batchsettlement.ComputeChannelId(payload.ChannelConfig, string(network))
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, payload.ChannelConfig.Payer, network, "",
			fmt.Sprintf("failed to compute channel id: %s", err))
	}
	refundKey := refundSettlementCacheKey(channelId, payload.RefundNonce)
	preState, err = refundPreState(ctx, signer, channelId, payload.ChannelConfig.Payer, network, preState)
	if err != nil {
		return nil, err
	}
	if refundableAmount, ok := getRefundableAmount(payload, &preState.ChannelState, channelId, string(network), refundAmount); ok && refundableAmount.Sign() == 0 {
		return &x402.SettleResponse{ //nolint:nilerr // no-op refund -> error encoded in response
			Success:      false,
			ErrorReason:  ErrRefundNoBalance,
			ErrorMessage: "Nothing to refund",
			Transaction:  "",
			Network:      network,
		}, nil
	}

	if _, simErr := signer.ReadContract(ctx, batchsettlement.BatchSettlementAddress, abiJSON, functionName, args...); simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:      false,
			ErrorReason:  ErrRefundSimulationFailed,
			ErrorMessage: simErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}

	txHash, err := signer.WriteContract(ctx, batchsettlement.BatchSettlementAddress, abiJSON, functionName, dataSuffix, args...)
	if err != nil {
		return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
			fmt.Sprintf("%s transaction failed: %s", functionName, err))
	}
	receipt, err := evm.WaitForSettleReceiptWithPendingStore(ctx, store, refundKey, signer, txHash, payload.ChannelConfig.Payer, network,
		ErrRefundTransactionFailed, ErrTransactionReverted)
	if err != nil {
		return nil, err
	}
	notifyClaimed(onClaimed, receipt)
	// Direct refund() consumes whatever nonce is onchain, so it advances the pre-read nonce.
	return finishRefundAfterReceipt(payload, channelId, preState, preState.RefundNonce, txHash, network, receipt), nil
}
