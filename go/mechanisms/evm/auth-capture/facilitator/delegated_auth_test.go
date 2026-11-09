package facilitator

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

const (
	delegatedTestAuthorizer = "0x1111111111111111111111111111111111111111"
	delegatedTestNetwork    = x402.Network("eip155:84532")
	delegatedTestNow        = int64(1_800_000_000)
)

var delegatedTestHash = "0x" + strings.Repeat("ab", 32)

func delegatedRecord(mutate func(*AuthCaptureDelegatedAuthRecord)) AuthCaptureDelegatedAuthRecord {
	record := AuthCaptureDelegatedAuthRecord{
		Network:         delegatedTestNetwork,
		PaymentInfoHash: delegatedTestHash,
		CallerIdentity:  "caller-1",
		ExpiresAt:       uint64(delegatedTestNow + 3600),
	}
	if mutate != nil {
		mutate(&record)
	}
	return record
}

// fakeClockStorage is an in-memory store whose clock the test controls.
func fakeClockStorage() (*InMemoryAuthCaptureDelegatedAuthStorage, func(seconds int64)) {
	storage := NewInMemoryAuthCaptureDelegatedAuthStorage()
	now := delegatedTestNow
	storage.now = func() time.Time { return time.Unix(now, 0) }
	return storage, func(seconds int64) { now = seconds }
}

// stubAuthorizerSigner is a ClientEvmSigner that only has an address.
type stubAuthorizerSigner struct{ address string }

func (s stubAuthorizerSigner) Address() string { return s.address }

func (stubAuthorizerSigner) SignTypedData(context.Context, evm.TypedDataDomain, map[string][]evm.TypedDataField, string, map[string]interface{}) ([]byte, error) {
	return nil, errors.New("not used")
}

// recordedStorageErrors collects OnStorageError reports.
type recordedStorageErrors struct {
	mu      sync.Mutex
	errs    []error
	network []x402.Network
	hashes  []string
}

func (r *recordedStorageErrors) report(err error, network x402.Network, paymentInfoHash string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.errs = append(r.errs, err)
	r.network = append(r.network, network)
	r.hashes = append(r.hashes, paymentInfoHash)
}

func delegatedWith(storage AuthCaptureDelegatedAuthStorage, reported *recordedStorageErrors) *delegatedAuthorizer {
	return &delegatedAuthorizer{
		signer:                stubAuthorizerSigner{address: delegatedTestAuthorizer},
		resolveCallerIdentity: func(context.Context, DelegatedSettleContext) (string, error) { return "", nil },
		storage:               storage,
		onStorageError:        reported.report,
	}
}

// failingBindStorage fails every Bind.
type failingBindStorage struct {
	AuthCaptureDelegatedAuthStorage
}

func (failingBindStorage) Bind(context.Context, AuthCaptureDelegatedAuthRecord) (AuthCaptureDelegatedAuthWrite, error) {
	return AuthCaptureDelegatedAuthWrite{}, errors.New("db down")
}

// failingRevertStorage fails every RevertBind.
type failingRevertStorage struct {
	AuthCaptureDelegatedAuthStorage
}

func (failingRevertStorage) RevertBind(context.Context, AuthCaptureDelegatedAuthWrite) error {
	return errors.New("db down")
}

func TestInMemoryAuthCaptureDelegatedAuthStorage(t *testing.T) {
	ctx := context.Background()

	t.Run("stores the first writer and returns a revert token", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		write, err := storage.Bind(ctx, delegatedRecord(nil))
		require.NoError(t, err)
		assert.Equal(t, "caller-1", write.Record.CallerIdentity)
		assert.NotEmpty(t, write.RevertToken)

		stored, err := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		require.NoError(t, err)
		assert.Equal(t, ptr(delegatedRecord(nil)), stored)
	})

	t.Run("keeps the first writer and returns an empty token for a different identity", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		_, err := storage.Bind(ctx, delegatedRecord(nil))
		require.NoError(t, err)
		write, err := storage.Bind(ctx, delegatedRecord(func(r *AuthCaptureDelegatedAuthRecord) {
			r.CallerIdentity = "caller-2"
			r.ExpiresAt = 1
		}))
		require.NoError(t, err)
		assert.Equal(t, delegatedRecord(nil), write.Record)
		assert.Empty(t, write.RevertToken)

		stored, err := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		require.NoError(t, err)
		assert.Equal(t, ptr(delegatedRecord(nil)), stored)
	})

	t.Run("rotates the token on a same-identity bind so the creator's revert no longer matches", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		creator, err := storage.Bind(ctx, delegatedRecord(nil))
		require.NoError(t, err)
		retry, err := storage.Bind(ctx, delegatedRecord(nil))
		require.NoError(t, err)
		assert.Empty(t, retry.RevertToken)

		require.NoError(t, storage.RevertBind(ctx, creator))
		stored, err := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		require.NoError(t, err)
		assert.NotNil(t, stored)
	})

	t.Run("deletes the row on revert only with the matching non-empty token", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		write, err := storage.Bind(ctx, delegatedRecord(nil))
		require.NoError(t, err)

		emptyToken := write
		emptyToken.RevertToken = ""
		require.NoError(t, storage.RevertBind(ctx, emptyToken))
		stored, _ := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		assert.NotNil(t, stored)

		require.NoError(t, storage.RevertBind(ctx, write))
		stored, _ = storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		assert.Nil(t, stored)
	})

	t.Run("treats an expired row as absent and lets a new identity bind", func(t *testing.T) {
		storage, setNow := fakeClockStorage()
		_, err := storage.Bind(ctx, delegatedRecord(func(r *AuthCaptureDelegatedAuthRecord) { r.ExpiresAt = uint64(delegatedTestNow + 10) }))
		require.NoError(t, err)
		setNow(delegatedTestNow + 10)
		stored, err := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		require.NoError(t, err)
		assert.Nil(t, stored)

		_, err = storage.Bind(ctx, delegatedRecord(func(r *AuthCaptureDelegatedAuthRecord) { r.ExpiresAt = uint64(delegatedTestNow + 20) }))
		require.NoError(t, err)
		setNow(delegatedTestNow + 20)
		write, err := storage.Bind(ctx, delegatedRecord(func(r *AuthCaptureDelegatedAuthRecord) {
			r.CallerIdentity = "caller-2"
			r.ExpiresAt = uint64(delegatedTestNow + 99)
		}))
		require.NoError(t, err)
		assert.Equal(t, "caller-2", write.Record.CallerIdentity)
		assert.NotEmpty(t, write.RevertToken)
	})

	t.Run("scopes rows by network and case-insensitive hash", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		_, err := storage.Bind(ctx, delegatedRecord(nil))
		require.NoError(t, err)

		other, err := storage.Get(ctx, "eip155:8453", delegatedTestHash)
		require.NoError(t, err)
		assert.Nil(t, other)
		upper, err := storage.Get(ctx, delegatedTestNetwork, "0x"+strings.ToUpper(delegatedTestHash[2:]))
		require.NoError(t, err)
		assert.NotNil(t, upper)

		require.NoError(t, storage.Delete(ctx, delegatedTestNetwork, delegatedTestHash))
		stored, err := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		require.NoError(t, err)
		assert.Nil(t, stored)
	})
}

func TestGetDelegatedAuthorizer(t *testing.T) {
	storage := NewInMemoryAuthCaptureDelegatedAuthStorage()
	config := AuthCaptureEvmSchemeConfig{
		AuthorizerSigner:      stubAuthorizerSigner{address: delegatedTestAuthorizer},
		ResolveCallerIdentity: func(context.Context, DelegatedSettleContext) (string, error) { return "caller-1", nil },
		DelegatedAuthStorage:  storage,
		OnStorageError:        func(error, x402.Network, string) {},
	}

	t.Run("returns the wiring only when the receiverAuthorizer is the configured signer", func(t *testing.T) {
		delegated := getDelegatedAuthorizer(config, delegatedTestAuthorizer)
		require.NotNil(t, delegated)
		assert.Same(t, storage, delegated.storage)
		assert.NotNil(t, getDelegatedAuthorizer(config, "0x"+strings.ToUpper(delegatedTestAuthorizer[2:])))
		assert.Nil(t, getDelegatedAuthorizer(config, "0x2222222222222222222222222222222222222222"))
	})

	t.Run("returns nil when delegation is not fully configured", func(t *testing.T) {
		assert.Nil(t, getDelegatedAuthorizer(AuthCaptureEvmSchemeConfig{}, delegatedTestAuthorizer))

		noStorage := config
		noStorage.DelegatedAuthStorage = nil
		assert.Nil(t, getDelegatedAuthorizer(noStorage, delegatedTestAuthorizer))

		noOnStorageError := config
		noOnStorageError.OnStorageError = nil
		assert.Nil(t, getDelegatedAuthorizer(noOnStorageError, delegatedTestAuthorizer))
	})
}

func TestResolveDelegatedCallerIdentity(t *testing.T) {
	settle := DelegatedSettleContext{Step: DelegatedStepCapture}

	resolve := func(identity string, err error) string {
		delegated := delegatedWith(NewInMemoryAuthCaptureDelegatedAuthStorage(), &recordedStorageErrors{})
		delegated.resolveCallerIdentity = func(context.Context, DelegatedSettleContext) (string, error) { return identity, err }
		return resolveDelegatedCallerIdentity(context.Background(), delegated, settle)
	}

	t.Run("returns a non-empty identity", func(t *testing.T) {
		assert.Equal(t, "caller-1", resolve("caller-1", nil))
	})

	t.Run("treats an empty identity as unauthenticated", func(t *testing.T) {
		assert.Empty(t, resolve("", nil))
	})

	t.Run("treats a returned error as unauthenticated", func(t *testing.T) {
		assert.Empty(t, resolve("caller-1", errors.New("boom")))
	})
}

func TestBindThenBroadcast(t *testing.T) {
	ctx := context.Background()

	t.Run("broadcasts after a successful bind and keeps the row", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		result := bindThenBroadcast(ctx, delegatedWith(storage, &recordedStorageErrors{}), delegatedRecord(nil),
			func() (string, bindDisposition) { return "ok", bindKeep })
		assert.True(t, result.OK)
		assert.Equal(t, "ok", result.Value)

		stored, _ := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		assert.NotNil(t, stored)
	})

	t.Run("reverts the created row when the broadcast asks for it", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		result := bindThenBroadcast(ctx, delegatedWith(storage, &recordedStorageErrors{}), delegatedRecord(nil),
			func() (string, bindDisposition) { return "failed", bindRevert })
		assert.True(t, result.OK)
		assert.Equal(t, "failed", result.Value)

		stored, _ := storage.Get(ctx, delegatedTestNetwork, delegatedTestHash)
		assert.Nil(t, stored)
	})

	t.Run("reports a failing revert without replacing the broadcast result", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		reported := &recordedStorageErrors{}
		result := bindThenBroadcast(ctx, delegatedWith(failingRevertStorage{storage}, reported), delegatedRecord(nil),
			func() (string, bindDisposition) { return "failed", bindRevert })
		assert.True(t, result.OK)
		assert.Equal(t, "failed", result.Value)
		require.Len(t, reported.errs, 1)
		assert.Equal(t, delegatedTestNetwork, reported.network[0])
		assert.Equal(t, delegatedTestHash, reported.hashes[0])
	})

	t.Run("fails closed without broadcasting on an identity conflict", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		_, err := storage.Bind(ctx, delegatedRecord(func(r *AuthCaptureDelegatedAuthRecord) { r.CallerIdentity = "someone-else" }))
		require.NoError(t, err)

		broadcast := false
		result := bindThenBroadcast(ctx, delegatedWith(storage, &recordedStorageErrors{}), delegatedRecord(nil),
			func() (string, bindDisposition) {
				broadcast = true
				return "", bindKeep
			})
		assert.False(t, result.OK)
		assert.Equal(t, bindConflict, result.Reason)
		assert.ErrorIs(t, result.Err, ErrCallerIdentityConflict)
		assert.False(t, broadcast)
	})

	t.Run("fails closed without broadcasting when the store is unavailable", func(t *testing.T) {
		storage, _ := fakeClockStorage()
		broadcast := false
		result := bindThenBroadcast(ctx, delegatedWith(failingBindStorage{storage}, &recordedStorageErrors{}), delegatedRecord(nil),
			func() (string, bindDisposition) {
				broadcast = true
				return "", bindKeep
			})
		assert.False(t, result.OK)
		assert.Equal(t, bindUnavailable, result.Reason)
		assert.False(t, broadcast)
	})
}

func ptr[T any](value T) *T { return &value }
