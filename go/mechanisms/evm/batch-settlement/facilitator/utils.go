package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

var zeroAddress = "0x0000000000000000000000000000000000000000"

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

	state := &batchsettlement.ChannelState{
		Balance:      big.NewInt(0),
		TotalClaimed: big.NewInt(0),
		RefundNonce:  big.NewInt(0),
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

	// If payerAuthorizer is non-zero, verify via ECDSA against payerAuthorizer
	if payerAuthorizer != zeroAddress && payerAuthorizer != "" {
		return signer.VerifyTypedData(
			ctx,
			payerAuthorizer,
			domain,
			batchsettlement.VoucherTypes,
			"Voucher",
			message,
			sigBytes,
		)
	}

	// Otherwise, verify via ERC-1271 against payer (smart wallet)
	return signer.VerifyTypedData(
		ctx,
		payer,
		domain,
		batchsettlement.VoucherTypes,
		"Voucher",
		message,
		sigBytes,
	)
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
