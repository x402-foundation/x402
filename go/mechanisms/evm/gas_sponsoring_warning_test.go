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
}

func (s *warningReadSigner) ReadContract(
	_ context.Context,
	_ string,
	_ []byte,
	_ string,
	_ ...interface{},
) (interface{}, error) {
	return s.allowance, nil
}

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

			t.Run("does not warn when ERC-20 approval is unnecessary", func(t *testing.T) {
				logs := captureClientWarningLogs(t)
				scheme := tc.newScheme(&warningReadSigner{
					warningTestSigner: &warningTestSigner{},
					allowance:         big.NewInt(1_000_000),
				})
				payloadCtx := x402.PaymentPayloadContext{Extensions: map[string]interface{}{
					erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{},
				}}

				payload, err := scheme.CreatePaymentPayload(context.Background(), tc.requirements, payloadCtx)
				if err != nil {
					t.Fatalf("CreatePaymentPayload failed: %v", err)
				}
				if payload.Extensions != nil {
					t.Fatalf("expected no extension with sufficient allowance, got %+v", payload.Extensions)
				}
				if strings.Contains(logs.String(), erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()) {
					t.Fatalf("expected no warning when approval is unnecessary, got %q", logs.String())
				}
			})
		})
	}
}
