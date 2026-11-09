package client

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

func newFileStore(t *testing.T) (*FileClientChannelStorage, string) {
	t.Helper()
	dir := t.TempDir()
	return NewFileClientChannelStorage(batchsettlement.FileChannelStorageOptions{Directory: dir}), dir
}

func TestFileClientStorage_GetMissing(t *testing.T) {
	s, _ := newFileStore(t)
	got, err := s.Get(missingChannelID)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestFileClientStorage_SetGetRoundTrip(t *testing.T) {
	s, _ := newFileStore(t)
	in := sampleCtx()
	if err := s.Set(testChannelID, in); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := s.Get(testChannelID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("mismatch:\nwant %+v\ngot  %+v", in, got)
	}
}

func TestFileClientStorage_PathLowercased(t *testing.T) {
	s, dir := newFileStore(t)
	const upper = "0xABCDEF0000000000000000000000000000000000000000000000000000000000"
	const lower = "0xabcdef0000000000000000000000000000000000000000000000000000000000"
	if err := s.Set(upper, sampleCtx()); err != nil {
		t.Fatalf("Set: %v", err)
	}
	expected := filepath.Join(dir, "client", lower+".json")
	if _, err := os.Stat(expected); err != nil {
		t.Fatalf("expected file at %s: %v", expected, err)
	}
}

func TestFileClientStorage_GetCaseInsensitiveOnPath(t *testing.T) {
	s, _ := newFileStore(t)
	const upper = "0xABCDEF0000000000000000000000000000000000000000000000000000000000"
	const lower = "0xabcdef0000000000000000000000000000000000000000000000000000000000"
	_ = s.Set(upper, sampleCtx())
	// Get should normalise to the same lowercase path
	got, err := s.Get(lower)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got == nil {
		t.Fatal("expected hit on lowercased lookup")
	}
}

func TestFileClientStorage_Delete(t *testing.T) {
	s, dir := newFileStore(t)
	_ = s.Set(testChannelID, sampleCtx())
	if err := s.Delete(testChannelID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, _ := s.Get(testChannelID)
	if got != nil {
		t.Fatalf("post-delete got %+v", got)
	}
	if err := s.Delete(testChannelID); err != nil {
		t.Fatalf("Delete-missing should not error: %v", err)
	}
	path := filepath.Join(dir, "client", testChannelID+".json")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected file removed, stat err=%v", err)
	}
}

func TestFileClientStorage_GetMalformed(t *testing.T) {
	s, dir := newFileStore(t)
	bad := filepath.Join(dir, "client", testChannelID+".json")
	_ = os.MkdirAll(filepath.Dir(bad), 0o755)
	_ = os.WriteFile(bad, []byte("not json{"), 0o644)
	if _, err := s.Get(testChannelID); err == nil {
		t.Fatal("expected error for malformed file")
	}
}
