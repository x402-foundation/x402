package client

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

func newFileStore(t *testing.T) (*FileClientChannelStorage, string) {
	t.Helper()
	dir := t.TempDir()
	return NewFileClientChannelStorage(batchsettlement.FileChannelStorageOptions{Directory: dir}), dir
}

func TestFileClientStorage_GetMissing(t *testing.T) {
	s, _ := newFileStore(t)
	got, err := s.Get("missing")
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

func TestFileClientStorage_PathLowercased(t *testing.T) {
	s, dir := newFileStore(t)
	if err := s.Set("0xABCDEF", sampleCtx()); err != nil {
		t.Fatalf("Set: %v", err)
	}
	expected := filepath.Join(dir, "client", "0xabcdef.json")
	if _, err := os.Stat(expected); err != nil {
		t.Fatalf("expected file at %s: %v", expected, err)
	}
}

func TestFileClientStorage_GetCaseInsensitiveOnPath(t *testing.T) {
	s, _ := newFileStore(t)
	_ = s.Set("0xABC", sampleCtx())
	// Get should normalise to the same lowercase path
	got, err := s.Get("0xabc")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got == nil {
		t.Fatal("expected hit on lowercased lookup")
	}
}

func TestFileClientStorage_Delete(t *testing.T) {
	s, dir := newFileStore(t)
	_ = s.Set("ch", sampleCtx())
	if err := s.Delete("ch"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, _ := s.Get("ch")
	if got != nil {
		t.Fatalf("post-delete got %+v", got)
	}
	if err := s.Delete("ch"); err != nil {
		t.Fatalf("Delete-missing should not error: %v", err)
	}
	_ = dir
}

func TestFileClientStorage_GetMalformed(t *testing.T) {
	s, dir := newFileStore(t)
	bad := filepath.Join(dir, "client", "ch.json")
	_ = os.MkdirAll(filepath.Dir(bad), 0o755)
	_ = os.WriteFile(bad, []byte("not json{"), 0o644)
	if _, err := s.Get("ch"); err == nil {
		t.Fatal("expected error for malformed file")
	}
}
