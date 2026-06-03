package batchsettlement

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestIsNotExist(t *testing.T) {
	if !IsNotExist(fs.ErrNotExist) {
		t.Fatal("fs.ErrNotExist should be NotExist")
	}
	if !IsNotExist(os.ErrNotExist) {
		t.Fatal("os.ErrNotExist should be NotExist")
	}
	if IsNotExist(errors.New("other")) {
		t.Fatal("arbitrary error should not be NotExist")
	}
	if IsNotExist(nil) {
		t.Fatal("nil should not be NotExist")
	}
}

func TestReadJSONFile_Missing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "missing.json")
	var out map[string]interface{}
	exists, err := ReadJSONFile(path, &out)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if exists {
		t.Fatal("expected exists=false")
	}
}

func TestReadJSONFile_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.json")

	in := map[string]interface{}{"k": "v", "n": float64(42)}
	if err := WriteJSONAtomic(path, in); err != nil {
		t.Fatalf("WriteJSONAtomic: %v", err)
	}

	var out map[string]interface{}
	exists, err := ReadJSONFile(path, &out)
	if err != nil {
		t.Fatalf("ReadJSONFile: %v", err)
	}
	if !exists {
		t.Fatal("expected exists=true")
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("round-trip mismatch:\nwant %v\ngot  %v", in, out)
	}
}

func TestReadJSONFile_Malformed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("not json{"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	var out map[string]interface{}
	if _, err := ReadJSONFile(path, &out); err == nil {
		t.Fatal("expected error")
	}
}

func TestWriteJSONAtomic_CreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "a", "b", "c", "data.json")
	if err := WriteJSONAtomic(nested, map[string]interface{}{"x": 1}); err != nil {
		t.Fatalf("err: %v", err)
	}
	if _, err := os.Stat(nested); err != nil {
		t.Fatalf("file not created: %v", err)
	}
}

func TestWriteJSONAtomic_Overwrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.json")

	if err := WriteJSONAtomic(path, map[string]interface{}{"v": 1}); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := WriteJSONAtomic(path, map[string]interface{}{"v": 2}); err != nil {
		t.Fatalf("overwrite: %v", err)
	}

	var out map[string]interface{}
	if _, err := ReadJSONFile(path, &out); err != nil {
		t.Fatalf("read: %v", err)
	}
	if out["v"].(float64) != 2 {
		t.Fatalf("not overwritten: got %v", out)
	}
}

func TestWriteJSONAtomic_NoTempLeaks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.json")
	if err := WriteJSONAtomic(path, map[string]interface{}{"x": 1}); err != nil {
		t.Fatalf("err: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if e.Name() == "data.json" {
			continue
		}
		t.Fatalf("leaked temp file: %s", e.Name())
	}
}

type unmarshalable struct{ Ch chan int }

func TestWriteJSONAtomic_MarshalError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.json")
	if err := WriteJSONAtomic(path, unmarshalable{Ch: make(chan int)}); err == nil {
		t.Fatal("expected marshal error")
	}
}
