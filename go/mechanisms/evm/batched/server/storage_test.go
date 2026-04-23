package server

import (
	"reflect"
	"sort"
	"sync"
	"testing"

	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

func sampleSession(id, charged string) *ChannelSession {
	return &ChannelSession{
		ChannelId:               id,
		ChannelConfig:           batched.ChannelConfig{Payer: "0x1", Receiver: "0x2"},
		Payer:                   "0x1",
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

func TestInMemorySessionStorage_GetMissing(t *testing.T) {
	s := NewInMemorySessionStorage()
	got, err := s.Get("missing")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil")
	}
}

func TestInMemorySessionStorage_SetGet(t *testing.T) {
	s := NewInMemorySessionStorage()
	in := sampleSession("ch", "10")
	if err := s.Set("ch", in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get("ch")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("round-trip mismatch")
	}
}

func TestInMemorySessionStorage_ReturnsCopy(t *testing.T) {
	s := NewInMemorySessionStorage()
	in := sampleSession("ch", "10")
	_ = s.Set("ch", in)
	in.Balance = "999"
	got, _ := s.Get("ch")
	if got.Balance != "900" {
		t.Fatalf("input pointer shared")
	}
	got.Balance = "1"
	got2, _ := s.Get("ch")
	if got2.Balance != "900" {
		t.Fatalf("output pointer shared")
	}
}

func TestInMemorySessionStorage_Delete(t *testing.T) {
	s := NewInMemorySessionStorage()
	_ = s.Set("ch", sampleSession("ch", "10"))
	if err := s.Delete("ch"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := s.Get("ch"); got != nil {
		t.Fatalf("expected nil after delete")
	}
	if err := s.Delete("missing"); err != nil {
		t.Fatalf("Delete missing: %v", err)
	}
}

func TestInMemorySessionStorage_List(t *testing.T) {
	s := NewInMemorySessionStorage()
	_ = s.Set("a", sampleSession("a", "1"))
	_ = s.Set("b", sampleSession("b", "2"))
	got, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got))
	}
	sort.Slice(got, func(i, j int) bool { return got[i].ChannelId < got[j].ChannelId })
	if got[0].ChannelId != "a" || got[1].ChannelId != "b" {
		t.Fatalf("ids = %s, %s", got[0].ChannelId, got[1].ChannelId)
	}
}

func TestInMemorySessionStorage_CompareAndSet_FirstWriteWins(t *testing.T) {
	s := NewInMemorySessionStorage()
	ok, err := s.CompareAndSet("ch", "0", sampleSession("ch", "10"))
	if err != nil || !ok {
		t.Fatalf("CAS on missing should succeed: ok=%v err=%v", ok, err)
	}
	got, _ := s.Get("ch")
	if got.ChargedCumulativeAmount != "10" {
		t.Fatalf("not stored")
	}
}

func TestInMemorySessionStorage_CompareAndSet_StaleFails(t *testing.T) {
	s := NewInMemorySessionStorage()
	_ = s.Set("ch", sampleSession("ch", "10"))
	ok, err := s.CompareAndSet("ch", "0", sampleSession("ch", "20"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("stale CAS should fail")
	}
	got, _ := s.Get("ch")
	if got.ChargedCumulativeAmount != "10" {
		t.Fatalf("storage mutated by failed CAS: %s", got.ChargedCumulativeAmount)
	}
}

func TestInMemorySessionStorage_CompareAndSet_FreshSucceeds(t *testing.T) {
	s := NewInMemorySessionStorage()
	_ = s.Set("ch", sampleSession("ch", "10"))
	ok, err := s.CompareAndSet("ch", "10", sampleSession("ch", "20"))
	if err != nil || !ok {
		t.Fatalf("CAS with matching expected should succeed: ok=%v err=%v", ok, err)
	}
	got, _ := s.Get("ch")
	if got.ChargedCumulativeAmount != "20" {
		t.Fatalf("CAS did not update: %s", got.ChargedCumulativeAmount)
	}
}

func TestInMemorySessionStorage_Concurrent(t *testing.T) {
	s := NewInMemorySessionStorage()
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			_ = s.Set("ch", sampleSession("ch", "10"))
			_ = i
		}(i)
		go func() {
			defer wg.Done()
			_, _ = s.List()
		}()
	}
	wg.Wait()
}
