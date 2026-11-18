package storage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

func newServerFileStore(t *testing.T) (*FileChannelStorage[*Channel], string) {
	t.Helper()
	dir := t.TempDir()
	return NewFileChannelStorage[*Channel](batchsettlement.FileChannelStorageOptions{Directory: dir}), dir
}

func mustSeedFileChannel(t *testing.T, s *FileChannelStorage[*Channel], sess *Channel) {
	t.Helper()
	if _, err := s.UpdateChannel(context.Background(), sess.ChannelId, func(*Channel) *Channel { return sess.Clone() }); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func TestServerFileStorage_GetMissing(t *testing.T) {
	s, _ := newServerFileStore(t)
	_, err := s.Get(context.Background(), "missing")
	if err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("expected ErrInvalidChannelId, got %v", err)
	}
}

func TestServerFileStorage_GetMissingCanonical(t *testing.T) {
	s, _ := newServerFileStore(t)
	got, err := s.Get(context.Background(), testChA)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestServerFileStorage_UpsertGetRoundTrip(t *testing.T) {
	s, _ := newServerFileStore(t)
	in := sampleSession(testChA, "5")
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return in.Clone() }); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	got, err := s.Get(context.Background(), testChA)
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
	mustSeedFileChannel(t, s, sampleSession(upper, "1"))
	expected := filepath.Join(dir, "server", testChA+".json")
	if _, err := os.Stat(expected); err != nil {
		t.Fatalf("expected file at %s: %v", expected, err)
	}
}

func TestServerFileStorage_UpdateChannelDelete(t *testing.T) {
	s, dir := newServerFileStore(t)
	mustSeedFileChannel(t, s, sampleSession(testChA, "1"))
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
		t.Fatalf("Delete must drop hold: held=%v err=%v", held, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "server", testChA+".hold")); !os.IsNotExist(err) {
		t.Fatalf("hold file should be gone: %v", err)
	}
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil }); err != nil {
		t.Fatalf("UpdateChannel delete-missing should not error: %v", err)
	}
}

func TestServerFileStorage_List_Empty(t *testing.T) {
	s, _ := newServerFileStore(t)
	got, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty list, got %d", len(got))
	}
}

func TestServerFileStorage_List_Populated(t *testing.T) {
	s, _ := newServerFileStore(t)
	mustSeedFileChannel(t, s, sampleSession(testChB, "2"))
	mustSeedFileChannel(t, s, sampleSession(testChA, "1"))
	got, err := s.List(context.Background())
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
	mustSeedFileChannel(t, s, sampleSession(testChA, "1"))
	// Drop a non-JSON file in the same directory
	_ = os.WriteFile(filepath.Join(dir, "server", "junk.txt"), []byte("noise"), 0o644)
	got, err := s.List(context.Background())
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
	if _, err := s.List(context.Background()); err == nil {
		t.Fatal("expected unmarshal error")
	}
}

func TestServerFileStorage_UpdateChannelCreatesDirectoryFromCold(t *testing.T) {
	dir := t.TempDir()
	s := NewFileChannelStorage[*Channel](batchsettlement.FileChannelStorageOptions{Directory: dir})
	result, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return sampleSession(testChA, "1") })
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if result.Status != ChannelUpdated {
		t.Fatalf("status = %q", result.Status)
	}
}

func TestServerFileStorage_RejectsPathEscapeMalformedIds(t *testing.T) {
	s, dir := newServerFileStore(t)
	malformed := "../../../etc/passwd"
	if _, err := s.UpdateChannel(context.Background(), malformed, func(*Channel) *Channel {
		return sampleSession(testChA, "1")
	}); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("UpdateChannel: expected ErrInvalidChannelId, got %v", err)
	}
	if _, err := s.Get(context.Background(), malformed); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
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
	if _, err := s.UpdateChannel(context.Background(), malformed, func(*Channel) *Channel {
		return sampleSession(testChA, "1")
	}); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("UpdateChannel: expected ErrInvalidChannelId, got %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected empty storage root, got %v", entries)
	}
}

func TestServerFileStorage_HoldSidecarDoesNotWritePendingOntoChannelJSON(t *testing.T) {
	s, dir := newServerFileStore(t)
	channel := sampleSession(testChA, "5")
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return channel }); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	ok, err := s.Acquire(context.Background(), testChA, "first", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire first: ok=%v err=%v", ok, err)
	}
	ok, err = s.Acquire(context.Background(), testChA, "second", 60_000)
	if err != nil || ok {
		t.Fatalf("second acquire should fail: ok=%v err=%v", ok, err)
	}
	held, err := s.IsHeld(context.Background(), testChA, "first")
	if err != nil || !held {
		t.Fatalf("first should be held: held=%v err=%v", held, err)
	}

	serverDir := filepath.Join(dir, "server")
	entries, err := os.ReadDir(serverDir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	var holds []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".hold") {
			holds = append(holds, e.Name())
		}
	}
	if len(holds) != 1 || holds[0] != testChA+".hold" {
		t.Fatalf("holds = %v", holds)
	}
	raw, err := os.ReadFile(filepath.Join(serverDir, testChA+".json"))
	if err != nil {
		t.Fatalf("read json: %v", err)
	}
	var stored Channel
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(&stored, channel) {
		t.Fatalf("channel JSON mutated:\nwant %+v\ngot  %+v", channel, stored)
	}
	listed, err := s.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0].ChannelId != testChA {
		t.Fatalf("list = %+v err=%v", listed, err)
	}

	if err := s.Release(context.Background(), testChA, "second"); err != nil {
		t.Fatalf("release second: %v", err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "first")
	if err != nil || !held {
		t.Fatalf("first should still be held: held=%v err=%v", held, err)
	}
	if err := s.Release(context.Background(), testChA, "first"); err != nil {
		t.Fatalf("release first: %v", err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("lock should be free: held=%v err=%v", held, err)
	}
	entries, err = os.ReadDir(serverDir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".hold") {
			t.Fatalf("hold file left behind: %s", e.Name())
		}
	}
}

func TestServerFileStorage_ReleaseExpiredPendingIdDoesNotDropNewerHolder(t *testing.T) {
	s, _ := newServerFileStore(t)
	ok, err := s.Acquire(context.Background(), testChA, "expired", 1)
	if err != nil || !ok {
		t.Fatalf("Acquire expired: ok=%v err=%v", ok, err)
	}
	time.Sleep(5 * time.Millisecond)
	ok, err = s.Acquire(context.Background(), testChA, "next", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire next: ok=%v err=%v", ok, err)
	}
	if err := s.Release(context.Background(), testChA, "expired"); err != nil {
		t.Fatalf("Release expired: %v", err)
	}
	held, err := s.IsHeld(context.Background(), testChA, "next")
	if err != nil || !held {
		t.Fatalf("newer holder must remain: held=%v err=%v", held, err)
	}
}

func TestServerFileStorage_ExpiredHoldIsFree(t *testing.T) {
	s, _ := newServerFileStore(t)
	ok, err := s.Acquire(context.Background(), testChA, "expired", 1)
	if err != nil || !ok {
		t.Fatalf("Acquire expired: ok=%v err=%v", ok, err)
	}
	time.Sleep(5 * time.Millisecond)
	ok, err = s.Acquire(context.Background(), testChA, "next", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire next: ok=%v err=%v", ok, err)
	}
	held, err := s.IsHeld(context.Background(), testChA, "expired")
	if err != nil || held {
		t.Fatalf("expired should not be held: held=%v err=%v", held, err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "next")
	if err != nil || !held {
		t.Fatalf("next should be held: held=%v err=%v", held, err)
	}
}

func TestServerFileStorage_MissingHoldIsNotHeld(t *testing.T) {
	s, _ := newServerFileStore(t)
	held, err := s.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("missing hold: held=%v err=%v", held, err)
	}
	if err := s.Release(context.Background(), testChA, "missing"); err != nil {
		t.Fatalf("release missing: %v", err)
	}
}

func TestServerFileStorage_CorruptHoldRethrows(t *testing.T) {
	s, dir := newServerFileStore(t)
	ok, err := s.Acquire(context.Background(), testChA, "ok", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "server", testChA+".hold"), []byte("{nope"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := s.IsHeld(context.Background(), testChA, ""); err == nil {
		t.Fatal("expected IsHeld error")
	}
	if err := s.Release(context.Background(), testChA, "ok"); err == nil {
		t.Fatal("expected Release error")
	}
	if _, err := s.Acquire(context.Background(), testChA, "next", 60_000); err == nil {
		t.Fatal("expected Acquire error")
	}
}

func TestServerFileStorage_StealsStaleHoldLock(t *testing.T) {
	s, dir := newServerFileStore(t)
	holdLock := filepath.Join(dir, "server", testChA+".hold.lock")
	if err := os.MkdirAll(filepath.Dir(holdLock), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(holdLock, []byte("stale"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	stale := time.Now().Add(-60 * time.Second)
	if err := os.Chtimes(holdLock, stale, stale); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	ok, err := s.Acquire(context.Background(), testChA, "fresh", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire after stale steal: ok=%v err=%v", ok, err)
	}
}

func TestAcquireExclusiveFile_ContendedWhenLockFresh(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "marker.lock")
	if err := os.WriteFile(lockPath, []byte("held"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := AcquireExclusiveFile(lockPath, &ExclusiveFileOptions{
		MaxAttempts:     2,
		RetryIntervalMs: 1,
		StaleMs:         60_000,
	})
	if err == nil || !strings.Contains(err.Error(), "contended") {
		t.Fatalf("expected contended, got %v", err)
	}
}

func TestAcquireExclusiveFile_DoesNotStealLiveOwnerEvenWhenOld(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "live.lock")
	handle, err := AcquireExclusiveFile(lockPath, nil)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer func() {
		_ = handle.Close()
		_ = os.Remove(lockPath)
	}()
	stale := time.Now().Add(-60 * time.Second)
	if err := os.Chtimes(lockPath, stale, stale); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	_, err = AcquireExclusiveFile(lockPath, &ExclusiveFileOptions{MaxAttempts: 2, RetryIntervalMs: 1})
	if err == nil || !strings.Contains(err.Error(), "contended") {
		t.Fatalf("expected contended, got %v", err)
	}
}

func TestAcquireExclusiveFile_StealsDeadOwner(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "dead.lock")
	raw, err := json.Marshal(FileLockOwner{Pid: 2147483647, Token: "dead-owner", CreatedAt: time.Now().UnixMilli()})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(lockPath, raw, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	handle, err := AcquireExclusiveFile(lockPath, &ExclusiveFileOptions{MaxAttempts: 5, RetryIntervalMs: 1})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	_ = handle.Close()
	_ = os.Remove(lockPath)
}

func TestFileChannelStorage_AcquireIsNotReentrant(t *testing.T) {
	s, dir := newServerFileStore(t)
	ok, err := s.Acquire(context.Background(), testChA, "same-owner", 60_000)
	if err != nil || !ok {
		t.Fatalf("first Acquire: ok=%v err=%v", ok, err)
	}
	holdPath := filepath.Join(dir, "server", testChA+".hold")
	firstRaw, err := os.ReadFile(holdPath)
	if err != nil {
		t.Fatalf("read hold: %v", err)
	}
	var first admissionLock
	if err := json.Unmarshal(firstRaw, &first); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	ok, err = s.Acquire(context.Background(), testChA, "same-owner", 60_000)
	if err != nil || ok {
		t.Fatalf("re-entrant Acquire should miss: ok=%v err=%v", ok, err)
	}
	secondRaw, err := os.ReadFile(holdPath)
	if err != nil {
		t.Fatalf("read hold after: %v", err)
	}
	var second admissionLock
	if err := json.Unmarshal(secondRaw, &second); err != nil {
		t.Fatalf("unmarshal after: %v", err)
	}
	if second.ExpiresAt != first.ExpiresAt {
		t.Fatalf("TTL refreshed: first=%d second=%d", first.ExpiresAt, second.ExpiresAt)
	}
	held, err := s.IsHeld(context.Background(), testChA, "same-owner")
	if err != nil || !held {
		t.Fatalf("original holder should remain: held=%v err=%v", held, err)
	}
}
