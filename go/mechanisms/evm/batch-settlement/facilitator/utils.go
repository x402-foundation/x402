package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

var zeroAddress = "0x0000000000000000000000000000000000000000"

// channelStateRereadDelays are the waits between the voucher channel-state re-reads
// (readChannelStateCovering), which wait out a lagging RPC node when the balance cannot cover
// the voucher. Each entry adds one read, and an uncovered voucher pays all of them, so keep the
// list short.
var channelStateRereadDelays = []time.Duration{150 * time.Millisecond, 400 * time.Millisecond, time.Second}

var (
	depositedEvent abi.Event
	claimedEvent   abi.Event
	refundedEvent  abi.Event
)

func init() {
	depositedEvent = mustParseEvent(batchsettlement.BatchSettlementDepositedEventABI, "Deposited")
	claimedEvent = mustParseEvent(batchsettlement.BatchSettlementClaimedEventABI, "Claimed")
	refundedEvent = mustParseEvent(batchsettlement.BatchSettlementRefundedEventABI, "Refunded")
}

func mustParseEvent(abiJSON []byte, name string) abi.Event {
	parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		panic(err)
	}
	event, ok := parsed.Events[name]
	if !ok {
		panic("missing event " + name)
	}
	return event
}

// channelEvents decodes the non-indexed values of each event the batch-settlement contract
// emitted for channelId, in log order. Logs from other emitters are ignored, so another
// contract in the same transaction cannot forge an event for the channel.
func channelEvents(receipt *evm.TransactionReceipt, event abi.Event, channelId string) [][]interface{} {
	contract := common.HexToAddress(batchsettlement.BatchSettlementAddress)
	want := common.HexToHash(channelId)
	var out [][]interface{}
	for _, log := range receipt.Logs {
		if log == nil || log.Address != contract || len(log.Topics) < 2 || log.Topics[0] != event.ID || log.Topics[1] != want {
			continue
		}
		values, err := event.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil {
			continue
		}
		out = append(out, values)
	}
	return out
}

// lastClaimedTotal returns newTotalClaimed of the channel's last Claimed event in the receipt.
// A claim only emits Claimed when it raises totalClaimed, so the last event is the highest.
func lastClaimedTotal(receipt *evm.TransactionReceipt, channelId string) (*big.Int, bool) {
	events := channelEvents(receipt, claimedEvent, channelId)
	if len(events) == 0 {
		return nil, false
	}
	total, ok := events[len(events)-1][1].(*big.Int)
	return total, ok
}

// receiptLogsUnavailableMessage explains ErrReceiptLogsUnavailable. An RPC always returns the
// logs field (possibly empty), so a nil Logs means the signer dropped it.
const receiptLogsUnavailableMessage = "signer returned a receipt without logs; batch settlement requires WaitForTransactionReceipt to return receipt logs"

// ContractChannelConfigTuple is the concrete struct shape passed to BatchSettlement
// contract calls (deposit, refund, claim). Field names and ordering match the
// Solidity ChannelConfig struct so go-ethereum's ABI packer can map them by reflection.
type ContractChannelConfigTuple struct {
	Payer              common.Address
	PayerAuthorizer    common.Address
	Receiver           common.Address
	ReceiverAuthorizer common.Address
	Token              common.Address
	WithdrawDelay      *big.Int
	Salt               [32]byte
}

// ToContractChannelConfig normalizes a ChannelConfig into the address-checksummed
// Solidity tuple expected by the batch-settlement contract's deposit / refund /
// claim entry points.
func ToContractChannelConfig(config batchsettlement.ChannelConfig) ContractChannelConfigTuple {
	withdrawDelay := new(big.Int).SetInt64(int64(config.WithdrawDelay))

	saltBytes := common.FromHex(config.Salt)
	var salt [32]byte
	copy(salt[:], saltBytes)

	return ContractChannelConfigTuple{
		Payer:              common.HexToAddress(config.Payer),
		PayerAuthorizer:    common.HexToAddress(config.PayerAuthorizer),
		Receiver:           common.HexToAddress(config.Receiver),
		ReceiverAuthorizer: common.HexToAddress(config.ReceiverAuthorizer),
		Token:              common.HexToAddress(config.Token),
		WithdrawDelay:      withdrawDelay,
		Salt:               salt,
	}
}

// ReadChannelState reads onchain channel state via a 3-call multicall:
// channels(channelId), pendingWithdrawals(channelId), refundNonce(channelId).
// Returns an error tagged with ErrRpcReadFailed when any sub-call fails so
// callers can distinguish RPC failures from a missing channel (which returns
// zero balance/totalClaimed/refundNonce).
func ReadChannelState(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	channelId string,
) (*batchsettlement.ChannelState, error) {
	state, err := readOnchainChannelState(ctx, signer, channelId)
	if err != nil {
		return nil, err
	}
	return &state.ChannelState, nil
}

// onchainChannelState is a ChannelState plus the pending withdrawal amount, which never goes on
// the wire.
type onchainChannelState struct {
	batchsettlement.ChannelState
	withdrawAmount *big.Int
}

func readOnchainChannelState(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	channelId string,
) (*onchainChannelState, error) {
	channelIdBytes := common.HexToHash(channelId)

	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
		{
			Address:      batchsettlement.BatchSettlementAddress,
			ABI:          batchsettlement.BatchSettlementChannelsABI,
			FunctionName: "channels",
			Args:         []interface{}{channelIdBytes},
		},
		{
			Address:      batchsettlement.BatchSettlementAddress,
			ABI:          batchsettlement.BatchSettlementPendingWithdrawalsABI,
			FunctionName: "pendingWithdrawals",
			Args:         []interface{}{channelIdBytes},
		},
		{
			Address:      batchsettlement.BatchSettlementAddress,
			ABI:          batchsettlement.BatchSettlementRefundNonceABI,
			FunctionName: "refundNonce",
			Args:         []interface{}{channelIdBytes},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("multicall failed: %w", err)
	}

	if !results[0].Success() || !results[1].Success() || !results[2].Success() {
		return nil, fmt.Errorf("%s: multicall returned failure for %s", ErrRpcReadFailed, channelId)
	}

	state := &onchainChannelState{
		ChannelState: batchsettlement.ChannelState{
			Balance:      big.NewInt(0),
			TotalClaimed: big.NewInt(0),
			RefundNonce:  big.NewInt(0),
		},
		withdrawAmount: big.NewInt(0),
	}

	// Parse channels result: [balance (uint128), totalClaimed (uint128)]
	if channelResult, ok := results[0].Result.([]interface{}); ok && len(channelResult) >= 2 {
		if bal, ok := channelResult[0].(*big.Int); ok {
			state.Balance = bal
		}
		if tc, ok := channelResult[1].(*big.Int); ok {
			state.TotalClaimed = tc
		}
	}

	// Parse pendingWithdrawals result: [amount (uint128), initiatedAt (uint40)]
	if wdResult, ok := results[1].Result.([]interface{}); ok && len(wdResult) >= 2 {
		if amount, ok := wdResult[0].(*big.Int); ok {
			state.withdrawAmount = amount
		}
		if initiatedAt, ok := wdResult[1].(*big.Int); ok {
			state.WithdrawRequestedAt = int(initiatedAt.Int64())
		}
	}

	// Parse refundNonce result: uint256
	if nonce, ok := results[2].Result.(*big.Int); ok {
		state.RefundNonce = nonce
	}

	return state, nil
}

// readChannelStateCovering reads channel state, re-reading after each channelStateRereadDelays
// wait while the balance is below minBalance. A balance that cannot cover the voucher is either
// a lagging RPC node or a real shortfall; after the last wait the last read is returned and
// treated as real. A zero minBalance is raised to 1 so an empty channel also re-reads. Read
// errors return at once.
func readChannelStateCovering(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	channelId string,
	minBalance *big.Int,
) (*batchsettlement.ChannelState, error) {
	floor := minBalance
	if floor.Sign() <= 0 {
		floor = big.NewInt(1)
	}
	state, err := ReadChannelState(ctx, signer, channelId)
	for _, delay := range channelStateRereadDelays {
		if err != nil || state.Balance.Cmp(floor) >= 0 {
			break
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		state, err = ReadChannelState(ctx, signer, channelId)
	}
	return state, err
}

// parseRequirementsAmount parses the server-supplied requirements.Amount as a non-negative
// base-10 integer. The amount comes from the resource server, so the facilitator must not trust
// it: signs, whitespace, and other non-digit forms are rejected (a negative value would lower
// the minimum-advance floor).
func parseRequirementsAmount(amount string) (*big.Int, bool) {
	if amount == "" {
		return nil, false
	}
	for i := 0; i < len(amount); i++ {
		if amount[i] < '0' || amount[i] > '9' {
			return nil, false
		}
	}
	return new(big.Int).SetString(amount, 10)
}

// ValidateChannelConfig validates a ChannelConfig against payment requirements.
func ValidateChannelConfig(
	config batchsettlement.ChannelConfig,
	channelId string,
	requirements types.PaymentRequirements,
) error {
	// Validate receiver matches
	if !strings.EqualFold(config.Receiver, requirements.PayTo) {
		return x402.NewVerifyError(ErrReceiverMismatch, "",
			fmt.Sprintf("channel receiver %s does not match payTo %s", config.Receiver, requirements.PayTo))
	}

	// Validate token matches
	if !strings.EqualFold(config.Token, requirements.Asset) {
		return x402.NewVerifyError(ErrTokenMismatch, "",
			fmt.Sprintf("channel token %s does not match asset %s", config.Token, requirements.Asset))
	}

	// Validate withdraw delay bounds
	if config.WithdrawDelay < batchsettlement.MinWithdrawDelay {
		return x402.NewVerifyError(ErrWithdrawDelayOutOfRange, "",
			fmt.Sprintf("withdrawDelay %d is below minimum %d", config.WithdrawDelay, batchsettlement.MinWithdrawDelay))
	}
	if config.WithdrawDelay > batchsettlement.MaxWithdrawDelay {
		return x402.NewVerifyError(ErrWithdrawDelayOutOfRange, "",
			fmt.Sprintf("withdrawDelay %d exceeds maximum %d", config.WithdrawDelay, batchsettlement.MaxWithdrawDelay))
	}

	// Validate channelId matches computed
	computed, err := batchsettlement.ComputeChannelId(config, requirements.Network)
	if err != nil {
		return x402.NewVerifyError(ErrChannelIdMismatch, "", fmt.Sprintf("failed to compute channel id: %s", err))
	}
	if !strings.EqualFold(computed, channelId) {
		return x402.NewVerifyError(ErrChannelIdMismatch, "",
			fmt.Sprintf("computed channelId %s does not match provided %s", computed, channelId))
	}

	// Validate against the requirement's `extra` map. Only `receiverAuthorizer`
	// and `withdrawDelay` participate in this check — other fields
	// (`name` / `version` / `assetTransferMethod`) are consumed elsewhere or
	// only exist to round-trip to the client, so they don't need to be
	// decoded here.
	//
	// receiverAuthorizer is mandatory and must agree with the channel's bound
	// authorizer.
	expectedAuthorizer, _ := requirements.Extra["receiverAuthorizer"].(string)
	if expectedAuthorizer == "" || strings.EqualFold(expectedAuthorizer, zeroAddress) ||
		!strings.EqualFold(config.ReceiverAuthorizer, expectedAuthorizer) {
		return x402.NewVerifyError(ErrReceiverAuthorizerMismatch, "",
			fmt.Sprintf("channel receiverAuthorizer %s does not match required %s",
				config.ReceiverAuthorizer, expectedAuthorizer))
	}
	if requirements.Extra != nil {
		var expectedDelay int
		switch v := requirements.Extra["withdrawDelay"].(type) {
		case float64:
			expectedDelay = int(v)
		case int:
			expectedDelay = v
		case int64:
			expectedDelay = int(v)
		}
		if expectedDelay != 0 && config.WithdrawDelay != expectedDelay {
			return x402.NewVerifyError(ErrWithdrawDelayMismatch, "",
				fmt.Sprintf("channel withdrawDelay %d does not match required %d",
					config.WithdrawDelay, expectedDelay))
		}
	}

	return nil
}

// VerifyBatchedVoucherTypedData verifies a voucher signature using dual-path verification.
// If payerAuthorizer != 0x0: ECDSA verification against payerAuthorizer (fast, stateless).
// If payerAuthorizer == 0x0: ERC-1271 verification against payer (smart wallet path).
func VerifyBatchedVoucherTypedData(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	channelId string,
	maxClaimableAmount string,
	payerAuthorizer string,
	payer string,
	signature string,
	chainId *big.Int,
) (bool, error) {
	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)

	maxClaimable, ok := new(big.Int).SetString(maxClaimableAmount, 10)
	if !ok {
		return false, fmt.Errorf("invalid maxClaimableAmount: %s", maxClaimableAmount)
	}

	channelIdBytes, err := evm.HexToBytes(channelId)
	if err != nil {
		return false, fmt.Errorf("invalid channelId: %w", err)
	}

	sigBytes, err := evm.HexToBytes(signature)
	if err != nil {
		return false, fmt.Errorf("invalid signature: %w", err)
	}

	message := map[string]interface{}{
		"channelId":          channelIdBytes,
		"maxClaimableAmount": maxClaimable,
	}

	// If payerAuthorizer is non-zero, verify via pure ECDSA against payerAuthorizer.
	// On-chain x402BatchSettlement uses ECDSA.recoverCalldata for the payerAuthorizer
	// path regardless of code at that address — mirror that exactly.
	if payerAuthorizer != zeroAddress && payerAuthorizer != "" {
		if !batchsettlement.IsContractRecoverableSignature(sigBytes) {
			return false, nil
		}
		return evm.VerifyEOATypedData(
			payerAuthorizer,
			domain,
			batchsettlement.VoucherTypes,
			"Voucher",
			message,
			sigBytes,
		)
	}

	// payerAuthorizer == 0: on-chain uses OZ SignatureChecker.isValidSignatureNow(payer, …)
	// which is code-routed. Use the strict primitive to match that.
	digest, err := evm.HashEIP712TypedData(domain, batchsettlement.VoucherTypes, "Voucher", message)
	if err != nil {
		return false, err
	}
	code, err := signer.GetCode(ctx, payer)
	if err != nil {
		return false, fmt.Errorf("GetCode failed: %w", err)
	}
	if len(code) == 0 && !batchsettlement.IsContractRecoverableSignature(sigBytes) {
		return false, nil
	}
	return evm.VerifySignatureStrictWithCode(ctx, signer, payer, digest, sigBytes, code)
}

// channelStateFields builds the shared field set used by both verify and
// settle response extras: { channelId, balance, totalClaimed,
// withdrawRequestedAt, refundNonce }. It does not include
// `chargedCumulativeAmount` because the resource server adds that field during
// settlement-response enrichment; the additive enrichment policy rejects
// duplicates emitted by the facilitator.
func channelStateFields(channelId string, state *batchsettlement.ChannelState) map[string]interface{} {
	return map[string]interface{}{
		"channelId":           channelId,
		"balance":             state.Balance.String(),
		"totalClaimed":        state.TotalClaimed.String(),
		"withdrawRequestedAt": state.WithdrawRequestedAt,
		"refundNonce":         state.RefundNonce.String(),
	}
}

// BuildVerifyExtra creates the Extensions map for VERIFY responses:
//
//	{ channelId, balance, totalClaimed, withdrawRequestedAt, refundNonce }
//
// Server-side `AfterVerifyHook` reads these fields directly off `extra` (e.g.
// `extra["balance"]`); wrapping them in `channelState` like the settle
// response would silently break state tracking.
func BuildVerifyExtra(channelId string, state *batchsettlement.ChannelState) map[string]interface{} {
	return channelStateFields(channelId, state)
}

// BuildSettleExtra creates the Extensions map for SETTLE responses:
//
//	{ "channelState": { channelId, balance, totalClaimed, withdrawRequestedAt,
//	                    refundNonce } }
//
// Server-side `AfterSettleHook` reads `extra.channelState.*` and the resource
// server's `enrichSettlementResponse` hook then adds `chargedCumulativeAmount`
// (and, for deposits, `chargedAmount`) on top via additive enrichment.
func BuildSettleExtra(channelId string, state *batchsettlement.ChannelState) map[string]interface{} {
	return map[string]interface{}{
		"channelState": channelStateFields(channelId, state),
	}
}

// Erc3009AuthorizationTimeInvalidReason checks the validity window of an ERC-3009 authorization.
// Returns an error code string if invalid, or empty string if valid.
func Erc3009AuthorizationTimeInvalidReason(validAfter, validBefore *big.Int) string {
	now := big.NewInt(currentTimestamp())
	nowPlusBuffer := new(big.Int).Add(now, big.NewInt(6))

	if validBefore.Cmp(nowPlusBuffer) < 0 {
		return ErrValidBeforeExpired
	}
	if validAfter.Cmp(now) > 0 {
		return ErrValidAfterInFuture
	}
	return ""
}

// currentTimestamp returns the current unix timestamp in seconds.
func currentTimestamp() int64 {
	return time.Now().Unix()
}
