package server

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

func newServerFileStore(t *testing.T) (*FileChannelStorage, string) {
	t.Helper()
	dir := t.TempDir()
	return NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{Directory: dir}), dir
}

func TestServerFileStorage_GetMissing(t *testing.T) {
	s, _ := newServerFileStore(t)
	got, err := s.Get("missing")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestServerFileStorage_SetGetRoundTrip(t *testing.T) {
	s, _ := newServerFileStore(t)
	in := sampleSession("ch", "5")
	if err := s.Set("ch", in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get("ch")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("mismatch:\nwant %+v\ngot  %+v", in, got)
	}
}

func TestServerFileStorage_PathLowercased(t *testing.T) {
	s, dir := newServerFileStore(t)
	_ = s.Set("0xABCDEF", sampleSession("0xABCDEF", "1"))
	expected := filepath.Join(dir, "server", "0xabcdef.json")
	if _, err := os.Stat(expected); err != nil {
		t.Fatalf("expected file at %s: %v", expected, err)
	}
}

func TestServerFileStorage_Delete(t *testing.T) {
	s, _ := newServerFileStore(t)
	_ = s.Set("ch", sampleSession("ch", "1"))
	if err := s.Delete("ch"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := s.Get("ch"); got != nil {
		t.Fatalf("expected nil after delete")
	}
	if err := s.Delete("ch"); err != nil {
		t.Fatalf("Delete-missing should not error: %v", err)
	}
}

func TestServerFileStorage_List_Empty(t *testing.T) {
	s, _ := newServerFileStore(t)
	got, err := s.List()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty list, got %d", len(got))
	}
}

func TestServerFileStorage_List_Populated(t *testing.T) {
	s, _ := newServerFileStore(t)
	_ = s.Set("b", sampleSession("b", "2"))
	_ = s.Set("a", sampleSession("a", "1"))
	got, err := s.List()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got))
	}
	// Should be sorted by ChannelId
	sort.SliceIsSorted(got, func(i, j int) bool { return got[i].ChannelId < got[j].ChannelId })
	if got[0].ChannelId != "a" || got[1].ChannelId != "b" {
		t.Fatalf("not sorted: %s, %s", got[0].ChannelId, got[1].ChannelId)
	}
}

func TestServerFileStorage_List_SkipsNonJSON(t *testing.T) {
	s, dir := newServerFileStore(t)
	_ = s.Set("a", sampleSession("a", "1"))
	// Drop a non-JSON file in the same directory
	_ = os.WriteFile(filepath.Join(dir, "server", "junk.txt"), []byte("noise"), 0o644)
	got, err := s.List()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 session, got %d", len(got))
	}
}

func TestServerFileStorage_List_Malformed(t *testing.T) {
	s, dir := newServerFileStore(t)
	_ = os.MkdirAll(filepath.Join(dir, "server"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "server", "bad.json"), []byte("not json{"), 0o644)
	if _, err := s.List(); err == nil {
		t.Fatal("expected unmarshal error")
	}
}

func TestServerFileStorage_CompareAndSet_FirstWriteWins(t *testing.T) {
	s, _ := newServerFileStore(t)
	ok, err := s.CompareAndSet("ch", "0", sampleSession("ch", "10"))
	if err != nil || !ok {
		t.Fatalf("expected ok, got ok=%v err=%v", ok, err)
	}
	got, _ := s.Get("ch")
	if got == nil || got.ChargedCumulativeAmount != "10" {
		t.Fatalf("not stored")
	}
}

func TestServerFileStorage_CompareAndSet_StaleFails(t *testing.T) {
	s, _ := newServerFileStore(t)
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
		t.Fatalf("storage mutated by failed CAS")
	}
}

func TestServerFileStorage_CompareAndSet_FreshSucceeds(t *testing.T) {
	s, _ := newServerFileStore(t)
	_ = s.Set("ch", sampleSession("ch", "10"))
	ok, err := s.CompareAndSet("ch", "10", sampleSession("ch", "20"))
	if err != nil || !ok {
		t.Fatalf("expected ok, got ok=%v err=%v", ok, err)
	}
	got, _ := s.Get("ch")
	if got.ChargedCumulativeAmount != "20" {
		t.Fatalf("CAS did not update")
	}
}

func TestServerFileStorage_CompareAndSet_LockHeld(t *testing.T) {
	s, dir := newServerFileStore(t)
	// Manually create the lock file to simulate a concurrent writer.
	lockDir := filepath.Join(dir, "server")
	_ = os.MkdirAll(lockDir, 0o755)
	lockPath := filepath.Join(lockDir, "ch.json.lock")
	if err := os.WriteFile(lockPath, []byte("held"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer os.Remove(lockPath)
	ok, err := s.CompareAndSet("ch", "0", sampleSession("ch", "10"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("CAS should yield to lock holder")
	}
}

func TestServerFileStorage_CompareAndSet_CreatesDirectoryFromCold(t *testing.T) {
	// Mirrors the 5a007ae70 fix — a brand-new directory must not blow up on
	// the very first CompareAndSet.
	dir := t.TempDir()
	s := NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{Directory: dir})
	ok, err := s.CompareAndSet("ch", "0", sampleSession("ch", "1"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("CAS from cold should succeed")
	}
}
