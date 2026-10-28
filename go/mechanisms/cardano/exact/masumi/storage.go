package masumi

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/x402-foundation/x402/go/v2/types"
)

// DefaultTermsStorageEntries is the default capacity of InMemoryTermsStorage.
const DefaultTermsStorageEntries = 10_000

// StoredTerms is one issued Masumi 402 keyed by its termsDigest: the
// authoritative copy of the quote and the transaction that claimed it.
type StoredTerms struct {
	TermsDigest string
	// Requirements exactly as served in the 402.
	Requirements types.PaymentRequirements
	// ClaimedTxHash is the transaction bound by the first paid retry.
	ClaimedTxHash string
}

// ClaimedTermsRetention keeps a claimed quote past its payment window so a
// settlement still awaiting confirmations can resume.
const ClaimedTermsRetention = time.Hour

// ErrTermsStorageFull refuses a new quote while every stored quote is still
// payable or recoverable.
var ErrTermsStorageFull = errors.New("masumi terms storage is full of live quotes")

// UpdateStatus says how UpdateTerms changed storage.
type UpdateStatus string

// UpdateTerms outcomes.
const (
	StatusUpdated   UpdateStatus = "updated"
	StatusUnchanged UpdateStatus = "unchanged"
	StatusDeleted   UpdateStatus = "deleted"
)

// UpdateResult is the final record and how storage changed.
type UpdateResult struct {
	Terms  *StoredTerms
	Status UpdateStatus
}

// TermsStorage stores issued quotes. UpdateTerms must be atomic per digest
// across every instance sharing the backend: the callback receives the current
// record (nil when absent) and returns the next one, nil to delete, or the
// same pointer to leave it unchanged.
type TermsStorage interface {
	Get(ctx context.Context, termsDigest string) (*StoredTerms, error)
	UpdateTerms(ctx context.Context, termsDigest string, update func(current *StoredTerms) *StoredTerms) (UpdateResult, error)
}

type digestLock struct {
	mu   sync.Mutex
	refs int
}

// InMemoryTermsStorage is a bounded process-local TermsStorage. Only quotes
// whose payment window (payByTime plus maxTimeoutSeconds, extended once
// claimed) has passed are evicted, oldest first; when none is, new quotes are
// refused with ErrTermsStorageFull so a buyer's payable quote is never lost.
// Records are shared, not copied: treat them as immutable. Suitable for tests
// and single-process servers only.
type InMemoryTermsStorage struct {
	mu         sync.Mutex
	terms      map[string]*StoredTerms
	expires    map[string]int64
	order      []string
	locks      map[string]*digestLock
	maxEntries int
	now        func() time.Time
}

// NewInMemoryTermsStorage creates a store retaining at most maxEntries quotes.
func NewInMemoryTermsStorage(maxEntries int) (*InMemoryTermsStorage, error) {
	if maxEntries <= 0 {
		return nil, errors.New("maxEntries must be a positive integer")
	}
	return &InMemoryTermsStorage{
		terms:      map[string]*StoredTerms{},
		expires:    map[string]int64{},
		locks:      map[string]*digestLock{},
		maxEntries: maxEntries,
		now:        time.Now,
	}, nil
}

// Get returns the stored quote for a digest, or nil.
func (s *InMemoryTermsStorage) Get(_ context.Context, termsDigest string) (*StoredTerms, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.terms[termsDigest], nil
}

// UpdateTerms atomically inspects and mutates one record under a per-digest lock.
func (s *InMemoryTermsStorage) UpdateTerms(ctx context.Context, termsDigest string, update func(current *StoredTerms) *StoredTerms) (UpdateResult, error) {
	if err := ctx.Err(); err != nil {
		return UpdateResult{}, err
	}
	lock := s.acquire(termsDigest)
	defer s.release(termsDigest, lock)

	s.mu.Lock()
	current := s.terms[termsDigest]
	s.mu.Unlock()

	next := update(current)
	if next == current {
		return UpdateResult{Terms: current, Status: StatusUnchanged}, nil
	}
	var nextExpires int64
	if next != nil {
		nextExpires = expiresAtMs(next)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if next == nil {
		s.delete(termsDigest)
		s.removeOrder(termsDigest)
		return UpdateResult{Status: StatusDeleted}, nil
	}
	if _, exists := s.terms[termsDigest]; !exists {
		if len(s.terms) >= s.maxEntries && !s.evictExpired() {
			return UpdateResult{}, ErrTermsStorageFull
		}
		s.order = append(s.order, termsDigest)
	}
	s.terms[termsDigest] = next
	s.expires[termsDigest] = nextExpires
	return UpdateResult{Terms: next, Status: StatusUpdated}, nil
}

// evictExpired drops the oldest quote whose payment window has passed. The
// caller holds s.mu.
func (s *InMemoryTermsStorage) evictExpired() bool {
	nowMs := s.now().UnixMilli()
	for i, digest := range s.order {
		if s.expires[digest] < nowMs {
			s.delete(digest)
			s.order = append(s.order[:i], s.order[i+1:]...)
			return true
		}
	}
	return false
}

func (s *InMemoryTermsStorage) delete(termsDigest string) {
	delete(s.terms, termsDigest)
	delete(s.expires, termsDigest)
}

// expiresAtMs is when a quote can no longer be paid or settled. A claimed
// quote is kept until its submitResultTime and at least ClaimedTermsRetention
// past its payment window. Unreadable quotes are expired.
func expiresAtMs(record *StoredTerms) int64 {
	extra, err := ValidateExtra(record.Requirements.Extra, record.Requirements.Network)
	if err != nil {
		return 0
	}
	expires, err := paymentWindowEndMs(extra, record.Requirements.MaxTimeoutSeconds)
	if err != nil {
		return 0
	}
	if record.ClaimedTxHash != "" {
		expires += ClaimedTermsRetention.Milliseconds()
		if submitBy, err := strconv.ParseInt(extra.Terms.SubmitResultTime, 10, 64); err == nil && submitBy > expires {
			expires = submitBy
		}
	}
	return expires
}

func (s *InMemoryTermsStorage) removeOrder(termsDigest string) {
	for i, d := range s.order {
		if d == termsDigest {
			s.order = append(s.order[:i], s.order[i+1:]...)
			return
		}
	}
}

func (s *InMemoryTermsStorage) acquire(termsDigest string) *digestLock {
	s.mu.Lock()
	lock, ok := s.locks[termsDigest]
	if !ok {
		lock = &digestLock{}
		s.locks[termsDigest] = lock
	}
	lock.refs++
	s.mu.Unlock()
	lock.mu.Lock()
	return lock
}

func (s *InMemoryTermsStorage) release(termsDigest string, lock *digestLock) {
	lock.mu.Unlock()
	s.mu.Lock()
	lock.refs--
	if lock.refs == 0 {
		delete(s.locks, termsDigest)
	}
	s.mu.Unlock()
}
