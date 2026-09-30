package paymentchannels

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestInMemoryStorageKeepsForwardOnlyExpiryAndActivity(t *testing.T) {
	storage := NewInMemoryPaymentChannelStorage()
	ctx := context.Background()
	network := "solana:devnet"
	first := PaymentChannelRecord{
		ChannelID:      "chan-a",
		ExpiresAt:      50,
		LastActivityAt: time.Unix(10, 0),
		Network:        network,
		PayTo:          "pay",
		TokenProgram:   "token",
	}
	_, err := storage.RecordOpen(ctx, first)
	require.NoError(t, err)
	_, err = storage.RecordOpen(ctx, PaymentChannelRecord{
		ChannelID:      "chan-a",
		ExpiresAt:      40,
		LastActivityAt: time.Unix(30, 0),
		Network:        network,
	})
	require.NoError(t, err)
	require.NoError(t, storage.RecordActivity(ctx, PaymentChannelRecord{
		ChannelID:      "chan-a",
		LastActivityAt: time.Unix(15, 0),
		Network:        network,
	}))

	got, err := storage.Get(ctx, network, "chan-a")
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, int64(50), got.ExpiresAt)
	require.True(t, got.LastActivityAt.Equal(time.Unix(30, 0)))
}

func TestInMemoryStorageRevertOpen(t *testing.T) {
	storage := NewInMemoryPaymentChannelStorage()
	ctx := context.Background()
	network := "solana:devnet"
	write, err := storage.RecordOpen(ctx, PaymentChannelRecord{
		ChannelID:      "chan-b",
		Network:        network,
		LastActivityAt: time.Unix(1, 0),
	})
	require.NoError(t, err)
	require.NotEmpty(t, write.RevertToken)

	require.NoError(t, storage.RevertOpen(ctx, write))
	got, err := storage.Get(ctx, network, "chan-b")
	require.NoError(t, err)
	require.Nil(t, got)
}

func TestInMemoryStorageConflictingOpenLeavesRowAndRevertTokenUntouched(t *testing.T) {
	network := "solana:devnet"
	base := PaymentChannelRecord{
		CallerIdentity:     "svc-1",
		ChannelID:          "chan-c",
		ExpiresAt:          50,
		LastActivityAt:     time.Unix(10, 0),
		Network:            network,
		ReceiverAuthorizer: "auth-a",
	}
	tests := []struct {
		name     string
		mutate   func(*PaymentChannelRecord)
		expected error
	}{
		{"caller identity", func(r *PaymentChannelRecord) { r.CallerIdentity = "svc-2" }, ErrCallerIdentityConflict},
		{"receiver authorizer", func(r *PaymentChannelRecord) { r.ReceiverAuthorizer = "auth-b" }, ErrReceiverAuthorizerConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			storage := NewInMemoryPaymentChannelStorage()
			ctx := context.Background()
			created, err := storage.RecordOpen(ctx, base)
			require.NoError(t, err)
			require.NotEmpty(t, created.RevertToken)

			requested := base
			requested.ExpiresAt = 90
			requested.LastActivityAt = time.Unix(30, 0)
			tt.mutate(&requested)
			conflicting, err := storage.RecordOpen(ctx, requested)
			require.NoError(t, err)
			require.Empty(t, conflicting.RevertToken)
			require.Equal(t, base, conflicting.Record)
			require.ErrorIs(t, CheckOpenBindings(requested, conflicting.Record), tt.expected)

			got, err := storage.Get(ctx, network, "chan-c")
			require.NoError(t, err)
			require.Equal(t, base, *got)

			require.NoError(t, storage.RevertOpen(ctx, created))
			got, err = storage.Get(ctx, network, "chan-c")
			require.NoError(t, err)
			require.Nil(t, got)
		})
	}
}

func TestInMemoryStorageSameIdentityOpenRotatesRevertToken(t *testing.T) {
	storage := NewInMemoryPaymentChannelStorage()
	ctx := context.Background()
	network := "solana:devnet"
	base := PaymentChannelRecord{
		CallerIdentity:     "svc-1",
		ChannelID:          "chan-d",
		LastActivityAt:     time.Unix(10, 0),
		Network:            network,
		ReceiverAuthorizer: "auth-a",
	}
	created, err := storage.RecordOpen(ctx, base)
	require.NoError(t, err)

	again := base
	again.LastActivityAt = time.Unix(11, 0)
	second, err := storage.RecordOpen(ctx, again)
	require.NoError(t, err)
	require.Empty(t, second.RevertToken)

	require.NoError(t, storage.RevertOpen(ctx, created))
	got, err := storage.Get(ctx, network, "chan-d")
	require.NoError(t, err)
	require.NotNil(t, got)
	require.True(t, got.LastActivityAt.Equal(time.Unix(11, 0)))
}
