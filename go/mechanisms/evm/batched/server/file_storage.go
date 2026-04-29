package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

// FileChannelStorage is a file-backed SessionStorage. Each session is stored
// as {root}/server/{channelId}.json. CompareAndSet is serialised through an
// exclusive lock file ({channelId}.json.lock) so concurrent writers see the
// loser as a no-op rather than racing.
type FileChannelStorage struct {
	root string
}

// NewFileChannelStorage returns a file-backed server session storage.
func NewFileChannelStorage(opts batched.FileChannelStorageOptions) *FileChannelStorage {
	return &FileChannelStorage{root: opts.Directory}
}

func (s *FileChannelStorage) filePath(channelId string) string {
	return filepath.Join(s.root, "server", strings.ToLower(channelId)+".json")
}

func (s *FileChannelStorage) Get(channelId string) (*ChannelSession, error) {
	out := &ChannelSession{}
	ok, err := batched.ReadJSONFile(s.filePath(channelId), out)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return out, nil
}

func (s *FileChannelStorage) Set(channelId string, session *ChannelSession) error {
	return batched.WriteJSONAtomic(s.filePath(channelId), session)
}

func (s *FileChannelStorage) Delete(channelId string) error {
	if err := os.Remove(s.filePath(channelId)); err != nil && !batched.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *FileChannelStorage) List() ([]*ChannelSession, error) {
	dir := filepath.Join(s.root, "server")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if batched.IsNotExist(err) {
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
			if batched.IsNotExist(err) {
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
// The mkdir call mirrors the TS fix in 5a007ae70 — without it, the very first
// CompareAndSet on a fresh directory fails with ENOENT on the lock file.
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
	ok, err := batched.ReadJSONFile(path, current)
	if err != nil {
		return false, err
	}
	if ok && current.ChargedCumulativeAmount != expectedCharged {
		return false, nil
	}
	if err := batched.WriteJSONAtomic(path, session); err != nil {
		return false, err
	}
	return true, nil
}
