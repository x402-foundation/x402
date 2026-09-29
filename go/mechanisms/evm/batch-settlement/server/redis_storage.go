package server

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
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
// expectedExists ("0"|"1"), expected raw value, operation ("delete"|"keep"|"set"),
// nextValue (set only). Returns {applied, currentOrNext} where applied is 0|1.
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
	Get(key string) (value string, ok bool, err error)
	Set(key, value string, opts *RedisSetOptions) (ok bool, err error)
	Del(key string) (deleted int64, err error)
	Eval(script string, keys []string, args []string) (any, error)
	// Scan returns every key matching pattern. count is a SCAN COUNT hint;
	// implementations should iterate the cursor to completion.
	Scan(match string, count int) (keys []string, err error)
}

// RedisChannelStorageOptions configures Redis-backed server channel storage.
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
func (s *RedisChannelLockStorage) Acquire(channelId string, pendingId string, ttlMs int64) (bool, error) {
	key, err := s.lockKey(channelId)
	if err != nil {
		return false, err
	}
	return s.client.Set(key, pendingId, &RedisSetOptions{NX: true, PX: ttlMs})
}

// Release compares-and-deletes the admission lock only when pendingId still holds it.
func (s *RedisChannelLockStorage) Release(channelId string, pendingId string) error {
	key, err := s.lockKey(channelId)
	if err != nil {
		return err
	}
	_, err = s.client.Eval(compareAndDelScript, []string{key}, []string{pendingId})
	return err
}

// IsHeld reports whether a live admission lock exists, optionally matching pendingId.
func (s *RedisChannelLockStorage) IsHeld(channelId string, pendingId string) (bool, error) {
	key, err := s.lockKey(channelId)
	if err != nil {
		return false, err
	}
	current, ok, err := s.client.Get(key)
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

// RedisChannelStorage is a Redis/Valkey-backed SessionStorage with optimistic
// atomic updates (Lua compare-and-write). It embeds RedisChannelLockStorage so
// one object implements both roles; lock storage is inferred by the scheme.
type RedisChannelStorage struct {
	*RedisChannelLockStorage
	channelKeyPrefix  string
	lockRetryInterval time.Duration
	maxUpdateWait     time.Duration
	scanCount         int
}

var (
	_ SessionStorage     = (*RedisChannelStorage)(nil)
	_ ChannelLockStorage = (*RedisChannelStorage)(nil)
)

// NewRedisChannelStorage creates Redis-backed server channel storage.
func NewRedisChannelStorage(opts RedisChannelStorageOptions) *RedisChannelStorage {
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
	return &RedisChannelStorage{
		RedisChannelLockStorage: lock,
		channelKeyPrefix:        lock.keyPrefix + ":server:channel",
		lockRetryInterval:       time.Duration(retryMs) * time.Millisecond,
		maxUpdateWait:           time.Duration(maxUpdateMs) * time.Millisecond,
		scanCount:               scanCount,
	}
}

func (s *RedisChannelStorage) channelKey(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return s.channelKeyPrefix + ":" + id, nil
}

func (s *RedisChannelStorage) Get(channelId string) (*ChannelSession, error) {
	key, err := s.channelKey(channelId)
	if err != nil {
		return nil, err
	}
	return s.loadChannel(key)
}

func (s *RedisChannelStorage) Set(channelId string, session *ChannelSession) error {
	key, err := s.channelKey(channelId)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(session)
	if err != nil {
		return err
	}
	_, err = s.client.Set(key, string(raw), nil)
	return err
}

func (s *RedisChannelStorage) Delete(channelId string) error {
	key, err := s.channelKey(channelId)
	if err != nil {
		return err
	}
	lockKey, err := s.lockKey(channelId)
	if err != nil {
		return err
	}
	if _, err := s.client.Del(key); err != nil {
		return err
	}
	_, err = s.client.Del(lockKey)
	return err
}

func (s *RedisChannelStorage) List() ([]*ChannelSession, error) {
	keys, err := s.client.Scan(s.channelKeyPrefix+":*", s.scanCount)
	if err != nil {
		return nil, err
	}
	sessions := make([]*ChannelSession, 0, len(keys))
	for _, key := range keys {
		session, err := s.loadChannel(key)
		if err != nil {
			return nil, fmt.Errorf("unmarshal %s: %w", key, err)
		}
		if session == nil {
			continue
		}
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].ChannelId < sessions[j].ChannelId })
	return sessions, nil
}

func (s *RedisChannelStorage) CompareAndSet(channelId string, expectedCharged string, session *ChannelSession) (bool, error) {
	result, err := s.UpdateChannel(channelId, func(current *ChannelSession) *ChannelSession {
		if current != nil && current.ChargedCumulativeAmount != expectedCharged {
			return current
		}
		return session
	})
	if err != nil {
		return false, err
	}
	return result.Status == ChannelUpdated, nil
}

func (s *RedisChannelStorage) UpdateChannel(channelId string, update func(current *ChannelSession) *ChannelSession) (*ChannelUpdateResult, error) {
	key, err := s.channelKey(channelId)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(s.maxUpdateWait)
	for {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("channel update contended")
		}
		currentRaw, current, err := s.readChannelRaw(key)
		if err != nil {
			return nil, err
		}
		next := update(current)

		if next == current {
			applied, err := s.commitUpdate(channelId, key, currentRaw, redisUpdateOperationKeep, "")
			if err != nil {
				return nil, err
			}
			if applied {
				return &ChannelUpdateResult{Channel: current, Status: ChannelUnchanged}, nil
			}
			time.Sleep(s.lockRetryInterval)
			continue
		}

		if next == nil {
			applied, err := s.commitUpdate(channelId, key, currentRaw, redisUpdateOperationDelete, "")
			if err != nil {
				return nil, err
			}
			if applied {
				status := ChannelUnchanged
				if current != nil {
					status = ChannelDeleted
				}
				return &ChannelUpdateResult{Status: status}, nil
			}
			time.Sleep(s.lockRetryInterval)
			continue
		}

		nextRaw, err := json.Marshal(next)
		if err != nil {
			return nil, err
		}
		applied, err := s.commitUpdate(channelId, key, currentRaw, redisUpdateOperationSet, string(nextRaw))
		if err != nil {
			return nil, err
		}
		if applied {
			return &ChannelUpdateResult{Channel: next, Status: ChannelUpdated}, nil
		}
		time.Sleep(s.lockRetryInterval)
	}
}

func (s *RedisChannelStorage) loadChannel(key string) (*ChannelSession, error) {
	_, session, err := s.readChannelRaw(key)
	return session, err
}

func (s *RedisChannelStorage) readChannelRaw(key string) (*string, *ChannelSession, error) {
	raw, ok, err := s.client.Get(key)
	if err != nil {
		return nil, nil, err
	}
	if !ok || raw == "" {
		return nil, nil, nil
	}
	session := &ChannelSession{}
	if err := json.Unmarshal([]byte(raw), session); err != nil {
		return nil, nil, err
	}
	return &raw, session, nil
}

func (s *RedisChannelStorage) commitUpdate(channelId, key string, expectedRaw *string, operation, nextRaw string) (bool, error) {
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
	value, err := s.client.Eval(updateChannelScript, []string{key, lockKey}, []string{expectedExists, expected, operation, nextRaw})
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
