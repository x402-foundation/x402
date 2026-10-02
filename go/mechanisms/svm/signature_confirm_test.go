package svm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func TestConfirmSignature_StatusDouble(t *testing.T) {
	sig := solana.SignatureFromBytes(append([]byte{9}, make([]byte, 63)...))
	instructionErr := `{"slot":9,"confirmations":null,"err":{"InstructionError":[2,{"Custom":4}]},"status":{"Err":{"InstructionError":[2,{"Custom":4}]}},"confirmationStatus":"%s"}`
	successStatus := `{"slot":9,"confirmations":null,"err":null,"status":{"Ok":null},"confirmationStatus":"%s"}`

	cases := []struct {
		name        string
		body        string
		attempts    int
		wantErr     string
		wantOnchain bool
		methods     []string
	}{
		{
			name:        "confirmed instruction error is terminal",
			body:        `{"context":{"slot":1},"value":[` + sprintfStatus(instructionErr, "confirmed") + `]}`,
			attempts:    1,
			wantErr:     "transaction failed on-chain: map[InstructionError:[2 map[Custom:4]]]",
			wantOnchain: true,
			methods:     []string{"getSignatureStatuses"},
		},
		{
			name:        "finalized instruction error is terminal",
			body:        `{"context":{"slot":1},"value":[` + sprintfStatus(instructionErr, "finalized") + `]}`,
			attempts:    1,
			wantErr:     "transaction failed on-chain: map[InstructionError:[2 map[Custom:4]]]",
			wantOnchain: true,
			methods:     []string{"getSignatureStatuses"},
		},
		{
			name:     "confirmed success",
			body:     `{"context":{"slot":1},"value":[` + sprintfStatus(successStatus, "confirmed") + `]}`,
			attempts: 1,
			methods:  []string{"getSignatureStatuses"},
		},
		{
			name:     "finalized success",
			body:     `{"context":{"slot":1},"value":[` + sprintfStatus(successStatus, "finalized") + `]}`,
			attempts: 1,
			methods:  []string{"getSignatureStatuses"},
		},
		{
			name:     "processed execution error stays uncertain",
			body:     `{"context":{"slot":1},"value":[` + sprintfStatus(instructionErr, "processed") + `]}`,
			attempts: 1,
			wantErr:  "transaction confirmation timed out after 1 attempts",
			methods:  []string{"getSignatureStatuses"},
		},
		{
			name:     "absent status stays uncertain",
			body:     `{"context":{"slot":1},"value":[null]}`,
			attempts: 2,
			wantErr:  "transaction confirmation timed out after 2 attempts",
			methods:  []string{"getSignatureStatuses", "getSignatureStatuses"},
		},
		{
			name:     "malformed status stays uncertain",
			body:     `{"context":{"slot":1},"value":"not-a-status"}`,
			attempts: 1,
			wantErr:  "transaction confirmation unavailable:",
			methods:  []string{"getSignatureStatuses", "getTransaction"},
		},
		{
			name:     "transport failure stays uncertain",
			body:     "",
			attempts: 1,
			wantErr:  "transaction confirmation unavailable:",
			methods:  []string{"getSignatureStatuses", "getTransaction"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var methods []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read body: %v", err)
					return
				}
				var req struct {
					ID     json.RawMessage `json:"id"`
					Method string          `json:"method"`
				}
				if err := json.Unmarshal(raw, &req); err != nil {
					t.Errorf("decode request: %v body %s", err, raw)
					return
				}
				mu.Lock()
				methods = append(methods, req.Method)
				mu.Unlock()
				if req.Method == "sendTransaction" {
					t.Errorf("sendTransaction must not be called")
				}
				if tc.name == "transport failure stays uncertain" {
					hj, ok := w.(http.Hijacker)
					if !ok {
						http.Error(w, "unavailable", http.StatusBadGateway)
						return
					}
					conn, _, err := hj.Hijack()
					if err != nil {
						return
					}
					_ = conn.Close()
					return
				}
				if req.Method == "getTransaction" {
					_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"error":{"code":-32600,"message":"not used"}}`))
					return
				}
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"result":` + tc.body + `}`))
			}))
			defer server.Close()

			err := ConfirmSignature(context.Background(), rpc.New(server.URL), sig, ConfirmPolicy{
				MaxAttempts: tc.attempts,
				Sleep:       func(time.Duration) {},
			})
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("confirm: %v", err)
				}
			} else if err == nil || !strings.Contains(err.Error(), strings.TrimSuffix(tc.wantErr, ":")) {
				t.Fatalf("confirm error = %v, want containing %q", err, tc.wantErr)
			}
			var onchain *TransactionOnchainFailureError
			if errors.As(err, &onchain) != tc.wantOnchain {
				t.Fatalf("on-chain typed error = %v, want %v (%v)", errors.As(err, &onchain), tc.wantOnchain, err)
			}
			mu.Lock()
			defer mu.Unlock()
			if strings.Join(methods, ",") != strings.Join(tc.methods, ",") {
				t.Fatalf("rpc methods = %v, want %v", methods, tc.methods)
			}
		})
	}
}

func TestConfirmSignature_TransactionFallbackIsTerminal(t *testing.T) {
	sig := solana.SignatureFromBytes(append([]byte{8}, make([]byte, 63)...))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Errorf("decode: %v", err)
			return
		}
		if req.Method == "sendTransaction" {
			t.Errorf("sendTransaction must not be called")
		}
		if req.Method == "getSignatureStatuses" {
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"error":{"code":-32000,"message":"status cache down"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"result":{"slot":3,"transaction":null,"meta":{"err":{"InstructionError":[2,{"Custom":4}]},"fee":5000,"preBalances":[],"postBalances":[],"status":{"Err":{"InstructionError":[2,{"Custom":4}]}}},"version":"legacy"}}`))
	}))
	defer server.Close()

	err := ConfirmSignature(context.Background(), rpc.New(server.URL), sig, ConfirmPolicy{
		MaxAttempts: 1,
		Sleep:       func(time.Duration) {},
	})
	var onchain *TransactionOnchainFailureError
	if !errors.As(err, &onchain) {
		t.Fatalf("got %v, want terminal on-chain failure", err)
	}
	if !strings.Contains(onchain.Error(), "InstructionError") {
		t.Fatalf("message = %q", onchain.Error())
	}
}

func sprintfStatus(format, level string) string {
	return strings.Replace(format, "%s", level, 1)
}
