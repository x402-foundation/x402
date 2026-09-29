package client

import (
	"reflect"
	"sync"
	"testing"
)

const testChannelID = "0xabcdef0000000000000000000000000000000000000000000000000000000001"
const missingChannelID = "0x0000000000000000000000000000000000000000000000000000000000000099"

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

type failingClientChannelStorage struct {
	storage   ClientChannelStorage
	getErr    error
	setErr    error
	deleteErr error
	setCalls  int
}

func (s *failingClientChannelStorage) Get(channelId string) (*BatchSettlementClientContext, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.storage.Get(channelId)
}

func (s *failingClientChannelStorage) Set(channelId string, ctx *BatchSettlementClientContext) error {
	s.setCalls++
	if s.setErr != nil {
		return s.setErr
	}
	return s.storage.Set(channelId, ctx)
}

func (s *failingClientChannelStorage) Delete(channelId string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	return s.storage.Delete(channelId)
}

func TestInMemoryClientChannelStorage_GetMissing(t *testing.T) {
	s := NewInMemoryClientChannelStorage()
	got, err := s.Get(missingChannelID)
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
	if err := s.Set(testChannelID, in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get(testChannelID)
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
	_ = s.Set(testChannelID, in)

	// Mutating the input should not affect stored value.
	in.Balance = "0"
	got, _ := s.Get(testChannelID)
	if got.Balance != "900" {
		t.Fatalf("storage shares input pointer: %s", got.Balance)
	}

	// Mutating returned value should not affect storage.
	got.Balance = "1"
	got2, _ := s.Get(testChannelID)
	if got2.Balance != "900" {
		t.Fatalf("storage shares output pointer: %s", got2.Balance)
	}
}

func TestInMemoryClientChannelStorage_Delete(t *testing.T) {
	s := NewInMemoryClientChannelStorage()
	_ = s.Set(testChannelID, sampleCtx())
	if err := s.Delete(testChannelID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, _ := s.Get(testChannelID)
	if got != nil {
		t.Fatalf("expected nil after delete, got %+v", got)
	}
	// Deleting missing should not error.
	if err := s.Delete(missingChannelID); err != nil {
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
			_ = s.Set(testChannelID, sampleCtx())
			_ = i
		}(i)
		go func() {
			defer wg.Done()
			_, _ = s.Get(testChannelID)
		}()
	}
	wg.Wait()
}
