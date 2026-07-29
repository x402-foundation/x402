package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const testBlockhash = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"

func mockBlockhashRPC(t *testing.T, blockhash string, fail bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string      `json:"method"`
			ID     interface{} `json:"id"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))

		w.Header().Set("Content-Type", "application/json")
		if fail {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error": map[string]interface{}{
					"code":    -32000,
					"message": "blockhash unavailable",
				},
			})
			return
		}

		require.Equal(t, "getLatestBlockhash", req.Method)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"result": map[string]interface{}{
				"context": map[string]interface{}{"slot": 1234},
				"value": map[string]interface{}{
					"blockhash":            blockhash,
					"lastValidBlockHeight": 12345678,
				},
			},
		})
	}
}

func TestEnhancePaymentRequirementsRecentBlockhash(t *testing.T) {
	baseRequirements := func() types.PaymentRequirements {
		return types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             "GsbwXfJraMomNxBcjK7xK2xQx5MQgQUF2k3wEX2Q9z3w",
			MaxTimeoutSeconds: 300,
			Extra:             map[string]interface{}{"memo": "pi_3abc123def456"},
		}
	}
	supportedKind := types.SupportedKind{
		X402Version: 2,
		Scheme:      "exact",
		Network:     "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		Extra:       map[string]interface{}{"feePayer": "FeePay3r1111111111111111111111111111111111"},
	}

	t.Run("embeds blockhash fields when RPC is configured", func(t *testing.T) {
		rpcServer := httptest.NewServer(mockBlockhashRPC(t, testBlockhash, false))
		defer rpcServer.Close()

		server := NewExactSvmScheme(&svm.ServerConfig{RPCURL: rpcServer.URL})
		requirements, err := server.EnhancePaymentRequirements(
			context.Background(),
			baseRequirements(),
			supportedKind,
			nil,
		)
		require.NoError(t, err)

		assert.Equal(t, supportedKind.Extra["feePayer"], requirements.Extra["feePayer"])
		assert.Equal(t, "pi_3abc123def456", requirements.Extra["memo"])
		assert.Equal(t, testBlockhash, requirements.Extra["recentBlockhash"])
		assert.Equal(t, "12345678", requirements.Extra["lastValidBlockHeight"])
	})

	t.Run("omits blockhash fields without RPC config", func(t *testing.T) {
		server := NewExactSvmScheme()
		requirements, err := server.EnhancePaymentRequirements(
			context.Background(),
			baseRequirements(),
			supportedKind,
			nil,
		)
		require.NoError(t, err)

		assert.Equal(t, supportedKind.Extra["feePayer"], requirements.Extra["feePayer"])
		assert.NotContains(t, requirements.Extra, "recentBlockhash")
		assert.NotContains(t, requirements.Extra, "lastValidBlockHeight")
	})

	t.Run("omits blockhash fields on RPC failure", func(t *testing.T) {
		rpcServer := httptest.NewServer(mockBlockhashRPC(t, testBlockhash, true))
		defer rpcServer.Close()

		server := NewExactSvmScheme(&svm.ServerConfig{RPCURL: rpcServer.URL})
		requirements, err := server.EnhancePaymentRequirements(
			context.Background(),
			baseRequirements(),
			supportedKind,
			nil,
		)
		require.NoError(t, err)

		assert.Equal(t, supportedKind.Extra["feePayer"], requirements.Extra["feePayer"])
		assert.NotContains(t, requirements.Extra, "recentBlockhash")
		assert.NotContains(t, requirements.Extra, "lastValidBlockHeight")
	})
}
