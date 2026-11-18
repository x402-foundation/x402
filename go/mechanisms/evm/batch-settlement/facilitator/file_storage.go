package facilitator

import (
	"os"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

type (
	FileChannelStorage   = storage.FileChannelStorage[*FacilitatorChannel]
	ExclusiveFileOptions = storage.ExclusiveFileOptions
)

// NewFileChannelStorage returns a file-backed facilitator channel store.
func NewFileChannelStorage(opts batchsettlement.FileChannelStorageOptions) *FileChannelStorage {
	return storage.NewFileChannelStorage[*FacilitatorChannel](opts)
}

// AcquireExclusiveFile creates lockPath with O_EXCL, polling until the marker
// is free or stale.
func AcquireExclusiveFile(lockPath string, opts *ExclusiveFileOptions) (*os.File, error) {
	return storage.AcquireExclusiveFile(lockPath, opts)
}
