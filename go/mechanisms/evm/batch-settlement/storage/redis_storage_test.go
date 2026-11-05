package storage

import (
	"context"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const redisTestPrefix = "test:x402"

type mockRedisValue struct {
	expiresAt int64
	value     string
}

type mockRedisClient struct {
	mu                  sync.Mutex
	store               map[string]mockRedisValue
	updateConflicts     int
	forceUpdateConflict bool
	nextUpdateEvalDelay chan struct{}
	evalStarted         chan struct{}
}

func newMockRedisClient() *mockRedisClient {
	return &mockRedisClient{store: make(map[string]mockRedisValue)}
}

func (c *mockRedisClient) Get(_ context.Context, key string) (string, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireKey(key)
	v, ok := c.store[key]
	if !ok {
		return "", false, nil
	}
	return v.value, true, nil
}

func (c *mockRedisClient) Set(_ context.Context, key, value string, opts *RedisSetOptions) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireKey(key)
	if opts != nil && opts.NX {
		if _, exists := c.store[key]; exists {
			return false, nil
		}
	}
	entry := mockRedisValue{value: value}
	if opts != nil && opts.PX > 0 {
		entry.expiresAt = time.Now().UnixMilli() + opts.PX
	}
	c.store[key] = entry
	return true, nil
}

func (c *mockRedisClient) Del(_ context.Context, key string) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireKey(key)
	if _, ok := c.store[key]; !ok {
		return 0, nil
	}
	delete(c.store, key)
	return 1, nil
}

func (c *mockRedisClient) Eval(_ context.Context, script string, keys []string, args []string) (any, error) {
	if len(keys) == 0 {
		return nil, fmt.Errorf("missing Redis key")
	}
	if !strings.Contains(script, "expectedExists") {
		c.mu.Lock()
		defer c.mu.Unlock()
		key := keys[0]
		c.expireKey(key)
		current, exists := c.store[key]
		if exists && len(args) > 0 && current.value == args[0] {
			delete(c.store, key)
			return int64(1), nil
		}
		return int64(0), nil
	}

	c.mu.Lock()
	delay := c.nextUpdateEvalDelay
	started := c.evalStarted
	if delay != nil {
		c.nextUpdateEvalDelay = nil
		c.evalStarted = nil
	}
	c.mu.Unlock()

	if delay != nil {
		if started != nil {
			close(started)
		}
		<-delay
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	key := keys[0]
	c.expireKey(key)

	expectedExists, expected, operation, nextValue := args[0], args[1], args[2], args[3]
	current, exists := c.store[key]
	matches := false
	if expectedExists == redisUpdateExpectedMissing {
		matches = !exists
	} else {
		matches = exists && current.value == expected
	}
	if !matches || c.forceUpdateConflict {
		c.updateConflicts++
		if exists {
			return []any{int64(0), current.value}, nil
		}
		return []any{int64(0), nil}, nil
	}
	switch operation {
	case redisUpdateOperationDelete:
		delete(c.store, key)
		if len(keys) > 1 {
			delete(c.store, keys[1])
		}
		return []any{int64(1), nil}, nil
	case redisUpdateOperationSet:
		c.store[key] = mockRedisValue{value: nextValue}
		return []any{int64(1), nextValue}, nil
	case redisUpdateOperationKeep:
		if exists {
			return []any{int64(1), current.value}, nil
		}
		return []any{int64(1), nil}, nil
	default:
		return nil, fmt.Errorf("unsupported Redis update operation")
	}
}

func (c *mockRedisClient) Scan(_ context.Context, match string, _ int) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	prefix := strings.TrimSuffix(match, "*")
	c.expireAll()
	keys := make([]string, 0, len(c.store))
	for key := range c.store {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

func (c *mockRedisClient) expireAll() {
	for key := range c.store {
		c.expireKey(key)
	}
}

func (c *mockRedisClient) expireKey(key string) {
	value, ok := c.store[key]
	if ok && value.expiresAt > 0 && value.expiresAt <= time.Now().UnixMilli() {
		delete(c.store, key)
	}
}

func (c *mockRedisClient) conflictCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.updateConflicts
}

func (c *mockRedisClient) hasKey(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireKey(key)
	_, ok := c.store[key]
	return ok
}

func (c *mockRedisClient) rawValue(key string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expireKey(key)
	return c.store[key].value
}

func newRedisStore(t *testing.T) (*RedisChannelStorage[*Channel], *mockRedisClient) {
	t.Helper()
	client := newMockRedisClient()
	return NewRedisChannelStorage[*Channel](RedisChannelStorageOptions{
		Client:              client,
		KeyPrefix:           redisTestPrefix,
		LockRetryIntervalMs: 1,
	}), client
}

func mustSeedRedisChannel(t *testing.T, s *RedisChannelStorage[*Channel], sess *Channel) {
	t.Helper()
	if _, err := s.UpdateChannel(context.Background(), sess.ChannelId, func(*Channel) *Channel { return sess.Clone() }); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func TestRedisChannelStorage_GetMissing(t *testing.T) {
	s, _ := newRedisStore(t)
	_, err := s.Get(context.Background(), "missing")
	if err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("expected ErrInvalidChannelId, got %v", err)
	}
}

func TestRedisChannelStorage_GetMissingCanonical(t *testing.T) {
	s, _ := newRedisStore(t)
	got, err := s.Get(context.Background(), testChA)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil")
	}
}

func TestRedisChannelStorage_UpsertGet(t *testing.T) {
	s, _ := newRedisStore(t)
	in := sampleSession(testChA, "10")
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return in.Clone() }); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	got, err := s.Get(context.Background(), testChA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("round-trip mismatch")
	}
}

func TestRedisChannelStorage_MixedCaseCanonicalGet(t *testing.T) {
	s, _ := newRedisStore(t)
	upper := "0x" + strings.ToUpper(strings.TrimPrefix(testChA, "0x"))
	mustSeedRedisChannel(t, s, sampleSession(upper, "7"))
	got, err := s.Get(context.Background(), testChA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil || got.ChargedCumulativeAmount != "7" {
		t.Fatalf("mixed-case Get missed lowercased key: %+v", got)
	}
}

func TestRedisChannelStorage_UpdateChannelDelete(t *testing.T) {
	s, _ := newRedisStore(t)
	mustSeedRedisChannel(t, s, sampleSession(testChA, "10"))
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil }); err != nil {
		t.Fatalf("UpdateChannel delete: %v", err)
	}
	if got, _ := s.Get(context.Background(), testChA); got != nil {
		t.Fatalf("expected nil after delete")
	}
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil }); err != nil {
		t.Fatalf("UpdateChannel delete-missing should not error: %v", err)
	}
}

func TestRedisChannelStorage_ListSorted(t *testing.T) {
	s, _ := newRedisStore(t)
	mustSeedRedisChannel(t, s, sampleSession(testChB, "2"))
	mustSeedRedisChannel(t, s, sampleSession(testChA, "1"))

	got, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got))
	}
	if got[0].ChannelId != testChA || got[1].ChannelId != testChB {
		t.Fatalf("not sorted: %s, %s", got[0].ChannelId, got[1].ChannelId)
	}
}

func TestRedisChannelStorage_List_Malformed(t *testing.T) {
	s, client := newRedisStore(t)
	_, _ = client.Set(context.Background(), redisTestPrefix+":server:channel:"+testChA, "{not-json", nil)
	if _, err := s.List(context.Background()); err == nil {
		t.Fatal("expected unmarshal error")
	}
}

func TestRedisChannelStorage_UpdateChannelInsertUnchangedDelete(t *testing.T) {
	s, _ := newRedisStore(t)
	channel := sampleSession(testChA, "500")
	result, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return channel })
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if result.Status != ChannelUpdated || !reflect.DeepEqual(result.Channel, channel) {
		t.Fatalf("insert result: %+v", result)
	}

	result, err = s.UpdateChannel(context.Background(), testChA, func(current *Channel) *Channel { return current })
	if err != nil {
		t.Fatalf("unchanged: %v", err)
	}
	if result.Status != ChannelUnchanged || result.Channel == nil || result.Channel.ChargedCumulativeAmount != "500" {
		t.Fatalf("unchanged result: %+v", result)
	}

	result, err = s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil })
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if result.Status != ChannelDeleted || result.Channel != nil {
		t.Fatalf("delete result: %+v", result)
	}
	if got, _ := s.Get(context.Background(), testChA); got != nil {
		t.Fatalf("expected nil after delete")
	}

	result, err = s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil })
	if err != nil {
		t.Fatalf("delete-missing: %v", err)
	}
	if result.Status != ChannelUnchanged || result.Channel != nil {
		t.Fatalf("delete-missing result: %+v", result)
	}
}

func TestRedisChannelStorage_RejectsMalformedIds(t *testing.T) {
	s, _ := newRedisStore(t)
	malformed := "../../../etc/passwd"
	if _, err := s.Get(context.Background(), malformed); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("Get: expected ErrInvalidChannelId, got %v", err)
	}
	if _, err := s.UpdateChannel(context.Background(), malformed, func(*Channel) *Channel {
		return sampleSession(testChA, "1")
	}); err == nil || err.Error() != batchsettlement.ErrInvalidChannelId {
		t.Fatalf("UpdateChannel: expected ErrInvalidChannelId, got %v", err)
	}
	list, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("storage mutated by malformed UpdateChannel, got %d sessions", len(list))
	}
}

func TestRedisChannelStorage_RetriesAfterCompareConflicts(t *testing.T) {
	s, client := newRedisStore(t)
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel {
		return sampleSession(testChA, "0")
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	delay := make(chan struct{})
	started := make(chan struct{})
	client.mu.Lock()
	client.nextUpdateEvalDelay = delay
	client.evalStarted = started
	client.mu.Unlock()

	firstDone := make(chan *ChannelUpdateResult[*Channel], 1)
	go func() {
		result, err := s.UpdateChannel(context.Background(), testChA, func(current *Channel) *Channel {
			next := sampleSession(testChA, "0")
			charged := "0"
			if current != nil {
				charged = current.ChargedCumulativeAmount
			}
			next.ChargedCumulativeAmount = strconv.Itoa(atoiOrZero(charged) + 1)
			return next
		})
		if err != nil {
			t.Errorf("first update: %v", err)
		}
		firstDone <- result
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first eval")
	}

	second, err := s.UpdateChannel(context.Background(), testChA, func(current *Channel) *Channel {
		next := sampleSession(testChA, "0")
		charged := "0"
		if current != nil {
			charged = current.ChargedCumulativeAmount
		}
		next.ChargedCumulativeAmount = strconv.Itoa(atoiOrZero(charged) + 1)
		return next
	})
	if err != nil {
		t.Fatalf("second update: %v", err)
	}
	waitForCharged := redisTestPrefix + ":server:channel:" + testChA
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(client.rawValue(waitForCharged), `"chargedCumulativeAmount":"1"`) {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for second write")
		}
		time.Sleep(time.Millisecond)
	}
	close(delay)

	first := <-firstDone
	if first == nil || first.Status != ChannelUpdated || second.Status != ChannelUpdated {
		t.Fatalf("status first=%v second=%v", first, second.Status)
	}
	if client.conflictCount() != 1 {
		t.Fatalf("conflicts = %d", client.conflictCount())
	}
	got, _ := s.Get(context.Background(), testChA)
	if got == nil || got.ChargedCumulativeAmount != "2" {
		t.Fatalf("final charged = %+v", got)
	}
}

func TestRedisChannelStorage_UpdateChannelDeleteDropsLockKey(t *testing.T) {
	s, client := newRedisStore(t)
	lockKey := redisTestPrefix + ":server:lock:" + testChA
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel {
		return sampleSession(testChA, "5")
	}); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	ok, err := s.Acquire(context.Background(), testChA, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	if !client.hasKey(lockKey) {
		t.Fatal("expected lock key after Acquire")
	}
	result, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return nil })
	if err != nil {
		t.Fatalf("UpdateChannel delete: %v", err)
	}
	if result.Status != ChannelDeleted {
		t.Fatalf("delete result: %+v", result)
	}
	if client.hasKey(lockKey) {
		t.Fatal("delete branch should drop :server:lock:")
	}
}

func TestRedisChannelStorage_UpdateChannelContendedAfterMaxWait(t *testing.T) {
	client := newMockRedisClient()
	s := NewRedisChannelStorage[*Channel](RedisChannelStorageOptions{
		Client:              client,
		KeyPrefix:           redisTestPrefix,
		LockRetryIntervalMs: 1,
		MaxUpdateWaitMs:     20,
	})
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel {
		return sampleSession(testChA, "0")
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	client.mu.Lock()
	client.forceUpdateConflict = true
	client.mu.Unlock()

	result, err := s.UpdateChannel(context.Background(), testChA, func(current *Channel) *Channel {
		next := sampleSession(testChA, "0")
		if current != nil {
			next.ChargedCumulativeAmount = strconv.Itoa(atoiOrZero(current.ChargedCumulativeAmount) + 1)
		}
		return next
	})
	if err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	if result.Status != ChannelConflict {
		t.Fatalf("status = %q, want conflict", result.Status)
	}
	if result.Channel == nil || result.Channel.ChargedCumulativeAmount != "0" {
		t.Fatalf("conflict channel = %+v", result.Channel)
	}
	if client.conflictCount() == 0 {
		t.Fatal("expected compare conflicts")
	}
}

func TestRedisChannelStorage_LockIsSeparateFromChannelJSON(t *testing.T) {
	s, client := newRedisStore(t)
	channel := sampleSession(testChA, "5")
	if _, err := s.UpdateChannel(context.Background(), testChA, func(*Channel) *Channel { return channel }); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	ok, err := s.Acquire(context.Background(), testChA, "first", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire first: ok=%v err=%v", ok, err)
	}
	ok, err = s.Acquire(context.Background(), testChA, "second", 60_000)
	if err != nil || ok {
		t.Fatalf("second acquire should fail: ok=%v err=%v", ok, err)
	}
	held, err := s.IsHeld(context.Background(), testChA, "")
	if err != nil || !held {
		t.Fatalf("any lock should be held: held=%v err=%v", held, err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "first")
	if err != nil || !held {
		t.Fatalf("first should be held: held=%v err=%v", held, err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "second")
	if err != nil || held {
		t.Fatalf("second should not be held: held=%v err=%v", held, err)
	}
	if !client.hasKey(redisTestPrefix + ":server:lock:" + testChA) {
		t.Fatal("expected lock key under :server:lock:")
	}

	got, err := s.Get(context.Background(), testChA)
	if err != nil || !reflect.DeepEqual(got, channel) {
		t.Fatalf("channel mutated: got=%+v err=%v", got, err)
	}
	listed, err := s.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0].ChannelId != testChA {
		t.Fatalf("list = %+v err=%v", listed, err)
	}

	if err := s.Release(context.Background(), testChA, "second"); err != nil {
		t.Fatalf("release second: %v", err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "first")
	if err != nil || !held {
		t.Fatalf("first should still be held: held=%v err=%v", held, err)
	}
	if err := s.Release(context.Background(), testChA, "first"); err != nil {
		t.Fatalf("release first: %v", err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("lock should be free: held=%v err=%v", held, err)
	}
	if client.hasKey(redisTestPrefix + ":server:lock:" + testChA) {
		t.Fatal("lock key should be deleted")
	}
}

func TestRedisChannelStorage_ExpiredLockIsFree(t *testing.T) {
	s, _ := newRedisStore(t)
	ok, err := s.Acquire(context.Background(), testChA, "expired", 1)
	if err != nil || !ok {
		t.Fatalf("Acquire expired: ok=%v err=%v", ok, err)
	}
	time.Sleep(5 * time.Millisecond)
	ok, err = s.Acquire(context.Background(), testChA, "next", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire next: ok=%v err=%v", ok, err)
	}
	held, err := s.IsHeld(context.Background(), testChA, "expired")
	if err != nil || held {
		t.Fatalf("expired should not be held: held=%v err=%v", held, err)
	}
	held, err = s.IsHeld(context.Background(), testChA, "next")
	if err != nil || !held {
		t.Fatalf("next should be held: held=%v err=%v", held, err)
	}
}

func TestRedisChannelStorage_MissingLockIsNotHeld(t *testing.T) {
	s, _ := newRedisStore(t)
	held, err := s.IsHeld(context.Background(), testChA, "")
	if err != nil || held {
		t.Fatalf("missing hold: held=%v err=%v", held, err)
	}
	if err := s.Release(context.Background(), testChA, "missing"); err != nil {
		t.Fatalf("release missing: %v", err)
	}
}

func TestRedisChannelLockStorage_Standalone(t *testing.T) {
	client := newMockRedisClient()
	lock := NewRedisChannelLockStorage(RedisChannelStorageOptions{
		Client:    client,
		KeyPrefix: redisTestPrefix,
	})
	ok, err := lock.Acquire(context.Background(), testChA, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("Acquire: ok=%v err=%v", ok, err)
	}
	if !client.hasKey(redisTestPrefix + ":server:lock:" + testChA) {
		t.Fatal("expected :server:lock: key")
	}
	if client.hasKey(redisTestPrefix + ":server:channel:" + testChA) {
		t.Fatal("lock store must not write channel JSON")
	}
}

func TestRedisChannelStorage_AcquireIsNotReentrant(t *testing.T) {
	s, client := newRedisStore(t)
	ok, err := s.Acquire(context.Background(), testChA, "same", 60_000)
	if err != nil || !ok {
		t.Fatalf("first Acquire: ok=%v err=%v", ok, err)
	}
	lockKey := redisTestPrefix + ":server:lock:" + testChA
	firstExpiry := client.store[lockKey].expiresAt
	ok, err = s.Acquire(context.Background(), testChA, "same", 120_000)
	if err != nil || ok {
		t.Fatalf("re-entrant Acquire should miss: ok=%v err=%v", ok, err)
	}
	if client.store[lockKey].expiresAt != firstExpiry {
		t.Fatalf("TTL refreshed: first=%d second=%d", firstExpiry, client.store[lockKey].expiresAt)
	}
	held, err := s.IsHeld(context.Background(), testChA, "same")
	if err != nil || !held {
		t.Fatalf("original holder should remain: held=%v err=%v", held, err)
	}
}

func TestParseRedisUpdateResult(t *testing.T) {
	applied, err := parseRedisUpdateResult([]any{int64(1), `{"ok":true}`})
	if err != nil || !applied {
		t.Fatalf("applied: applied=%v err=%v", applied, err)
	}
	applied, err = parseRedisUpdateResult([]any{int64(0), nil})
	if err != nil || applied {
		t.Fatalf("conflict: applied=%v err=%v", applied, err)
	}
	applied, err = parseRedisUpdateResult([]any{int64(1), []byte("raw")})
	if err != nil || !applied {
		t.Fatalf("bytes: applied=%v err=%v", applied, err)
	}
	if _, err := parseRedisUpdateResult("nope"); err == nil {
		t.Fatal("expected unexpected response")
	}
	if _, err := parseRedisUpdateResult([]any{int64(2), nil}); err == nil {
		t.Fatal("expected unexpected status")
	}
	if _, err := parseRedisUpdateResult([]any{int64(1), 3}); err == nil {
		t.Fatal("expected unexpected value")
	}
}

func atoiOrZero(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}
