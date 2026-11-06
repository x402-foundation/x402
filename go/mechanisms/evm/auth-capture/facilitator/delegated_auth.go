package facilitator

// Facilitator-delegated receiver authorizer: caller-identity binding.
//
// When the facilitator holds the receiverAuthorizer key, the authorizerSignature it produces is
// no longer evidence of the server's intent, so the request is authenticated out of band
// instead. The first authenticated caller to settle a payment is bound to its paymentInfoHash;
// every later facilitator-signed step must come from the same identity. The binding is written
// after re-verify and before broadcast, and fails closed.

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// DelegatedStep names the settle step a delegated request performs.
type DelegatedStep string

// Delegated settle steps.
const (
	DelegatedStepAuthorize DelegatedStep = "authorize"
	DelegatedStepCharge    DelegatedStep = "charge"
	DelegatedStepCapture   DelegatedStep = "capture"
	DelegatedStepVoid      DelegatedStep = "void"
	DelegatedStepRefund    DelegatedStep = "refund"
)

// DelegatedSettleContext is passed to AuthCaptureEvmSchemeConfig.ResolveCallerIdentity.
type DelegatedSettleContext struct {
	Step               DelegatedStep
	PaymentInfoHash    string
	Network            x402.Network
	Payer              string
	Payload            types.PaymentPayload
	Requirements       types.PaymentRequirements
	FacilitatorContext *x402.FacilitatorContext
}

// ResolveCallerIdentity authenticates the caller of a delegated settle out of band and returns a
// stable identity. Returning an empty string or an error rejects the settle. The identity must
// be the same across the authorize and the later lifecycle settles of one payment.
type ResolveCallerIdentity func(ctx context.Context, settle DelegatedSettleContext) (string, error)

// AuthCaptureDelegatedAuthRecord is the caller binding for one payment.
type AuthCaptureDelegatedAuthRecord struct {
	Network         x402.Network
	PaymentInfoHash string
	// CallerIdentity is the stable identity returned by ResolveCallerIdentity.
	CallerIdentity string
	// ExpiresAt is unix seconds (refundDeadline). An expired row is treated as absent.
	ExpiresAt uint64
}

// AuthCaptureDelegatedAuthWrite is the result of AuthCaptureDelegatedAuthStorage.Bind.
// RevertToken is empty when the row already existed, so a later revert leaves that row alone.
type AuthCaptureDelegatedAuthWrite struct {
	// Record is the row as stored after the write.
	Record AuthCaptureDelegatedAuthRecord
	// RevertToken is an opaque host-defined token. Empty when this call did not create the row.
	RevertToken string
}

// AuthCaptureDelegatedAuthStorage is the pluggable storage for facilitator-delegated caller bindings.
type AuthCaptureDelegatedAuthStorage interface {
	// Bind inserts the row when it is absent (an expired row counts as absent). The check and the
	// insert MUST be one atomic operation under concurrent callers, for example a unique key on
	// Network and PaymentInfoHash with insert-on-conflict.
	//
	// When a live row exists, leave its CallerIdentity and ExpiresAt untouched and return it with
	// an empty RevertToken. A different identity is rejected by the SDK through bindThenBroadcast.
	// A matching identity is an idempotent success; hosts SHOULD rotate the stored token so a
	// concurrent creator's revert no longer matches.
	Bind(ctx context.Context, record AuthCaptureDelegatedAuthRecord) (AuthCaptureDelegatedAuthWrite, error)
	// RevertBind deletes the row only when write.RevertToken is non-empty and still matches.
	RevertBind(ctx context.Context, write AuthCaptureDelegatedAuthWrite) error
	// Get reads one live row. It returns nil when the row is absent or expired.
	Get(ctx context.Context, network x402.Network, paymentInfoHash string) (*AuthCaptureDelegatedAuthRecord, error)
	// Delete removes a row. Hosts SHOULD also purge expired rows (for example a TTL index on ExpiresAt).
	Delete(ctx context.Context, network x402.Network, paymentInfoHash string) error
}

// OnDelegatedAuthStorageError is reported when a binding revert or early delete fails.
// It must not replace the settle result.
type OnDelegatedAuthStorageError func(err error, network x402.Network, paymentInfoHash string)

// ErrCallerIdentityConflict means the first writer already bound this payment to a different
// caller identity.
var ErrCallerIdentityConflict = errors.New("delegated auth binding already exists for a different identity")

// delegatedAuthorizer is the resolved delegated-authorizer wiring for one request.
type delegatedAuthorizer struct {
	signer                evm.ClientEvmSigner
	resolveCallerIdentity ResolveCallerIdentity
	storage               AuthCaptureDelegatedAuthStorage
	onStorageError        OnDelegatedAuthStorageError
}

// getDelegatedAuthorizer returns the delegated authorizer when receiverAuthorizer is the key this
// facilitator holds and delegation is fully wired, and nil otherwise.
func getDelegatedAuthorizer(config AuthCaptureEvmSchemeConfig, receiverAuthorizer string) *delegatedAuthorizer {
	if config.AuthorizerSigner == nil || config.ResolveCallerIdentity == nil ||
		config.DelegatedAuthStorage == nil || config.OnStorageError == nil {
		return nil
	}
	if !strings.EqualFold(evm.NormalizeAddress(config.AuthorizerSigner.Address()), evm.NormalizeAddress(receiverAuthorizer)) {
		return nil
	}
	return &delegatedAuthorizer{
		signer:                config.AuthorizerSigner,
		resolveCallerIdentity: config.ResolveCallerIdentity,
		storage:               config.DelegatedAuthStorage,
		onStorageError:        config.OnStorageError,
	}
}

// resolveDelegatedCallerIdentity resolves a delegated settle's caller identity. An error and an
// empty result are both treated as unauthenticated and return an empty string.
func resolveDelegatedCallerIdentity(ctx context.Context, delegated *delegatedAuthorizer, settle DelegatedSettleContext) string {
	identity, err := delegated.resolveCallerIdentity(ctx, settle)
	if err != nil {
		return ""
	}
	return identity
}

// reportDelegatedStorageError reports a storage failure that must not replace the settle result.
func reportDelegatedStorageError(delegated *delegatedAuthorizer, err error, network x402.Network, paymentInfoHash string) {
	delegated.onStorageError(err, network, paymentInfoHash)
}

// bindDisposition says how a broadcast ended, for bindThenBroadcast.
type bindDisposition string

const (
	bindKeep   bindDisposition = "keep"
	bindRevert bindDisposition = "revert"
)

// bindFailure says why a bind failed closed.
type bindFailure string

const (
	bindConflict    bindFailure = "conflict"
	bindUnavailable bindFailure = "unavailable"
)

// bindThenBroadcastResult is the outcome of bindThenBroadcast: the broadcast value when OK, or
// the reason the bind failed closed.
type bindThenBroadcastResult[T any] struct {
	OK     bool
	Value  T
	Reason bindFailure
	Err    error
}

// bindingCleanupTimeout bounds a binding revert or delete.
const bindingCleanupTimeout = 5 * time.Second

// detachedCleanupContext keeps ctx's values but not its cancellation, so a client disconnect
// cannot leave a stale binding behind.
func detachedCleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), bindingCleanupTimeout)
}

// bindThenBroadcast binds the caller to the payment, then runs broadcast.
//
// The bind is fail-closed: a storage error or an identity conflict returns without calling
// broadcast. A binding this call created is reverted when broadcast returns bindRevert; bindKeep
// leaves it, because the outcome is then unknown. A revert error goes to OnStorageError and
// never replaces the broadcast result.
func bindThenBroadcast[T any](
	ctx context.Context,
	delegated *delegatedAuthorizer,
	record AuthCaptureDelegatedAuthRecord,
	broadcast func() (T, bindDisposition),
) bindThenBroadcastResult[T] {
	write, err := delegated.storage.Bind(ctx, record)
	if err != nil {
		return bindThenBroadcastResult[T]{Reason: bindUnavailable, Err: err}
	}
	if write.Record.CallerIdentity != record.CallerIdentity {
		return bindThenBroadcastResult[T]{Reason: bindConflict, Err: ErrCallerIdentityConflict}
	}

	value, disposition := broadcast()
	if disposition == bindRevert {
		cleanupCtx, cancel := detachedCleanupContext(ctx)
		defer cancel()
		if err := delegated.storage.RevertBind(cleanupCtx, write); err != nil {
			reportDelegatedStorageError(delegated, err, record.Network, record.PaymentInfoHash)
		}
	}
	return bindThenBroadcastResult[T]{OK: true, Value: value}
}

// validateDelegatedReceiverAuthorizerConfig rejects a partial delegated-authorizer config.
func validateDelegatedReceiverAuthorizerConfig(config AuthCaptureEvmSchemeConfig) error {
	anyDelegation := config.AuthorizerSigner != nil || config.ResolveCallerIdentity != nil ||
		config.DelegatedAuthStorage != nil || config.OnStorageError != nil
	if !anyDelegation {
		return nil
	}
	switch {
	case config.AuthorizerSigner == nil:
		return errors.New("facilitator-delegated receiver authorization requires AuthorizerSigner")
	case config.ResolveCallerIdentity == nil:
		return errors.New("AuthorizerSigner requires ResolveCallerIdentity")
	case config.DelegatedAuthStorage == nil:
		return errors.New("AuthorizerSigner requires DelegatedAuthStorage")
	case config.OnStorageError == nil:
		return errors.New("AuthorizerSigner requires OnStorageError")
	}
	return nil
}

// delegatedAuthRow is one stored binding and the token that reverts it.
type delegatedAuthRow struct {
	record      AuthCaptureDelegatedAuthRecord
	revertToken string
}

// InMemoryAuthCaptureDelegatedAuthStorage is an in-memory AuthCaptureDelegatedAuthStorage. A
// per-row counter is the revert token: a matching-identity Bind on a live row rotates it and
// returns an empty token, so the creator's revert no longer matches. Expired rows are purged
// lazily on Bind and Get. Bindings are lost on restart, which fails closed.
type InMemoryAuthCaptureDelegatedAuthStorage struct {
	mu        sync.Mutex
	rows      map[string]*delegatedAuthRow
	nextToken uint64
	now       func() time.Time
}

// NewInMemoryAuthCaptureDelegatedAuthStorage creates an empty in-memory binding store.
func NewInMemoryAuthCaptureDelegatedAuthStorage() *InMemoryAuthCaptureDelegatedAuthStorage {
	return &InMemoryAuthCaptureDelegatedAuthStorage{
		rows: make(map[string]*delegatedAuthRow),
		now:  time.Now,
	}
}

// Bind implements AuthCaptureDelegatedAuthStorage.
func (s *InMemoryAuthCaptureDelegatedAuthStorage) Bind(_ context.Context, record AuthCaptureDelegatedAuthRecord) (AuthCaptureDelegatedAuthWrite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.purgeExpired()
	key := delegatedAuthRowKey(record.Network, record.PaymentInfoHash)
	s.nextToken++
	revertToken := strconv.FormatUint(s.nextToken, 10)
	existing, ok := s.rows[key]
	if !ok {
		s.rows[key] = &delegatedAuthRow{record: record, revertToken: revertToken}
		return AuthCaptureDelegatedAuthWrite{Record: record, RevertToken: revertToken}, nil
	}
	if existing.record.CallerIdentity == record.CallerIdentity {
		existing.revertToken = revertToken
	}
	return AuthCaptureDelegatedAuthWrite{Record: existing.record}, nil
}

// RevertBind implements AuthCaptureDelegatedAuthStorage.
func (s *InMemoryAuthCaptureDelegatedAuthStorage) RevertBind(_ context.Context, write AuthCaptureDelegatedAuthWrite) error {
	if write.RevertToken == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	key := delegatedAuthRowKey(write.Record.Network, write.Record.PaymentInfoHash)
	row, ok := s.rows[key]
	if !ok || row.revertToken != write.RevertToken {
		return nil
	}
	delete(s.rows, key)
	return nil
}

// Get implements AuthCaptureDelegatedAuthStorage.
func (s *InMemoryAuthCaptureDelegatedAuthStorage) Get(_ context.Context, network x402.Network, paymentInfoHash string) (*AuthCaptureDelegatedAuthRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := delegatedAuthRowKey(network, paymentInfoHash)
	row, ok := s.rows[key]
	if !ok {
		return nil, nil
	}
	if s.isExpired(row.record) {
		delete(s.rows, key)
		return nil, nil
	}
	record := row.record
	return &record, nil
}

// Delete implements AuthCaptureDelegatedAuthStorage.
func (s *InMemoryAuthCaptureDelegatedAuthStorage) Delete(_ context.Context, network x402.Network, paymentInfoHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.rows, delegatedAuthRowKey(network, paymentInfoHash))
	return nil
}

// purgeExpired drops every expired row. The caller holds the lock.
func (s *InMemoryAuthCaptureDelegatedAuthStorage) purgeExpired() {
	for key, row := range s.rows {
		if s.isExpired(row.record) {
			delete(s.rows, key)
		}
	}
}

// isExpired reports whether a binding is past ExpiresAt.
func (s *InMemoryAuthCaptureDelegatedAuthStorage) isExpired(record AuthCaptureDelegatedAuthRecord) bool {
	return record.ExpiresAt <= uint64(s.now().Unix())
}

// delegatedAuthRowKey is a composite key so the same hash on two networks cannot collide.
func delegatedAuthRowKey(network x402.Network, paymentInfoHash string) string {
	return string(network) + "\x00" + strings.ToLower(paymentInfoHash)
}
