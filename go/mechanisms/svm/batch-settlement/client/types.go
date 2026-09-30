package client

import (
	"encoding/json"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
)

// BatchClientChannelStorage persists a confirmed allocation and any replayable
// pending payment so a restart can resume the same channel.
type BatchClientChannelStorage interface {
	Get(key string) (*BatchClientChannelRecord, error)
	Set(key string, record BatchClientChannelRecord) error
	Delete(key string) error
}

// DepositPolicy sizes a deposit when DepositAmount is unset.
type DepositPolicy struct {
	DepositMultiplier *int
}

// BatchSvmClientConfig configures the batch-settlement client.
type BatchSvmClientConfig struct {
	RPCURL string
	// DepositAmount is a fixed deposit or top-up size. It overrides server hints
	// and DepositPolicy. Accepts the same shapes as paymentchannels.ParseU64.
	DepositAmount  any
	DepositPolicy  *DepositPolicy
	ChannelStorage BatchClientChannelStorage
	// Salt derives the channel PDA. Nil uses 0 so a restart reopens the same channel.
	Salt any
	// DiscoverChannels scans for a channel this wallet already opened.
	// Nil enables the scan.
	DiscoverChannels           *bool
	ServerSignedChannelsPolicy *BatchServerSignedChannelsPolicy
}

// PendingPayment is a payload the client built and has not yet heard back about.
type PendingPayment struct {
	Payload     map[string]any `json:"payload"`
	X402Version int            `json:"x402Version"`
}

// StoredPending is one in-flight allocation inside a storage record.
type StoredPending struct {
	Amount                  string         `json:"amount"`
	ChargedCumulativeAmount string         `json:"chargedCumulativeAmount"`
	Deposit                 string         `json:"deposit"`
	OperationKey            string         `json:"operationKey,omitempty"`
	Payment                 PendingPayment `json:"payment"`
}

// BatchClientChannelRecord is a serializable confirmed allocation.
type BatchClientChannelRecord struct {
	ChannelConfig           batchsettlement.BatchChannelConfig `json:"channelConfig"`
	ChannelID               string                             `json:"channelId"`
	ChargedCumulativeAmount string                             `json:"chargedCumulativeAmount"`
	Deposit                 string                             `json:"deposit"`
	HasConfirmedState       bool                               `json:"hasConfirmedState,omitempty"`
	Pending                 []StoredPending                    `json:"pending,omitempty"`
}

// UnmarshalJSON accepts a single pending object or a list, matching either
// storage shape a writer may have persisted.
func (r *BatchClientChannelRecord) UnmarshalJSON(data []byte) error {
	type record BatchClientChannelRecord
	var raw struct {
		record
		Pending json.RawMessage `json:"pending"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*r = BatchClientChannelRecord(raw.record)
	if len(raw.Pending) == 0 || string(raw.Pending) == "null" {
		return nil
	}
	if raw.Pending[0] == '[' {
		return json.Unmarshal(raw.Pending, &r.Pending)
	}
	var one StoredPending
	if err := json.Unmarshal(raw.Pending, &one); err != nil {
		return err
	}
	r.Pending = []StoredPending{one}
	return nil
}

type openChannel struct {
	tracker *BatchChannelTracker
	deposit uint64
}

type pendingChannel struct {
	openChannel
	confirmed    *openChannel
	key          string
	operationKey string
	amount       string
	cumulative   uint64
	payment      PendingPayment
}

// resolvedTerms are the channel terms taken from a 402 before a payment is built.
type resolvedTerms struct {
	feePayer           string
	receiverAuthorizer string
	tokenProgram       string
	withdrawDelay      int
	memo               *string
	voucherSigner      string
	operator           string
	trust              *ResolvedServerSignedTrust
}
