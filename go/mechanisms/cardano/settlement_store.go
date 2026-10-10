package cardano

import (
	"container/list"
	"context"
	"sync"
	"time"
)

// SettlementClaim asks to own the broadcast of TxHash. Masumi claims also bind
// TermsDigest so one quote can pay for only one transaction.
type SettlementClaim struct {
	TxHash      string
	OwnerToken  string
	TermsDigest string
	// TermsExpireAtMs is when the bound terms can no longer pay (POSIX ms);
	// the binding must outlive it. 0 keeps the binding indefinitely.
	TermsExpireAtMs int64
	// RetainUntilMs is when the transaction can no longer land (its TTL plus
	// the confirmation and rollback grace, POSIX ms); until then the record
	// is never evicted, so the transaction is never broadcast twice. 0 sets no
	// such bound.
	RetainUntilMs int64
}

// SettlementClaimResult is the outcome of a claim attempt.
type SettlementClaimResult string

// Claim outcomes.
const (
	ClaimFresh            SettlementClaimResult = "fresh"
	ClaimInFlight         SettlementClaimResult = "in-flight"
	ClaimSubmitted        SettlementClaimResult = "submitted"
	ClaimRejected         SettlementClaimResult = "rejected"
	ClaimTermsConflict    SettlementClaimResult = "terms-conflict"
	ClaimCapacityExceeded SettlementClaimResult = "capacity-exceeded"
)

// SettlementStore guards against broadcasting a transaction twice. Production
// deployments with several facilitator instances need a durable, shared
// implementation whose ClaimSettlement is atomic.
//
// An in-flight claim whose owner never recorded an outcome (crash, failed
// store update) must be reported as ClaimSubmitted once its lease expires, so
// a retry reconciles the transaction from chain evidence instead of being
// refused forever. A resumed claim is only observed, never rebroadcast.
type SettlementStore interface {
	// ClaimSettlement records a fresh claim for claim.OwnerToken, or reports
	// why the transaction (or its terms) is already claimed.
	ClaimSettlement(ctx context.Context, claim SettlementClaim) (SettlementClaimResult, error)
	// MarkSubmitted records that the owner broadcast, or may have broadcast,
	// the transaction.
	MarkSubmitted(ctx context.Context, txHash, ownerToken string) error
	// MarkRejected records a definitive ledger rejection by the owner.
	MarkRejected(ctx context.Context, txHash, ownerToken string) error
	// ReleaseClaim drops an in-flight claim held by ownerToken, and its terms
	// binding, once nothing was sent.
	ReleaseClaim(ctx context.Context, txHash, ownerToken string) error
}

// DefaultSettlementStoreEntries bounds the in-memory store.
const DefaultSettlementStoreEntries = 4096

// SettlementRetentionGrace is the confirmation and rollback grace a record is
// kept past its transaction's TTL.
const SettlementRetentionGrace = 30 * time.Minute

// DefaultSettlementClaimLease is how long an in-flight claim blocks retries; it
// comfortably exceeds one settle call.
const DefaultSettlementClaimLease = 5 * time.Minute

type recordState int

const (
	stateInFlight recordState = iota
	stateSubmitted
	stateRejected
)

type submissionRecord struct {
	claim     SettlementClaim
	state     recordState
	claimedAt time.Time
	element   *list.Element
}

// InMemorySettlementStore is a bounded, process-local SettlementStore that
// evicts the oldest record that can no longer matter: its transaction can no
// longer land and any Masumi terms it binds have expired. When none can go,
// new claims are refused.
type InMemorySettlementStore struct {
	mu          sync.Mutex
	submissions map[string]*submissionRecord
	order       *list.List
	terms       map[string]string
	maxEntries  int
	lease       time.Duration
	now         func() time.Time
}

// NewInMemorySettlementStore creates a store holding at most maxEntries
// claims plus terms bindings (DefaultSettlementStoreEntries when
// maxEntries <= 0); a Masumi claim takes two.
func NewInMemorySettlementStore(maxEntries int) *InMemorySettlementStore {
	if maxEntries <= 0 {
		maxEntries = DefaultSettlementStoreEntries
	}
	return &InMemorySettlementStore{
		submissions: map[string]*submissionRecord{},
		order:       list.New(),
		terms:       map[string]string{},
		maxEntries:  maxEntries,
		lease:       DefaultSettlementClaimLease,
		now:         time.Now,
	}
}

// WithClaimLease sets how long an unfinished in-flight claim blocks retries.
func (s *InMemorySettlementStore) WithClaimLease(lease time.Duration) *InMemorySettlementStore {
	s.mu.Lock()
	defer s.mu.Unlock()
	if lease > 0 {
		s.lease = lease
	}
	return s
}

// ClaimSettlement implements SettlementStore.
func (s *InMemorySettlementStore) ClaimSettlement(_ context.Context, claim SettlementClaim) (SettlementClaimResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	boundTx, termsBound := "", false
	if claim.TermsDigest != "" {
		boundTx, termsBound = s.terms[claim.TermsDigest]
	}
	if termsBound && boundTx != claim.TxHash {
		return ClaimTermsConflict, nil
	}
	if existing, ok := s.submissions[claim.TxHash]; ok {
		if existing.claim.TermsDigest != claim.TermsDigest {
			return ClaimTermsConflict, nil
		}
		switch {
		case existing.state == stateRejected:
			return ClaimRejected, nil
		case existing.state == stateInFlight && s.now().Sub(existing.claimedAt) < s.lease:
			return ClaimInFlight, nil
		}
		return ClaimSubmitted, nil
	}
	required := 1
	if claim.TermsDigest != "" && !termsBound {
		required++
	}
	for len(s.submissions)+len(s.terms)+required > s.maxEntries {
		if !s.evictOldestExpired() {
			return ClaimCapacityExceeded, nil
		}
	}
	if claim.TermsDigest != "" && !termsBound {
		s.terms[claim.TermsDigest] = claim.TxHash
	}
	record := &submissionRecord{claim: claim, state: stateInFlight, claimedAt: s.now()}
	record.element = s.order.PushBack(claim.TxHash)
	s.submissions[claim.TxHash] = record
	return ClaimFresh, nil
}

// MarkSubmitted implements SettlementStore.
func (s *InMemorySettlementStore) MarkSubmitted(_ context.Context, txHash, ownerToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if record, ok := s.submissions[txHash]; ok && record.claim.OwnerToken == ownerToken {
		record.state = stateSubmitted
	}
	return nil
}

// MarkRejected implements SettlementStore.
func (s *InMemorySettlementStore) MarkRejected(_ context.Context, txHash, ownerToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if record, ok := s.submissions[txHash]; ok && record.claim.OwnerToken == ownerToken {
		record.state = stateRejected
	}
	return nil
}

// ReleaseClaim implements SettlementStore. Only an in-flight claim held by
// ownerToken is released.
func (s *InMemorySettlementStore) ReleaseClaim(_ context.Context, txHash, ownerToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.submissions[txHash]
	if !ok || record.claim.OwnerToken != ownerToken || record.state != stateInFlight {
		return nil
	}
	s.remove(record)
	return nil
}

// evictOldestExpired drops the oldest record that can no longer matter: its
// lease (if in flight), its transaction's retention and its terms all ended.
func (s *InMemorySettlementStore) evictOldestExpired() bool {
	now := s.now()
	nowMs := now.UnixMilli()
	for e := s.order.Front(); e != nil; e = e.Next() {
		record := s.submissions[e.Value.(string)]
		if record.state == stateInFlight && now.Sub(record.claimedAt) < s.lease {
			continue
		}
		if expires := record.claim.TermsExpireAtMs; record.claim.TermsDigest != "" && (expires == 0 || nowMs <= expires) {
			continue
		}
		if nowMs <= record.claim.RetainUntilMs {
			continue
		}
		s.remove(record)
		return true
	}
	return false
}

func (s *InMemorySettlementStore) remove(record *submissionRecord) {
	delete(s.submissions, record.claim.TxHash)
	s.order.Remove(record.element)
	if digest := record.claim.TermsDigest; digest != "" && s.terms[digest] == record.claim.TxHash {
		delete(s.terms, digest)
	}
}
