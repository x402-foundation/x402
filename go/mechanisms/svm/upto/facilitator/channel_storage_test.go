package facilitator

import (
	"context"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func TestInMemoryChannelStorageKeepsTheWidestWindow(t *testing.T) {
	ctx := context.Background()
	storage := paymentchannels.NewInMemoryPaymentChannelStorage()
	firstActivity := time.Now().Add(-time.Hour)
	record := paymentchannels.PaymentChannelRecord{
		ChannelID:      "channel-1",
		PayTo:          "recipient",
		TokenProgram:   solana.TokenProgramID.String(),
		LastActivityAt: firstActivity,
		ExpiresAt:      2_000,
		Network:        testNetwork,
	}
	_, err := storage.RecordOpen(ctx, record)
	require.NoError(t, err)

	// A later settle on the same channel must not shorten its cleanup window.
	later := record
	later.LastActivityAt = time.Now()
	later.ExpiresAt = 1_000
	_, err = storage.RecordOpen(ctx, later)
	require.NoError(t, err)

	stored, err := storage.Get(ctx, testNetwork, record.ChannelID)
	require.NoError(t, err)
	require.NotNil(t, stored)
	assert.True(t, stored.LastActivityAt.After(firstActivity) || stored.LastActivityAt.Equal(firstActivity))
	assert.Equal(t, int64(2_000), stored.ExpiresAt)

	// A longer voucher does extend it.
	extended := record
	extended.ExpiresAt = 3_000
	_, err = storage.RecordOpen(ctx, extended)
	require.NoError(t, err)
	stored, err = storage.Get(ctx, testNetwork, record.ChannelID)
	require.NoError(t, err)
	assert.Equal(t, int64(3_000), stored.ExpiresAt)

	records, err := storage.List(ctx, testNetwork)
	require.NoError(t, err)
	assert.Len(t, records, 1)

	require.NoError(t, storage.Delete(ctx, testNetwork, record.ChannelID))
	stored, err = storage.Get(ctx, testNetwork, record.ChannelID)
	require.NoError(t, err)
	assert.Nil(t, stored)
}
