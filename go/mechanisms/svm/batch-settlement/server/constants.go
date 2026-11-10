package server

import batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"

// ChannelBusy is returned when a reservation conflicts with work already in flight.
const ChannelBusy = "duplicate_settlement"

const (
	defaultServerMinDepositMultiplier       uint64 = 10
	defaultServerSignedMinDepositMultiplier uint64 = 3
	assetTransferMethodChannel                     = "channel"
	// maxChannelsPerBatch is the claim and settle capacity when the facilitator advertises none.
	maxChannelsPerBatch = batchsettlement.DefaultBatchChannels
)
