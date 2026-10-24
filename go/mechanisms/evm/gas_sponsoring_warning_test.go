package evm_test

import (
	"bytes"
	"context"
	"log"
	"math/big"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	exactclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	uptoclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/client"
	"github.com/x402-foundation/x402/go/v2/types"
)

type warningTestSigner struct{}

func (s *warningTestSigner) Address() string {
	return "0x1234567890123456789012345678901234567890"
}

func (s *warningTestSigner) SignTypedData(
	_ context.Context,
	_ evm.TypedDataDomain,
	_ map[string][]evm.TypedDataField,
	_ string,
	_ map[string]interface{},
) ([]byte, error) {
	return []byte{0x01}, nil
}

type warningReadSigner struct {
	*warningTestSigner
	allowance *big.Int
	reads     int
}

func (s *warningReadSigner) ReadContract(
	_ context.Context,
	_ string,
	_ []byte,
	_ string,
	_ ...interface{},
) (interface{}, error) {
	s.reads++
	return s.allowance, nil
}

// warningProbeSigner is a read signer that also reports HasRPCClient.
type warningProbeSigner struct {
	*warningReadSigner
	hasRPC bool
}

func (s *warningProbeSigner) HasRPCClient() bool { return s.hasRPC }

type clientWarningCase struct {
	name         string
	logPrefix    string
	configName   string
	newScheme    func(evm.ClientEvmSigner) x402.SchemeNetworkClient
	requirements types.PaymentRequirements
}

func clientWarningCases() []clientWarningCase {
	base := types.PaymentRequirements{
		Network:           "eip155:8453",
		Asset:             "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
		Amount:            "100",
		PayTo:             "0x3333333333333333333333333333333333333333",
		MaxTimeoutSeconds: 600,
		Extra: map[string]interface{}{
			"assetTransferMethod": "permit2",
			"name":                "USDC",
			"version":             "2",
		},
	}
	exactRequirements := base
	exactRequirements.Scheme = "exact"
	uptoRequirements := base
	uptoRequirements.Scheme = "upto"
	uptoRequirements.Extra = map[string]interface{}{
		"facilitatorAddress": "0x4444444444444444444444444444444444444444",
		"name":               "USDC",
		"version":            "2",
	}

	return []clientWarningCase{
		{
			name:       "exact",
			logPrefix:  "[x402 exact]",
			configName: "ExactEvmSchemeConfig",
			newScheme: func(signer evm.ClientEvmSigner) x402.SchemeNetworkClient {
				return exactclient.NewExactEvmScheme(signer, nil)
			},
			requirements: exactRequirements,
		},
		{
			name:       "upto",
			logPrefix:  "[x402 upto]",
			configName: "UptoEvmSchemeConfig",
			newScheme: func(signer evm.ClientEvmSigner) x402.SchemeNetworkClient {
				return uptoclient.NewUptoEvmScheme(signer, nil)
			},
			requirements: uptoRequirements,
		},
	}
}

func captureClientWarningLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	return &logs
}

func TestClientGasSponsoringWarnings(t *testing.T) {
	for _, tc := range clientWarningCases() {
		t.Run(tc.name, func(t *testing.T) {
			t.Run("warns once without EIP-2612 read capability", func(t *testing.T) {
				logs := captureClientWarningLogs(t)
				scheme := tc.newScheme(&warningTestSigner{})
				payloadCtx := x402.PaymentPayloadContext{Extensions: map[string]interface{}{
					eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{},
				}}

				for range 2 {
					payload, err := scheme.CreatePaymentPayload(context.Background(), tc.requirements, payloadCtx)
					if err != nil {
						t.Fatalf("CreatePaymentPayload failed: %v", err)
					}
					if payload.Extensions != nil {
						t.Fatalf("expected no extension without read capability, got %+v", payload.Extensions)
					}
				}

				output := logs.String()
				warning := tc.logPrefix + " " + eip2612gassponsor.EIP2612GasSponsoring.Key()
				if count := strings.Count(output, warning); count != 1 {
					t.Fatalf("expected one warning, got %d: %q", count, output)
				}
				if !strings.Contains(output, tc.configName+".RPCURL") ||
					!strings.Contains(output, "RPCByChainID") {
					t.Fatalf("expected actionable RPC guidance, got %q", output)
				}
			})

			t.Run("does not warn without advertisement", func(t *testing.T) {
				logs := captureClientWarningLogs(t)
				scheme := tc.newScheme(&warningTestSigner{})
				if _, err := scheme.CreatePaymentPayload(context.Background(), tc.requirements, x402.PaymentPayloadContext{}); err != nil {
					t.Fatalf("CreatePaymentPayload failed: %v", err)
				}
				if logs.Len() != 0 {
					t.Fatalf("expected no warning without an advertised extension, got %q", logs.String())
				}
			})

			t.Run("warns without ERC-20 transaction capability", func(t *testing.T) {
				logs := captureClientWarningLogs(t)
				scheme := tc.newScheme(&warningTestSigner{})
				payloadCtx := x402.PaymentPayloadContext{Extensions: map[string]interface{}{
					erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{},
				}}

				payload, err := scheme.CreatePaymentPayload(context.Background(), tc.requirements, payloadCtx)
				if err != nil {
					t.Fatalf("CreatePaymentPayload failed: %v", err)
				}
				if payload.Extensions != nil {
					t.Fatalf("expected no extension without transaction capability, got %+v", payload.Extensions)
				}
				output := logs.String()
				if !strings.Contains(output, tc.logPrefix+" "+erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()) ||
					!strings.Contains(output, "NewClientSignerFromPrivateKeyWithClient") {
					t.Fatalf("expected actionable transaction warning, got %q", output)
				}
			})

			t.Run("allowance short-circuit", func(t *testing.T) {
				boolPtr := func(b bool) *bool { return &b }
				cases := []struct {
					name        string
					hasRPC      *bool // nil: signer has no HasRPCClient probe
					wantReads   int
					wantWarning bool
				}{
					{name: "reads allowance without probe", wantReads: 1},
					{name: "reads allowance when HasRPCClient is true", hasRPC: boolPtr(true), wantReads: 1},
					{name: "skips allowance read when HasRPCClient is false", hasRPC: boolPtr(false), wantWarning: true},
				}
				for _, c := range cases {
					t.Run(c.name, func(t *testing.T) {
						logs := captureClientWarningLogs(t)
						reader := &warningReadSigner{
							warningTestSigner: &warningTestSigner{},
							allowance:         big.NewInt(1_000_000),
						}
						var signer evm.ClientEvmSigner = reader
						if c.hasRPC != nil {
							signer = &warningProbeSigner{warningReadSigner: reader, hasRPC: *c.hasRPC}
						}
						scheme := tc.newScheme(signer)
						payloadCtx := x402.PaymentPayloadContext{Extensions: map[string]interface{}{
							erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{},
						}}

						payload, err := scheme.CreatePaymentPayload(context.Background(), tc.requirements, payloadCtx)
						if err != nil {
							t.Fatalf("CreatePaymentPayload failed: %v", err)
						}
						if payload.Extensions != nil {
							t.Fatalf("expected no extension, got %+v", payload.Extensions)
						}
						if reader.reads != c.wantReads {
							t.Fatalf("expected %d allowance reads, got %d", c.wantReads, reader.reads)
						}
						warned := strings.Contains(logs.String(), erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key())
						if warned != c.wantWarning {
							t.Fatalf("warning emitted=%v, want %v: %q", warned, c.wantWarning, logs.String())
						}
					})
				}
			})
		})
	}
}
