package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const (
	testChA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testChB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testChC = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

func sampleSession(id, charged string) *Channel {
	return &Channel{
		ChannelId:               id,
		ChannelConfig:           batchsettlement.ChannelConfig{Payer: "0x1", Receiver: "0x2"},
		ChargedCumulativeAmount: charged,
		SignedMaxClaimable:      "1000",
		Signature:               "0xsig",
		Balance:                 "900",
		TotalClaimed:            "100",
		WithdrawRequestedAt:     0,
		RefundNonce:             0,
		LastRequestTimestamp:    1,
	}
}

func mustSeedChannel(t *testing.T, s *InMemoryChannelStorage[*Channel], sess *Channel) {
	t.Helper()
	if _, err := s.UpdateChannel(context.Background(), sess.ChannelId, func(*Channel) *Channel { return sess.Clone() }); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func TestInMemoryChannelStorage_GetMissing(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	_, err := s.Get(context.Background(), "missing")
	if err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("expected ErrInvalidChannelId, got %v", err)
	}
}

func TestInMemoryChannelStorage_GetMissingCanonical(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	got, err := s.Get(context.Background(), testChA)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil")
	}
}

func TestInMemoryChannelStorage_UpsertGet(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	in := sampleSession(testChA, "10")
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return in.Clone() }); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	got, err := s.Get(context.Background(), testChA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("round-trip mismatch")
	}
}

func TestInMemoryChannelStorage_ReturnsCopy(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	in := sampleSession(testChA, "10")
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return in }); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	in.Balance = "999"
	got, _ := s.Get(context.Background(), testChA)
	if got.Balance != "900" {
		t.Fatalf("input pointer shared")
	}
	got.Balance = "1"
	got2, _ := s.Get(context.Background(), testChA)
	if got2.Balance != "900" {
		t.Fatalf("output pointer shared")
	}
}

func TestInMemoryChannelStorage_UpdateChannelDelete(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	mustSeedChannel(t, s, sampleSession(testChA, "10"))
	ok, err := s.Acquire(context.Background(), testChA, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil }); err != nil {
		t.Fatalf("UpdateChannel delete: %v", err)
	}
	if got, _ := s.Get(context.Background(), testChA); got != nil {
		t.Fatalf("expected nil after delete")
	}
	held, err := s.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("Delete must drop admission lock: held=%v err=%v", held, err)
	}
	if _, err := s.UpdateChannel(context.Background(), "missing", func(*Channel) *Channel { return nil }); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("UpdateChannel missing: expected ErrInvalidChannelId, got %v", err)
	}
}

func TestInMemoryChannelStorage_UpdateChannelDeleteClearsAdmissionLock(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	mustSeedChannel(t, s, sampleSession(testChA, "10"))
	ok, err := s.Acquire(context.Background(), testChA, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	res, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil })
	if err != nil || res.Status != ChannelDeleted {
		t.Fatalf("UpdateChannel delete: res=%+v err=%v", res, err)
	}
	held, err := s.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("UpdateChannel delete must drop admission lock: held=%v err=%v", held, err)
	}
}

func TestInMemoryChannelStorage_List(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	mustSeedChannel(t, s, sampleSession(testChA, "1"))
	mustSeedChannel(t, s, sampleSession(testChB, "2"))
	got, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got))
	}
	sort.Slice(got, func(i, j int) bool { return got[i].ChannelId < got[j].ChannelId })
	if got[0].ChannelId != testChA || got[1].ChannelId != testChB {
		t.Fatalf("ids = %s, %s", got[0].ChannelId, got[1].ChannelId)
	}
}

func TestInMemoryChannelStorage_RejectsMalformedIds(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	malformed := "../../../etc/passwd"
	if _, err := s.Get(context.Background(), malformed); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Get: expected ErrInvalidChannelId, got %v", err)
	}
	if _, err := s.UpdateChannel(context.Background(), malformed, func(*Channel) *Channel {
		return sampleSession(testChA, "1")
	}); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("UpdateChannel: expected ErrInvalidChannelId, got %v", err)
	}
	list, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("storage mutated by malformed UpdateChannel, got %d sessions", len(list))
	}
}

func TestInMemoryChannelStorage_MixedCaseCanonicalGet(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	upper := "0x" + strings.ToUpper(strings.TrimPrefix(testChA, "0x"))
	mustSeedChannel(t, s, sampleSession(upper, "7"))
	got, err := s.Get(context.Background(), testChA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil || got.ChargedCumulativeAmount != "7" {
		t.Fatalf("mixed-case Get missed lowercased key: %+v", got)
	}
}

func TestInMemoryChannelStorage_ExpiredAdmissionLockIsFree(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	ok, err := s.Acquire(context.Background(), testChA, "old", 1)
	if err != nil || !ok {
		t.Fatalf("Acquire old: ok=%v err=%v", ok, err)
	}
	time.Sleep(5 * time.Millisecond)
	held, err := s.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("expired lock should be free: held=%v err=%v", held, err)
	}
	ok, err = s.Acquire(context.Background(), testChA, "new", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire new: ok=%v err=%v", ok, err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "new")
	if err != nil || !held {
		t.Fatalf("new lock should be held: held=%v err=%v", held, err)
	}
}

func TestInMemoryChannelStorage_Concurrent(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			_, _ = s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return sampleSession(testChA, "10") })
			_ = i
		}(i)
		go func() {
			defer wg.Done()
			_, _ = s.List(context.Background())
		}()
	}
	wg.Wait()
}

func TestRethrowLockImplementationError(t *testing.T) {
	if got := RethrowLockImplementationError(nil); got != nil {
		t.Fatalf("nil: %v", got)
	}
	if got := RethrowLockImplementationError(errors.New("lock down")); got != nil {
		t.Fatalf("io: %v", got)
	}
	syntax := &json.SyntaxError{}
	if got := RethrowLockImplementationError(syntax); !errors.Is(got, syntax) {
		t.Fatalf("syntax: %v", got)
	}
	unmarshalType := &json.UnmarshalTypeError{Value: "string", Offset: 1}
	if got := RethrowLockImplementationError(unmarshalType); !errors.Is(got, unmarshalType) {
		t.Fatalf("unmarshal type: %v", got)
	}
	wrapped := fmt.Errorf("hold: %w", syntax)
	if got := RethrowLockImplementationError(wrapped); !errors.Is(got, wrapped) {
		t.Fatalf("wrapped: %v", got)
	}
}

func TestInMemoryChannelStorage_AcquireIsNotReentrant(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	ok, err := s.Acquire(context.Background(), testChA, "same", 60_000)
	if err != nil || !ok {
		t.Fatalf("first Acquire: ok=%v err=%v", ok, err)
	}
	ok, err = s.Acquire(context.Background(), testChA, "same", 120_000)
	if err != nil || ok {
		t.Fatalf("re-entrant Acquire should miss: ok=%v err=%v", ok, err)
	}
	held, err := s.IsHeld(context.Background(), testChA, "same")
	if err != nil || !held {
		t.Fatalf("original holder should remain: held=%v err=%v", held, err)
	}
}

func TestIsChannelLockStorage(t *testing.T) {
	s := NewInMemoryChannelStorage[*Channel]()
	if !IsChannelLockStorage(s) {
		t.Fatal("in-memory store should implement ChannelLockStorage")
	}
	if IsChannelLockStorage(struct{}{}) {
		t.Fatal("empty struct should not implement ChannelLockStorage")
	}
}
