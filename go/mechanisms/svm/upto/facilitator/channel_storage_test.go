package facilitator

import (
	"context"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInMemoryChannelStorageKeepsTheWidestWindow(t *testing.T) {
	ctx := context.Background()
	storage := NewInMemoryChannelStorage()
	firstSeenAt := time.Now().Add(-time.Hour)
	record := ChannelRecord{
		ChannelID:    "channel-1",
		PayTo:        "recipient",
		TokenProgram: solana.TokenProgramID.String(),
		FirstSeenAt:  firstSeenAt,
		ExpiresAt:    2_000,
		Network:      testNetwork,
	}
	require.NoError(t, storage.Upsert(ctx, record))

	// A later settle on the same channel must not shorten its cleanup window.
	later := record
	later.FirstSeenAt = time.Now()
	later.ExpiresAt = 1_000
	require.NoError(t, storage.Upsert(ctx, later))

	stored, err := storage.Get(ctx, record.ChannelID)
	require.NoError(t, err)
	require.NotNil(t, stored)
	assert.Equal(t, firstSeenAt, stored.FirstSeenAt)
	assert.Equal(t, int64(2_000), stored.ExpiresAt)

	// A longer voucher does extend it.
	extended := record
	extended.ExpiresAt = 3_000
	require.NoError(t, storage.Upsert(ctx, extended))
	stored, err = storage.Get(ctx, record.ChannelID)
	require.NoError(t, err)
	assert.Equal(t, int64(3_000), stored.ExpiresAt)

	records, err := storage.List(ctx)
	require.NoError(t, err)
	assert.Len(t, records, 1)

	require.NoError(t, storage.Delete(ctx, record.ChannelID))
	stored, err = storage.Get(ctx, record.ChannelID)
	require.NoError(t, err)
	assert.Nil(t, stored)
}
