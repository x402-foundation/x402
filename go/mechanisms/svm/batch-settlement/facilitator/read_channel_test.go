package facilitator

import (
	"context"
	"sync"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestBatchSettlementChannelReadsUnderAConfirmationSlotFloor(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)

	t.Run("retries a read the backend rejects for the remembered slot, then returns the account", func(t *testing.T) {
		signer := &rejectingAccountSigner{
			scriptedSigner: newScriptedSigner(t, 1),
			errors: []error{
				errString("Minimum context slot has not been reached"),
				errString("Minimum context slot has not been reached"),
			},
		}
		scheme := newReadScheme(signer)
		scheme.rememberSlot(network, 321)

		channel, err := scheme.readChannel(context.Background(), network, signer.feePayer().String())
		require.NoError(t, err)
		assert.Nil(t, channel)
		calls := signer.calls()
		assert.Len(t, calls, 3)
		for _, call := range calls {
			require.NotNil(t, call.opts)
			assert.Equal(t, rpc.CommitmentConfirmed, call.opts.Commitment)
			require.NotNil(t, call.opts.MinContextSlot)
			assert.Equal(t, uint64(321), *call.opts.MinContextSlot)
		}
	})

	t.Run("gives up after the read budget when the backend never catches up", func(t *testing.T) {
		signer := &rejectingAccountSigner{
			scriptedSigner: newScriptedSigner(t, 1),
			always:         errString("Minimum context slot has not been reached"),
		}
		scheme := newReadScheme(signer)
		scheme.rememberSlot(network, 321)

		_, err := scheme.readChannel(context.Background(), network, signer.feePayer().String())
		require.Error(t, err)
		assert.ErrorContains(t, err, "Minimum context slot has not been reached")
		assert.Len(t, signer.calls(), ChannelReadAttempts)
	})

	t.Run("treats a missing account as no channel", func(t *testing.T) {
		signer := &rejectingAccountSigner{
			scriptedSigner: newScriptedSigner(t, 1),
			always:         rpc.ErrNotFound,
		}
		scheme := newReadScheme(signer)

		channel, err := scheme.readChannel(context.Background(), network, signer.feePayer().String())
		require.NoError(t, err)
		assert.Nil(t, channel)
		assert.Len(t, signer.calls(), 1)
	})

	t.Run("surfaces a read error at once when no slot floor is in effect", func(t *testing.T) {
		signer := &rejectingAccountSigner{
			scriptedSigner: newScriptedSigner(t, 1),
			always:         errString("rpc unavailable"),
		}
		scheme := newReadScheme(signer)

		_, err := scheme.readChannel(context.Background(), network, signer.feePayer().String())
		require.Error(t, err)
		assert.ErrorContains(t, err, "rpc unavailable")
		calls := signer.calls()
		assert.Len(t, calls, 1)
		require.NotNil(t, calls[0].opts)
		assert.Nil(t, calls[0].opts.MinContextSlot)
	})
}

func newReadScheme(signer *rejectingAccountSigner) *BatchSvmScheme {
	scheme := NewBatchSvmScheme(context.Background(), signer, nil)
	scheme.hooks.waitForChannelRead = func(int) error { return nil }
	return scheme
}

type errString string

func (e errString) Error() string { return string(e) }

// rejectingAccountSigner fails GetAccountInfo with a scripted sequence, then returns no account.
type rejectingAccountSigner struct {
	*scriptedSigner
	mu     sync.Mutex
	errors []error
	always error
	seen   []accountCall
}

func (s *rejectingAccountSigner) GetAccountInfo(
	ctx context.Context,
	account solana.PublicKey,
	network string,
	opts *rpc.GetAccountInfoOpts,
) (*rpc.GetAccountInfoResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen = append(s.seen, accountCall{account: account, opts: opts})
	if s.always != nil {
		return nil, s.always
	}
	if len(s.errors) > 0 {
		err := s.errors[0]
		s.errors = s.errors[1:]
		return nil, err
	}
	return s.scriptedSigner.GetAccountInfo(ctx, account, network, opts)
}

func (s *rejectingAccountSigner) calls() []accountCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]accountCall(nil), s.seen...)
}
