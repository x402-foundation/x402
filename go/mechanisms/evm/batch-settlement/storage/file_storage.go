package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const (
	fileLockMaxAttempts     = 50
	fileLockRetryIntervalMs = 10
	fileLockStaleMs         = 30_000
)

// FileLockOwner is the owner record written into every exclusive lock marker.
//
// The on-disk protocol is shared with the TypeScript SDK: a lock file contains
// JSON `{ pid, token, createdAt }`. Stealing is only allowed when the owner is
// provably gone (dead PID) or when an unreadable legacy marker is older than
// StaleMs. A live owner is never stolen, no matter how old the marker is.
type FileLockOwner struct {
	Pid       int    `json:"pid"`
	Token     string `json:"token"`
	CreatedAt int64  `json:"createdAt"`
}

// FileChannelStorage is a file-backed ChannelStorage. Each record is stored as
// {root}/server/{channelId}.json. UpdateChannel is serialised through an
// exclusive lock file ({channelId}.json.lock) so concurrent writers cannot
// interleave.
type FileChannelStorage[T ChannelRecord[T]] struct {
	root string
}

var (
	_ ChannelStorage[*Channel] = (*FileChannelStorage[*Channel])(nil)
	_ ChannelLockStorage       = (*FileChannelStorage[*Channel])(nil)
)

// NewFileChannelStorage returns a file-backed channel store.
func NewFileChannelStorage[T ChannelRecord[T]](opts batchsettlement.FileChannelStorageOptions) *FileChannelStorage[T] {
	return &FileChannelStorage[T]{root: opts.Directory}
}

func (s *FileChannelStorage[T]) filePath(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return batchsettlement.ResolveWithinDir(filepath.Join(s.root, "server"), id+".json")
}

func (s *FileChannelStorage[T]) holdPath(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return batchsettlement.ResolveWithinDir(filepath.Join(s.root, "server"), id+".hold")
}

// Get loads a persisted channel record, or the zero T when the file is missing.
func (s *FileChannelStorage[T]) Get(_ context.Context, channelId string) (T, error) {
	var zero T
	path, err := s.filePath(channelId)
	if err != nil {
		return zero, err
	}
	var out T
	ok, err := batchsettlement.ReadJSONFile(path, &out)
	if err != nil {
		return zero, err
	}
	if !ok {
		return zero, nil
	}
	return out, nil
}

// List returns stored records sorted by channelId.
func (s *FileChannelStorage[T]) List(_ context.Context) ([]T, error) {
	dir := filepath.Join(s.root, "server")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if batchsettlement.IsNotExist(err) {
			return []T{}, nil
		}
		return nil, err
	}

	sessions := make([]T, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".lock") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			if batchsettlement.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		var out T
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("unmarshal %s: %w", name, err)
		}
		sessions = append(sessions, out)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Base().ChannelId < sessions[j].Base().ChannelId })
	return sessions, nil
}

// UpdateChannel atomically reads, mutates, and writes a channel record under an
// exclusive lock file. Returning a different pointer commits the new session;
// returning the zero T deletes the file; returning the same pointer is a no-op.
func (s *FileChannelStorage[T]) UpdateChannel(_ context.Context, channelId string, update func(current T) T) (*ChannelUpdateResult[T], error) {
	path, err := s.filePath(channelId)
	if err != nil {
		return nil, err
	}
	lockPath := path + ".lock"

	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}

	lockFile, err := AcquireExclusiveFile(lockPath, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()

	var current T
	ok, err := batchsettlement.ReadJSONFile(path, &current)
	if err != nil {
		return nil, err
	}
	if !ok {
		current = zeroRecord[T]()
	}

	next := update(current)
	if sameRecord(next, current) {
		return &ChannelUpdateResult[T]{Channel: current, Status: ChannelUnchanged}, nil
	}
	if isZeroRecord(next) {
		if !ok {
			return &ChannelUpdateResult[T]{Status: ChannelUnchanged}, nil
		}
		if rmErr := os.Remove(path); rmErr != nil && !batchsettlement.IsNotExist(rmErr) {
			return nil, rmErr
		}
		if dropErr := s.dropHold(channelId); dropErr != nil {
			return nil, dropErr
		}
		return &ChannelUpdateResult[T]{Status: ChannelDeleted}, nil
	}
	if err := batchsettlement.WriteJSONAtomic(path, next); err != nil {
		return nil, err
	}
	return &ChannelUpdateResult[T]{Channel: next, Status: ChannelUpdated}, nil
}

// Acquire takes a per-channel admission lock via a sidecar hold file.
//
// Serialized with Release and IsHeld on {id}.hold.lock so an expired hold
// cannot be unlinked out from under a new holder. Not re-entrant: a live hold,
// including one owned by the same pendingId, is a miss.
func (s *FileChannelStorage[T]) Acquire(_ context.Context, channelId string, pendingId string, ttlMs int64) (bool, error) {
	var acquired bool
	err := s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil && !batchsettlement.IsNotExist(readErr) {
			return readErr
		}
		if readErr == nil {
			var existing admissionLock
			if unmarshalErr := json.Unmarshal(raw, &existing); unmarshalErr != nil {
				return unmarshalErr
			}
			if existing.ExpiresAt > time.Now().UnixMilli() {
				acquired = false
				return nil
			}
		}
		record, err := json.Marshal(admissionLock{PendingId: pendingId, ExpiresAt: time.Now().UnixMilli() + ttlMs})
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, record, 0o644); err != nil {
			return err
		}
		acquired = true
		return nil
	})
	return acquired, err
}

// Release drops the admission lock only when pendingId still holds it.
func (s *FileChannelStorage[T]) Release(_ context.Context, channelId string, pendingId string) error {
	return s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			if batchsettlement.IsNotExist(err) {
				return nil
			}
			return err
		}
		var hold admissionLock
		if err := json.Unmarshal(raw, &hold); err != nil {
			return err
		}
		if hold.PendingId != pendingId {
			return nil
		}
		if rmErr := os.Remove(path); rmErr != nil && !batchsettlement.IsNotExist(rmErr) {
			return rmErr
		}
		return nil
	})
}

// IsHeld reports whether a live admission lock exists, optionally matching pendingId.
func (s *FileChannelStorage[T]) IsHeld(_ context.Context, channelId string, pendingId string) (bool, error) {
	var held bool
	err := s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			if batchsettlement.IsNotExist(err) {
				held = false
				return nil
			}
			return err
		}
		var hold admissionLock
		if err := json.Unmarshal(raw, &hold); err != nil {
			return err
		}
		if hold.ExpiresAt <= time.Now().UnixMilli() {
			held = false
			return nil
		}
		if pendingId == "" {
			held = true
			return nil
		}
		held = hold.PendingId == pendingId
		return nil
	})
	return held, err
}

func (s *FileChannelStorage[T]) dropHold(channelId string) error {
	return s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		if rmErr := os.Remove(path); rmErr != nil && !batchsettlement.IsNotExist(rmErr) {
			return rmErr
		}
		return nil
	})
}

func (s *FileChannelStorage[T]) withHoldLock(channelId string, fn func() error) error {
	path, err := s.holdPath(channelId)
	if err != nil {
		return err
	}
	lockPath := path + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}
	lockFile, err := AcquireExclusiveFile(lockPath, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()
	return fn()
}

// ExclusiveFileOptions bounds exclusive lock-file create attempts.
type ExclusiveFileOptions struct {
	MaxAttempts     int
	RetryIntervalMs int
	StaleMs         int
}

func (o *ExclusiveFileOptions) withDefaults() ExclusiveFileOptions {
	out := ExclusiveFileOptions{}
	if o != nil {
		out = *o
	}
	if out.MaxAttempts <= 0 {
		out.MaxAttempts = fileLockMaxAttempts
	}
	if out.RetryIntervalMs <= 0 {
		out.RetryIntervalMs = fileLockRetryIntervalMs
	}
	if out.StaleMs <= 0 {
		out.StaleMs = fileLockStaleMs
	}
	return out
}

// AcquireExclusiveFile creates lockPath with O_EXCL, writing an owner marker
// ({ pid, token, createdAt }) under the same on-disk protocol as the
// TypeScript SDK. A contended marker is unlinked only when its owner is
// provably gone (dead PID) or when a legacy/unreadable marker is older than
// StaleMs. A live owner is never stolen: slow writers keep the lock and
// contenders fail with `contended` after MaxAttempts.
func AcquireExclusiveFile(lockPath string, opts *ExclusiveFileOptions) (*os.File, error) {
	cfg := opts.withDefaults()
	staleAfter := time.Duration(cfg.StaleMs) * time.Millisecond
	retryInterval := time.Duration(cfg.RetryIntervalMs) * time.Millisecond
	for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			// Best effort: the O_EXCL marker already serializes writers even if
			// the owner payload cannot be persisted; steal decisions fall back
			// to mtime.
			if raw, marshalErr := json.Marshal(FileLockOwner{
				Pid:       os.Getpid(),
				Token:     newFileLockToken(),
				CreatedAt: time.Now().UnixMilli(),
			}); marshalErr == nil {
				_, _ = f.Write(raw)
				_ = f.Sync()
			}
			return f, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire lock %s: %w", lockPath, err)
		}
		stale, statErr := isStaleLock(lockPath, staleAfter)
		if statErr != nil {
			return nil, statErr
		}
		if stale {
			_ = os.Remove(lockPath)
			continue
		}
		time.Sleep(retryInterval)
	}
	return nil, fmt.Errorf("acquire lock %s: contended", lockPath)
}

// isStaleLock reports whether lockPath may be unlinked and retried.
//
// A marker with a readable owner is stale only when its PID is provably gone.
// Legacy or unreadable markers (empty file from an older SDK, partial write
// after a crash) fall back to mtime age so crash debris cannot pin the channel
// forever.
func isStaleLock(lockPath string, staleAfter time.Duration) (bool, error) {
	info, statErr := os.Stat(lockPath)
	if statErr != nil {
		if batchsettlement.IsNotExist(statErr) {
			return true, nil
		}
		return false, fmt.Errorf("acquire lock %s: %w", lockPath, statErr)
	}
	mtime := info.ModTime()
	raw, readErr := os.ReadFile(lockPath)
	if readErr != nil {
		if batchsettlement.IsNotExist(readErr) {
			return true, nil
		}
		return false, fmt.Errorf("acquire lock %s: %w", lockPath, readErr)
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return time.Since(mtime) >= staleAfter, nil
	}
	if pid, ok := parseLockOwnerPid(raw); ok {
		return !isOwnerAlive(pid), nil
	}
	return time.Since(mtime) >= staleAfter, nil
}

// parseLockOwnerPid extracts the owner PID from a lock marker.
// ok=false means the marker is legacy or corrupt, and the caller falls back
// to mtime age so crash debris cannot pin the channel forever.
func parseLockOwnerPid(raw []byte) (int, bool) {
	var fields map[string]interface{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return 0, false
	}
	pidVal, ok := fields["pid"]
	if !ok {
		return 0, false
	}
	return lockOwnerPid(pidVal)
}

func lockOwnerPid(v interface{}) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n != float64(int(n)) {
			return 0, false
		}
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
}

// isOwnerAlive reports whether a lock-owner PID may still be running.
//
// Signal 0: ESRCH means provably gone, EPERM means alive but un-signallable,
// and any other failure fails closed to alive so a live writer is never stolen.
func isOwnerAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if pid == os.Getpid() {
		return true
	}
	err := syscall.Kill(pid, 0)
	switch {
	case err == nil:
		return true
	case errors.Is(err, syscall.ESRCH):
		return false
	default:
		// EPERM means alive but un-signallable; any other failure fails
		// closed to alive so a live writer is never stolen.
		return true
	}
}

func newFileLockToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err == nil {
		return hex.EncodeToString(b[:])
	}
	return fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
}
