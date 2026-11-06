package paymentchannels

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"
)

// PaymentChannelRecord holds the stored payment-channel facts the facilitator
// reads back.
//
// Hosts keep tenant and audit columns in their own schema. Every field here
// is something the SDK cannot recover onchain, except TokenProgram, which is
// stored so cleanup can skip a mint-account read.
type PaymentChannelRecord struct {
	// Network is the CAIP-2 network. Part of the storage key.
	Network string
	// ChannelID is the channel PDA. Part of the storage key.
	ChannelID string
	// PayTo is the distribution recipient sealed at open (requirements.payTo).
	PayTo string
	// TokenProgram is the token program that owns the mint. Cleanup distribute uses it directly.
	TokenProgram string
	// ExpiresAt is the voucher expiry (Unix seconds). 0 for batch settlement.
	// It only moves forward. Upto treats a row at or past this instant as
	// absent for delegated claims.
	ExpiresAt int64
	// LastActivityAt is the wall time of the last open, activity, or discovery
	// write. It drives the batch idle clock and the cleanup grace for an open
	// whose account is not visible yet. It never moves backwards.
	LastActivityAt time.Time
	// ReceiverAuthorizer is the batch open's binding memo key. Empty for upto,
	// where that key is onchain.
	ReceiverAuthorizer string
	// CallerIdentity is the delegated-mode caller. Empty when the open was not delegated.
	CallerIdentity string
}

// PaymentChannelOpenWrite is the result of RecordOpen. RevertToken is empty
// when the row already existed, so a later revert leaves that row alone.
type PaymentChannelOpenWrite struct {
	// Record is the row as stored after the write.
	Record PaymentChannelRecord
	// RevertToken is an opaque host-defined token. Empty when this call did not create the row.
	RevertToken string
}

// PaymentChannelStorage is the pluggable store shared by the upto and
// batch-settlement facilitators.
type PaymentChannelStorage interface {
	// RecordOpen inserts the row when it is absent. An existing row keeps its
	// open facts (PayTo, TokenProgram, ReceiverAuthorizer, CallerIdentity);
	// ExpiresAt and LastActivityAt only move forward. Hosts may enforce
	// admission policy here.
	//
	// When an existing row's non-empty CallerIdentity or ReceiverAuthorizer
	// differs from the requested non-empty value, RecordOpen MUST leave the
	// row unchanged (no token rotation, no ExpiresAt or LastActivityAt
	// advance) and return the stored row with an empty RevertToken. The
	// SDK then rejects the open through CheckOpenBindings, and the creator's
	// RevertOpen still matches. The comparison and the write MUST be one
	// atomic operation.
	//
	// The absent-row check and insert MUST be atomic under concurrent callers
	// (for example a unique key on Network and ChannelID with insert-on-conflict,
	// or one transaction). A naive read-then-write allows two opens on the same
	// key to both insert and breaks first-writer-wins binding checks.
	RecordOpen(ctx context.Context, record PaymentChannelRecord) (PaymentChannelOpenWrite, error)
	// RevertOpen deletes the row only when write.RevertToken is non-empty and
	// still matches. A later non-conflicting open rotates the token, so this
	// becomes a no-op.
	RevertOpen(ctx context.Context, write PaymentChannelOpenWrite) error
	// RecordActivity bumps LastActivityAt for channels already verified
	// onchain. A missing row is inserted. Bindings and admission policy are
	// left untouched, and the write is never reverted.
	RecordActivity(ctx context.Context, records ...PaymentChannelRecord) error
	// Get reads one row. A missing row returns (nil, nil).
	Get(ctx context.Context, network, channelID string) (*PaymentChannelRecord, error)
	// List returns every row on network, in any order. Rent cleanup sorts before scanning.
	List(ctx context.Context, network string) ([]PaymentChannelRecord, error)
	// Delete removes a row. Used after the channel account is gone.
	Delete(ctx context.Context, network, channelID string) error
}

// OnStorageError is called when reverting a failed open fails. It must not
// replace the settle error.
type OnStorageError func(err error, network, channelID string)

// ErrReceiverAuthorizerConflict means the first writer already bound this
// channel to a different receiver authorizer.
var ErrReceiverAuthorizerConflict = errors.New("receiver authorizer binding already exists for a different key")

// ErrCallerIdentityConflict means the first writer already bound this channel
// to a different caller identity.
var ErrCallerIdentityConflict = errors.New("delegated auth binding already exists for a different identity")

// CheckOpenBindings compares the non-empty requested bindings to the row
// RecordOpen stored. A created row carries the requested bindings, so a
// conflict means the row already existed and there is nothing to revert.
func CheckOpenBindings(requested, stored PaymentChannelRecord) error {
	if requested.ReceiverAuthorizer != "" &&
		stored.ReceiverAuthorizer != "" &&
		stored.ReceiverAuthorizer != requested.ReceiverAuthorizer {
		return ErrReceiverAuthorizerConflict
	}
	if requested.CallerIdentity != "" &&
		stored.CallerIdentity != "" &&
		stored.CallerIdentity != requested.CallerIdentity {
		return ErrCallerIdentityConflict
	}
	return nil
}

// ChannelWriteKind selects whether a pre-broadcast write can be reverted.
type ChannelWriteKind string

const (
	// ChannelWriteOpen reverts the row this call created when the broadcast fails definitively.
	ChannelWriteOpen ChannelWriteKind = "open"
	// ChannelWriteActivity is kept whether or not the broadcast lands.
	ChannelWriteActivity ChannelWriteKind = "activity"
)

// OpenBroadcastDisposition says whether an open broadcast should keep or revert its row.
type OpenBroadcastDisposition string

const (
	// OpenBroadcastKeep leaves the row in place.
	OpenBroadcastKeep OpenBroadcastDisposition = "keep"
	// OpenBroadcastRevert deletes a row this open created.
	OpenBroadcastRevert OpenBroadcastDisposition = "revert"
)

// BroadcastOutcome is the value and keep-or-revert decision from a broadcast attempt.
type BroadcastOutcome[T any] struct {
	Value       T
	Disposition OpenBroadcastDisposition
}

// WriteThenBroadcastArgs records the channels a transaction depends on, then runs Broadcast.
type WriteThenBroadcastArgs[T any] struct {
	Storage        PaymentChannelStorage
	Kind           ChannelWriteKind
	Records        []PaymentChannelRecord
	OnStorageError OnStorageError
	// Broadcast sends or reconciles. Call reserved once this attempt holds the
	// broadcast reservation or is following the winner.
	Broadcast func(reserved func()) (BroadcastOutcome[T], error)
}

// WriteThenBroadcast records the channels a transaction depends on, then runs Broadcast.
//
// The write is fail-closed: a storage error rejects before Broadcast. An open
// is reverted when Broadcast returns OpenBroadcastRevert, or returns an error
// before reserved is called. Activity is kept either way. A revert error is
// reported through OnStorageError and never replaces the broadcast error.
func WriteThenBroadcast[T any](ctx context.Context, args WriteThenBroadcastArgs[T]) (T, error) {
	switch args.Kind {
	case ChannelWriteOpen:
		return writeOpenThenBroadcast(ctx, args)
	case ChannelWriteActivity:
		var zero T
		if err := args.Storage.RecordActivity(ctx, args.Records...); err != nil {
			return zero, err
		}
		outcome, err := args.Broadcast(func() {})
		if err != nil {
			return zero, err
		}
		return outcome.Value, nil
	default:
		var zero T
		return zero, fmt.Errorf("unexpected channel write kind %q", args.Kind)
	}
}

// ReportStorageError reports a revert failure without letting it replace the settle error.
func ReportStorageError(onStorageError OnStorageError, err error, network, channelID string) {
	if onStorageError != nil {
		onStorageError(err, network, channelID)
		return
	}
	log.Printf("[x402] svm: channel storage revert failed channel_id=%s network=%s error=%v", channelID, network, err)
}

// InMemoryPaymentChannelStorage is an in-memory PaymentChannelStorage. A
// per-row counter is the revert token: a non-conflicting RecordOpen on an
// existing row rotates it and returns an empty token, so the creator's revert
// no longer matches. A conflicting open leaves the row and token untouched.
type InMemoryPaymentChannelStorage struct {
	mu        sync.Mutex
	channels  map[string]memoryChannelRow
	nextToken uint64
}

type memoryChannelRow struct {
	record      PaymentChannelRecord
	revertToken string
}

// NewInMemoryPaymentChannelStorage creates an empty in-memory channel store.
func NewInMemoryPaymentChannelStorage() *InMemoryPaymentChannelStorage {
	return &InMemoryPaymentChannelStorage{channels: make(map[string]memoryChannelRow)}
}

// RecordOpen inserts a row or moves its forward-only timestamps. An open whose
// bindings conflict with the stored row changes nothing.
func (s *InMemoryPaymentChannelStorage) RecordOpen(_ context.Context, record PaymentChannelRecord) (PaymentChannelOpenWrite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := channelStorageKey(record.Network, record.ChannelID)
	existing, ok := s.channels[key]
	if ok && CheckOpenBindings(record, existing.record) != nil {
		return PaymentChannelOpenWrite{Record: existing.record, RevertToken: ""}, nil
	}
	s.nextToken++
	revertToken := strconv.FormatUint(s.nextToken, 10)
	if !ok {
		s.channels[key] = memoryChannelRow{record: record, revertToken: revertToken}
		return PaymentChannelOpenWrite{Record: record, RevertToken: revertToken}, nil
	}
	stored := forwardOnlyChannel(existing.record, record)
	s.channels[key] = memoryChannelRow{record: stored, revertToken: revertToken}
	return PaymentChannelOpenWrite{Record: stored, RevertToken: ""}, nil
}

// RevertOpen deletes a row this process created, when the token still matches.
func (s *InMemoryPaymentChannelStorage) RevertOpen(_ context.Context, write PaymentChannelOpenWrite) error {
	if write.RevertToken == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := channelStorageKey(write.Record.Network, write.Record.ChannelID)
	existing, ok := s.channels[key]
	if !ok || existing.revertToken != write.RevertToken {
		return nil
	}
	delete(s.channels, key)
	return nil
}

// RecordActivity bumps LastActivityAt, inserting a row when the channel is missing.
func (s *InMemoryPaymentChannelStorage) RecordActivity(_ context.Context, records ...PaymentChannelRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range records {
		key := channelStorageKey(record.Network, record.ChannelID)
		existing, ok := s.channels[key]
		if !ok {
			s.channels[key] = memoryChannelRow{record: record, revertToken: ""}
			continue
		}
		if record.LastActivityAt.After(existing.record.LastActivityAt) {
			existing.record.LastActivityAt = record.LastActivityAt
			s.channels[key] = existing
		}
	}
	return nil
}

// Get returns a stored channel, or nil when the channel is not tracked.
func (s *InMemoryPaymentChannelStorage) Get(_ context.Context, network, channelID string) (*PaymentChannelRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.channels[channelStorageKey(network, channelID)]
	if !ok {
		return nil, nil
	}
	record := existing.record
	return &record, nil
}

// List returns every stored channel on network.
func (s *InMemoryPaymentChannelStorage) List(_ context.Context, network string) ([]PaymentChannelRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]PaymentChannelRecord, 0, len(s.channels))
	for _, row := range s.channels {
		if row.record.Network == network {
			records = append(records, row.record)
		}
	}
	return records, nil
}

// Delete removes a channel from storage.
func (s *InMemoryPaymentChannelStorage) Delete(_ context.Context, network, channelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.channels, channelStorageKey(network, channelID))
	return nil
}

func forwardOnlyChannel(existing, incoming PaymentChannelRecord) PaymentChannelRecord {
	stored := existing
	if incoming.ExpiresAt > stored.ExpiresAt {
		stored.ExpiresAt = incoming.ExpiresAt
	}
	if incoming.LastActivityAt.After(stored.LastActivityAt) {
		stored.LastActivityAt = incoming.LastActivityAt
	}
	return stored
}

func channelStorageKey(network, channelID string) string {
	return network + "\x00" + channelID
}

func writeOpenThenBroadcast[T any](ctx context.Context, args WriteThenBroadcastArgs[T]) (T, error) {
	var zero T
	if len(args.Records) != 1 {
		return zero, errors.New("an open records exactly one channel")
	}
	requested := args.Records[0]
	write, err := args.Storage.RecordOpen(ctx, requested)
	if err != nil {
		return zero, err
	}
	if err := CheckOpenBindings(requested, write.Record); err != nil {
		return zero, err
	}
	reserved := false
	outcome, err := args.Broadcast(func() { reserved = true })
	if err != nil {
		if !reserved {
			revertOpenBestEffort(ctx, args, write)
		}
		return zero, err
	}
	if outcome.Disposition == OpenBroadcastRevert {
		revertOpenBestEffort(ctx, args, write)
	}
	return outcome.Value, nil
}

func revertOpenBestEffort[T any](ctx context.Context, args WriteThenBroadcastArgs[T], write PaymentChannelOpenWrite) {
	if err := args.Storage.RevertOpen(ctx, write); err != nil {
		ReportStorageError(args.OnStorageError, err, write.Record.Network, write.Record.ChannelID)
	}
}
