package client

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

// FileClientChannelStorage persists each channel's client context as
// {root}/client/{channelId}.json so sessions survive process restarts.
type FileClientChannelStorage struct {
	root string
}

// NewFileClientChannelStorage returns a file-backed client session storage rooted at opts.Directory.
func NewFileClientChannelStorage(opts batched.FileChannelStorageOptions) *FileClientChannelStorage {
	return &FileClientChannelStorage{root: opts.Directory}
}

func (s *FileClientChannelStorage) filePath(key string) string {
	return filepath.Join(s.root, "client", strings.ToLower(key)+".json")
}

func (s *FileClientChannelStorage) Get(channelId string) (*BatchedClientContext, error) {
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

func (s *FileClientChannelStorage) Set(channelId string, ctx *BatchedClientContext) error {
	return batched.WriteJSONAtomic(s.filePath(channelId), ctx)
}

func (s *FileClientChannelStorage) Delete(channelId string) error {
	if err := os.Remove(s.filePath(channelId)); err != nil && !batched.IsNotExist(err) {
		return err
	}
	return nil
}
