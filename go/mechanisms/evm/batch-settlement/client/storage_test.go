package client

import (
	"reflect"
	"sync"
	"testing"
)

func sampleCtx() *BatchSettlementClientContext {
	return &BatchSettlementClientContext{
		ChargedCumulativeAmount: "100",
		Balance:                 "900",
		TotalClaimed:            "50",
		DepositAmount:           "1000",
		SignedMaxClaimable:      "500",
		Signature:               "0xsig",
	}
}

func TestInMemoryClientChannelStorage_GetMissing(t *testing.T) {
	s := NewInMemoryClientChannelStorage()
	got, err := s.Get("missing")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestInMemoryClientChannelStorage_SetGet(t *testing.T) {
	s := NewInMemoryClientChannelStorage()
	in := sampleCtx()
	if err := s.Set("ch", in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get("ch")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("round-trip mismatch:\nwant %+v\ngot  %+v", in, got)
	}
}

func TestInMemoryClientChannelStorage_ReturnsCopy(t *testing.T) {
	s := NewInMemoryClientChannelStorage()
	in := sampleCtx()
	_ = s.Set("ch", in)

	// Mutating the input should not affect stored value.
	in.Balance = "0"
	got, _ := s.Get("ch")
	if got.Balance != "900" {
		t.Fatalf("storage shares input pointer: %s", got.Balance)
	}

	// Mutating returned value should not affect storage.
	got.Balance = "1"
	got2, _ := s.Get("ch")
	if got2.Balance != "900" {
		t.Fatalf("storage shares output pointer: %s", got2.Balance)
	}
}

func TestInMemoryClientChannelStorage_Delete(t *testing.T) {
	s := NewInMemoryClientChannelStorage()
	_ = s.Set("ch", sampleCtx())
	if err := s.Delete("ch"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, _ := s.Get("ch")
	if got != nil {
		t.Fatalf("expected nil after delete, got %+v", got)
	}
	// Deleting missing should not error.
	if err := s.Delete("missing"); err != nil {
		t.Fatalf("Delete missing: %v", err)
	}
}

func TestInMemoryClientChannelStorage_ConcurrentAccess(t *testing.T) {
	s := NewInMemoryClientChannelStorage()
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			_ = s.Set("ch", sampleCtx())
			_ = i
		}(i)
		go func() {
			defer wg.Done()
			_, _ = s.Get("ch")
		}()
	}
	wg.Wait()
}
