package paymentchannels

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestChannelHistoryReadsPagesSignaturesAndTransactionBytes(t *testing.T) {
	account := testKeypair(t).PublicKey()
	before := solana.Signature{1}
	wire := []byte("test")
	var sawBefore string
	var sawLimit float64

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     interface{}       `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		w.Header().Set("Content-Type", "application/json")

		switch request.Method {
		case "getSignaturesForAddress":
			var opts rpc.GetSignaturesForAddressOpts
			require.NoError(t, json.Unmarshal(request.Params[1], &opts))
			sawBefore = opts.Before.String()
			if opts.Limit != nil {
				sawLimit = float64(*opts.Limit)
			}
			require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result": []map[string]interface{}{{
					"signature": before.String(),
					"slot":      1,
					"err":       nil,
				}},
			}))
		case "getTransaction":
			require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result": map[string]interface{}{
					"slot":        1,
					"transaction": []interface{}{base64.StdEncoding.EncodeToString(wire), "base64"},
					"meta":        map[string]interface{}{"err": nil, "fee": 0},
				},
			}))
		default:
			t.Fatalf("unexpected method %s", request.Method)
		}
	}))
	t.Cleanup(server.Close)

	reads := ChannelHistoryReadsFromRPC(map[string]string{svm.SolanaDevnetCAIP2: server.URL})
	limit := 5
	page, err := reads.GetSignaturesForAddress(t.Context(), account, svm.SolanaDevnetCAIP2, &before, &limit)
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, before.String(), page[0].Signature)
	assert.Nil(t, page[0].Err)
	assert.Equal(t, before.String(), sawBefore)
	assert.Equal(t, float64(5), sawLimit)

	got, err := reads.GetTransaction(t.Context(), before, svm.SolanaDevnetCAIP2)
	require.NoError(t, err)
	assert.Equal(t, base64.StdEncoding.EncodeToString(wire), got)
}

func TestChannelHistoryReadsTreatsAMissingTransactionAsUnknown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     interface{} `json:"id"`
			Method string      `json:"method"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		require.Equal(t, "getTransaction", request.Method)
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  nil,
		}))
	}))
	t.Cleanup(server.Close)

	reads := ChannelHistoryReadsFromRPC(map[string]string{svm.SolanaDevnetCAIP2: server.URL})
	got, err := reads.GetTransaction(t.Context(), solana.Signature{2}, svm.SolanaDevnetCAIP2)
	require.NoError(t, err)
	assert.Empty(t, got)
}
