package client

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/mechanisms/svm"
	"github.com/x402-foundation/x402/go/types"
)

const fixedV1Blockhash = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"

type mockV1ClientSigner struct {
	keypair solana.PrivateKey
}

func (m *mockV1ClientSigner) Address() solana.PublicKey {
	return m.keypair.PublicKey()
}

func (m *mockV1ClientSigner) SignTransaction(ctx context.Context, tx *solana.Transaction) error {
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

func mockV1SolanaRPCHandler(t *testing.T, accountInfoCalls *int32) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string      `json:"method"`
			ID     interface{} `json:"id"`
		}

		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		w.Header().Set("Content-Type", "application/json")

		writeResult := func(result interface{}) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  result,
			})
		}

		switch req.Method {
		case "getLatestBlockhash":
			writeResult(map[string]interface{}{
				"context": map[string]interface{}{"slot": 1234},
				"value": map[string]interface{}{
					"blockhash":            fixedV1Blockhash,
					"lastValidBlockHeight": 12345678,
				},
			})
		case "getAccountInfo":
			atomic.AddInt32(accountInfoCalls, 1)

			mint := token.Mint{
				Supply:        1000000000000,
				Decimals:      6,
				IsInitialized: true,
			}

			buf := new(bytes.Buffer)
			require.NoError(t, mint.MarshalWithEncoder(bin.NewBinEncoder(buf)))
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
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error": map[string]interface{}{
					"code":    -32601,
					"message": "method not found",
				},
			})
		}
	}
}

func TestMintMetadataCacheAvoidsRepeatedMintRPC(t *testing.T) {
	var accountInfoCalls int32
	server := httptest.NewServer(mockV1SolanaRPCHandler(t, &accountInfoCalls))
	defer server.Close()

	signer := &mockV1ClientSigner{keypair: solana.NewWallet().PrivateKey}
	client := NewExactSvmSchemeV1(signer, &svm.ClientConfig{RPCURL: server.URL})

	extra := json.RawMessage(`{"feePayer":"` + solana.NewWallet().PublicKey().String() + `"}`)
	requirements := types.PaymentRequirementsV1{
		Scheme:            "exact",
		Network:           "solana-devnet",
		MaxAmountRequired: "100000",
		Resource:          "https://example.com",
		PayTo:             solana.NewWallet().PublicKey().String(),
		MaxTimeoutSeconds: 3600,
		Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
		Extra:             &extra,
	}

	ctx := context.Background()
	_, err := client.CreatePaymentPayload(ctx, requirements)
	require.NoError(t, err)

	_, err = client.CreatePaymentPayload(ctx, requirements)
	require.NoError(t, err)

	assert.Equal(t, int32(1), atomic.LoadInt32(&accountInfoCalls))
}
