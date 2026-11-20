// Package masumi implements the Cardano exact scheme's Masumi assetTransferMethod:
// the seller-signed terms, the vested_pay escrow datum, the deployment-derived
// escrow address, issuance on the resource server and lock verification on the
// client and facilitator. Every digest and encoding is byte-compatible with the
// TypeScript SDK.
package masumi

import (
	"math"
	"math/big"
	"math/bits"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const (
	// PaymentSourceType is the only Masumi contract generation this scheme targets.
	PaymentSourceType = "Web3CardanoV2"

	// RegistryPolicyID prefixes every non-empty terms.agentIdentifier.
	RegistryPolicyID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b"

	// MinCollateralLovelace is the floor for a non-zero collateral_return_lovelace.
	MinCollateralLovelace uint64 = 1_435_230

	// MinPayToSubmitMs is the minimum gap from pay_by_time to submit_result_time.
	MinPayToSubmitMs int64 = 5 * 60 * 1000
	// MinSubmitToUnlockMs is the minimum gap from submit_result_time to unlock_time.
	MinSubmitToUnlockMs int64 = 15 * 60 * 1000
	// MinUnlockToDisputeMs is the minimum gap from unlock_time to external_dispute_unlock_time.
	MinUnlockToDisputeMs int64 = 15 * 60 * 1000
	// MinSubmitResultLeadMs is the minimum lead from issuance to submit_result_time.
	MinSubmitResultLeadMs int64 = 15 * 60 * 1000

	// MaxDeadlineHorizonMs is the default ceiling on how far past now the last
	// escrow deadline may sit.
	MaxDeadlineHorizonMs int64 = 30 * 24 * 60 * 60 * 1000

	// DefaultMaxCollateralLovelace is the default ceiling on the collateral a
	// client will lock.
	DefaultMaxCollateralLovelace uint64 = 15_000_000

	// StateFundsLocked is the datum state constructor index of a fresh lock.
	StateFundsLocked = 0
)

// Post-SubmitResult min-UTxO headroom, mirroring Masumi's calculateMinUtxo.
const (
	resultHashDeltaBytes = 33
	resultHashBuffer     = 50
	cooldownBuffer       = 15
	minUtxoSafetyMargin  = 100
	perTokenBuffer       = 50
)

// maxCollateralRounds bounds the collateral fixed-point iteration.
const maxCollateralRounds = 4

// DeadlineIntervalsHold reports whether the four escrow deadlines are ordered
// and clear the minimum gaps.
func DeadlineIntervalsHold(payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime *big.Int) bool {
	return gapHolds(payByTime, MinPayToSubmitMs, submitResultTime) &&
		gapHolds(submitResultTime, MinSubmitToUnlockMs, unlockTime) &&
		gapHolds(unlockTime, MinUnlockToDisputeMs, externalDisputeUnlockTime)
}

func gapHolds(from *big.Int, gap int64, to *big.Int) bool {
	sum := new(big.Int).Add(from, big.NewInt(gap))
	return sum.Cmp(to) <= 0
}

// MinUtxoLovelace is the lovelace the escrow output must hold, computed on the
// datum as it will look after SubmitResult, with Masumi's buffers; unlike
// cardano.MinUtxoLovelace it is not the ledger minimum of the output as built.
// The product saturates at MaxUint64.
func MinUtxoLovelace(lockDatumBytes, nativeTokenCount int, coinsPerUtxoByte uint64) uint64 {
	total := uint64(lockDatumBytes) + resultHashDeltaBytes + cardano.MinUtxoOverheadBytes +
		resultHashBuffer + cooldownBuffer + minUtxoSafetyMargin + perTokenBuffer*uint64(nativeTokenCount)
	hi, lo := bits.Mul64(coinsPerUtxoByte, total)
	if hi != 0 {
		return math.MaxUint64
	}
	return lo
}

// CollateralLovelace is the collateral_return_lovelace a lock must carry: zero
// when requestedLovelace already clears the post-result min-UTxO, otherwise the
// larger of the shortfall and MinCollateralLovelace.
func CollateralLovelace(requestedLovelace uint64, lockDatumBytes, nativeTokenCount int, coinsPerUtxoByte uint64) uint64 {
	minUtxo := MinUtxoLovelace(lockDatumBytes, nativeTokenCount, coinsPerUtxoByte)
	if requestedLovelace >= minUtxo {
		return 0
	}
	shortfall := minUtxo - requestedLovelace
	if shortfall > MinCollateralLovelace {
		return shortfall
	}
	return MinCollateralLovelace
}
