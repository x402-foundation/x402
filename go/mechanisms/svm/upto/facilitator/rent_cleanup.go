package facilitator

import (
	"context"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

const (
	// DefaultAbandonGraceSecs is how long after voucher expiry an Open channel
	// is left alone before the facilitator seals it to recover its rent.
	DefaultAbandonGraceSecs = paymentchannels.DefaultAbandonGraceSecs

	// DefaultMaxReclaimsPerTx is how many reclaim instructions are packed into
	// one cleanup transaction.
	DefaultMaxReclaimsPerTx = paymentchannels.DefaultMaxReclaimsPerTx

	// MaxSafeReclaimsPerTx is the largest reclaim batch that serializes under
	// Solana's packet data size. MaxReclaimsPerTx is clamped to this.
	MaxSafeReclaimsPerTx = paymentchannels.MaxSafeReclaimsPerTx

	// DefaultMaxTxsPerRun caps the close/distribute transactions the storage
	// scan submits per run.
	DefaultMaxTxsPerRun = paymentchannels.DefaultMaxTxsPerRun

	// DefaultMaxTxsPerSigner caps the reclaim transactions each rent payer
	// submits per run.
	DefaultMaxTxsPerSigner = paymentchannels.DefaultMaxTxsPerSigner

	// DefaultMaxClosesPerRun caps the seal/distribute transactions per run.
	DefaultMaxClosesPerRun = paymentchannels.DefaultMaxClosesPerRun
)

// CloseAction describes which cleanup path closed a channel.
type CloseAction string

// Cleanup close actions.
const (
	// CloseActionAbandonClose seals and distributes an abandoned Open channel.
	CloseActionAbandonClose CloseAction = CloseAction(paymentchannels.RentCleanupCloseAbandon)
	// CloseActionDistribute distributes an already-Sealed channel.
	CloseActionDistribute CloseAction = CloseAction(paymentchannels.RentCleanupCloseDistribute)
)

// CloseResult reports a successful abandon-close or Sealed distribute.
type CloseResult struct {
	ChannelID   string
	Transaction string
	Action      CloseAction
}

// ReclaimResult reports a successful batched reclaim transaction.
type ReclaimResult struct {
	ChannelIDs  []string
	Transaction string
}

// CleanupOptions bound the work of one cleanup pass and receive its results.
type CleanupOptions struct {
	// AbandonGraceSecs is the delay after ExpiresAt before abandon-closing an
	// Open channel. Defaults to DefaultAbandonGraceSecs.
	AbandonGraceSecs int64
	MaxReclaimsPerTx int
	// MaxTxsPerRun caps the transactions the storage scan may submit before it
	// stops and saves a resume cursor. It caps the scan, not the pass:
	// reclaims are budgeted separately by MaxTxsPerSigner.
	MaxTxsPerRun int
	// MaxTxsPerSigner caps the reclaim transactions each rent payer may submit
	// per pass. Budgeted per signer because rent-payer groups are independent:
	// adding managed keys adds throughput rather than dividing a fixed pool.
	MaxTxsPerSigner int
	MaxClosesPerRun int

	OnClose   func(result CloseResult)
	OnReclaim func(result ReclaimResult)
	OnError   func(err error, channelID string)
}

func (o CleanupOptions) withDefaults() CleanupOptions {
	if o.AbandonGraceSecs <= 0 {
		o.AbandonGraceSecs = DefaultAbandonGraceSecs
	}
	if o.MaxReclaimsPerTx <= 0 {
		o.MaxReclaimsPerTx = DefaultMaxReclaimsPerTx
	} else if o.MaxReclaimsPerTx > MaxSafeReclaimsPerTx {
		o.MaxReclaimsPerTx = MaxSafeReclaimsPerTx
	}
	if o.MaxTxsPerRun <= 0 {
		o.MaxTxsPerRun = DefaultMaxTxsPerRun
	}
	if o.MaxTxsPerSigner <= 0 {
		o.MaxTxsPerSigner = DefaultMaxTxsPerSigner
	}
	if o.MaxClosesPerRun <= 0 {
		o.MaxClosesPerRun = DefaultMaxClosesPerRun
	}
	return o
}

func (o CleanupOptions) toShared() paymentchannels.RentCleanupOptions {
	shared := paymentchannels.RentCleanupOptions{
		AbandonGraceSecs: o.AbandonGraceSecs,
		MaxReclaimsPerTx: o.MaxReclaimsPerTx,
		MaxTxsPerRun:     o.MaxTxsPerRun,
		MaxTxsPerSigner:  o.MaxTxsPerSigner,
		MaxClosesPerRun:  o.MaxClosesPerRun,
		OnError:          o.OnError,
	}
	if o.OnClose != nil {
		onClose := o.OnClose
		shared.OnClose = func(result paymentchannels.RentCleanupCloseResult) {
			onClose(CloseResult{
				ChannelID:   result.ChannelID,
				Transaction: result.Transaction,
				Action:      CloseAction(result.Action),
			})
		}
	}
	if o.OnReclaim != nil {
		onReclaim := o.OnReclaim
		shared.OnReclaim = func(result paymentchannels.RentCleanupReclaimResult) {
			onReclaim(ReclaimResult{
				ChannelIDs:  result.ChannelIDs,
				Transaction: result.Transaction,
			})
		}
	}
	return shared
}

// DiscoveryResult reports the channels one discovery sweep added to Storage.
type DiscoveryResult struct {
	ChannelIDs []string
}

// DiscoveryOptions receive the results of one discovery sweep.
type DiscoveryOptions struct {
	OnDiscover func(result DiscoveryResult)
	OnError    func(err error, channelID string)
}

func (o DiscoveryOptions) toShared() paymentchannels.RentDiscoveryOptions {
	shared := paymentchannels.RentDiscoveryOptions{OnError: o.OnError}
	if o.OnDiscover != nil {
		onDiscover := o.OnDiscover
		shared.OnDiscover = func(result paymentchannels.RentDiscoveryResult) {
			onDiscover(DiscoveryResult{ChannelIDs: result.ChannelIDs})
		}
	}
	return shared
}

// StartConfig configures the interval runners.
type StartConfig struct {
	CleanupOptions
	// Interval is the delay between cleanup passes and is required.
	Interval time.Duration

	// DiscoveryInterval is the delay between Discover sweeps. Zero leaves
	// discovery off. A sweep is a getProgramAccounts scan per managed signer,
	// so it belongs on a far longer interval than cleanup: daily is typical.
	DiscoveryInterval time.Duration

	// OnDiscover receives each interval sweep's result.
	OnDiscover func(result DiscoveryResult)
}

// RentCleanupConfig configures a rent cleanup manager for one network.
type RentCleanupConfig struct {
	Signer  paymentchannels.PaymentChannelFacilitatorSigner
	Storage paymentchannels.PaymentChannelStorage
	Network string

	// ComputeUnitPriceMicroLamports is the SetComputeUnitPrice (microlamports
	// per compute unit) attached to cleanup transactions; 0 omits the
	// instruction. Unset defaults to svm.DefaultComputeUnitPriceMicrolamports.
	ComputeUnitPriceMicroLamports *uint64

	// SettleComputeUnitLimit is the SetComputeUnitLimit for close/distribute
	// cleanup transactions. Unset defaults to paymentchannels.DefaultSettleComputeUnitLimit
	// (100k, standard SPL Token settlement); raise it for compute-heavy
	// Token-2022 extension mints. Reclaim batches instead derive their limit
	// per channel (paymentchannels.ReclaimComputeUnitLimit) and are mint-independent.
	SettleComputeUnitLimit *uint32
}

// RentCleanupManager recovers the rent a facilitator fronts for payment
// channels on one network. Passes are driven by settle-time ChannelStorage
// rather than RPC discovery.
//
// Open channels close at expiresAt plus a grace period. Closing channels are
// left alone: upto does not seal them.
type RentCleanupManager struct {
	inner *paymentchannels.PaymentChannelRentCleanupManager
}

// NewRentCleanupManager creates a rent cleanup manager. It does not start
// automatically; the facilitator scheme never runs cleanup on its own.
func NewRentCleanupManager(config RentCleanupConfig) *RentCleanupManager {
	sealClosingChannels := false
	return &RentCleanupManager{
		inner: paymentchannels.NewPaymentChannelRentCleanupManager(paymentchannels.PaymentChannelRentCleanupConfig{
			Signer:                        config.Signer,
			Storage:                       config.Storage,
			Network:                       config.Network,
			ComputeUnitPriceMicroLamports: config.ComputeUnitPriceMicroLamports,
			SettleComputeUnitLimit:        config.SettleComputeUnitLimit,
			AbandonPolicy:                 paymentchannels.OpenAbandonPolicyExpiry,
			SealClosingChannels:           &sealClosingChannels,
			Label:                         "RentCleanupManager",
		}),
	}
}

// Start runs Cleanup on an interval, and Discover on its own longer interval
// when one is configured, until Stop is called or the context is canceled.
// Calling Start on a running manager is a no-op.
func (m *RentCleanupManager) Start(ctx context.Context, config StartConfig) {
	shared := config.CleanupOptions.withDefaults().toShared()
	start := paymentchannels.RentCleanupStartConfig{
		RentCleanupOptions: shared,
		Interval:           config.Interval,
		DiscoveryInterval:  config.DiscoveryInterval,
	}
	if config.OnDiscover != nil {
		onDiscover := config.OnDiscover
		start.OnDiscover = func(result paymentchannels.RentDiscoveryResult) {
			onDiscover(DiscoveryResult{ChannelIDs: result.ChannelIDs})
		}
	}
	m.inner.Start(ctx, start)
}

// Stop halts the interval runners and waits for an in-flight pass to finish.
func (m *RentCleanupManager) Stop() {
	m.inner.Stop()
}

// Cleanup runs one pass: abandon-close due Open channels, distribute Sealed
// ones, and batch-reclaim Distributed ones past the open-slot gate.
func (m *RentCleanupManager) Cleanup(ctx context.Context, opts CleanupOptions) error {
	return m.inner.Cleanup(ctx, opts.withDefaults().toShared())
}

// Discover finds Distributed channels this facilitator paid rent for that
// storage does not know about and adds them, so Cleanup reclaims them later.
func (m *RentCleanupManager) Discover(ctx context.Context, opts DiscoveryOptions) error {
	return m.inner.Discover(ctx, opts.toShared())
}
