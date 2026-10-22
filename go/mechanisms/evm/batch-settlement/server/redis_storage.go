package server

import "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"

type (
	RedisChannelStorage        = storage.RedisChannelStorage[*storage.Channel]
	RedisChannelLockStorage    = storage.RedisChannelLockStorage
	RedisChannelStorageClient  = storage.RedisChannelStorageClient
	RedisChannelStorageOptions = storage.RedisChannelStorageOptions
	RedisSetOptions            = storage.RedisSetOptions
)

// NewRedisChannelStorage creates Redis-backed server channel storage.
func NewRedisChannelStorage(opts RedisChannelStorageOptions) *RedisChannelStorage {
	return storage.NewRedisChannelStorage[*storage.Channel](opts)
}

// NewRedisChannelLockStorage creates Redis-backed admission locks (no channel JSON).
func NewRedisChannelLockStorage(opts RedisChannelStorageOptions) *RedisChannelLockStorage {
	return storage.NewRedisChannelLockStorage(opts)
}
