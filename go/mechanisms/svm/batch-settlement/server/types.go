package server

import batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"

const (
	// ChannelStatusOpen is a channel that can still accept vouchers.
	ChannelStatusOpen = "open"
	// ChannelStatusClosing is a channel whose payer has started a forced close.
	ChannelStatusClosing = "closing"
	// ChannelStatusDistributed is a channel that has been paid out.
	ChannelStatusDistributed = "distributed"
)

const (
	reservationKindClient = "client"
	reservationKindServer = "server"
	reservationKindClose  = "close"
)

// ChannelReservation is a ceiling held while a verified handler runs.
type ChannelReservation struct {
	Ceiling   uint64
	ExpiresAt int64
	RequestID string
	Kind      string
}

// ChannelState is the server-held record for one channel, keyed by channel id.
type ChannelState struct {
	ChannelID               string
	Payer                   string
	Receiver                string
	FeePayer                string
	Mint                    string
	TokenProgram            string
	PayerAuthorizer         string
	ReceiverAuthorizer      string
	WithdrawDelay           int
	Salt                    uint64
	OpenSlot                uint64
	Deposit                 uint64
	ChargedCumulativeAmount uint64
	SignedMaxClaimable      uint64
	Settled                 uint64
	PayoutWatermark         uint64
	OnchainSyncedAt         int64
	Status                  string
	CloseRequestedAt        int64
	HighestVoucherSignature string
	HighestVoucherExpiresAt int64
	ChannelConfig           batchsettlement.BatchChannelConfig
	OpenSignature           string
	CloseSignature          string
	Reservations            map[string]ChannelReservation
}

// ChannelStore persists channel records. Update is atomic per channel.
// List is optional: a store that only serves requests does not implement channelLister.
type ChannelStore interface {
	Get(channelID string) (*ChannelState, error)
	Put(state ChannelState) error
	Update(channelID string, updater func(current *ChannelState) (ChannelState, error)) (ChannelState, error)
}

// channelLister is implemented by stores a redemption worker can enumerate.
type channelLister interface {
	List() ([]ChannelState, error)
}

// RequestContext is the per-request bookkeeping kept from verify until settle.
type RequestContext struct {
	ChannelID               string
	Proof                   *batchsettlement.BatchProof
	Cumulative              *uint64
	Ceiling                 *uint64
	RequestID               string
	PendingID               string
	TopUp                   bool
	RequiresCumulativeCheck bool
}

// VerifiedChannelState is a channel snapshot a facilitator confirmed against the chain.
type VerifiedChannelState struct {
	ChannelID           *string
	Balance             *uint64
	TotalClaimed        uint64
	WithdrawRequestedAt int64
}

// BatchOperation is a single-use server-mode request record.
type BatchOperation struct {
	Status     string
	ChannelID  string
	RequestID  string
	Ceiling    uint64
	Actual     uint64
	Cumulative uint64
}

const (
	operationReserved  = "reserved"
	operationCompleted = "completed"
)

// ReserveResult is the outcome of trying to reserve one request id.
type ReserveResult struct {
	Created   bool
	Operation BatchOperation
}

// BatchOperationStore tracks server-mode request ids separately from channel accounting.
type BatchOperationStore interface {
	Get(channelID, requestID string) (*BatchOperation, error)
	Reserve(channelID, requestID string, ceiling uint64) (ReserveResult, error)
	Complete(operation BatchOperation) error
	Release(channelID, requestID string) error
}
