package server

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

func newServerFileStore(t *testing.T) (*FileChannelStorage, string) {
	t.Helper()
	dir := t.TempDir()
	return NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{Directory: dir}), dir
}

func TestServerFileStorage_GetMissing(t *testing.T) {
	s, _ := newServerFileStore(t)
	_, err := s.Get("missing")
	if err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("expected ErrInvalidChannelId, got %v", err)
	}
}

func TestServerFileStorage_GetMissingCanonical(t *testing.T) {
	s, _ := newServerFileStore(t)
	got, err := s.Get(testChA)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestServerFileStorage_SetGetRoundTrip(t *testing.T) {
	s, _ := newServerFileStore(t)
	in := sampleSession(testChA, "5")
	if err := s.Set(testChA, in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get(testChA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("mismatch:\nwant %+v\ngot  %+v", in, got)
	}
}

func TestServerFileStorage_PathLowercased(t *testing.T) {
	s, dir := newServerFileStore(t)
	upper := "0x" + strings.ToUpper(strings.TrimPrefix(testChA, "0x"))
	_ = s.Set(upper, sampleSession(upper, "1"))
	expected := filepath.Join(dir, "server", testChA+".json")
	if _, err := os.Stat(expected); err != nil {
		t.Fatalf("expected file at %s: %v", expected, err)
	}
}

func TestServerFileStorage_Delete(t *testing.T) {
	s, _ := newServerFileStore(t)
	_ = s.Set(testChA, sampleSession(testChA, "1"))
	if err := s.Delete(testChA); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := s.Get(testChA); got != nil {
		t.Fatalf("expected nil after delete")
	}
	if err := s.Delete(testChA); err != nil {
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
	_ = s.Set(testChB, sampleSession(testChB, "2"))
	_ = s.Set(testChA, sampleSession(testChA, "1"))
	got, err := s.List()
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got))
	}
	if got[0].ChannelId != testChA || got[1].ChannelId != testChB {
		t.Fatalf("not sorted: %s, %s", got[0].ChannelId, got[1].ChannelId)
	}
}

func TestServerFileStorage_List_SkipsNonJSON(t *testing.T) {
	s, dir := newServerFileStore(t)
	_ = s.Set(testChA, sampleSession(testChA, "1"))
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
	ok, err := s.CompareAndSet(testChA, "0", sampleSession(testChA, "10"))
	if err != nil || !ok {
		t.Fatalf("expected ok, got ok=%v err=%v", ok, err)
	}
	got, _ := s.Get(testChA)
	if got == nil || got.ChargedCumulativeAmount != "10" {
		t.Fatalf("not stored")
	}
}

func TestServerFileStorage_CompareAndSet_StaleFails(t *testing.T) {
	s, _ := newServerFileStore(t)
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
		t.Fatalf("storage mutated by failed CAS")
	}
}

func TestServerFileStorage_CompareAndSet_FreshSucceeds(t *testing.T) {
	s, _ := newServerFileStore(t)
	_ = s.Set(testChA, sampleSession(testChA, "10"))
	ok, err := s.CompareAndSet(testChA, "10", sampleSession(testChA, "20"))
	if err != nil || !ok {
		t.Fatalf("expected ok, got ok=%v err=%v", ok, err)
	}
	got, _ := s.Get(testChA)
	if got.ChargedCumulativeAmount != "20" {
		t.Fatalf("CAS did not update")
	}
}

func TestServerFileStorage_CompareAndSet_LockHeld(t *testing.T) {
	s, dir := newServerFileStore(t)
	// Manually create the lock file to simulate a concurrent writer.
	lockDir := filepath.Join(dir, "server")
	_ = os.MkdirAll(lockDir, 0o755)
	lockPath := filepath.Join(lockDir, testChA+".json.lock")
	if err := os.WriteFile(lockPath, []byte("held"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer os.Remove(lockPath)
	ok, err := s.CompareAndSet(testChA, "0", sampleSession(testChA, "10"))
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
	ok, err := s.CompareAndSet(testChA, "0", sampleSession(testChA, "1"))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("CAS from cold should succeed")
	}
}

func TestServerFileStorage_RejectsPathEscapeMalformedIds(t *testing.T) {
	s, dir := newServerFileStore(t)
	malformed := "../../../etc/passwd"
	if err := s.Set(malformed, sampleSession(testChA, "1")); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Set: expected ErrInvalidChannelId, got %v", err)
	}
	if _, err := s.Get(malformed); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Get: expected ErrInvalidChannelId, got %v", err)
	}
	// No files should have been created under the storage root.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected empty storage root, got %v", entries)
	}
}

func TestServerFileStorage_RejectsPrefixedValidId(t *testing.T) {
	s, dir := newServerFileStore(t)
	malformed := "../server/" + testChA
	if err := s.Set(malformed, sampleSession(testChA, "1")); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Set: expected ErrInvalidChannelId, got %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected empty storage root, got %v", entries)
	}
}
