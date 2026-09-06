package client

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/ethereum/go-ethereum/ethclient"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	batchedclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	exactevmv1 "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/v1/client"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/client"
	svmconfig "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/client"
	svmv1 "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/v1/client"
	uptosvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
)

// StepResult is the JSON shape the harness expects per request step.
type StepResult struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
	Error           string      `json:"error,omitempty"`
}

// AggregateResult mirrors TS aggregateBatchResult() output.
type AggregateResult struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
}

// SettleResponseExtractor reads PAYMENT-RESPONSE headers.
type SettleResponseExtractor interface {
	GetPaymentSettleResponse(headers map[string]string) (*x402.SettleResponse, error)
}

// ClientContext holds a configured payment-capable HTTP client for e2e runs.
type ClientContext struct {
	URL           string
	HTTPClient    *http.Client
	Settle        SettleResponseExtractor
	BatchedScheme *batchedclient.BatchSettlementEvmScheme
	BatchPhase    string
}

// PaymentClientContext bundles the signer-backed x402 payment client shared
// by the go-http and MCP e2e clients, built once from the same env vars.
// Transports that speak something other than plain HTTP (e.g. MCP) wrap
// Client themselves instead of going through Newx402HTTPClient.
type PaymentClientContext struct {
	Client        *x402.X402Client
	BatchedScheme *batchedclient.BatchSettlementEvmScheme
	BatchPhase    string
}

// BuildPaymentClient builds the shared x402 payment client + batched scheme
// from env vars, registering each Go-supported network whose credentials are set.
// Exits the process via OutputError on misconfiguration.
func BuildPaymentClient() *PaymentClientContext {
	evmPrivateKey := os.Getenv("CLIENT_EVM_PRIVATE_KEY")
	svmPrivateKey := os.Getenv("CLIENT_SVM_PRIVATE_KEY")
	if evmPrivateKey == "" && svmPrivateKey == "" {
		log.Fatal("At least one of CLIENT_EVM_PRIVATE_KEY or CLIENT_SVM_PRIVATE_KEY is required")
	}

	x402Client := x402.Newx402Client().DisableSpendControls()
	var batchedScheme *batchedclient.BatchSettlementEvmScheme

	if evmPrivateKey != "" {
		evmRpcURL := os.Getenv("EVM_RPC_URL")
		if evmRpcURL == "" {
			evmRpcURL = "https://sepolia.base.org"
		}
		ethClient, err := ethclient.Dial(evmRpcURL)
		if err != nil {
			OutputError(fmt.Sprintf("Failed to connect to EVM RPC: %v", err))
			return nil
		}

		evmSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(evmPrivateKey, ethClient)
		if err != nil {
			OutputError(fmt.Sprintf("Failed to create EVM signer: %v", err))
			return nil
		}

		var evmConfig *exactevm.ExactEvmSchemeConfig
		if evmRpcURL != "" {
			evmConfig = &exactevm.ExactEvmSchemeConfig{RPCURL: evmRpcURL}
		}
		var uptoConfig *uptoevm.UptoEvmSchemeConfig
		if evmRpcURL != "" {
			uptoConfig = &uptoevm.UptoEvmSchemeConfig{RPCURL: evmRpcURL}
		}

		batchedCfg := &batchedclient.BatchSettlementEvmSchemeOptions{}
		if salt := os.Getenv("EVM_BATCH_SETTLEMENT_CHANNEL"); salt != "" {
			batchedCfg.Salt = salt
		}
		if voucherKey := os.Getenv("CLIENT_EVM_BATCH_SETTLEMENT_VOUCHER_SIGNER_PRIVATE_KEY"); voucherKey != "" {
			voucherSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(voucherKey, ethClient)
			if err != nil {
				OutputError(fmt.Sprintf("Failed to create voucher signer: %v", err))
				return nil
			}
			batchedCfg.VoucherSigner = voucherSigner
		}
		batchedScheme = batchedclient.NewBatchSettlementEvmScheme(evmSigner, batchedCfg)

		evmPattern := x402.Network(networkCaip2Pattern("evm"))
		x402Client.
			Register(evmPattern, exactevm.NewExactEvmScheme(evmSigner, evmConfig)).
			Register(evmPattern, uptoevm.NewUptoEvmScheme(evmSigner, uptoConfig)).
			Register(evmPattern, batchedScheme).
			RegisterV1("base-sepolia", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
			RegisterV1("base", exactevmv1.NewExactEvmSchemeV1(evmSigner))
	}

	if svmPrivateKey != "" {
		svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
		if err != nil {
			OutputError(fmt.Sprintf("Failed to create SVM signer: %v", err))
			return nil
		}

		var svmCfg *svmconfig.ClientConfig
		if svmRpcURL := os.Getenv("SVM_RPC_URL"); svmRpcURL != "" {
			svmCfg = &svmconfig.ClientConfig{RPCURL: svmRpcURL}
		}

		svmPattern := x402.Network(networkCaip2Pattern("svm"))
		x402Client.
			Register(svmPattern, svm.NewExactSvmScheme(svmSigner, svmCfg)).
			Register(svmPattern, uptosvm.NewUptoSvmScheme(svmSigner, svmCfg)).
			RegisterV1("solana-devnet", svmv1.NewExactSvmSchemeV1(svmSigner, svmCfg)).
			RegisterV1("solana", svmv1.NewExactSvmSchemeV1(svmSigner, svmCfg))
	}

	return &PaymentClientContext{
		Client:        x402Client,
		BatchedScheme: batchedScheme,
		BatchPhase:    os.Getenv("EVM_BATCH_SETTLEMENT_PHASE"),
	}
}

// CreateClient builds the shared x402 client used by go-http e2e, wrapping
// BuildPaymentClient's payment client in a payment-capable *http.Client.
func CreateClient() *ClientContext {
	serverURL := os.Getenv("RESOURCE_SERVER_URL")
	if serverURL == "" {
		log.Fatal("RESOURCE_SERVER_URL is required")
	}

	endpointPath := os.Getenv("ENDPOINT_PATH")
	if endpointPath == "" {
		endpointPath = "/protected"
	}

	pc := BuildPaymentClient()
	if pc == nil {
		return nil
	}

	httpClient := x402http.Newx402HTTPClient(pc.Client)
	client := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	return &ClientContext{
		URL:           serverURL + endpointPath,
		HTTPClient:    client,
		Settle:        httpClient,
		BatchedScheme: pc.BatchedScheme,
		BatchPhase:    pc.BatchPhase,
	}
}

// RunScenario executes the single-request or batch-settlement client flow.
func RunScenario(ctx context.Context, c *ClientContext) {
	RunPhasedScenario(ctx, c.BatchPhase,
		func(ctx context.Context) StepResult { return IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL) },
		func(ctx context.Context) StepResult { return IssueRefund(ctx, c.BatchedScheme, c.URL, nil) },
	)
}

// RunPhasedScenario runs the shared single-request / batch-settlement phase
// flow used by both the go-http and MCP e2e clients, given transport-specific
// issueRequest/refund callbacks (MCP bridges these onto tool calls instead of
// raw HTTP requests).
func RunPhasedScenario(
	ctx context.Context,
	batchPhase string,
	issueRequest func(ctx context.Context) StepResult,
	refund func(ctx context.Context) StepResult,
) {
	switch batchPhase {
	case "initial":
		deposit := issueRequest(ctx)
		voucher := issueRequest(ctx)
		Emit(Aggregate("initial", []StepResult{deposit, voucher}, map[string]StepResult{
			"deposit": deposit,
			"voucher": voucher,
		}))
	case "recovery-refund":
		recoveryVoucher := issueRequest(ctx)
		refundResult := refund(ctx)
		Emit(Aggregate("recovery-refund", []StepResult{recoveryVoucher, refundResult}, map[string]StepResult{
			"recoveryVoucher": recoveryVoucher,
			"refund":          refundResult,
		}))
	case "full":
		deposit := issueRequest(ctx)
		voucher := issueRequest(ctx)
		refundResult := refund(ctx)
		Emit(Aggregate("full", []StepResult{deposit, voucher, refundResult}, map[string]StepResult{
			"deposit": deposit,
			"voucher": voucher,
			"refund":  refundResult,
		}))
	case "":
		Emit(ToAggregate(issueRequest(ctx)))
	default:
		OutputError(fmt.Sprintf("Unknown EVM_BATCH_SETTLEMENT_PHASE: %s", batchPhase))
	}
}

// IssueRequest performs a single paid GET.
func IssueRequest(
	ctx context.Context,
	client *http.Client,
	httpClient SettleResponseExtractor,
	url string,
) StepResult {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return StepResult{Success: false, Error: fmt.Sprintf("Failed to create request: %v", err)}
	}
	resp, err := client.Do(req)
	if err != nil {
		return StepResult{Success: false, Error: fmt.Sprintf("Request failed: %v", err)}
	}
	defer resp.Body.Close()

	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		return StepResult{Success: false, Error: fmt.Sprintf("Failed to decode response: %v", err), StatusCode: resp.StatusCode}
	}

	var paymentResponse interface{}
	if header := resp.Header.Get("PAYMENT-RESPONSE"); header != "" {
		if settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{"PAYMENT-RESPONSE": header}); err == nil {
			paymentResponse = settleResp
		}
	} else if header := resp.Header.Get("X-PAYMENT-RESPONSE"); header != "" {
		if settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{"X-PAYMENT-RESPONSE": header}); err == nil {
			paymentResponse = settleResp
		}
	}

	success := true
	if resp.StatusCode == 402 {
		success = false
	} else if settleResp, ok := paymentResponse.(*x402.SettleResponse); ok && settleResp != nil {
		success = settleResp.Success
	}

	return StepResult{
		Success:         success,
		Data:            responseData,
		StatusCode:      resp.StatusCode,
		PaymentResponse: paymentResponse,
	}
}

// IssueRefund triggers a cooperative refund on the batch-settlement channel.
// options is optional (nil uses the default plain-HTTP RefundOptions); the
// MCP client passes an HTTPClient whose Transport bridges refund requests
// onto MCP tool calls instead.
func IssueRefund(ctx context.Context, scheme *batchedclient.BatchSettlementEvmScheme, url string, options *batchedclient.RefundOptions) StepResult {
	if options == nil {
		options = &batchedclient.RefundOptions{}
	}
	settle, err := scheme.Refund(ctx, url, options)
	if err != nil {
		return StepResult{
			Success:    false,
			Error:      fmt.Sprintf("Refund failed: %v", err),
			StatusCode: 200,
			Data:       map[string]bool{"refund": true},
		}
	}
	return StepResult{
		Success:         settle.Success,
		Data:            map[string]bool{"refund": true},
		StatusCode:      200,
		PaymentResponse: settle,
	}
}

// Aggregate builds the multi-step batchSettlement payload.
func Aggregate(phase string, results []StepResult, details map[string]StepResult) AggregateResult {
	last := results[len(results)-1]
	allOk := true
	for _, r := range results {
		if !r.Success {
			allOk = false
			break
		}
	}
	batch := map[string]interface{}{
		"phase":    phase,
		"requests": results,
	}
	for k, v := range details {
		batch[k] = v
	}
	return AggregateResult{
		Success:         allOk,
		Data:            map[string]interface{}{"batchSettlement": batch},
		StatusCode:      last.StatusCode,
		PaymentResponse: last.PaymentResponse,
	}
}

// ToAggregate lifts a single StepResult into the wrapper shape.
func ToAggregate(s StepResult) AggregateResult {
	return AggregateResult{
		Success:         s.Success,
		Data:            s.Data,
		StatusCode:      s.StatusCode,
		PaymentResponse: s.PaymentResponse,
	}
}

// Emit prints an aggregate result as JSON.
func Emit(result AggregateResult) {
	data, err := json.Marshal(result)
	if err != nil {
		log.Fatalf("Failed to marshal result: %v", err)
	}
	fmt.Println(string(data))
}

// OutputError prints a step error and exits.
func OutputError(errorMsg string) {
	data, _ := json.Marshal(StepResult{Success: false, Error: errorMsg})
	fmt.Println(string(data))
	os.Exit(1)
}
