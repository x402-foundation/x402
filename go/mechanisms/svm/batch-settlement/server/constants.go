package server

// ChannelBusy is returned when a reservation conflicts with work already in flight.
const ChannelBusy = "duplicate_settlement"

const (
	defaultServerMinDepositMultiplier       uint64 = 10
	defaultServerSignedMinDepositMultiplier uint64 = 3
	assetTransferMethodChannel                     = "channel"
	maxChannelsPerBatch                            = 4
)
