package facilitator

import (
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

const (
	// MaxChannelsPerSettleTx is how many Ed25519-plus-settle pairs fit in one
	// legacy or version-0 transaction. Version 1 redemptions use
	// batchsettlement.V1MaxClaimChannels and V1MaxSettleChannels.
	MaxChannelsPerSettleTx = 4

	// RedemptionComputeUnitsBase and RedemptionComputeUnitsPerChannel size a
	// version-1 redemption's compute unit limit; MaxRedemptionComputeUnits caps it.
	RedemptionComputeUnitsBase       = 25_000
	RedemptionComputeUnitsPerChannel = 25_000
	MaxRedemptionComputeUnits        = 1_400_000

	// ChannelReadAttempts is how many times a post-broadcast channel read retries a transient RPC failure.
	ChannelReadAttempts = 5

	// ChannelReadInitialBackoff is the first delay before retrying a channel read. Later attempts double it.
	ChannelReadInitialBackoff = 200 * time.Millisecond

	// BindingHistoryPageLimit is the getSignaturesForAddress page size. RPC rejects a limit above this.
	BindingHistoryPageLimit = 1000

	// ChannelBusy is reported when a channel is already mid-operation.
	ChannelBusy = "duplicate_settlement"

	// ReservationTTL is how long a broadcast reservation is held: the blockhash
	// lifetime plus a grace period. Once it lapses the chain answers.
	ReservationTTL = svm.SettlementTTL + time.Minute
)

// Rent-cleanup defaults re-exported for batch operators.
const (
	DefaultAbandonGraceSecs   = paymentchannels.DefaultAbandonGraceSecs
	DefaultMaxIdleSecs        = paymentchannels.DefaultMaxIdleSecs
	DefaultMaxReclaimsPerTx   = paymentchannels.DefaultMaxReclaimsPerTx
	DefaultMaxReclaimsPerTxV1 = paymentchannels.DefaultMaxReclaimsPerTxV1
	MaxSafeReclaimsPerTx      = paymentchannels.MaxSafeReclaimsPerTx
	DefaultMaxTxsPerRun       = paymentchannels.DefaultMaxTxsPerRun
	DefaultMaxTxsPerSigner    = paymentchannels.DefaultMaxTxsPerSigner
	DefaultMaxClosesPerRun    = paymentchannels.DefaultMaxClosesPerRun
)
