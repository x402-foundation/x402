package hedera

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPreflightTransferHbarBalance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/accounts/0.0.7001":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"receiver_sig_required": false})
		case "/api/v1/accounts/0.0.9001":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"balance": map[string]int64{"balance": 100},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := &mirrorHTTP{client: server.Client()}
	if got := preflightTransfer(context.Background(), client, server.URL, "0.0.9001", "0.0.7001", HBARAssetID, "100"); !got.OK {
		t.Fatalf("expected sufficient balance: %+v", got)
	}
	if got := preflightTransfer(context.Background(), client, server.URL, "0.0.9001", "0.0.7001", HBARAssetID, "101"); got.OK || got.Reason != "insufficient_balance" {
		t.Fatalf("expected insufficient balance: %+v", got)
	}
}

func TestPreflightTransferRejectsReceiverSignatureRequired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"receiver_sig_required": true})
	}))
	defer server.Close()

	got := preflightTransfer(
		context.Background(),
		&mirrorHTTP{client: server.Client()},
		server.URL,
		"0.0.9001",
		"0.0.7001",
		HBARAssetID,
		"1",
	)
	if got.OK || got.Reason != "receiver_signature_required" {
		t.Fatalf("got=%+v", got)
	}
}

func TestPreflightTransferTokenAssociation(t *testing.T) {
	const (
		payer = "0.0.9001"
		payTo = "0.0.7001"
		asset = "0.0.6001"
	)

	tests := []struct {
		name          string
		associated    bool
		maxAuto       int
		autoPerPage   []int
		freezeDefault bool
		kycRequired   bool
		wantOK        bool
		wantReason    string
	}{
		{name: "associated", associated: true, wantOK: true},
		{name: "auto slot available", maxAuto: 2, autoPerPage: []int{1}, wantOK: true},
		{name: "unlimited auto association", maxAuto: -1, wantOK: true},
		{name: "auto association would be frozen", maxAuto: 2, freezeDefault: true, wantReason: "pay_to_not_associated"},
		{name: "auto association requires KYC", maxAuto: 2, kycRequired: true, wantReason: "pay_to_not_associated"},
		{name: "auto slots exhausted across pages", maxAuto: 2, autoPerPage: []int{1, 1}, wantReason: "pay_to_not_associated"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/tokens/" + asset:
					token := map[string]interface{}{
						"type":           "FUNGIBLE_COMMON",
						"freeze_default": tt.freezeDefault,
					}
					if tt.kycRequired {
						token["kyc_key"] = map[string]interface{}{"_type": "ED25519", "key": "00"}
					}
					_ = json.NewEncoder(w).Encode(token)
				case "/api/v1/accounts/" + payer + "/tokens":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"tokens": []map[string]interface{}{{"token_id": asset, "balance": 1000}},
						"links":  map[string]interface{}{"next": nil},
					})
				case "/api/v1/accounts/" + payTo:
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"max_automatic_token_associations": tt.maxAuto,
					})
				case "/api/v1/accounts/" + payTo + "/tokens":
					if r.URL.Query().Get("token.id") != "" {
						tokens := []map[string]interface{}{}
						if tt.associated {
							tokens = append(tokens, map[string]interface{}{"token_id": asset, "balance": 0})
						}
						_ = json.NewEncoder(w).Encode(map[string]interface{}{
							"tokens": tokens,
							"links":  map[string]interface{}{"next": nil},
						})
						return
					}

					page := 0
					if r.URL.Query().Get("page") == "2" {
						page = 1
					}
					count := 0
					if page < len(tt.autoPerPage) {
						count = tt.autoPerPage[page]
					}
					tokens := make([]map[string]interface{}, count)
					for i := range tokens {
						tokens[i] = map[string]interface{}{"automatic_association": true}
					}
					var next interface{}
					if page+1 < len(tt.autoPerPage) {
						next = "/api/v1/accounts/" + payTo + "/tokens?page=2"
					}
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"tokens": tokens,
						"links":  map[string]interface{}{"next": next},
					})
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			got := preflightTransfer(
				context.Background(),
				&mirrorHTTP{client: server.Client()},
				server.URL,
				payer,
				payTo,
				asset,
				"1000",
			)
			if got.OK != tt.wantOK || got.Reason != tt.wantReason {
				t.Fatalf("got=%+v wantOK=%v wantReason=%q", got, tt.wantOK, tt.wantReason)
			}
		})
	}
}

func TestPreflightTransferRejectsInvalidTokenRelationships(t *testing.T) {
	const (
		payer = "0.0.9001"
		payTo = "0.0.7001"
		asset = "0.0.6001"
	)
	tests := []struct {
		name         string
		payerFreeze  string
		payerKYC     string
		payToFreeze  string
		payToKYC     string
		expectedCode string
	}{
		{name: "payer frozen", payerFreeze: "FROZEN", expectedCode: "token_frozen"},
		{name: "payer KYC revoked", payerKYC: "REVOKED", expectedCode: "token_kyc_revoked"},
		{name: "payTo frozen", payToFreeze: "FROZEN", expectedCode: "token_frozen"},
		{name: "payTo KYC revoked", payToKYC: "REVOKED", expectedCode: "token_kyc_revoked"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/tokens/" + asset:
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"type": "FUNGIBLE_COMMON"})
				case "/api/v1/accounts/" + payTo:
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"receiver_sig_required": false})
				case "/api/v1/accounts/" + payer + "/tokens":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"tokens": []map[string]interface{}{{
							"token_id":      asset,
							"balance":       1000,
							"freeze_status": tt.payerFreeze,
							"kyc_status":    tt.payerKYC,
						}},
					})
				case "/api/v1/accounts/" + payTo + "/tokens":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"tokens": []map[string]interface{}{{
							"token_id":      asset,
							"freeze_status": tt.payToFreeze,
							"kyc_status":    tt.payToKYC,
						}},
					})
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			got := preflightTransfer(
				context.Background(),
				&mirrorHTTP{client: server.Client()},
				server.URL,
				payer,
				payTo,
				asset,
				"1000",
			)
			if got.OK || got.Reason != tt.expectedCode {
				t.Fatalf("got=%+v wantReason=%q", got, tt.expectedCode)
			}
		})
	}
}

func TestPreflightTransferRejectsUnsafeToken(t *testing.T) {
	const asset = "0.0.6001"
	tests := []struct {
		name         string
		token        map[string]interface{}
		expectedCode string
	}{
		{
			name: "custom fees",
			token: map[string]interface{}{
				"type": "FUNGIBLE_COMMON",
				"custom_fees": map[string]interface{}{
					"fixed_fees": []map[string]interface{}{{"amount": 1}},
				},
			},
			expectedCode: "token_custom_fees_unsupported",
		},
		{name: "paused", token: map[string]interface{}{"type": "FUNGIBLE_COMMON", "pause_status": "PAUSED"}, expectedCode: "token_paused"},
		{name: "deleted", token: map[string]interface{}{"type": "FUNGIBLE_COMMON", "deleted": true}, expectedCode: "invalid_asset"},
		{name: "non-fungible", token: map[string]interface{}{"type": "NON_FUNGIBLE_UNIQUE"}, expectedCode: "invalid_asset"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/accounts/0.0.7001":
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"receiver_sig_required": false})
				case "/api/v1/tokens/" + asset:
					_ = json.NewEncoder(w).Encode(tt.token)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			got := preflightTransfer(
				context.Background(),
				&mirrorHTTP{client: server.Client()},
				server.URL,
				"0.0.9001",
				"0.0.7001",
				asset,
				"1000",
			)
			if got.OK || got.Reason != tt.expectedCode {
				t.Fatalf("got=%+v wantReason=%q", got, tt.expectedCode)
			}
		})
	}
}

func TestPreflightTransferTokenBalanceAndMirrorFailure(t *testing.T) {
	t.Run("insufficient token balance", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/accounts/0.0.7001":
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"receiver_sig_required": false})
				return
			case "/api/v1/tokens/0.0.6001":
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"type": "FUNGIBLE_COMMON"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"tokens": []map[string]interface{}{{"token_id": "0.0.6001", "balance": 999}},
				"links":  map[string]interface{}{"next": nil},
			})
		}))
		defer server.Close()

		got := preflightTransfer(
			context.Background(),
			&mirrorHTTP{client: server.Client()},
			server.URL,
			"0.0.9001",
			"0.0.7001",
			"0.0.6001",
			"1000",
		)
		if got.OK || got.Reason != "insufficient_balance" {
			t.Fatalf("got=%+v", got)
		}
	})

	t.Run("mirror failure", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		}))
		defer server.Close()

		got := preflightTransfer(
			context.Background(),
			&mirrorHTTP{client: server.Client()},
			server.URL,
			"0.0.9001",
			"0.0.7001",
			HBARAssetID,
			"1",
		)
		if got.OK || got.Reason != "preflight_failed" {
			t.Fatalf("got=%+v", got)
		}
	})
}

func TestResolveAccountMirror(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/accounts/0.0.7001":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{})
		case "/api/v1/accounts/0.0.7002":
			http.NotFound(w, r)
		case "/api/v1/accounts/0.0.9001":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"balance": map[string]int64{"balance": 100},
			})
		default:
			http.Error(w, "unexpected request", http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	client := &mirrorHTTP{client: server.Client()}

	signer := &PrivateKeyFacilitatorSigner{mirrorNodeURL: server.URL, http: client}
	ctx := context.Background()
	if res, err := signer.ResolveAccount(ctx, "0.0.7001", HederaTestnetCAIP2); err != nil || !res.Exists {
		t.Fatalf("signer resolve=%+v err=%v", res, err)
	}
	if _, err := signer.ResolveAccount(ctx, "0.0.7001", "hedera:previewnet"); err == nil {
		t.Fatal("expected unsupported network error")
	}
	if got := signer.PreflightTransfer(ctx, "0.0.9001", "0.0.7001", HBARAssetID, "100", HederaTestnetCAIP2); !got.OK {
		t.Fatalf("signer preflight=%+v", got)
	}
	if got := signer.PreflightTransfer(ctx, "0.0.9001", "0.0.7001", HBARAssetID, "100", "hedera:previewnet"); got.OK || got.Reason != "preflight_failed" {
		t.Fatalf("unsupported network preflight=%+v", got)
	}

	existing, err := resolveAccountMirror(context.Background(), client, server.URL, "0.0.7001")
	if err != nil || !existing.Exists || existing.IsAlias {
		t.Fatalf("existing=%+v err=%v", existing, err)
	}
	missing, err := resolveAccountMirror(context.Background(), client, server.URL, "0.0.7002")
	if err != nil || missing.Exists || missing.IsAlias {
		t.Fatalf("missing=%+v err=%v", missing, err)
	}
	alias, err := resolveAccountMirror(context.Background(), client, server.URL, "0x0123456789abcdef0123456789abcdef01234567")
	if err != nil || alias.Exists || !alias.IsAlias {
		t.Fatalf("alias=%+v err=%v", alias, err)
	}
}
