package facilitator

import (
	"context"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// CloseAction describes which cleanup path closed a channel.
type CloseAction = paymentchannels.RentCleanupCloseAction

const (
	CloseActionAbandon    = paymentchannels.RentCleanupCloseAbandon
	CloseActionForced     = paymentchannels.RentCleanupCloseForced
	CloseActionDistribute = paymentchannels.RentCleanupCloseDistribute
)

// CloseResult reports one successful close or distribute.
type CloseResult = paymentchannels.RentCleanupCloseResult

// ReclaimResult reports one successful batched reclaim.
type ReclaimResult = paymentchannels.RentCleanupReclaimResult

// CleanupOptions bound one cleanup pass and receive its results.
type CleanupOptions = paymentchannels.RentCleanupOptions

// DiscoveryResult reports the channels one discovery sweep added to storage.
type DiscoveryResult = paymentchannels.RentDiscoveryResult

// DiscoveryOptions receive one discovery sweep's results.
type DiscoveryOptions = paymentchannels.RentDiscoveryOptions

// StartConfig configures the interval runners.
type StartConfig = paymentchannels.RentCleanupStartConfig

// RentCleanupConfig configures a rent cleanup manager for one network.
type RentCleanupConfig struct {
	Signer                        svm.FacilitatorSvmSigner
	Storage                       paymentchannels.PaymentChannelStorage
	Network                       string
	MaxIdleSecs                   *int64
	ComputeUnitPriceMicroLamports *uint64
	SettleComputeUnitLimit        *uint32
}

// BatchSvmRentCleanupManager recovers rent a facilitator fronts for batch channels.
// Operators start it themselves; the facilitator scheme never runs cleanup on its own.
// Non-expiring vouchers abandon after MaxIdleSecs without activity, and Closing
// channels are sealed once onchain grace elapses.
type BatchSvmRentCleanupManager struct {
	inner *paymentchannels.PaymentChannelRentCleanupManager
}

// NewBatchSvmRentCleanupManager creates a rent cleanup manager for one network.
func NewBatchSvmRentCleanupManager(config RentCleanupConfig) *BatchSvmRentCleanupManager {
	return &BatchSvmRentCleanupManager{
		inner: paymentchannels.NewPaymentChannelRentCleanupManager(paymentchannels.PaymentChannelRentCleanupConfig{
			Signer:                        config.Signer,
			Storage:                       config.Storage,
			Network:                       config.Network,
			ComputeUnitPriceMicroLamports: config.ComputeUnitPriceMicroLamports,
			SettleComputeUnitLimit:        config.SettleComputeUnitLimit,
			MaxIdleSecs:                   config.MaxIdleSecs,
			AbandonPolicy:                 paymentchannels.OpenAbandonPolicyIdle,
			Label:                         "BatchSvmRentCleanupManager",
		}),
	}
}

// Start runs Cleanup on an interval, and Discover on its own longer interval when one is configured.
func (m *BatchSvmRentCleanupManager) Start(ctx context.Context, config StartConfig) {
	m.inner.Start(ctx, config)
}

// Stop halts the interval runners and waits for an in-flight pass to finish.
func (m *BatchSvmRentCleanupManager) Stop() {
	m.inner.Stop()
}

// Cleanup runs one pass.
func (m *BatchSvmRentCleanupManager) Cleanup(ctx context.Context, opts CleanupOptions) error {
	return m.inner.Cleanup(ctx, opts)
}

// Discover finds Distributed channels this facilitator paid rent for that storage does not know about.
func (m *BatchSvmRentCleanupManager) Discover(ctx context.Context, opts DiscoveryOptions) error {
	return m.inner.Discover(ctx, opts)
}
