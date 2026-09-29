package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// FileChannelStorage is a file-backed SessionStorage. Each session is stored
// as {root}/server/{channelId}.json. CompareAndSet is serialised through an
// exclusive lock file ({channelId}.json.lock) so concurrent writers see the
// loser as a no-op rather than racing.
type FileChannelStorage struct {
	root string
}

// NewFileChannelStorage returns a file-backed server session storage.
func NewFileChannelStorage(opts batchsettlement.FileChannelStorageOptions) *FileChannelStorage {
	return &FileChannelStorage{root: opts.Directory}
}

func (s *FileChannelStorage) filePath(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return batchsettlement.ResolveWithinDir(filepath.Join(s.root, "server"), id+".json")
}

func (s *FileChannelStorage) holdPath(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return batchsettlement.ResolveWithinDir(filepath.Join(s.root, "server"), id+".hold")
}

func (s *FileChannelStorage) Get(channelId string) (*ChannelSession, error) {
	path, err := s.filePath(channelId)
	if err != nil {
		return nil, err
	}
	out := &ChannelSession{}
	ok, err := batchsettlement.ReadJSONFile(path, out)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return out, nil
}

func (s *FileChannelStorage) Set(channelId string, session *ChannelSession) error {
	path, err := s.filePath(channelId)
	if err != nil {
		return err
	}
	return batchsettlement.WriteJSONAtomic(path, session)
}

func (s *FileChannelStorage) Delete(channelId string) error {
	path, err := s.filePath(channelId)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !batchsettlement.IsNotExist(err) {
		return err
	}
	return s.dropHold(channelId)
}

func (s *FileChannelStorage) List() ([]*ChannelSession, error) {
	dir := filepath.Join(s.root, "server")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if batchsettlement.IsNotExist(err) {
			return []*ChannelSession{}, nil
		}
		return nil, err
	}

	sessions := make([]*ChannelSession, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".lock") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			// Skip files that disappeared between readdir and read (concurrent delete).
			if batchsettlement.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		out := &ChannelSession{}
		if err := json.Unmarshal(raw, out); err != nil {
			return nil, fmt.Errorf("unmarshal %s: %w", name, err)
		}
		sessions = append(sessions, out)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].ChannelId < sessions[j].ChannelId })
	return sessions, nil
}

// CompareAndSet uses an exclusive lock file to serialise concurrent writers.
// The mkdir call ensures the very first CompareAndSet on a fresh directory
// does not fail with ENOENT on the lock file.
func (s *FileChannelStorage) CompareAndSet(channelId string, expectedCharged string, session *ChannelSession) (bool, error) {
	path, err := s.filePath(channelId)
	if err != nil {
		return false, err
	}
	lockPath := path + ".lock"

	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return false, fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}

	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return false, nil
		}
		return false, fmt.Errorf("acquire lock %s: %w", lockPath, err)
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()

	current := &ChannelSession{}
	ok, err := batchsettlement.ReadJSONFile(path, current)
	if err != nil {
		return false, err
	}
	if ok && current.ChargedCumulativeAmount != expectedCharged {
		return false, nil
	}
	if err := batchsettlement.WriteJSONAtomic(path, session); err != nil {
		return false, err
	}
	return true, nil
}

// UpdateChannel atomically reads, mutates, and writes a channel record under an
// exclusive lock file. Returning a different pointer commits the new session;
// returning nil deletes the file; returning the same pointer is treated as a
// no-op (status: unchanged).
func (s *FileChannelStorage) UpdateChannel(channelId string, update func(current *ChannelSession) *ChannelSession) (*ChannelUpdateResult, error) {
	path, err := s.filePath(channelId)
	if err != nil {
		return nil, err
	}
	lockPath := path + ".lock"

	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}

	lockFile, err := acquireExclusiveFile(lockPath, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()

	var current *ChannelSession
	out := &ChannelSession{}
	ok, err := batchsettlement.ReadJSONFile(path, out)
	if err != nil {
		return nil, err
	}
	if ok {
		current = out
	}

	next := update(current)
	switch {
	case next == nil:
		if !ok {
			return &ChannelUpdateResult{Status: ChannelUnchanged}, nil
		}
		if rmErr := os.Remove(path); rmErr != nil && !batchsettlement.IsNotExist(rmErr) {
			return nil, rmErr
		}
		if dropErr := s.dropHold(channelId); dropErr != nil {
			return nil, dropErr
		}
		return &ChannelUpdateResult{Status: ChannelDeleted}, nil
	case current != nil && next == current:
		return &ChannelUpdateResult{Channel: current, Status: ChannelUnchanged}, nil
	default:
		if err := batchsettlement.WriteJSONAtomic(path, next); err != nil {
			return nil, err
		}
		return &ChannelUpdateResult{Channel: next, Status: ChannelUpdated}, nil
	}
}

func (s *FileChannelStorage) Acquire(channelId string, pendingId string, ttlMs int64) (bool, error) {
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

func (s *FileChannelStorage) Release(channelId string, pendingId string) error {
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

func (s *FileChannelStorage) IsHeld(channelId string, pendingId string) (bool, error) {
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

func (s *FileChannelStorage) dropHold(channelId string) error {
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

// withHoldLock serializes Acquire, Release, and IsHeld on {id}.hold.lock so an
// expired hold cannot be unlinked out from under a new holder.
func (s *FileChannelStorage) withHoldLock(channelId string, fn func() error) error {
	path, err := s.holdPath(channelId)
	if err != nil {
		return err
	}
	lockPath := path + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}
	lockFile, err := acquireExclusiveFile(lockPath, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()
	return fn()
}

type acquireExclusiveFileOptions struct {
	maxAttempts   int
	retryInterval time.Duration
	staleAfter    time.Duration
}

func (o *acquireExclusiveFileOptions) withDefaults() acquireExclusiveFileOptions {
	out := *o
	if out.maxAttempts <= 0 {
		out.maxAttempts = 50
	}
	if out.retryInterval <= 0 {
		out.retryInterval = 10 * time.Millisecond
	}
	if out.staleAfter <= 0 {
		out.staleAfter = 2 * time.Second
	}
	return out
}

// acquireExclusiveFile creates lockPath with O_EXCL, polling until the marker is
// free or stale (mtime older than staleAfter). Stale markers are unlinked so a
// crash cannot pin the channel forever.
func acquireExclusiveFile(lockPath string, opts *acquireExclusiveFileOptions) (*os.File, error) {
	var cfg acquireExclusiveFileOptions
	if opts != nil {
		cfg = opts.withDefaults()
	} else {
		cfg = (&acquireExclusiveFileOptions{}).withDefaults()
	}
	for attempt := 0; attempt < cfg.maxAttempts; attempt++ {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			return f, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire lock %s: %w", lockPath, err)
		}
		info, statErr := os.Stat(lockPath)
		if statErr != nil {
			if batchsettlement.IsNotExist(statErr) {
				continue
			}
			return nil, fmt.Errorf("acquire lock %s: %w", lockPath, statErr)
		}
		if time.Since(info.ModTime()) > cfg.staleAfter {
			_ = os.Remove(lockPath)
			continue
		}
		time.Sleep(cfg.retryInterval)
	}
	return nil, fmt.Errorf("acquire lock %s: contended", lockPath)
}
