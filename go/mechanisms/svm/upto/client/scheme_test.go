package client

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

const testNetwork = "solana-devnet"

// testSigner is a client signer backed by an ephemeral keypair.
type testSigner struct {
	key solana.PrivateKey
}

func newTestSigner(t *testing.T) *testSigner {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return &testSigner{key: key}
}

func (s *testSigner) Address() solana.PublicKey {
	return s.key.PublicKey()
}

func (s *testSigner) SignTransaction(_ context.Context, tx *solana.Transaction) error {
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return err
	}
	signature, err := s.key.Sign(message)
	if err != nil {
		return err
	}
	index, err := tx.GetAccountIndex(s.key.PublicKey())
	if err != nil {
		return err
	}
	if len(tx.Signatures) <= int(index) {
		signatures := make([]solana.Signature, index+1)
		copy(signatures, tx.Signatures)
		tx.Signatures = signatures
	}
	tx.Signatures[index] = signature
	return nil
}

// stubRPC serves the handful of JSON-RPC methods the client falls back to when
// the challenge omits its blockhash and slot hints.
func stubRPC(t *testing.T, slot uint64, blockhash solana.Hash) string {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     interface{} `json:"id"`
			Method string      `json:"method"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))

		var result interface{}
		switch request.Method {
		case "getSlot":
			result = slot
		case "getLatestBlockhash":
			result = map[string]interface{}{
				"context": map[string]interface{}{"slot": slot},
				"value": map[string]interface{}{
					"blockhash":            blockhash.String(),
					"lastValidBlockHeight": slot + 150,
				},
			}
		default:
			t.Errorf("unexpected RPC method %s", request.Method)
		}

		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  result,
		}))
	}))
	t.Cleanup(server.Close)
	return server.URL
}

// unreachableRPC fails the test if the client makes any RPC call.
func unreachableRPC(t *testing.T) string {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		t.Errorf("the client called %s despite a complete challenge", request.Method)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

type challengeOptions struct {
	omitHints bool
	memo      *string
	amount    string
}

func newRequirements(t *testing.T, feePayer, authorizer solana.PublicKey, opts challengeOptions) types.PaymentRequirements {
	t.Helper()

	amount := opts.amount
	if amount == "" {
		amount = "10000"
	}
	extra := map[string]interface{}{
		upto.ExtraFeePayer:           feePayer.String(),
		upto.ExtraReceiverAuthorizer: authorizer.String(),
		upto.ExtraWithdrawDelay:      float64(3600),
		upto.ExtraTokenProgram:       solana.TokenProgramID.String(),
	}
	if !opts.omitHints {
		extra[upto.ExtraRecentBlockhash] = solana.Hash(solana.SystemProgramID).String()
		extra[upto.ExtraRecentSlot] = "341000000"
	}
	if opts.memo != nil {
		extra[upto.ExtraMemo] = *opts.memo
	}

	return types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Amount:            amount,
		Asset:             svm.USDCDevnetAddress,
		PayTo:             solana.SysVarClockPubkey.String(),
		MaxTimeoutSeconds: 600,
		Extra:             extra,
	}
}

func TestCreatePaymentPayloadBuildsAVerifiableOpen(t *testing.T) {
	signer := newTestSigner(t)
	feePayer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	authorizer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	memo := "order-42"
	requirements := newRequirements(t, feePayer, authorizer, challengeOptions{memo: &memo})
	scheme := NewUptoSvmScheme(signer)

	payload, err := scheme.CreatePaymentPayload(context.Background(), requirements)
	require.NoError(t, err)

	assert.Equal(t, 2, payload.X402Version)
	decoded, err := svm.UptoPayloadFromMap(payload.Payload)
	require.NoError(t, err)

	assert.Equal(t, signer.Address().String(), decoded.From)
	assert.Equal(t, "10000", decoded.MaxAmount)
	assert.Equal(t, "10000", decoded.Deposit, "the deposit is the authorized ceiling")
	assert.Equal(t, authorizer.String(), decoded.AuthorizedSigner)
	assert.Equal(t, "341000000", decoded.OpenSlot)
	assert.Empty(t, decoded.VoucherSignature, "the voucher is server-owned and never client-set")
	assert.False(t, svm.HasUptoVoucherSignature(payload.Payload))

	_, err = strconv.ParseUint(decoded.Nonce, 10, 64)
	require.NoError(t, err, "nonce is the decimal u64 open salt")

	now := time.Now().Unix()
	assert.LessOrEqual(t, decoded.ValidAfter, now)
	assert.InDelta(t, now+600, decoded.ExpiresAt, 5)

	// The facilitator's acceptance policy must accept what the client built.
	recentSlot := uint64(341_000_000)
	result, err := paymentchannels.VerifyOpenTransaction(decoded.OpenTransaction, paymentchannels.VerifyOpenExpected{
		AuthorizedSigner: authorizer,
		FeePayer:         feePayer,
		From:             signer.Address(),
		Mint:             solana.MustPublicKeyFromBase58(requirements.Asset),
		TokenProgram:     solana.TokenProgramID,
		Payee:            feePayer,
		MaxCap:           10_000,
		WithdrawDelay:    3600,
		OpenSlot:         recentSlot,
		Recipients: []paymentchannels.Split{
			{Recipient: requirements.PayTo, BPS: paymentchannels.BasisPointsDenominator},
		},
		RecentSlot: &recentSlot,
		Memo:       &memo,
	})
	require.NoError(t, err)
	assert.Equal(t, decoded.ChannelId, result.ChannelID.String())
	assert.Equal(t, decoded.Nonce, strconv.FormatUint(result.Salt, 10))
}

// An empty extra.memo is a seller that set no memo, not a demand for an empty
// one. The client still emits its uniqueness nonce, and the facilitator (which
// resolves the same way) does not bind to it.
func TestCreatePaymentPayloadTreatsAnEmptyMemoAsUnset(t *testing.T) {
	signer := newTestSigner(t)
	feePayer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	authorizer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	empty := ""
	requirements := newRequirements(t, feePayer, authorizer, challengeOptions{memo: &empty})
	scheme := NewUptoSvmScheme(signer)

	payload, err := scheme.CreatePaymentPayload(context.Background(), requirements)
	require.NoError(t, err)

	decoded, err := svm.UptoPayloadFromMap(payload.Payload)
	require.NoError(t, err)
	recentSlot := uint64(341_000_000)
	expected := paymentchannels.VerifyOpenExpected{
		AuthorizedSigner: authorizer,
		FeePayer:         feePayer,
		From:             signer.Address(),
		Mint:             solana.MustPublicKeyFromBase58(requirements.Asset),
		TokenProgram:     solana.TokenProgramID,
		Payee:            feePayer,
		MaxCap:           10_000,
		WithdrawDelay:    3600,
		OpenSlot:         recentSlot,
		Recipients: []paymentchannels.Split{
			{Recipient: requirements.PayTo, BPS: paymentchannels.BasisPointsDenominator},
		},
		RecentSlot: &recentSlot,
		Memo:       upto.ParseExtraMemo(requirements.Extra[upto.ExtraMemo]),
	}
	require.Nil(t, expected.Memo, `extra.memo "" resolves to unset`)

	_, err = paymentchannels.VerifyOpenTransaction(decoded.OpenTransaction, expected)
	require.NoError(t, err)

	// The open carries a nonce, not the empty memo, so a facilitator that did
	// demand an empty memo would reject it.
	expected.Memo = &empty
	_, err = paymentchannels.VerifyOpenTransaction(decoded.OpenTransaction, expected)
	require.ErrorContains(t, err, "does not match extra.memo")
}

func TestCreatePaymentPayloadFallsBackToRPCHints(t *testing.T) {
	signer := newTestSigner(t)
	feePayer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	authorizer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	requirements := newRequirements(t, feePayer, authorizer, challengeOptions{omitHints: true})
	rpcURL := stubRPC(t, 341_000_123, solana.Hash(solana.SysVarRentPubkey))
	scheme := NewUptoSvmScheme(signer, &svm.ClientConfig{RPCURL: rpcURL})

	payload, err := scheme.CreatePaymentPayload(context.Background(), requirements)
	require.NoError(t, err)

	decoded, err := svm.UptoPayloadFromMap(payload.Payload)
	require.NoError(t, err)
	assert.Equal(t, "341000123", decoded.OpenSlot, "openSlot falls back to getSlot")

	transaction, err := svm.DecodeTransaction(decoded.OpenTransaction)
	require.NoError(t, err)
	assert.Equal(t, solana.Hash(solana.SysVarRentPubkey), transaction.Message.RecentBlockhash)
}

// Every hint the server advertises saves the client a round-trip, so a complete
// challenge must not touch RPC at all.
func TestCreatePaymentPayloadUsesChallengeHintsWithoutRPC(t *testing.T) {
	signer := newTestSigner(t)
	feePayer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	authorizer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	requirements := newRequirements(t, feePayer, authorizer, challengeOptions{})
	scheme := NewUptoSvmScheme(signer, &svm.ClientConfig{RPCURL: unreachableRPC(t)})

	payload, err := scheme.CreatePaymentPayload(context.Background(), requirements)
	require.NoError(t, err)

	decoded, err := svm.UptoPayloadFromMap(payload.Payload)
	require.NoError(t, err)
	assert.Equal(t, "341000000", decoded.OpenSlot)

	transaction, err := svm.DecodeTransaction(decoded.OpenTransaction)
	require.NoError(t, err)
	assert.Equal(t, solana.Hash(solana.SystemProgramID), transaction.Message.RecentBlockhash)
}

// The open's ComputeBudget prefix is fixed by the scheme, not the caller: the
// facilitator's compute-unit and priority-fee caps are verified against it.
func TestCreatePaymentPayloadUsesTheOpenComputeBudgetDefaults(t *testing.T) {
	signer := newTestSigner(t)
	feePayer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	authorizer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	requirements := newRequirements(t, feePayer, authorizer, challengeOptions{})
	scheme := NewUptoSvmScheme(signer, &svm.ClientConfig{})

	payload, err := scheme.CreatePaymentPayload(context.Background(), requirements)
	require.NoError(t, err)

	decoded, err := svm.UptoPayloadFromMap(payload.Payload)
	require.NoError(t, err)
	transaction, err := svm.DecodeTransaction(decoded.OpenTransaction)
	require.NoError(t, err)

	instructions := transaction.Message.Instructions
	require.GreaterOrEqual(t, len(instructions), 2)
	program, err := transaction.Message.Program(instructions[0].ProgramIDIndex)
	require.NoError(t, err)
	assert.True(t, program.Equals(solana.ComputeBudget))
	assert.Equal(
		t,
		paymentchannels.OpenDefaultComputeUnitLimit,
		binary.LittleEndian.Uint32(instructions[0].Data[1:5]),
	)
	assert.Equal(
		t,
		uint64(svm.DefaultComputeUnitPriceMicrolamports),
		binary.LittleEndian.Uint64(instructions[1].Data[1:9]),
	)
}

func TestCreatePaymentPayloadRejectsInvalidChallenges(t *testing.T) {
	feePayer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	authorizer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()

	tests := []struct {
		name      string
		mutate    func(requirements *types.PaymentRequirements)
		wantError string
	}{
		{
			name: "unsupported network",
			mutate: func(requirements *types.PaymentRequirements) {
				requirements.Network = "eip155:8453"
			},
			wantError: ErrUnsupportedNetwork,
		},
		{
			name: "missing fee payer",
			mutate: func(requirements *types.PaymentRequirements) {
				delete(requirements.Extra, upto.ExtraFeePayer)
			},
			wantError: ErrInvalidPaymentRequirements,
		},
		{
			name: "missing receiver authorizer",
			mutate: func(requirements *types.PaymentRequirements) {
				delete(requirements.Extra, upto.ExtraReceiverAuthorizer)
			},
			wantError: ErrInvalidPaymentRequirements,
		},
		{
			name: "non-integer withdraw delay",
			mutate: func(requirements *types.PaymentRequirements) {
				requirements.Extra[upto.ExtraWithdrawDelay] = 12.5
			},
			wantError: ErrInvalidPaymentRequirements,
		},
		{
			name: "non-integer amount",
			mutate: func(requirements *types.PaymentRequirements) {
				requirements.Amount = "1.5"
			},
			wantError: ErrInvalidAmount,
		},
		{
			name: "invalid payTo",
			mutate: func(requirements *types.PaymentRequirements) {
				requirements.PayTo = "not-an-address"
			},
			wantError: ErrInvalidPayToAddress,
		},
		{
			name: "unsupported token program",
			mutate: func(requirements *types.PaymentRequirements) {
				requirements.Extra[upto.ExtraTokenProgram] = solana.SystemProgramID.String()
			},
			wantError: ErrUnknownTokenProgram,
		},
		{
			name: "oversized memo",
			mutate: func(requirements *types.PaymentRequirements) {
				requirements.Extra[upto.ExtraMemo] = string(make([]byte, paymentchannels.MaxMemoBytes+1))
			},
			wantError: ErrFailedToBuildOpen,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			requirements := newRequirements(t, feePayer, authorizer, challengeOptions{})
			test.mutate(&requirements)
			scheme := NewUptoSvmScheme(newTestSigner(t))

			_, err := scheme.CreatePaymentPayload(context.Background(), requirements)

			require.ErrorContains(t, err, test.wantError)
		})
	}
}

func TestSchemeIdentifier(t *testing.T) {
	assert.Equal(t, "upto", NewUptoSvmScheme(newTestSigner(t)).Scheme())
}

// mustNewKey returns a fresh base58 private key.
func mustNewKey(t *testing.T) string {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return key.String()
}
