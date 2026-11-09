package server

import (
	"context"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"

	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
)

// AuthorizedPayment is a collected payment the server can still capture, void or refund.
// Amounts are decimal strings in token base units so records serialize to any backend.
type AuthorizedPayment struct {
	PaymentInfoHash string
	PaymentInfo     authcapture.PaymentInfoStruct
	SaltNonce       string
	Network         string

	ReceiverAuthorizer  string
	Policy              string
	Name                string
	Version             string
	PaymentFlow         string
	OperatorType        string
	AssetTransferMethod string
	AuthCaptureEscrow   string

	CapturableAmount   string
	RefundableAmount   string
	CollectTransaction string
	CreatedAt          time.Time
}

// AuthorizedPaymentStorage persists AuthorizedPayment records keyed by paymentInfoHash.
type AuthorizedPaymentStorage interface {
	// Get returns a copy of the record, or nil when absent.
	Get(ctx context.Context, paymentInfoHash string) (*AuthorizedPayment, error)
	List(ctx context.Context) ([]*AuthorizedPayment, error)
	// Update runs update on a copy of the current record, nil when absent, and stores what it
	// returns. Returning nil deletes the record and returning the argument keeps it. An
	// implementation shared by several instances must make the read-modify-write atomic, for
	// example with a SQL transaction or a Lua script, and update must not call back into storage.
	Update(ctx context.Context, paymentInfoHash string, update func(current *AuthorizedPayment) *AuthorizedPayment) error
}

// InMemoryAuthorizedPaymentStorage keeps records in process memory. Records are lost on restart,
// so a deferred capture then falls back on the payer's reclaim after the capture deadline.
type InMemoryAuthorizedPaymentStorage struct {
	mu       sync.Mutex
	payments map[string]*AuthorizedPayment
}

// NewInMemoryAuthorizedPaymentStorage returns an empty in-memory store.
func NewInMemoryAuthorizedPaymentStorage() *InMemoryAuthorizedPaymentStorage {
	return &InMemoryAuthorizedPaymentStorage{payments: map[string]*AuthorizedPayment{}}
}

func (p *AuthorizedPayment) clone() *AuthorizedPayment {
	if p == nil {
		return nil
	}
	copied := *p
	return &copied
}

func storageKey(paymentInfoHash string) string { return strings.ToLower(paymentInfoHash) }

// Get implements AuthorizedPaymentStorage.
func (s *InMemoryAuthorizedPaymentStorage) Get(_ context.Context, paymentInfoHash string) (*AuthorizedPayment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.payments[storageKey(paymentInfoHash)].clone(), nil
}

// List implements AuthorizedPaymentStorage, oldest record first.
func (s *InMemoryAuthorizedPaymentStorage) List(_ context.Context) ([]*AuthorizedPayment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]*AuthorizedPayment, 0, len(s.payments))
	for _, record := range s.payments {
		records = append(records, record.clone())
	}
	sort.Slice(records, func(i, j int) bool { return records[i].CreatedAt.Before(records[j].CreatedAt) })
	return records, nil
}

// Update implements AuthorizedPaymentStorage.
func (s *InMemoryAuthorizedPaymentStorage) Update(
	_ context.Context,
	paymentInfoHash string,
	update func(current *AuthorizedPayment) *AuthorizedPayment,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := storageKey(paymentInfoHash)
	next := update(s.payments[key].clone())
	if next == nil {
		delete(s.payments, key)
		return nil
	}
	s.payments[key] = next.clone()
	return nil
}

func parseBalance(value string) (*big.Int, bool) {
	n, ok := new(big.Int).SetString(value, 10)
	return n, ok && n.Sign() >= 0
}

// adjustBalances applies mutate to the stored capturable and refundable amounts. A missing record
// or one with unreadable balances is left alone.
func adjustBalances(ctx context.Context, storage AuthorizedPaymentStorage, paymentInfoHash string, mutate func(capturable, refundable *big.Int)) error {
	return storage.Update(ctx, paymentInfoHash, func(current *AuthorizedPayment) *AuthorizedPayment {
		if current == nil {
			return nil
		}
		capturable, capturableOK := parseBalance(current.CapturableAmount)
		refundable, refundableOK := parseBalance(current.RefundableAmount)
		if !capturableOK || !refundableOK {
			return current
		}
		mutate(capturable, refundable)
		current.CapturableAmount, current.RefundableAmount = capturable.String(), refundable.String()
		return current
	})
}

// applyCapture moves a captured amount from capturable to refundable, zeroing the hold when the
// remainder was voided.
func applyCapture(ctx context.Context, storage AuthorizedPaymentStorage, paymentInfoHash string, amount *big.Int, voidRemainder bool) error {
	return adjustBalances(ctx, storage, paymentInfoHash, func(capturable, refundable *big.Int) {
		if voidRemainder {
			capturable.SetInt64(0)
		} else {
			capturable.Sub(capturable, amount)
		}
		refundable.Add(refundable, amount)
	})
}

func applyVoid(ctx context.Context, storage AuthorizedPaymentStorage, paymentInfoHash string) error {
	return adjustBalances(ctx, storage, paymentInfoHash, func(capturable, _ *big.Int) { capturable.SetInt64(0) })
}

func applyRefund(ctx context.Context, storage AuthorizedPaymentStorage, paymentInfoHash string, amount *big.Int) error {
	return adjustBalances(ctx, storage, paymentInfoHash, func(_, refundable *big.Int) { refundable.Sub(refundable, amount) })
}
