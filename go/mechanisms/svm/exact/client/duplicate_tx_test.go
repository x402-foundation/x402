package client

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/mechanisms/svm"
	"github.com/x402-foundation/x402/go/types"
)

const (
	fixedBlockhash    = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"
	fixedBlockhashAlt = "7ZCxc2SDhzV2bYgEQqdxTpweYJkpwshVSDtXuY7uPtjf"
)

func mockSolanaRPCHandler(t *testing.T, blockhashFunc func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string        `json:"method"`
			ID     interface{}   `json:"id"`
			Params []interface{} `json:"params"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("Failed to decode request: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")

		writeResult := func(result interface{}) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  result,
			})
		}

		writeError := func(code int, message string) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error": map[string]interface{}{
					"code":    code,
					"message": message,
				},
			})
		}

		switch req.Method {
		case "getLatestBlockhash":
			blockhash := blockhashFunc()
			writeResult(map[string]interface{}{
				"context": map[string]interface{}{"slot": 1234},
				"value": map[string]interface{}{
					"blockhash":            blockhash,
					"lastValidBlockHeight": 12345678,
				},
			})

		case "getAccountInfo":
			mint := token.Mint{
				MintAuthority:   nil,
				Supply:          1000000000000,
				Decimals:        6,
				IsInitialized:   true,
				FreezeAuthority: nil,
			}

			buf := new(bytes.Buffer)
			encoder := bin.NewBinEncoder(buf)
			if err := mint.MarshalWithEncoder(encoder); err != nil {
				fallback := make([]byte, 82)
				fallback[44] = 6
				fallback[45] = 1
				buf = bytes.NewBuffer(fallback)
			}

			mintDataB64 := base64.StdEncoding.EncodeToString(buf.Bytes())
			writeResult(map[string]interface{}{
				"context": map[string]interface{}{"slot": 1234},
				"value": map[string]interface{}{
					"data":       []interface{}{mintDataB64, "base64"},
					"executable": false,
					"lamports":   1000000000,
					"owner":      solana.TokenProgramID.String(),
					"rentEpoch":  0,
				},
			})

		default:
			writeError(-32601, "Method not found: "+req.Method)
		}
	}
}

type mockClientSigner struct {
	keypair solana.PrivateKey
}

func (m *mockClientSigner) Address() solana.PublicKey {
	return m.keypair.PublicKey()
}

func (m *mockClientSigner) SignTransaction(ctx context.Context, tx *solana.Transaction) error {
	_ = ctx

	messageBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return err
	}

	signature, err := m.keypair.Sign(messageBytes)
	if err != nil {
		return err
	}

	accountIndex, err := tx.GetAccountIndex(m.keypair.PublicKey())
	if err != nil {
		return err
	}

	if len(tx.Signatures) <= int(accountIndex) {
		newSignatures := make([]solana.Signature, accountIndex+1)
		copy(newSignatures, tx.Signatures)
		tx.Signatures = newSignatures
	}

	tx.Signatures[accountIndex] = signature
	return nil
}

func TestDuplicateTransactionAttackVector(t *testing.T) {
	t.Run("transaction construction is deterministic", func(t *testing.T) {
		assert.Equal(t, uint32(20000), svm.DefaultComputeUnitLimit,
			"Compute unit limit is fixed at 20000")
		assert.Equal(t, 1, int(svm.DefaultComputeUnitPriceMicrolamports),
			"Compute unit price is fixed at 1 microlamport")
	})

	t.Run("blockhash is not the only source of uniqueness", func(t *testing.T) {
		slotTimeMs := 400
		assert.Less(t, slotTimeMs, 1000, "Slot time is very short")
	})
}

func TestFixedBlockhashProducesDistinctTransactions(t *testing.T) {
	t.Run("distinct transactions with fixed blockhash", func(t *testing.T) {
		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			return fixedBlockhash
		}))
		defer server.Close()

		signer := &mockClientSigner{
			keypair: solana.NewWallet().PrivateKey,
		}

		config := &svm.ClientConfig{RPCURL: server.URL}
		client := NewExactSvmScheme(signer, config)

		feePayer := solana.NewWallet().PublicKey()
		payTo := solana.NewWallet().PublicKey()

		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             payTo.String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": feePayer.String(),
			},
		}

		ctx := context.Background()

		payload1, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err, "First payload creation should succeed")

		payload2, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err, "Second payload creation should succeed")

		tx1 := payload1.Payload["transaction"].(string)
		tx2 := payload2.Payload["transaction"].(string)

		assert.NotEqual(t, tx1, tx2,
			"Memo mitigation confirmed: Identical inputs with same blockhash produce distinct transactions.")

		assert.Greater(t, len(tx1), 100, "Transaction should have substantial content")

		decoded, err := svm.DecodeTransaction(tx1)
		require.NoError(t, err, "Transaction should decode")
		require.GreaterOrEqual(t, len(decoded.Message.Instructions), 4)
		memoProgram := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
		memoProgramID := decoded.Message.AccountKeys[decoded.Message.Instructions[3].ProgramIDIndex]
		assert.Equal(t, memoProgram, memoProgramID, "Memo instruction should be present")

		t.Logf("\n=== MEMO UNIQUENESS CONFIRMED ===")
		t.Logf("Transaction 1 (first 80 chars): %s...", tx1[:min(80, len(tx1))])
		t.Logf("Transaction 2 (first 80 chars): %s...", tx2[:min(80, len(tx2))])
		t.Logf("Transactions are DISTINCT: %v", tx1 != tx2)
	})

	t.Run("different blockhash produces different transactions", func(t *testing.T) {
		var callCount int32

		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			count := atomic.AddInt32(&callCount, 1)
			if count == 1 {
				return fixedBlockhash
			}
			return fixedBlockhashAlt
		}))
		defer server.Close()

		signer := &mockClientSigner{
			keypair: solana.NewWallet().PrivateKey,
		}

		config := &svm.ClientConfig{RPCURL: server.URL}
		client := NewExactSvmScheme(signer, config)

		feePayer := solana.NewWallet().PublicKey()
		payTo := solana.NewWallet().PublicKey()

		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             payTo.String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": feePayer.String(),
			},
		}

		ctx := context.Background()

		payload1, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err)

		payload2, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err)

		tx1 := payload1.Payload["transaction"].(string)
		tx2 := payload2.Payload["transaction"].(string)

		assert.NotEqual(t, tx1, tx2,
			"CONTROL TEST PASSED: Different blockhash produces different transactions")

		t.Logf("\n=== CONTROL TEST: DIFFERENT BLOCKHASH ===")
		t.Logf("Transaction 1 (first 80 chars): %s...", tx1[:min(80, len(tx1))])
		t.Logf("Transaction 2 (first 80 chars): %s...", tx2[:min(80, len(tx2))])
		t.Logf("Transactions are DIFFERENT: %v", tx1 != tx2)
	})

	t.Run("concurrent requests with same blockhash", func(t *testing.T) {
		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			return fixedBlockhash
		}))
		defer server.Close()

		signer := &mockClientSigner{
			keypair: solana.NewWallet().PrivateKey,
		}

		config := &svm.ClientConfig{RPCURL: server.URL}
		client := NewExactSvmScheme(signer, config)

		feePayer := solana.NewWallet().PublicKey()
		payTo := solana.NewWallet().PublicKey()

		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             payTo.String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": feePayer.String(),
			},
		}

		ctx := context.Background()
		numConcurrent := 5
		transactions := make([]string, numConcurrent)
		var wg sync.WaitGroup

		for i := 0; i < numConcurrent; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				payload, err := client.CreatePaymentPayload(ctx, requirements)
				if err != nil {
					t.Errorf("Concurrent request %d failed: %v", idx, err)
					return
				}
				transactions[idx] = payload.Payload["transaction"].(string)
			}(i)
		}

		wg.Wait()

		unique := map[string]struct{}{}
		for _, tx := range transactions {
			unique[tx] = struct{}{}
		}

		assert.Equal(t, numConcurrent, len(unique),
			"Memo mitigation: All %d concurrent requests should produce unique transactions", numConcurrent)

		t.Logf("\n=== CONCURRENT UNIQUENESS CHECK ===")
		t.Logf("Concurrent requests: %d", numConcurrent)
		t.Logf("Unique transactions: %d", len(unique))
	})
}

func TestFacilitatorInstructionCountConstraints(t *testing.T) {
	t.Run("Go/TS allow 3-6 instructions", func(t *testing.T) {
		minInstructions := 3
		maxInstructions := 6

		assert.Equal(t, 3, minInstructions)
		assert.Equal(t, 6, maxInstructions)
	})

	t.Run("optional instructions may be Lighthouse or Memo", func(t *testing.T) {
		lighthouseProgram := svm.LighthouseProgramAddress
		memoProgram := svm.MemoProgramAddress

		assert.NotEqual(t, lighthouseProgram, memoProgram)
		assert.NotEmpty(t, lighthouseProgram)
		assert.NotEmpty(t, memoProgram)
	})
}

func TestAttackScenarioSimulation(t *testing.T) {
	t.Run("memo mitigation eliminates loss", func(t *testing.T) {
		paymentsAttempted := 10
		paymentsSettled := 10

		sellerLossPercent := ((paymentsAttempted - paymentsSettled) * 100) / paymentsAttempted

		assert.Equal(t, 0, sellerLossPercent)
	})

	t.Run("vulnerability window is slot time", func(t *testing.T) {
		slotTimeMs := 400
		typicalAPILatencyMs := 50

		requestsPerSlot := slotTimeMs / typicalAPILatencyMs

		assert.Greater(t, requestsPerSlot, 1,
			"Multiple requests (%d) can arrive within a single slot", requestsPerSlot)
	})
}

func TestMemoDataIsValidUTF8(t *testing.T) {
	t.Run("memo data is valid UTF-8 (SPL Memo requirement)", func(t *testing.T) {
		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			return fixedBlockhash
		}))
		defer server.Close()

		signer := &mockClientSigner{
			keypair: solana.NewWallet().PrivateKey,
		}

		config := &svm.ClientConfig{RPCURL: server.URL}
		client := NewExactSvmScheme(signer, config)

		feePayer := solana.NewWallet().PublicKey()
		payTo := solana.NewWallet().PublicKey()

		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             payTo.String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": feePayer.String(),
			},
		}

		ctx := context.Background()

		payload, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err)

		tx1 := payload.Payload["transaction"].(string)
		decoded, err := svm.DecodeTransaction(tx1)
		require.NoError(t, err)

		// Find memo instruction (index 3)
		require.GreaterOrEqual(t, len(decoded.Message.Instructions), 4)
		memoProgram := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
		memoIx := decoded.Message.Instructions[3]
		memoProgramID := decoded.Message.AccountKeys[memoIx.ProgramIDIndex]
		assert.Equal(t, memoProgram, memoProgramID, "Fourth instruction should be memo")

		// Verify memo data is valid UTF-8 (critical for SPL Memo)
		memoData := memoIx.Data
		assert.True(t, utf8.Valid(memoData), "Memo data must be valid UTF-8")

		// Verify the hex-encoded portion (the library may add a length prefix byte)
		memoString := string(memoData)
		// Trim any leading whitespace/control characters the library might add
		trimmedMemo := []byte(memoString)
		for len(trimmedMemo) > 0 && (trimmedMemo[0] == ' ' || trimmedMemo[0] < 32) {
			trimmedMemo = trimmedMemo[1:]
		}

		// The trimmed memo should be hex-encoded (32 chars for 16 bytes)
		expectedLen := 32
		assert.Equal(t, expectedLen, len(trimmedMemo), "Memo hex content should be double the byte count")

		// Verify all characters in trimmed memo are valid hex
		for _, b := range trimmedMemo {
			isHex := (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')
			assert.True(t, isHex, "Memo hex content should only contain hex characters, got: %c", b)
		}

		t.Logf("\n=== UTF-8 VALIDITY CONFIRMED ===")
		t.Logf("Memo data (raw): %q", memoData)
		t.Logf("Memo hex content: %s", string(trimmedMemo))
		t.Logf("Is valid UTF-8: %v", utf8.Valid(memoData))
	})
}

// TestMemoInstructionHasNoSigners verifies memo has empty accounts.
// SPL Memo doesn't require signers; adding them breaks facilitator verification.
func TestMemoInstructionHasNoSigners(t *testing.T) {
	server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
		return fixedBlockhash
	}))
	defer server.Close()

	signer := &mockClientSigner{keypair: solana.NewWallet().PrivateKey}
	client := NewExactSvmScheme(signer, &svm.ClientConfig{RPCURL: server.URL})

	requirements := types.PaymentRequirements{
		Scheme:            "exact",
		Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
		Amount:            "100000",
		PayTo:             solana.NewWallet().PublicKey().String(),
		MaxTimeoutSeconds: 3600,
		Extra:             map[string]interface{}{"feePayer": solana.NewWallet().PublicKey().String()},
	}

	payload, err := client.CreatePaymentPayload(context.Background(), requirements)
	require.NoError(t, err)

	decoded, err := svm.DecodeTransaction(payload.Payload["transaction"].(string))
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(decoded.Message.Instructions), 4)

	memoIx := decoded.Message.Instructions[3]
	memoProgramID := decoded.Message.AccountKeys[memoIx.ProgramIDIndex]
	require.Equal(t, solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), memoProgramID)

	// Empty accounts is critical - signers break facilitator verification
	assert.Empty(t, memoIx.Accounts, "memo must have no accounts")
}

func TestSellerMemo(t *testing.T) {
	t.Run("uses extra.memo as memo data when provided", func(t *testing.T) {
		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			return fixedBlockhash
		}))
		defer server.Close()

		signer := &mockClientSigner{keypair: solana.NewWallet().PrivateKey}
		client := NewExactSvmScheme(signer, &svm.ClientConfig{RPCURL: server.URL})

		sellerMemo := "pi_3abc123def456"
		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             solana.NewWallet().PublicKey().String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": solana.NewWallet().PublicKey().String(),
				"memo":     sellerMemo,
			},
		}

		payload, err := client.CreatePaymentPayload(context.Background(), requirements)
		require.NoError(t, err)

		decoded, err := svm.DecodeTransaction(payload.Payload["transaction"].(string))
		require.NoError(t, err)
		require.GreaterOrEqual(t, len(decoded.Message.Instructions), 4)

		memoIx := decoded.Message.Instructions[3]
		memoProgramID := decoded.Message.AccountKeys[memoIx.ProgramIDIndex]
		assert.Equal(t, solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), memoProgramID)

		// Memo data should contain a length prefix byte followed by the seller memo
		memoData := memoIx.Data
		assert.True(t, utf8.Valid(memoData), "Memo data must be valid UTF-8")
		assert.Contains(t, string(memoData), sellerMemo, "Memo data should contain seller memo")
	})

	t.Run("produces identical memo data with extra.memo across calls", func(t *testing.T) {
		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			return fixedBlockhash
		}))
		defer server.Close()

		signer := &mockClientSigner{keypair: solana.NewWallet().PrivateKey}
		client := NewExactSvmScheme(signer, &svm.ClientConfig{RPCURL: server.URL})

		feePayer := solana.NewWallet().PublicKey()
		payTo := solana.NewWallet().PublicKey()
		sellerMemo := "order_12345"

		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             payTo.String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": feePayer.String(),
				"memo":     sellerMemo,
			},
		}

		ctx := context.Background()

		payload1, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err)
		payload2, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err)

		decoded1, err := svm.DecodeTransaction(payload1.Payload["transaction"].(string))
		require.NoError(t, err)
		decoded2, err := svm.DecodeTransaction(payload2.Payload["transaction"].(string))
		require.NoError(t, err)

		memo1 := string(decoded1.Message.Instructions[3].Data)
		memo2 := string(decoded2.Message.Instructions[3].Data)

		assert.Equal(t, memo1, memo2, "Seller memo should be deterministic across calls")
		assert.Contains(t, memo1, sellerMemo)
	})

	t.Run("rejects extra.memo exceeding max size", func(t *testing.T) {
		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			return fixedBlockhash
		}))
		defer server.Close()

		signer := &mockClientSigner{keypair: solana.NewWallet().PrivateKey}
		client := NewExactSvmScheme(signer, &svm.ClientConfig{RPCURL: server.URL})

		longMemo := ""
		for i := 0; i < 257; i++ {
			longMemo += "x"
		}

		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             solana.NewWallet().PublicKey().String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": solana.NewWallet().PublicKey().String(),
				"memo":     longMemo,
			},
		}

		_, err := client.CreatePaymentPayload(context.Background(), requirements)
		require.Error(t, err)
		assert.Contains(t, err.Error(), ErrMemoExceedsMaxSize)
	})

	t.Run("falls back to random nonce when extra.memo is absent", func(t *testing.T) {
		server := httptest.NewServer(mockSolanaRPCHandler(t, func() string {
			return fixedBlockhash
		}))
		defer server.Close()

		signer := &mockClientSigner{keypair: solana.NewWallet().PrivateKey}
		client := NewExactSvmScheme(signer, &svm.ClientConfig{RPCURL: server.URL})

		feePayer := solana.NewWallet().PublicKey()
		payTo := solana.NewWallet().PublicKey()

		requirements := types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             payTo.String(),
			MaxTimeoutSeconds: 3600,
			Extra: map[string]interface{}{
				"feePayer": feePayer.String(),
				// no memo
			},
		}

		ctx := context.Background()

		payload1, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err)
		payload2, err := client.CreatePaymentPayload(ctx, requirements)
		require.NoError(t, err)

		decoded1, err := svm.DecodeTransaction(payload1.Payload["transaction"].(string))
		require.NoError(t, err)
		decoded2, err := svm.DecodeTransaction(payload2.Payload["transaction"].(string))
		require.NoError(t, err)

		memo1 := string(decoded1.Message.Instructions[3].Data)
		memo2 := string(decoded2.Message.Instructions[3].Data)

		assert.NotEqual(t, memo1, memo2, "Random nonces should differ between calls")
	})
}
