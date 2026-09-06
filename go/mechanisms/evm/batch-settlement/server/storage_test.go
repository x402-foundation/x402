package server

import (
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const (
	testChA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testChB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testChC = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

func sampleSession(id, charged string) *ChannelSession {
	return &ChannelSession{
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

func TestInMemoryChannelStorage_GetMissing(t *testing.T) {
	s := NewInMemoryChannelStorage()
	_, err := s.Get("missing")
	if err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("expected ErrInvalidChannelId, got %v", err)
	}
}

func TestInMemoryChannelStorage_GetMissingCanonical(t *testing.T) {
	s := NewInMemoryChannelStorage()
	got, err := s.Get(testChA)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil")
	}
}

func TestInMemoryChannelStorage_SetGet(t *testing.T) {
	s := NewInMemoryChannelStorage()
	in := sampleSession(testChA, "10")
	if err := s.Set(testChA, in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get(testChA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("round-trip mismatch")
	}
}

func TestInMemoryChannelStorage_ReturnsCopy(t *testing.T) {
	s := NewInMemoryChannelStorage()
	in := sampleSession(testChA, "10")
	_ = s.Set(testChA, in)
	in.Balance = "999"
	got, _ := s.Get(testChA)
	if got.Balance != "900" {
		t.Fatalf("input pointer shared")
	}
	got.Balance = "1"
	got2, _ := s.Get(testChA)
	if got2.Balance != "900" {
		t.Fatalf("output pointer shared")
	}
}

func TestInMemoryChannelStorage_Delete(t *testing.T) {
	s := NewInMemoryChannelStorage()
	_ = s.Set(testChA, sampleSession(testChA, "10"))
	if err := s.Delete(testChA); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := s.Get(testChA); got != nil {
		t.Fatalf("expected nil after delete")
	}
	if err := s.Delete("missing"); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Delete missing: expected ErrInvalidChannelId, got %v", err)
	}
}

func TestInMemoryChannelStorage_List(t *testing.T) {
	s := NewInMemoryChannelStorage()
	_ = s.Set(testChA, sampleSession(testChA, "1"))
	_ = s.Set(testChB, sampleSession(testChB, "2"))
	got, err := s.List()
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

func TestInMemoryChannelStorage_CompareAndSet_FirstWriteWins(t *testing.T) {
	s := NewInMemoryChannelStorage()
	ok, err := s.CompareAndSet(testChA, "0", sampleSession(testChA, "10"))
	if err != nil || !ok {
		t.Fatalf("CAS on missing should succeed: ok=%v err=%v", ok, err)
	}
	got, _ := s.Get(testChA)
	if got.ChargedCumulativeAmount != "10" {
		t.Fatalf("not stored")
	}
}

func TestInMemoryChannelStorage_CompareAndSet_StaleFails(t *testing.T) {
	s := NewInMemoryChannelStorage()
	_ = s.Set(testChA, sampleSession(testChA, "10"))
	ok, err := s.CompareAndSet(testChA, "0", sampleSession(testChA, "20"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("stale CAS should fail")
	}
	got, _ := s.Get(testChA)
	if got.ChargedCumulativeAmount != "10" {
		t.Fatalf("storage mutated by failed CAS: %s", got.ChargedCumulativeAmount)
	}
}

func TestInMemoryChannelStorage_CompareAndSet_FreshSucceeds(t *testing.T) {
	s := NewInMemoryChannelStorage()
	_ = s.Set(testChA, sampleSession(testChA, "10"))
	ok, err := s.CompareAndSet(testChA, "10", sampleSession(testChA, "20"))
	if err != nil || !ok {
		t.Fatalf("CAS with matching expected should succeed: ok=%v err=%v", ok, err)
	}
	got, _ := s.Get(testChA)
	if got.ChargedCumulativeAmount != "20" {
		t.Fatalf("CAS did not update: %s", got.ChargedCumulativeAmount)
	}
}

func TestInMemoryChannelStorage_RejectsMalformedIds(t *testing.T) {
	s := NewInMemoryChannelStorage()
	malformed := "../../../etc/passwd"
	if _, err := s.Get(malformed); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Get: expected ErrInvalidChannelId, got %v", err)
	}
	if err := s.Set(malformed, sampleSession(testChA, "1")); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Set: expected ErrInvalidChannelId, got %v", err)
	}
	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("storage mutated by malformed Set, got %d sessions", len(list))
	}
}

func TestInMemoryChannelStorage_MixedCaseCanonicalGet(t *testing.T) {
	s := NewInMemoryChannelStorage()
	upper := "0x" + strings.ToUpper(strings.TrimPrefix(testChA, "0x"))
	if err := s.Set(upper, sampleSession(upper, "7")); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get(testChA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil || got.ChargedCumulativeAmount != "7" {
		t.Fatalf("mixed-case Get missed lowercased key: %+v", got)
	}
}

func TestInMemoryChannelStorage_Concurrent(t *testing.T) {
	s := NewInMemoryChannelStorage()
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			_ = s.Set(testChA, sampleSession(testChA, "10"))
			_ = i
		}(i)
		go func() {
			defer wg.Done()
			_, _ = s.List()
		}()
	}
	wg.Wait()
}
