package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
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

func (s *FileChannelStorage) filePath(channelId string) string {
	return filepath.Join(s.root, "server", strings.ToLower(channelId)+".json")
}

func (s *FileChannelStorage) Get(channelId string) (*ChannelSession, error) {
	out := &ChannelSession{}
	ok, err := batchsettlement.ReadJSONFile(s.filePath(channelId), out)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return out, nil
}

func (s *FileChannelStorage) Set(channelId string, session *ChannelSession) error {
	return batchsettlement.WriteJSONAtomic(s.filePath(channelId), session)
}

func (s *FileChannelStorage) Delete(channelId string) error {
	if err := os.Remove(s.filePath(channelId)); err != nil && !batchsettlement.IsNotExist(err) {
		return err
	}
	return nil
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
	path := s.filePath(channelId)
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
	path := s.filePath(channelId)
	lockPath := path + ".lock"

	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}

	// Spin-lock until we acquire the exclusive lock file. Concurrent writers see
	// ErrExist and retry; bounded retries keep this from hanging on stale locks.
	const maxAttempts = 50
	var lockFile *os.File
	for attempt := 0; attempt < maxAttempts; attempt++ {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			lockFile = f
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire lock %s: %w", lockPath, err)
		}
	}
	if lockFile == nil {
		return nil, fmt.Errorf("acquire lock %s: contended", lockPath)
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
