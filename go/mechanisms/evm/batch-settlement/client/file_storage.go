package client

import (
	"os"
	"path/filepath"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// FileClientChannelStorage persists each channel's client context as
// {root}/client/{channelId}.json so sessions survive process restarts.
type FileClientChannelStorage struct {
	root string
}

// NewFileClientChannelStorage returns a file-backed client session storage rooted at opts.Directory.
func NewFileClientChannelStorage(opts batchsettlement.FileChannelStorageOptions) *FileClientChannelStorage {
	return &FileClientChannelStorage{root: opts.Directory}
}

func (s *FileClientChannelStorage) filePath(key string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(key)
	if err != nil {
		return "", err
	}
	return batchsettlement.ResolveWithinDir(filepath.Join(s.root, "client"), id+".json")
}

func (s *FileClientChannelStorage) Get(channelId string) (*BatchSettlementClientContext, error) {
	path, err := s.filePath(channelId)
	if err != nil {
		return nil, err
	}
	out := &BatchSettlementClientContext{}
	ok, err := batchsettlement.ReadJSONFile(path, out)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return out, nil
}

func (s *FileClientChannelStorage) Set(channelId string, ctx *BatchSettlementClientContext) error {
	path, err := s.filePath(channelId)
	if err != nil {
		return err
	}
	return batchsettlement.WriteJSONAtomic(path, ctx)
}

func (s *FileClientChannelStorage) Delete(channelId string) error {
	path, err := s.filePath(channelId)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !batchsettlement.IsNotExist(err) {
		return err
	}
	return nil
}
