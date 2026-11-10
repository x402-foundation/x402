package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const (
	defaultRedisKeyPrefix      = "x402:batch-settlement"
	defaultLockRetryIntervalMs = 10
	defaultMaxUpdateWaitMs     = 5000
	defaultRedisScanCount      = 100
	redisUpdateExpectedMissing = "0"
	redisUpdateExpectedPresent = "1"
	redisUpdateOperationDelete = "delete"
	redisUpdateOperationKeep   = "keep"
	redisUpdateOperationSet    = "set"
)

// updateChannelScript applies a compare-and-write mutation. ARGV:
// expectedExists ("0"|"1"), expected raw value, operation
// ("delete"|"keep"|"set"), nextValue (set only). Returns {applied,
// currentOrNext} where applied is 0|1.
const updateChannelScript = `
local current = redis.call("GET", KEYS[1])
local expectedExists = ARGV[1]
local expected = ARGV[2]
local operation = ARGV[3]
local nextValue = ARGV[4]

if expectedExists == "0" then
  if current ~= false then
    return {0, current}
  end
elseif current ~= expected then
  return {0, current or false}
end

if operation == "delete" then
  redis.call("DEL", KEYS[1])
  redis.call("DEL", KEYS[2])
  return {1, false}
end

if operation == "set" then
  redis.call("SET", KEYS[1], nextValue)
  return {1, nextValue}
end

return {1, current or false}
`

const compareAndDelScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

// RedisSetOptions configures a SET. NX is SET NX; PX is expiry in milliseconds.
type RedisSetOptions struct {
	NX bool
	PX int64
}

// RedisChannelStorageClient is the Redis/Valkey surface used by RedisChannelStorage
// and RedisChannelLockStorage. Inject an adapter around a client such as go-redis;
// the SDK does not depend on a specific Redis library.
type RedisChannelStorageClient interface {
	Get(ctx context.Context, key string) (value string, ok bool, err error)
	Set(ctx context.Context, key, value string, opts *RedisSetOptions) (ok bool, err error)
	Del(ctx context.Context, key string) (deleted int64, err error)
	Eval(ctx context.Context, script string, keys []string, args []string) (any, error)
	// Scan returns every key matching pattern. count is a SCAN COUNT hint;
	// implementations should iterate the cursor to completion.
	Scan(ctx context.Context, match string, count int) (keys []string, err error)
}

// RedisChannelStorageOptions configures Redis-backed channel storage.
type RedisChannelStorageOptions struct {
	Client              RedisChannelStorageClient
	KeyPrefix           string
	LockRetryIntervalMs int
	MaxUpdateWaitMs     int
	ScanCount           int
}

// RedisChannelLockStorage is a Redis/Valkey-backed ChannelLockStorage using
// SET NX PX and compare-and-delete. Lock keys are
// `{prefix}:server:lock:{channelId}` so they can be used independently of
// channel JSON (for example FileChannelStorage plus Redis locks).
type RedisChannelLockStorage struct {
	client    RedisChannelStorageClient
	keyPrefix string
}

var _ ChannelLockStorage = (*RedisChannelLockStorage)(nil)

// NewRedisChannelLockStorage creates Redis-backed admission locks (no channel JSON).
func NewRedisChannelLockStorage(opts RedisChannelStorageOptions) *RedisChannelLockStorage {
	prefix := opts.KeyPrefix
	if prefix == "" {
		prefix = defaultRedisKeyPrefix
	}
	return &RedisChannelLockStorage{
		client:    opts.Client,
		keyPrefix: prefix,
	}
}

func (s *RedisChannelLockStorage) lockKey(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return s.keyPrefix + ":server:lock:" + id, nil
}

// Acquire takes a per-channel admission lock with a single atomic SET NX PX.
//
// Intentionally not re-entrant: do not add a GET-then-SET PX refresh for the
// same pendingId; that pattern races and can extend another holder's lock.
func (s *RedisChannelLockStorage) Acquire(ctx context.Context, channelId string, pendingId string, ttlMs int64) (bool, error) {
	key, err := s.lockKey(channelId)
	if err != nil {
		return false, err
	}
	return s.client.Set(ctx, key, pendingId, &RedisSetOptions{NX: true, PX: ttlMs})
}

// Release compares-and-deletes the admission lock only when pendingId still holds it.
func (s *RedisChannelLockStorage) Release(ctx context.Context, channelId string, pendingId string) error {
	key, err := s.lockKey(channelId)
	if err != nil {
		return err
	}
	_, err = s.client.Eval(ctx, compareAndDelScript, []string{key}, []string{pendingId})
	return err
}

// IsHeld reports whether a live admission lock exists, optionally matching pendingId.
func (s *RedisChannelLockStorage) IsHeld(ctx context.Context, channelId string, pendingId string) (bool, error) {
	key, err := s.lockKey(channelId)
	if err != nil {
		return false, err
	}
	current, ok, err := s.client.Get(ctx, key)
	if err != nil {
		return false, err
	}
	if !ok || current == "" {
		return false, nil
	}
	if pendingId == "" {
		return true, nil
	}
	return current == pendingId, nil
}

// RedisChannelStorage is a Redis/Valkey-backed ChannelStorage with optimistic
// atomic updates (Lua compare-and-write). It embeds RedisChannelLockStorage so
// one object implements both roles.
type RedisChannelStorage[T ChannelRecord[T]] struct {
	*RedisChannelLockStorage
	channelKeyPrefix  string
	lockRetryInterval time.Duration
	maxUpdateWait     time.Duration
	scanCount         int
}

var (
	_ ChannelStorage[*Channel] = (*RedisChannelStorage[*Channel])(nil)
	_ ChannelLockStorage       = (*RedisChannelStorage[*Channel])(nil)
)

// NewRedisChannelStorage creates Redis-backed channel storage.
func NewRedisChannelStorage[T ChannelRecord[T]](opts RedisChannelStorageOptions) *RedisChannelStorage[T] {
	lock := NewRedisChannelLockStorage(opts)
	retryMs := opts.LockRetryIntervalMs
	if retryMs <= 0 {
		retryMs = defaultLockRetryIntervalMs
	}
	maxUpdateMs := opts.MaxUpdateWaitMs
	if maxUpdateMs <= 0 {
		maxUpdateMs = defaultMaxUpdateWaitMs
	}
	scanCount := opts.ScanCount
	if scanCount <= 0 {
		scanCount = defaultRedisScanCount
	}
	return &RedisChannelStorage[T]{
		RedisChannelLockStorage: lock,
		channelKeyPrefix:        lock.keyPrefix + ":server:channel",
		lockRetryInterval:       time.Duration(retryMs) * time.Millisecond,
		maxUpdateWait:           time.Duration(maxUpdateMs) * time.Millisecond,
		scanCount:               scanCount,
	}
}

func (s *RedisChannelStorage[T]) channelKey(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return s.channelKeyPrefix + ":" + id, nil
}

// Get loads a persisted channel record, or the zero T when the key is missing.
func (s *RedisChannelStorage[T]) Get(ctx context.Context, channelId string) (T, error) {
	key, err := s.channelKey(channelId)
	if err != nil {
		return zeroRecord[T](), err
	}
	_, session, err := s.readChannelRaw(ctx, key)
	return session, err
}

// List returns stored records sorted by channelId.
func (s *RedisChannelStorage[T]) List(ctx context.Context) ([]T, error) {
	keys, err := s.client.Scan(ctx, s.channelKeyPrefix+":*", s.scanCount)
	if err != nil {
		return nil, err
	}
	sessions := make([]T, 0, len(keys))
	for _, key := range keys {
		if strings.HasSuffix(key, ":lock") {
			continue
		}
		session, err := s.loadChannel(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("unmarshal %s: %w", key, err)
		}
		if isZeroRecord(session) {
			continue
		}
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Base().ChannelId < sessions[j].Base().ChannelId })
	return sessions, nil
}

// UpdateChannel inspects and mutates a channel record with Redis
// compare-and-write retries. Contested writes that still cannot be applied
// after maxUpdateWait return status "conflict". A successful delete also
// drops the admission lock key.
func (s *RedisChannelStorage[T]) UpdateChannel(ctx context.Context, channelId string, update func(current T) T) (*ChannelUpdateResult[T], error) {
	key, err := s.channelKey(channelId)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(s.maxUpdateWait)
	for {
		currentRaw, current, err := s.readChannelRaw(ctx, key)
		if err != nil {
			return nil, err
		}
		next := update(current)
		var applied bool
		switch {
		case sameRecord(next, current):
			applied, err = s.commitUpdate(ctx, channelId, key, currentRaw, redisUpdateOperationKeep, "")
			if err != nil {
				return nil, err
			}
			if applied {
				return &ChannelUpdateResult[T]{Channel: current, Status: ChannelUnchanged}, nil
			}
		case isZeroRecord(next):
			applied, err = s.commitUpdate(ctx, channelId, key, currentRaw, redisUpdateOperationDelete, "")
			if err != nil {
				return nil, err
			}
			if applied {
				status := ChannelUnchanged
				if !isZeroRecord(current) {
					status = ChannelDeleted
				}
				return &ChannelUpdateResult[T]{Status: status}, nil
			}
		default:
			nextRaw, err := json.Marshal(next)
			if err != nil {
				return nil, err
			}
			applied, err = s.commitUpdate(ctx, channelId, key, currentRaw, redisUpdateOperationSet, string(nextRaw))
			if err != nil {
				return nil, err
			}
			if applied {
				return &ChannelUpdateResult[T]{Channel: next, Status: ChannelUpdated}, nil
			}
		}

		if !time.Now().Before(deadline) {
			return &ChannelUpdateResult[T]{Channel: current, Status: ChannelConflict}, nil
		}
		time.Sleep(s.lockRetryInterval)
	}
}

func (s *RedisChannelStorage[T]) loadChannel(ctx context.Context, key string) (T, error) {
	_, session, err := s.readChannelRaw(ctx, key)
	return session, err
}

func (s *RedisChannelStorage[T]) readChannelRaw(ctx context.Context, key string) (*string, T, error) {
	var zero T
	raw, ok, err := s.client.Get(ctx, key)
	if err != nil {
		return nil, zero, err
	}
	if !ok || raw == "" {
		return nil, zero, nil
	}
	var session T
	if err := json.Unmarshal([]byte(raw), &session); err != nil {
		return nil, zero, err
	}
	return &raw, session, nil
}

func (s *RedisChannelStorage[T]) commitUpdate(ctx context.Context, channelId, key string, expectedRaw *string, operation, nextRaw string) (bool, error) {
	lockKey, err := s.lockKey(channelId)
	if err != nil {
		return false, err
	}
	expectedExists := redisUpdateExpectedMissing
	expected := ""
	if expectedRaw != nil {
		expectedExists = redisUpdateExpectedPresent
		expected = *expectedRaw
	}
	value, err := s.client.Eval(ctx, updateChannelScript, []string{key, lockKey}, []string{expectedExists, expected, operation, nextRaw})
	if err != nil {
		return false, err
	}
	return parseRedisUpdateResult(value)
}

func parseRedisUpdateResult(value any) (bool, error) {
	items, ok := value.([]any)
	if !ok || len(items) < 1 {
		return false, fmt.Errorf("unexpected Redis update response")
	}
	applied, ok := redisInt(items[0])
	if !ok || (applied != 0 && applied != 1) {
		return false, fmt.Errorf("unexpected Redis update status")
	}
	if len(items) > 1 {
		if _, ok := redisOptionalString(items[1]); !ok {
			return false, fmt.Errorf("unexpected Redis update value")
		}
	}
	return applied == 1, nil
}

func redisInt(value any) (int64, bool) {
	switch n := value.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case string:
		parsed, err := strconv.ParseInt(n, 10, 64)
		return parsed, err == nil
	case []byte:
		parsed, err := strconv.ParseInt(string(n), 10, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func redisOptionalString(value any) (string, bool) {
	switch s := value.(type) {
	case nil:
		return "", true
	case bool:
		return "", !s
	case string:
		return s, true
	case []byte:
		return string(s), true
	default:
		return "", false
	}
}
