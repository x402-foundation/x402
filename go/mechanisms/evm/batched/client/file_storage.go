package client

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

// FileClientSessionStorage persists each channel's client context as
// {root}/client/{channelId}.json so sessions survive process restarts.
type FileClientSessionStorage struct {
	root string
}

// NewFileClientSessionStorage returns a file-backed client session storage rooted at opts.Directory.
func NewFileClientSessionStorage(opts batched.FileSessionStorageOptions) *FileClientSessionStorage {
	return &FileClientSessionStorage{root: opts.Directory}
}

func (s *FileClientSessionStorage) filePath(key string) string {
	return filepath.Join(s.root, "client", strings.ToLower(key)+".json")
}

func (s *FileClientSessionStorage) Get(channelId string) (*BatchedClientContext, error) {
	out := &BatchedClientContext{}
	ok, err := batched.ReadJSONFile(s.filePath(channelId), out)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return out, nil
}

func (s *FileClientSessionStorage) Set(channelId string, ctx *BatchedClientContext) error {
	return batched.WriteJSONAtomic(s.filePath(channelId), ctx)
}

func (s *FileClientSessionStorage) Delete(channelId string) error {
	if err := os.Remove(s.filePath(channelId)); err != nil && !batched.IsNotExist(err) {
		return err
	}
	return nil
}
