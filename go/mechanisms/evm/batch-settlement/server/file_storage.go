package server

import (
	"os"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

type (
	FileChannelStorage   = storage.FileChannelStorage[*storage.Channel]
	ExclusiveFileOptions = storage.ExclusiveFileOptions
)

// NewFileChannelStorage returns a file-backed server session storage.
func NewFileChannelStorage(opts batchsettlement.FileChannelStorageOptions) *FileChannelStorage {
	return storage.NewFileChannelStorage[*storage.Channel](opts)
}

// AcquireExclusiveFile creates lockPath with O_EXCL, polling until the marker
// is free or stale.
func AcquireExclusiveFile(lockPath string, opts *ExclusiveFileOptions) (*os.File, error) {
	return storage.AcquireExclusiveFile(lockPath, opts)
}
