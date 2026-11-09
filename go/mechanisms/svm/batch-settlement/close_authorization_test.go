package batchsettlement_test

import (
	"context"
	"math/big"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
)

const closeAuthNow int64 = 1_800_000_000

func TestBatchSettlementCloseAuthorization(t *testing.T) {
	authorizer := newCloseSigner(t)
	other := newCloseSigner(t)

	t.Run("hashes the domain-separated message to 32 bytes and binds every field", func(t *testing.T) {
		base, err := batchsettlement.EncodeCloseAuthorizationDigest(closeBinding(closeAuthNow + 120))
		require.NoError(t, err)
		assert.Len(t, base, 32)
		variants := []batchsettlement.CloseAuthorizationBinding{
			withChannel(closeBinding(closeAuthNow+120), svm.USDCDevnetAddress),
			withFeePayer(closeBinding(closeAuthNow+120), svm.USDCMainnetAddress),
			withAmount(closeBinding(closeAuthNow+120), 5001),
			withVoucherExpiry(closeBinding(closeAuthNow+120), 1),
			closeBinding(closeAuthNow + 121),
			withNetwork(closeBinding(closeAuthNow+120), "solana:other"),
		}
		for _, variant := range variants {
			digest, err := batchsettlement.EncodeCloseAuthorizationDigest(variant)
			require.NoError(t, err)
			assert.NotEqual(t, base, digest)
		}
	})

	t.Run("rejects malformed bindings", func(t *testing.T) {
		_, err := batchsettlement.EncodeCloseAuthorizationDigest(withChannel(closeBinding(closeAuthNow+120), "short"))
		require.Error(t, err)
		assert.Regexp(t, "32 bytes", err.Error())

		_, err = batchsettlement.EncodeCloseAuthorizationDigest(closeBinding(0))
		require.Error(t, err)
		assert.Regexp(t, "validBefore", err.Error())

		negative := closeBinding(closeAuthNow + 120)
		negative.MaxClaimableAmount = big.NewInt(-1)
		_, err = batchsettlement.EncodeCloseAuthorizationDigest(negative)
		require.Error(t, err)
		assert.Regexp(t, "u64", err.Error())
	})

	t.Run("signs and verifies within the validity window only", func(t *testing.T) {
		authorization, err := batchsettlement.SignCloseAuthorization(context.Background(), authorizer, closeBinding(closeAuthNow+120))
		require.NoError(t, err)
		fields := closeBinding(closeAuthNow + 120)
		fields.ValidBefore = 0
		assert.Equal(t, closeAuthNow+120, authorization.ValidBefore)
		assert.True(t, batchsettlement.VerifyCloseAuthorization(authorization, fields, authorizer.Address().String(), 300, closeAuthNow))
		assert.False(t, batchsettlement.VerifyCloseAuthorization(authorization, fields, other.Address().String(), 300, closeAuthNow))

		rebound := fields
		rebound.MaxClaimableAmount = big.NewInt(4999)
		assert.False(t, batchsettlement.VerifyCloseAuthorization(authorization, rebound, authorizer.Address().String(), 300, closeAuthNow))
		assert.False(t, batchsettlement.VerifyCloseAuthorization(authorization, fields, authorizer.Address().String(), 300, closeAuthNow+120))
		assert.False(t, batchsettlement.VerifyCloseAuthorization(authorization, fields, authorizer.Address().String(), 60, closeAuthNow))

		garbage := authorization
		garbage.Signature = "nope"
		assert.False(t, batchsettlement.VerifyCloseAuthorization(garbage, fields, authorizer.Address().String(), 300, closeAuthNow))
	})
}

func closeBinding(validBefore int64) batchsettlement.CloseAuthorizationBinding {
	return batchsettlement.CloseAuthorizationBinding{
		ChannelID:          svm.USDCMainnetAddress,
		FeePayer:           svm.USDCDevnetAddress,
		MaxClaimableAmount: big.NewInt(5000),
		Network:            svm.SolanaDevnetCAIP2,
		ValidBefore:        validBefore,
		VoucherExpiresAt:   0,
	}
}

func withChannel(binding batchsettlement.CloseAuthorizationBinding, channelID string) batchsettlement.CloseAuthorizationBinding {
	binding.ChannelID = channelID
	return binding
}

func withFeePayer(binding batchsettlement.CloseAuthorizationBinding, feePayer string) batchsettlement.CloseAuthorizationBinding {
	binding.FeePayer = feePayer
	return binding
}

func withAmount(binding batchsettlement.CloseAuthorizationBinding, amount int64) batchsettlement.CloseAuthorizationBinding {
	binding.MaxClaimableAmount = big.NewInt(amount)
	return binding
}

func withVoucherExpiry(binding batchsettlement.CloseAuthorizationBinding, expires int64) batchsettlement.CloseAuthorizationBinding {
	binding.VoucherExpiresAt = expires
	return binding
}

func withNetwork(binding batchsettlement.CloseAuthorizationBinding, network string) batchsettlement.CloseAuthorizationBinding {
	binding.Network = network
	return binding
}

type closeSigner struct{ key solana.PrivateKey }

func newCloseSigner(t *testing.T) closeSigner {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return closeSigner{key: key}
}

func (s closeSigner) Address() solana.PublicKey { return s.key.PublicKey() }

func (s closeSigner) SignMessage(_ context.Context, message []byte) ([]byte, error) {
	signature, err := s.key.Sign(message)
	if err != nil {
		return nil, err
	}
	return signature[:], nil
}
