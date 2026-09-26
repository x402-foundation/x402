package facilitator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/make-software/casper-go-sdk/v2/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
	casperFacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/facilitator"
)

const (
	preflightRoot     = "1111111111111111111111111111111111111111111111111111111111111111"
	preflightContract = "2222222222222222222222222222222222222222222222222222222222222222"
	balanceSeed       = "uref-3333333333333333333333333333333333333333333333333333333333333333-007"
	nonceSeed         = "uref-4444444444444444444444444444444444444444444444444444444444444444-007"
)

type preflightFixture struct {
	url             string
	mu              sync.Mutex
	block           json.RawMessage
	contractPackage json.RawMessage
	contract        json.RawMessage
	balance         json.RawMessage
	nonce           json.RawMessage
	errors          map[string]*rpc.RpcError
	calls           []string
	balanceKey      string
	nonceKey        string
	contractKey     string
}

func newPreflightFixture(t *testing.T) *preflightFixture {
	t.Helper()
	f := &preflightFixture{
		block:           preflightBlock(time.Now().UTC()),
		contractPackage: json.RawMessage(fmt.Sprintf(`{"ContractPackage":{"versions":[{"contract_hash":"%s","contract_version":1,"protocol_version_major":2}],"disabled_versions":[]}}`, preflightContract)),
		contract:        json.RawMessage(fmt.Sprintf(`{"Contract":{"contract_package_hash":"contract-package-%s","entry_points":[{"name":"transfer_with_authorization"}],"named_keys":[{"name":"balances","key":"%s"},{"name":"used_nonces","key":"%s"}]}}`, testAsset, balanceSeed, nonceSeed)),
		balance:         json.RawMessage(`{"CLValue":{"cl_type":"U256","bytes":"0340420f","parsed":"1000000"}}`),
		nonce:           json.RawMessage(`{"CLValue":{"cl_type":"Bool","bytes":"00","parsed":false}}`),
		errors:          make(map[string]*rpc.RpcError),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				StateIdentifier struct {
					StateRootHash string `json:"StateRootHash"`
				} `json:"state_identifier"`
				StateRootHash        string   `json:"state_root_hash"`
				Key                  string   `json:"key"`
				Path                 []string `json:"path"`
				DictionaryIdentifier struct {
					URef struct {
						SeedUref          string `json:"seed_uref"`
						DictionaryItemKey string `json:"dictionary_item_key"`
					} `json:"URef"`
				} `json:"dictionary_identifier"`
			} `json:"params"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&request)) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		var result json.RawMessage
		stage := request.Method
		switch request.Method {
		case "chain_get_block":
			stage, result = "block", f.block
		case "query_global_state":
			assert.Equal(t, preflightRoot, request.Params.StateIdentifier.StateRootHash)
			assert.Empty(t, request.Params.Path)
			if request.Params.Key == "hash-"+testAsset {
				stage, result = "package", f.contractPackage
			} else {
				stage, result = "contract", f.contract
				f.contractKey = request.Params.Key
			}
		case "state_get_dictionary_item":
			assert.Equal(t, preflightRoot, request.Params.StateRootHash)
			identifier := request.Params.DictionaryIdentifier.URef
			switch identifier.SeedUref {
			case balanceSeed:
				stage, result, f.balanceKey = "balance", f.balance, identifier.DictionaryItemKey
			case nonceSeed:
				stage, result, f.nonceKey = "nonce", f.nonce, identifier.DictionaryItemKey
			default:
				t.Errorf("unexpected dictionary seed %s", identifier.SeedUref)
			}
		default:
			t.Errorf("unexpected RPC method %s", request.Method)
		}
		f.calls = append(f.calls, stage)
		w.Header().Set("Content-Type", "application/json")
		if err := f.errors[stage]; err != nil {
			assert.NoError(t, json.NewEncoder(w).Encode(struct {
				JSONRPC string          `json:"jsonrpc"`
				ID      json.RawMessage `json:"id"`
				Error   *rpc.RpcError   `json:"error"`
			}{"2.0", request.ID, err}))
			return
		}
		if stage != "block" {
			result = json.RawMessage(`{"stored_value":` + string(result) + `}`)
		}
		assert.NoError(t, json.NewEncoder(w).Encode(struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Result  json.RawMessage `json:"result"`
		}{"2.0", request.ID, result}))
	}))
	t.Cleanup(server.Close)
	f.url = server.URL
	return f
}

func preflightBlock(timestamp time.Time) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"api_version":"2.0.0","block":{"hash":"%s","header":{"state_root_hash":"%s","timestamp":"%s","protocol_version":"2.0.0"},"body":{}}}`, preflightRoot, preflightRoot, timestamp.UTC().Format(time.RFC3339Nano)))
}

func missingDictionaryItem() *rpc.RpcError {
	return &rpc.RpcError{Code: -32003, Message: "Query failed", Data: json.RawMessage(`"value was not found in the global state"`)}
}

func TestVerify_TargetedPreflight(t *testing.T) {
	tests := []struct {
		name   string
		change func(*preflightFixture)
		reason string
	}{
		{"funded unused authorization", func(*preflightFixture) {}, ""},
		{"balance above uint64", func(f *preflightFixture) {
			f.balance = json.RawMessage(`{"CLValue":{"cl_type":"U256","bytes":"09000000000000000001"}}`)
		}, ""},
		{"insufficient balance", func(f *preflightFixture) {
			f.balance = json.RawMessage(`{"CLValue":{"cl_type":"U256","bytes":"033f420f"}}`)
		}, casperFacilitator.ErrInsufficientBalance},
		{"missing balance", func(f *preflightFixture) { f.errors["balance"] = missingDictionaryItem() }, casperFacilitator.ErrInsufficientBalance},
		{"used or canceled nonce", func(f *preflightFixture) {
			f.nonce = json.RawMessage(`{"CLValue":{"cl_type":"Bool","bytes":"01","parsed":true}}`)
		}, casperFacilitator.ErrAuthorizationUsed},
		{"missing nonce", func(f *preflightFixture) { f.errors["nonce"] = missingDictionaryItem() }, ""},
		{"legacy missing nonce", func(f *preflightFixture) {
			f.errors["nonce"] = &rpc.RpcError{Code: -32003, Message: "Query failed", Data: json.RawMessage(`"ValueNotFound(\"missing dictionary item\")"`)}
		}, ""},
		{"missing seed is not unused nonce", func(f *preflightFixture) {
			f.errors["nonce"] = &rpc.RpcError{Code: -32010, Message: "Failed to get dictionary URef", Data: json.RawMessage(`"the provided dictionary name doesn't exist"`)}
		}, casperFacilitator.ErrPreflightFailed},
		{"unknown state root", func(f *preflightFixture) {
			f.errors["nonce"] = &rpc.RpcError{Code: -32013, Message: "No such state root"}
		}, casperFacilitator.ErrPreflightFailed},
		{"unknown query error", func(f *preflightFixture) {
			f.errors["nonce"] = &rpc.RpcError{Code: -32003, Message: "Query failed", Data: json.RawMessage(`"database unavailable"`)}
		}, casperFacilitator.ErrPreflightFailed},
		{"malformed query error data", func(f *preflightFixture) {
			f.errors["nonce"] = &rpc.RpcError{Code: -32003, Message: "Query failed", Data: json.RawMessage(`{"message":"value was not found in the global state"}`)}
		}, casperFacilitator.ErrPreflightFailed},
		{"asset is not a package", func(f *preflightFixture) {
			f.contractPackage = json.RawMessage(`{"CLValue":{"cl_type":"Bool","bytes":"00"}}`)
		}, casperFacilitator.ErrUnsupportedAsset},
		{"no contract versions", func(f *preflightFixture) { f.contractPackage = json.RawMessage(`{"ContractPackage":{"versions":[]}}`) }, casperFacilitator.ErrUnsupportedAsset},
		{"all versions disabled", func(f *preflightFixture) {
			f.contractPackage = json.RawMessage(strings.Replace(string(f.contractPackage), `"disabled_versions":[]`, `"disabled_versions":[[2,1]]`, 1))
		}, casperFacilitator.ErrUnsupportedAsset},
		{"only a future protocol major", func(f *preflightFixture) {
			f.contractPackage = json.RawMessage(strings.Replace(string(f.contractPackage), `"protocol_version_major":2`, `"protocol_version_major":3`, 1))
		}, casperFacilitator.ErrUnsupportedAsset},
		{"not a contract", func(f *preflightFixture) { f.contract = json.RawMessage(`{"ContractPackage":{}}`) }, casperFacilitator.ErrUnsupportedAsset},
		{"entry point absent", func(f *preflightFixture) {
			f.contract = json.RawMessage(strings.Replace(string(f.contract), "transfer_with_authorization", "transfer", 1))
		}, casperFacilitator.ErrUnsupportedAsset},
		{"balance dictionary absent", func(f *preflightFixture) {
			f.contract = json.RawMessage(strings.Replace(string(f.contract), `"balances"`, `"other"`, 1))
		}, casperFacilitator.ErrUnsupportedAsset},
		{"nonce dictionary absent", func(f *preflightFixture) {
			f.contract = json.RawMessage(strings.Replace(string(f.contract), `"used_nonces"`, `"other"`, 1))
		}, casperFacilitator.ErrUnsupportedAsset},
		{"balance seed is not a URef", func(f *preflightFixture) {
			f.contract = json.RawMessage(strings.Replace(string(f.contract), balanceSeed, "hash-"+preflightRoot, 1))
		}, casperFacilitator.ErrUnsupportedAsset},
		{"wrong balance type", func(f *preflightFixture) {
			f.balance = json.RawMessage(`{"CLValue":{"cl_type":"U64","bytes":"40420f0000000000"}}`)
		}, casperFacilitator.ErrPreflightFailed},
		{"missing balance value", func(f *preflightFixture) { f.balance = json.RawMessage(`{}`) }, casperFacilitator.ErrPreflightFailed},
		{"truncated balance", func(f *preflightFixture) {
			f.balance = json.RawMessage(`{"CLValue":{"cl_type":"U256","bytes":"0340"}}`)
		}, casperFacilitator.ErrPreflightFailed},
		{"balance with trailing bytes", func(f *preflightFixture) {
			f.balance = json.RawMessage(`{"CLValue":{"cl_type":"U256","bytes":"0340420f00"}}`)
		}, casperFacilitator.ErrPreflightFailed},
		{"wrong nonce type", func(f *preflightFixture) { f.nonce = json.RawMessage(`{"CLValue":{"cl_type":"U8","bytes":"00"}}`) }, casperFacilitator.ErrPreflightFailed},
		{"missing nonce value", func(f *preflightFixture) { f.nonce = json.RawMessage(`{}`) }, casperFacilitator.ErrPreflightFailed},
		{"invalid bool", func(f *preflightFixture) { f.nonce = json.RawMessage(`{"CLValue":{"cl_type":"Bool","bytes":"02"}}`) }, casperFacilitator.ErrPreflightFailed},
		{"block state missing", func(f *preflightFixture) {
			f.block = json.RawMessage(strings.ReplaceAll(string(f.block), preflightRoot, strings.Repeat("0", 64)))
		}, casperFacilitator.ErrPreflightFailed},
		{"protocol version missing", func(f *preflightFixture) {
			f.block = json.RawMessage(strings.Replace(string(f.block), `"2.0.0"`, `""`, 2))
		}, casperFacilitator.ErrPreflightFailed},
		{"chain behind validity window", func(f *preflightFixture) { f.block = preflightBlock(time.Now().Add(-2 * time.Minute)) }, casperFacilitator.ErrNotYetValid},
		{"chain past validity window", func(f *preflightFixture) { f.block = preflightBlock(time.Now().Add(10 * time.Minute)) }, casperFacilitator.ErrPayloadExpired},
	}
	for _, stage := range []string{"block", "package", "contract", "balance", "nonce"} {
		tests = append(tests, struct {
			name   string
			change func(*preflightFixture)
			reason string
		}{
			name: stage + " RPC fails", reason: casperFacilitator.ErrPreflightFailed,
			change: func(f *preflightFixture) { f.errors[stage] = &rpc.RpcError{Code: -32603, Message: "Internal error"} },
		})
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := newPreflightFixture(t)
			test.change(f)
			signer := defaultSigner(t)
			signer.rpcURL = f.url
			scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
			payload, requirements := buildValidPayload(t)
			response, err := scheme.Verify(context.Background(), payload, requirements, nil)
			if test.reason != "" {
				require.ErrorContains(t, err, test.reason)
				return
			}
			require.NoError(t, err)
			assert.True(t, response.IsValid)
			f.mu.Lock()
			defer f.mu.Unlock()
			assert.Equal(t, []string{"block", "package", "contract", "balance", "nonce"}, f.calls)
			assert.Equal(t, "hash-"+preflightContract, f.contractKey)
			assert.Equal(t, "ADht4vIf3aPY2Mf6mThKajXX3783wNcUdc0tkykXVBD9", f.balanceKey)
			// Independent vector: Python hashlib.blake2b(key + u32le(32) + nonce, digest_size=32).
			assert.Equal(t, "ce52af71c7d8d1c3f325f681f6b89b2f83a8d5c0bffb237a1fad97ff8822cc47", f.nonceKey)
		})
	}
}

func TestSettle_TargetedPreflightRechecksNonce(t *testing.T) {
	f := newPreflightFixture(t)
	signer := defaultSigner(t)
	signer.rpcURL = f.url
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, requirements := buildValidPayload(t)
	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	f.mu.Lock()
	f.nonce = json.RawMessage(`{"CLValue":{"cl_type":"Bool","bytes":"01"}}`)
	f.mu.Unlock()
	_, err = scheme.Settle(context.Background(), payload, requirements, nil)
	var settleErr *x402.SettleError
	require.ErrorAs(t, err, &settleErr)
	assert.Equal(t, casperFacilitator.ErrAuthorizationUsed, settleErr.ErrorReason)
	assert.Equal(t, payload.Payload["authorization"].(map[string]interface{})["from"], settleErr.Payer)
	assert.ErrorContains(t, err, "consumed or canceled")
	assert.Nil(t, signer.capturedTransaction)
}

func TestVerify_TargetedPreflightCanceledContext(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, requirements := buildValidPayload(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := scheme.Verify(ctx, payload, requirements, nil)
	require.ErrorContains(t, err, casperFacilitator.ErrPreflightFailed)
}

func TestVerify_TargetedPreflightStrictTimeBounds(t *testing.T) {
	for _, bound := range []string{"validAfter", "validBefore"} {
		t.Run(bound, func(t *testing.T) {
			f := newPreflightFixture(t)
			signer := defaultSigner(t)
			signer.rpcURL = f.url
			payload, requirements := buildValidPayload(t)
			authorization := payload.Payload["authorization"].(map[string]interface{})
			seconds, err := time.ParseDuration(authorization[bound].(string) + "s")
			require.NoError(t, err)
			f.block = preflightBlock(time.Unix(int64(seconds/time.Second), 0))
			_, err = casperFacilitator.NewExactCasperScheme(signer, nil).Verify(context.Background(), payload, requirements, nil)
			reason := casperFacilitator.ErrNotYetValid
			if bound == "validBefore" {
				reason = casperFacilitator.ErrPayloadExpired
			}
			require.ErrorContains(t, err, reason)
		})
	}
}

func TestVerify_RejectsContractPayerBeforeTargetedPreflight(t *testing.T) {
	f := newPreflightFixture(t)
	signer := defaultSigner(t)
	signer.rpcURL = f.url
	payload, requirements := buildValidPayload(t)
	payload.Payload["authorization"].(map[string]interface{})["from"] = "01" + testFrom[2:]
	_, err := casperFacilitator.NewExactCasperScheme(signer, nil).Verify(context.Background(), payload, requirements, nil)
	require.ErrorContains(t, err, casperFacilitator.ErrPayerMismatch)
	f.mu.Lock()
	defer f.mu.Unlock()
	assert.Empty(t, f.calls)
}

func TestVerify_TargetedPreflightSelectsLatestEnabledVersion(t *testing.T) {
	f := newPreflightFixture(t)
	// Unordered versions across protocol majors, with the latest current version disabled.
	f.contractPackage = json.RawMessage(fmt.Sprintf(`{"ContractPackage":{"versions":[
		{"protocol_version_major":2,"contract_version":3,"contract_hash":"%s"},
		{"protocol_version_major":1,"contract_version":9,"contract_hash":"%s"},
		{"protocol_version_major":2,"contract_version":2,"contract_hash":"%s"},
		{"protocol_version_major":2,"contract_version":1,"contract_hash":"%s"}
	],"disabled_versions":[{"protocol_version_major":2,"contract_version":3}]}}`,
		strings.Repeat("55", 32), strings.Repeat("66", 32), preflightContract, strings.Repeat("77", 32)))
	signer := defaultSigner(t)
	signer.rpcURL = f.url
	payload, requirements := buildValidPayload(t)
	_, err := casperFacilitator.NewExactCasperScheme(signer, nil).Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	f.mu.Lock()
	defer f.mu.Unlock()
	assert.Equal(t, "hash-"+preflightContract, f.contractKey)
}

func TestVerify_TargetedPreflightProtocolMajorFallback(t *testing.T) {
	v1Old, v1Latest, v2 := strings.Repeat("11", 32), strings.Repeat("12", 32), strings.Repeat("22", 32)
	version := func(major, number int, hash string) string {
		return fmt.Sprintf(`{"protocol_version_major":%d,"contract_version":%d,"contract_hash":"%s"}`, major, number, hash)
	}
	for _, test := range []struct {
		name     string
		versions []string
		disabled string
		want     string
	}{
		{"current major wins over higher earlier version", []string{version(1, 9, v1Latest), version(2, 1, v2)}, `[]`, v2},
		{"falls back to latest major 1 version", []string{version(1, 1, v1Old), version(1, 4, v1Latest)}, `[]`, v1Latest},
		{"falls back when every major 2 version is disabled", []string{version(1, 4, v1Latest), version(2, 1, v2)}, `[[2,1]]`, v1Latest},
		{"skips disabled major 1 versions", []string{version(1, 1, v1Old), version(1, 4, v1Latest)}, `[[1,4]]`, v1Old},
		{"ignores future major", []string{version(1, 4, v1Latest), version(3, 1, v2)}, `[]`, v1Latest},
		{"rejects when every version is disabled", []string{version(1, 1, v1Old), version(2, 1, v2)}, `[[1,1],[2,1]]`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newPreflightFixture(t)
			f.contractPackage = json.RawMessage(fmt.Sprintf(`{"ContractPackage":{"versions":[%s],"disabled_versions":%s}}`,
				strings.Join(test.versions, ","), test.disabled))
			signer := defaultSigner(t)
			signer.rpcURL = f.url
			payload, requirements := buildValidPayload(t)
			_, err := casperFacilitator.NewExactCasperScheme(signer, nil).Verify(context.Background(), payload, requirements, nil)
			f.mu.Lock()
			defer f.mu.Unlock()
			if test.want == "" {
				require.ErrorContains(t, err, casperFacilitator.ErrUnsupportedAsset)
				assert.Empty(t, f.contractKey)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, "hash-"+test.want, f.contractKey)
		})
	}
}

func TestVerify_TargetedPreflightRejectsTransportFailure(t *testing.T) {
	signer := defaultSigner(t)
	signer.rpcURL = "http://127.0.0.1:1/rpc"
	payload, requirements := buildValidPayload(t)
	_, err := casperFacilitator.NewExactCasperScheme(signer, nil).Verify(context.Background(), payload, requirements, nil)
	require.ErrorContains(t, err, casperFacilitator.ErrPreflightFailed)
}
