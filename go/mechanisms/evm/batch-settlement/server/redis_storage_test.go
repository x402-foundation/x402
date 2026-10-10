package server

import (
	"context"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

type lockOnlyRedis struct {
	store map[string]string
}

func (c *lockOnlyRedis) Get(_ context.Context, key string) (string, bool, error) {
	v, ok := c.store[key]
	return v, ok, nil
}

func (c *lockOnlyRedis) Set(_ context.Context, key, value string, opts *RedisSetOptions) (bool, error) {
	if opts != nil && opts.NX {
		if _, exists := c.store[key]; exists {
			return false, nil
		}
	}
	if c.store == nil {
		c.store = make(map[string]string)
	}
	c.store[key] = value
	return true, nil
}

func (c *lockOnlyRedis) Del(_ context.Context, key string) (int64, error) {
	if _, ok := c.store[key]; !ok {
		return 0, nil
	}
	delete(c.store, key)
	return 1, nil
}

func (c *lockOnlyRedis) Eval(_ context.Context, _ string, keys []string, args []string) (any, error) {
	if len(keys) == 0 {
		return int64(0), nil
	}
	if len(args) > 0 && c.store[keys[0]] == args[0] {
		delete(c.store, keys[0])
		return int64(1), nil
	}
	return int64(0), nil
}

func (c *lockOnlyRedis) Scan(_ context.Context, _ string, _ int) ([]string, error) { return nil, nil }

func TestFileDurableWithRedisLockStore(t *testing.T) {
	file := NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{Directory: t.TempDir()})
	redisLock := NewRedisChannelLockStorage(RedisChannelStorageOptions{
		Client:    &lockOnlyRedis{store: make(map[string]string)},
		KeyPrefix: "test:mixed",
	})
	scheme := NewBatchSettlementEvmScheme("0x9876543210987654321098765432109876543210", &BatchSettlementEvmSchemeServerConfig{
		Storage:     file,
		LockStorage: redisLock,
	})
	if scheme.GetStorage() != file {
		t.Fatal("expected file storage")
	}
	if scheme.GetLockStorage() != redisLock {
		t.Fatal("expected redis lock store")
	}
	ok, err := redisLock.Acquire(context.Background(), testChA, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	held, err := file.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("file should not hold lock: held=%v err=%v", held, err)
	}
	held, err = redisLock.IsHeld(context.Background(), testChA, "pending")
	if err != nil || !held {
		t.Fatalf("redis lock should be held: held=%v err=%v", held, err)
	}
}
