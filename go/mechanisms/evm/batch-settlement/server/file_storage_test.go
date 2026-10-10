package server

import (
	"context"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

func TestFileDurableWithSeparateLockStore(t *testing.T) {
	dir := t.TempDir()
	file := NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{Directory: dir})
	memLock := NewInMemoryChannelStorage()
	scheme := NewBatchSettlementEvmScheme("0x9876543210987654321098765432109876543210", &BatchSettlementEvmSchemeServerConfig{
		Storage:     file,
		LockStorage: memLock,
	})
	if scheme.GetStorage() != file {
		t.Fatal("expected file storage")
	}
	if scheme.GetLockStorage() != memLock {
		t.Fatal("expected explicit lock store")
	}
	ok, err := memLock.Acquire(context.Background(), testChA, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	held, err := file.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("file should not hold lock: held=%v err=%v", held, err)
	}
	held, err = memLock.IsHeld(context.Background(), testChA, "pending")
	if err != nil || !held {
		t.Fatalf("mem lock should be held: held=%v err=%v", held, err)
	}
}
