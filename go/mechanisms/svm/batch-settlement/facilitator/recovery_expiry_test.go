package facilitator

import (
	"context"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func TestExpiryOfABroadcastThatWasNeverConfirmed(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	feePayer := mustKey(t)
	blockhash := solana.Hash{1}
	instruction := solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte{1})
	tx, err := solana.NewTransaction([]solana.Instruction{instruction}, blockhash, solana.TransactionPayer(feePayer.PublicKey()))
	require.NoError(t, err)
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(feePayer.PublicKey()) {
			return &feePayer
		}
		return nil
	})
	require.NoError(t, err)
	wire, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)
	signature := tx.Signatures[0].String()
	record := encodeBroadcastRecord(signature, blockhash.String(), "")
	timedOutRecord := encodeBroadcastRecord(signature, blockhash.String(), wire)
	key := "batch:claim:" + network + ":" + svm.USDCDevnetAddress + ":1000"

	newScheme := func(t *testing.T, valid func(context.Context, solana.Hash, string) (bool, error), confirmed func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error)) (*BatchSvmScheme, *capabilitySigner, *x402.InMemoryPendingSettlementStore, *svm.InMemoryDuplicateSettlementStore) {
		t.Helper()
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		inner.confirmErr = errString("Transaction confirmation timeout")
		signer := &capabilitySigner{scriptedSigner: inner, blockhashValid: valid, confirmed: confirmed}
		pending := x402.NewInMemoryPendingSettlementStore()
		duplicates := svm.NewInMemoryDuplicateSettlementStore()
		scheme := NewBatchSvmScheme(context.Background(), signer, &Config{
			PendingSettlementStore:   pending,
			DuplicateSettlementStore: duplicates,
		})
		return scheme, signer, pending, duplicates
	}
	expired := func(context.Context, solana.Hash, string) (bool, error) { return false, nil }
	live := func(context.Context, solana.Hash, string) (bool, error) { return true, nil }
	holdRecord := func(t *testing.T, pending *x402.InMemoryPendingSettlementStore, duplicates *svm.InMemoryDuplicateSettlementStore, held string) {
		t.Helper()
		require.NoError(t, pending.Set(context.Background(), key, held))
		_, reserved, err := duplicates.Reserve(context.Background(), key, held, ReservationTTL)
		require.NoError(t, err)
		require.True(t, reserved)
	}

	t.Run("clears the pending record and the reservation when the blockhash expired and the network has no record", func(t *testing.T) {
		scheme, signer, pending, duplicates := newScheme(t, expired, nil)
		holdRecord(t, pending, duplicates, record)

		result, err := scheme.reconcileBroadcast(context.Background(), key, record, network, "")
		require.NoError(t, err)
		assert.False(t, result.OK)
		require.NotNil(t, result.Response)
		assert.Equal(t, "transaction_failed", result.Response.ErrorReason)
		assert.Equal(t, signature, result.Response.Transaction)
		assert.Contains(t, result.Response.ErrorMessage, "expired")
		require.Equal(t, []solana.Hash{blockhash}, signer.blockhashCalls)
		assert.Equal(t, 1, signer.confirmedCalls)
		_, ok, err := pending.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
		_, reserved, err := duplicates.Reserve(context.Background(), key, "next", ReservationTTL)
		require.NoError(t, err)
		assert.True(t, reserved, "a retry must be able to send afresh")
		assert.Empty(t, signer.sentTransactions())
	})

	t.Run("keeps the record, blockhash included, while the blockhash is still valid", func(t *testing.T) {
		scheme, signer, pending, duplicates := newScheme(t, live, nil)
		holdRecord(t, pending, duplicates, record)

		result, err := scheme.reconcileBroadcast(context.Background(), key, record, network, "")
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		assert.Equal(t, signature, result.Response.Transaction)
		assert.Zero(t, signer.confirmedCalls)
		got, ok, err := pending.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, record, got)
	})

	t.Run("stays pending when the expired blockhash's transaction is found in history", func(t *testing.T) {
		scheme, _, pending, duplicates := newScheme(t, expired, func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
			return &svm.FacilitatorConfirmedTransaction{Slot: 5}, nil
		})
		holdRecord(t, pending, duplicates, record)

		result, err := scheme.reconcileBroadcast(context.Background(), key, record, network, "")
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		got, ok, err := pending.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, record, got)
	})

	t.Run("stays pending when the record has no blockhash or the signer cannot check validity", func(t *testing.T) {
		scheme, signer, pending, duplicates := newScheme(t, expired, nil)
		holdRecord(t, pending, duplicates, signature)
		result, err := scheme.reconcileBroadcast(context.Background(), key, signature, network, "")
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		assert.Empty(t, signer.blockhashCalls)

		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		inner.confirmErr = errString("Transaction confirmation timeout")
		plain := NewBatchSvmScheme(context.Background(), inner, &Config{PendingSettlementStore: x402.NewInMemoryPendingSettlementStore()})
		result, err = plain.reconcileBroadcast(context.Background(), key, record, network, "")
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
	})

	t.Run("never classifies a broadcast as expired on a failing check", func(t *testing.T) {
		parsed := tx.Signatures[0]
		scheme, _, _, _ := newScheme(t, expired, nil)
		assert.False(t, scheme.expiredWithoutLanding(context.Background(), parsed, "", network))
		assert.False(t, scheme.expiredWithoutLanding(context.Background(), parsed, "not-a-hash", network))
		assert.True(t, scheme.expiredWithoutLanding(context.Background(), parsed, blockhash.String(), network))
		failing, _, _, _ := newScheme(t, func(context.Context, solana.Hash, string) (bool, error) {
			return false, errString("rpc down")
		}, nil)
		assert.False(t, failing.expiredWithoutLanding(context.Background(), parsed, blockhash.String(), network))
	})

	t.Run("a retry sends the kept transaction again and keeps it while the blockhash is valid", func(t *testing.T) {
		scheme, signer, pending, duplicates := newScheme(t, live, nil)
		require.NoError(t, pending.Set(context.Background(), key, timedOutRecord))
		_, reserved, err := duplicates.Reserve(context.Background(), key, record, ReservationTTL)
		require.NoError(t, err)
		require.True(t, reserved)

		result, err := scheme.reconcileBroadcast(context.Background(), key, timedOutRecord, network, "")
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		assert.Equal(t, signature, result.Response.Transaction)
		sent := signer.sentTransactions()
		require.Len(t, sent, 1)
		assert.Equal(t, tx.Signatures[0], sent[0].Signatures[0])
		got, ok, err := pending.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, timedOutRecord, got)
	})

	t.Run("an expired record that kept its transaction still frees the reservation", func(t *testing.T) {
		scheme, _, pending, duplicates := newScheme(t, expired, nil)
		require.NoError(t, pending.Set(context.Background(), key, timedOutRecord))
		_, reserved, err := duplicates.Reserve(context.Background(), key, record, ReservationTTL)
		require.NoError(t, err)
		require.True(t, reserved)

		result, err := scheme.reconcileBroadcast(context.Background(), key, timedOutRecord, network, "")
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, "transaction_failed", result.Response.ErrorReason)
		_, reserved, err = duplicates.Reserve(context.Background(), key, "next", ReservationTTL)
		require.NoError(t, err)
		assert.True(t, reserved, "the reservation holds the record without its transaction")
	})

	t.Run("a retry never sends a kept transaction that does not match the record's signature", func(t *testing.T) {
		scheme, signer, _, _ := newScheme(t, live, nil)
		other := encodeBroadcastRecord(solana.Signature{9}.String(), blockhash.String(), wire)

		_, err := scheme.reconcileBroadcast(context.Background(), key, other, network, "")
		require.NoError(t, err)
		assert.Empty(t, signer.sentTransactions())
	})

	t.Run("a timed-out send keeps its blockhash and transaction, and a retry after expiry broadcasts afresh", func(t *testing.T) {
		scheme, signer, pending, _ := newScheme(t, expired, nil)
		sends := 0
		timedOut := func(onPrepared func(string, string) error) (string, error) {
			sends++
			if err := onPrepared(signature, wire); err != nil {
				return "", err
			}
			return "", &paymentchannels.SettlementConfirmationTimeoutError{Signature: signature}
		}
		landed := func(onPrepared func(string, string) error) (string, error) {
			sends++
			if err := onPrepared("fresh-signature", wire); err != nil {
				return "", err
			}
			return "fresh-signature", nil
		}
		args := func(send func(func(string, string) error) (string, error)) durableArgs {
			return durableArgs{
				key:     key,
				network: network,
				send:    send,
				postcondition: func(string, bool) (any, *x402.SettleResponse, error) {
					return nil, nil, nil
				},
			}
		}

		_, _, response, err := scheme.settleDurably(context.Background(), args(timedOut))
		require.NoError(t, err)
		require.NotNil(t, response)
		assert.Equal(t, x402.ErrSettlementPending, response.ErrorReason)
		assert.Equal(t, signature, response.Transaction)
		stored, ok, err := pending.Get(context.Background(), key)
		require.NoError(t, err)
		require.True(t, ok)
		assert.Equal(t, timedOutRecord, stored)

		_, _, response, err = scheme.settleDurably(context.Background(), args(landed))
		require.NoError(t, err)
		require.NotNil(t, response)
		assert.Equal(t, "transaction_failed", response.ErrorReason)
		assert.Contains(t, response.ErrorMessage, "expired")
		assert.Equal(t, 1, sends, "the expired record is answered without a new broadcast")
		assert.Len(t, signer.sentTransactions(), 1, "only the kept transaction is sent again")
		_, ok, err = pending.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)

		_, signed, response, err := scheme.settleDurably(context.Background(), args(landed))
		require.NoError(t, err)
		assert.Nil(t, response)
		assert.Equal(t, "fresh-signature", signed)
		assert.Equal(t, 2, sends)
	})

	t.Run("a worker that loses the reservation reconciles with the holder's blockhash", func(t *testing.T) {
		scheme, _, pending, duplicates := newScheme(t, expired, nil)
		_, reserved, err := duplicates.Reserve(context.Background(), key, record, time.Minute)
		require.NoError(t, err)
		require.True(t, reserved)

		result, err := scheme.sendDurably(context.Background(), key, key, network, "", func(onPrepared func(string, string) error) (string, error) {
			if err := onPrepared("other-signature", wire); err != nil {
				return "", err
			}
			return "other-signature", nil
		})
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, "transaction_failed", result.Response.ErrorReason)
		assert.Equal(t, signature, result.Response.Transaction)
		_, ok, err := pending.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
	})
}
