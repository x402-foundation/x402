package facilitator

import (
	"context"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

// Start runs claim, settle, and idle-refund timers for single-process dev use.
// The refund timer is scheduled only when RefundIdleSecs is set.
func (m *FacilitatorChannelManager) Start(config FacilitatorAutoConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return
	}
	m.running = true
	m.autoConfig = config
	m.startAutoTimerLocked(autoJobClaim, config.ClaimIntervalSecs)
	m.startAutoTimerLocked(autoJobSettle, config.SettleIntervalSecs)
	if config.RefundIdleSecs != nil && *config.RefundIdleSecs > 0 {
		m.startAutoTimerLocked(autoJobRefund, config.RefundIntervalSecs)
	}
}

// Stop stops the interval loop. When flush is true, run ClaimAndSettle before returning.
func (m *FacilitatorChannelManager) Stop(ctx context.Context, flush bool) error {
	m.mu.Lock()
	m.running = false
	for _, ticker := range m.timers {
		ticker.Stop()
	}
	for _, ch := range m.stopChans {
		close(ch)
	}
	m.timers = make(map[autoJob]*time.Ticker)
	m.stopChans = make(map[autoJob]chan struct{})
	m.pendingJobs = make(map[autoJob]struct{})
	cfg := m.autoConfig
	m.mu.Unlock()
	if flush {
		opts := &FacilitatorClaimOptions{}
		if cfg.MaxClaimsPerBatch > 0 {
			opts.MaxClaimsPerBatch = cfg.MaxClaimsPerBatch
		}
		_, _, err := m.ClaimAndSettle(ctx, opts)
		return err
	}
	return nil
}

func (m *FacilitatorChannelManager) startAutoTimerLocked(job autoJob, intervalSecs *int) {
	if intervalSecs == nil {
		return
	}
	ticker := time.NewTicker(time.Duration(*intervalSecs) * time.Second)
	stop := make(chan struct{})
	m.timers[job] = ticker
	m.stopChans[job] = stop
	go func() {
		for {
			select {
			case <-ticker.C:
				m.enqueueJob(job)
			case <-stop:
				return
			}
		}
	}()
}

func (m *FacilitatorChannelManager) enqueueJob(job autoJob) {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	m.pendingJobs[job] = struct{}{}
	draining := m.drainingJobs
	m.mu.Unlock()
	if !draining {
		go m.drainJobs()
	}
}

func (m *FacilitatorChannelManager) drainJobs() {
	m.mu.Lock()
	if m.drainingJobs {
		m.mu.Unlock()
		return
	}
	m.drainingJobs = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.drainingJobs = false
		m.mu.Unlock()
	}()

	for {
		m.mu.Lock()
		if !m.running || len(m.pendingJobs) == 0 {
			m.mu.Unlock()
			return
		}
		job := m.nextPendingJobLocked()
		if job == "" {
			m.mu.Unlock()
			return
		}
		delete(m.pendingJobs, job)
		m.mu.Unlock()
		m.runAutoJob(job)
	}
}

func (m *FacilitatorChannelManager) nextPendingJobLocked() autoJob {
	for _, job := range autoJobPriority {
		if _, ok := m.pendingJobs[job]; ok {
			return job
		}
	}
	return ""
}

func (m *FacilitatorChannelManager) runAutoJob(job autoJob) {
	switch job {
	case autoJobClaim:
		m.runClaimJob()
	case autoJobSettle:
		m.runSettleJob()
	case autoJobRefund:
		m.runRefundJob()
	default:
		panic("unhandled auto job: " + string(job))
	}
}

func (m *FacilitatorChannelManager) runClaimJob() {
	m.mu.Lock()
	cfg := m.autoConfig
	m.mu.Unlock()
	opts := &FacilitatorClaimOptions{}
	if cfg.MaxClaimsPerBatch > 0 {
		opts.MaxClaimsPerBatch = cfg.MaxClaimsPerBatch
	}
	if cfg.OnError != nil {
		onErr := cfg.OnError
		opts.OnError = func(err error, _ string) { onErr(err) }
	}
	results, err := m.Claim(context.Background(), opts)
	if len(results) > 0 {
		m.mu.Lock()
		m.pendingSettle = true
		m.mu.Unlock()
	}
	if cfg.OnClaim != nil {
		for _, result := range results {
			cfg.OnClaim(result)
		}
	}
	if err != nil && cfg.OnError != nil {
		cfg.OnError(err)
	}
}

func (m *FacilitatorChannelManager) runSettleJob() {
	m.mu.Lock()
	pending := m.pendingSettle
	cfg := m.autoConfig
	m.mu.Unlock()
	if !pending {
		return
	}
	opts := &FacilitatorSettleOptions{}
	if cfg.OnError != nil {
		onErr := cfg.OnError
		opts.OnError = func(err error, _ *storage.SettleTarget) { onErr(err) }
	}
	results, err := m.Settle(context.Background(), opts)
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(err)
		}
		return
	}
	m.mu.Lock()
	m.pendingSettle = false
	m.mu.Unlock()
	if cfg.OnSettle != nil {
		for _, result := range results {
			cfg.OnSettle(result)
		}
	}
}

func (m *FacilitatorChannelManager) runRefundJob() {
	m.mu.Lock()
	cfg := m.autoConfig
	m.mu.Unlock()
	if cfg.RefundIdleSecs == nil || *cfg.RefundIdleSecs <= 0 {
		return
	}
	var onError func(error, string)
	if cfg.OnError != nil {
		onErr := cfg.OnError
		onError = func(err error, _ string) { onErr(err) }
	}
	results, err := m.RefundIdleChannels(context.Background(), FacilitatorRefundOptions{
		IdleSecs: *cfg.RefundIdleSecs,
		OnError:  onError,
	})
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(err)
		}
		return
	}
	if cfg.OnRefund != nil {
		for _, result := range results {
			cfg.OnRefund(result)
		}
	}
}
