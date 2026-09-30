package facilitator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestExpiryOfABroadcastThatWasNeverConfirmed(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	feePayer := mustKey(t)
	const blockhash = "11111111111111111111111111111111"
	instruction := solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte{1})
	tx, err := solana.NewTransaction([]solana.Instruction{instruction}, solana.MustHashFromBase58(blockhash), solana.TransactionPayer(feePayer.PublicKey()))
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
	signature := tx.Signatures[0]
	key := "batch:distribute:" + network + ":" + svm.USDCDevnetAddress + ":" + svm.USDCMainnetAddress + ":" + svm.USDCMainnetAddress
	wireKey := "batch:transaction:" + network + ":" + signature.String() + ":wire"

	pendingScheme := func(t *testing.T, signer svm.FacilitatorSvmSigner) (*BatchSvmScheme, *InMemoryPendingSettlementStore) {
		t.Helper()
		store := NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, signature.String()))
		require.NoError(t, store.Set(context.Background(), wireKey, wire))
		scheme := NewBatchSvmScheme(context.Background(), signer, &Config{
			PendingSettlementStore: store,
		})
		return scheme, store
	}
	newCaps := func(t *testing.T, valid func(context.Context, solana.Hash, string) (bool, error), confirmed func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error)) *capabilitySigner {
		t.Helper()
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		inner.confirmErr = errString("Transaction confirmation timeout")
		return &capabilitySigner{scriptedSigner: inner, blockhashValid: valid, confirmed: confirmed}
	}

	t.Run("releases the queue when the blockhash expired and the network has no record", func(t *testing.T) {
		signer := newCaps(t, func(context.Context, solana.Hash, string) (bool, error) { return false, nil }, nil)
		scheme, store := pendingScheme(t, signer)
		result, err := scheme.reconcileBroadcast(context.Background(), key, signature.String(), network, "")
		require.NoError(t, err)
		assert.False(t, result.OK)
		require.NotNil(t, result.Response)
		assert.False(t, result.Response.Success)
		assert.Equal(t, "transaction_failed", result.Response.ErrorReason)
		assert.Equal(t, signature.String(), result.Response.Transaction)
		assert.Contains(t, result.Response.ErrorMessage, "expired")
		require.NotEmpty(t, signer.blockhashCalls)
		assert.Equal(t, blockhash, signer.blockhashCalls[0].String())
		assert.Equal(t, 1, signer.confirmedCalls)
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
		_, ok, err = store.Get(context.Background(), wireKey)
		require.NoError(t, err)
		assert.False(t, ok)
		sent := signer.sentTransactions()
		require.Len(t, sent, 1)
		encoded, err := svm.EncodeTransaction(sent[0])
		require.NoError(t, err)
		assert.Equal(t, wire, encoded)
	})

	t.Run("stays pending while the blockhash is still valid", func(t *testing.T) {
		signer := newCaps(t, func(context.Context, solana.Hash, string) (bool, error) { return true, nil }, nil)
		scheme, store := pendingScheme(t, signer)
		result, err := scheme.reconcileBroadcast(context.Background(), key, signature.String(), network, "")
		require.NoError(t, err)
		assert.False(t, result.OK)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		assert.Zero(t, signer.confirmedCalls)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, signature.String(), got)
		got, ok, err = store.Get(context.Background(), wireKey)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, wire, got)
	})

	t.Run("stays pending when the expired blockhash's transaction is found in history", func(t *testing.T) {
		signer := newCaps(t, func(context.Context, solana.Hash, string) (bool, error) { return false, nil }, func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
			return &svm.FacilitatorConfirmedTransaction{Slot: 5}, nil
		})
		scheme, store := pendingScheme(t, signer)
		result, err := scheme.reconcileBroadcast(context.Background(), key, signature.String(), network, "")
		require.NoError(t, err)
		assert.False(t, result.OK)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, signature.String(), got)
	})

	t.Run("stays pending when the signer cannot check blockhash validity", func(t *testing.T) {
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		inner.confirmErr = errString("Transaction confirmation timeout")
		scheme, store := pendingScheme(t, inner)
		result, err := scheme.reconcileBroadcast(context.Background(), key, signature.String(), network, "")
		require.NoError(t, err)
		assert.False(t, result.OK)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, signature.String(), got)
	})

	t.Run("never classifies a broadcast as expired without its bytes or on a failing check", func(t *testing.T) {
		signer := newCaps(t, func(context.Context, solana.Hash, string) (bool, error) { return false, nil }, nil)
		assert.False(t, BroadcastExpiredWithoutLanding(context.Background(), signer, signature, network, ""))
		assert.False(t, BroadcastExpiredWithoutLanding(context.Background(), signer, signature, network, "not-a-transaction"))
		failing := newCaps(t, func(context.Context, solana.Hash, string) (bool, error) {
			return false, errString("rpc down")
		}, nil)
		assert.False(t, BroadcastExpiredWithoutLanding(context.Background(), failing, signature, network, wire))
		assert.True(t, BroadcastExpiredWithoutLanding(context.Background(), newCaps(t, func(context.Context, solana.Hash, string) (bool, error) {
			return false, nil
		}, nil), signature, network, wire))
	})
}

func TestAmbiguousPayoutAttribution(t *testing.T) {
	t.Run("answers with its own reason and releases the sweep queue", func(t *testing.T) {
		network := string(svm.SolanaDevnetCAIP2)
		payer := mustKey(t)
		feePayer := mustKey(t)
		payTo := payer.PublicKey().String()
		channelID := svm.USDCMainnetAddress
		key := "batch:distribute:" + network + ":" + svm.USDCDevnetAddress + ":" + payTo + ":" + channelID
		mint := solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress)
		tokenProgram := solana.MustPublicKeyFromBase58(svm.TokenProgramAddress)
		recipient, err := paymentchannels.FindATA(payer.PublicKey(), mint, tokenProgram)
		require.NoError(t, err)
		escrow, err := paymentchannels.FindATA(solana.MustPublicKeyFromBase58(channelID), mint, tokenProgram)
		require.NoError(t, err)
		token := func(index int, owner, amount string) svm.FacilitatorTokenBalance {
			return svm.FacilitatorTokenBalance{AccountIndex: index, Mint: svm.USDCDevnetAddress, Owner: owner, UITokenAmount: svm.FacilitatorTokenAmount{Amount: amount}}
		}
		signature := solana.Signature{7}
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		signer := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return &svm.FacilitatorConfirmedTransaction{
					Slot:        100,
					AccountKeys: []string{recipient.String(), escrow.String()},
					Meta: &svm.FacilitatorConfirmedMeta{
						PreTokenBalances:  []svm.FacilitatorTokenBalance{token(0, payTo, "100"), token(1, channelID, "9800")},
						PostTokenBalances: []svm.FacilitatorTokenBalance{token(0, payTo, "9900")},
					},
				}, nil
			},
		}
		store := NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, signature.String()))
		var recorded int
		scheme := NewBatchSvmScheme(context.Background(), signer, &Config{
			PendingSettlementStore: store,
			OnDistributionConfirmed: func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
				recorded++
				return nil
			},
		})
		terms := BatchTerms{FeePayer: feePayer.PublicKey().String(), TokenProgram: svm.TokenProgramAddress, WithdrawDelay: 900, VoucherSigner: batchsettlement.VoucherSignerClient}
		scheme.hooks.resolveTerms = func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error) {
			return terms, nil
		}
		scheme.hooks.deriveChannelID = func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error) {
			return channelID, nil
		}
		requirements := types.PaymentRequirements{
			Amount: "1000", Asset: svm.USDCDevnetAddress, Network: network, PayTo: payTo, Scheme: batchsettlement.Scheme,
			MaxTimeoutSeconds: 300,
			Extra:             map[string]any{"feePayer": feePayer.PublicKey().String(), "tokenProgram": svm.TokenProgramAddress, "withdrawDelay": 900},
		}
		response, err := scheme.Settle(context.Background(), types.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload: asMap(t, batchsettlement.BatchSettlePayload{
				Type: batchsettlement.PayloadTypeSettle,
				Channels: []batchsettlement.BatchSettleChannel{{
					ChannelID: channelID,
					ChannelConfig: batchsettlement.BatchChannelConfig{
						OpenSlot: 1, Payer: payer.PublicKey().String(), PayerAuthorizer: payer.PublicKey().String(),
						Receiver: svm.USDCMainnetAddress, Salt: "0", Token: svm.USDCDevnetAddress, WithdrawDelay: 900,
					},
				}},
			}),
		}, requirements, nil)
		require.NoError(t, err)
		assert.False(t, response.Success)
		assert.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, response.ErrorReason)
		assert.Equal(t, signature.String(), response.Transaction)
		assert.Zero(t, recorded)
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
		raw, ok, err := store.Get(context.Background(), key+":result")
		require.NoError(t, err)
		require.True(t, ok)
		var stored x402.SettleResponse
		require.NoError(t, json.Unmarshal([]byte(raw), &stored))
		assert.Equal(t, batchsettlement.ErrPayoutAttributionAmbiguous, stored.ErrorReason)
	})
}

func TestWireRecords(t *testing.T) {
	t.Run("drops the bytes written by a broadcast that lost its reservation", func(t *testing.T) {
		network := string(svm.SolanaDevnetCAIP2)
		feePayer := mustKey(t)
		const blockhash = "11111111111111111111111111111111"
		tx, err := solana.NewTransaction(
			[]solana.Instruction{solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte{1})},
			solana.MustHashFromBase58(blockhash),
			solana.TransactionPayer(feePayer.PublicKey()),
		)
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
		key := "batch:distribute:" + network + ":" + svm.USDCDevnetAddress + ":" + svm.USDCMainnetAddress + ":" + svm.USDCMainnetAddress
		store := NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, "other-signature"))
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayer
		scheme := NewBatchSvmScheme(context.Background(), inner, &Config{
			PendingSettlementStore: store,
		})
		scheme.hooks.reconcileBroadcast = func(context.Context, string, string, string, string) (durableResult, error) {
			return durableResult{OK: true, Signature: "other-signature"}, nil
		}
		_, err = scheme.broadcastDurably(context.Background(), key, network, "", func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared(signature, wire))
			return signature, nil
		})
		require.NoError(t, err)
		_, ok, err := store.Get(context.Background(), "batch:transaction:"+network+":"+signature+":wire")
		require.NoError(t, err)
		assert.False(t, ok)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, "other-signature", got)
	})
}

func TestConfirmationPolling(t *testing.T) {
	t.Run("searches transaction history on the first lookup only", func(t *testing.T) {
		var requests [][]any
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
				Params []any  `json:"params"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			requests = append(requests, body.Params)
			value := any(nil)
			if len(requests) > 1 {
				value = map[string]any{"slot": 7, "confirmationStatus": "confirmed", "err": nil}
			}
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      body.ID,
				"result":  map[string]any{"context": map[string]any{"slot": 1}, "value": []any{value}},
			}))
		}))
		defer server.Close()
		signature := solana.Signature{9}
		err := paymentchannels.ConfirmSignature(context.Background(), rpc.New(server.URL), signature, 3*time.Second, true)
		require.NoError(t, err)
		require.Len(t, requests, 2)
		assert.Equal(t, []any{[]any{signature.String()}, map[string]any{"searchTransactionHistory": true}}, requests[0])
		assert.Equal(t, []any{[]any{signature.String()}}, requests[1])
	})
}
