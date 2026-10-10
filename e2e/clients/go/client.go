package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/ethclient"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	authcaptureclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/client"
	batchedclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	exactevmv1 "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/v1/client"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/client"
	svmconfig "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsvmclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
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
	URL              string
	HTTPClient       *http.Client
	Settle           SettleResponseExtractor
	BatchedEvmScheme *batchedclient.BatchSettlementEvmScheme
	BatchedSvmScheme *batchsvmclient.BatchSvmScheme
	BatchPhase       string
}

// PaymentClientContext bundles the signer-backed x402 payment client shared
// by the go-http and MCP e2e clients, built once from the same env vars.
// Transports that speak something other than plain HTTP (e.g. MCP) wrap
// Client themselves instead of going through Newx402HTTPClient.
type PaymentClientContext struct {
	Client           *x402.X402Client
	BatchedEvmScheme *batchedclient.BatchSettlementEvmScheme
	BatchedSvmScheme *batchsvmclient.BatchSvmScheme
	BatchPhase       string
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
	var batchedEvmScheme *batchedclient.BatchSettlementEvmScheme
	var batchedSvmScheme *batchsvmclient.BatchSvmScheme

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
		batchedEvmScheme = batchedclient.NewBatchSettlementEvmScheme(evmSigner, batchedCfg)

		evmPattern := x402.Network(networkCaip2Pattern("evm"))
		x402Client.
			Register(evmPattern, exactevm.NewExactEvmScheme(evmSigner, evmConfig)).
			Register(evmPattern, uptoevm.NewUptoEvmScheme(evmSigner, uptoConfig)).
			Register(evmPattern, batchedEvmScheme).
			Register(evmPattern, authcaptureclient.NewAuthCaptureEvmScheme(evmSigner)).
			RegisterV1("base-sepolia", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
			RegisterV1("base", exactevmv1.NewExactEvmSchemeV1(evmSigner))
	}

	if svmPrivateKey != "" {
		batchSigner, err := batchsvmclient.NewPrivateKeySigner(svmPrivateKey)
		if err != nil {
			OutputError(fmt.Sprintf("Failed to create SVM batch signer: %v", err))
			return nil
		}

		svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
		if err != nil {
			OutputError(fmt.Sprintf("Failed to create SVM signer: %v", err))
			return nil
		}

		var svmCfg *svmconfig.ClientConfig
		svmRpcURL := os.Getenv("SVM_RPC_URL")
		if svmRpcURL != "" {
			svmCfg = &svmconfig.ClientConfig{RPCURL: svmRpcURL}
		}

		batchCfg := &batchsvmclient.BatchSvmClientConfig{RPCURL: svmRpcURL}
		if saltHex := batchSettlementChannelSalt(); saltHex != "" {
			if salt, err := svmChannelSaltU64(saltHex); err != nil {
				OutputError(fmt.Sprintf("Invalid batch-settlement channel salt: %v", err))
				return nil
			} else {
				batchCfg.Salt = salt
			}
		}
		if operators := parseCommaSeparated(os.Getenv("CLIENT_SVM_SERVER_SIGNED_OPERATORS")); len(operators) > 0 {
			policy := &batchsvmclient.BatchServerSignedChannelsPolicy{AllowedOperators: operators}
			if maxDeposit := strings.TrimSpace(os.Getenv("CLIENT_SVM_SERVER_SIGNED_MAX_DEPOSIT")); maxDeposit != "" {
				policy.MaxDeposit = maxDeposit
			}
			batchCfg.ServerSignedChannelsPolicy = policy
		}
		batchedSvmScheme, err = batchsvmclient.NewBatchSvmScheme(batchSigner, batchCfg)
		if err != nil {
			OutputError(fmt.Sprintf("Failed to create SVM batch-settlement scheme: %v", err))
			return nil
		}

		svmPattern := x402.Network(networkCaip2Pattern("svm"))
		x402Client.
			Register(svmPattern, svm.NewExactSvmScheme(svmSigner, svmCfg)).
			Register(svmPattern, uptosvm.NewUptoSvmScheme(svmSigner, svmCfg)).
			Register(svmPattern, batchedSvmScheme).
			RegisterV1("solana-devnet", svmv1.NewExactSvmSchemeV1(svmSigner, svmCfg)).
			RegisterV1("solana", svmv1.NewExactSvmSchemeV1(svmSigner, svmCfg))
		if batchCfg.ServerSignedChannelsPolicy != nil {
			x402Client.RegisterPolicy(batchedSvmScheme.PaymentPolicy())
		}
	}

	batchPhase := strings.TrimSpace(os.Getenv("BATCH_SETTLEMENT_PHASE"))
	if batchPhase == "" {
		batchPhase = strings.TrimSpace(os.Getenv("EVM_BATCH_SETTLEMENT_PHASE"))
	}

	return &PaymentClientContext{
		Client:           x402Client,
		BatchedEvmScheme: batchedEvmScheme,
		BatchedSvmScheme: batchedSvmScheme,
		BatchPhase:       batchPhase,
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
		URL:              serverURL + endpointPath,
		HTTPClient:       client,
		Settle:           httpClient,
		BatchedEvmScheme: pc.BatchedEvmScheme,
		BatchedSvmScheme: pc.BatchedSvmScheme,
		BatchPhase:       pc.BatchPhase,
	}
}

// RunScenario executes the single-request or batch-settlement client flow.
func RunScenario(ctx context.Context, c *ClientContext) {
	refund := batchRefundStep(c)
	RunPhasedScenario(ctx, c.BatchPhase,
		func(ctx context.Context) StepResult { return IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL) },
		refund,
	)
}

func batchRefundStep(c *ClientContext) func(context.Context) StepResult {
	endpointPath := os.Getenv("ENDPOINT_PATH")
	useSvm := strings.Contains(endpointPath, "/svm")
	return func(ctx context.Context) StepResult {
		if useSvm && c.BatchedSvmScheme != nil {
			return IssueSvmRefund(ctx, c.BatchedSvmScheme, c.URL, nil)
		}
		return IssueRefund(ctx, c.BatchedEvmScheme, c.URL, nil)
	}
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
		OutputError(fmt.Sprintf("Unknown BATCH_SETTLEMENT_PHASE: %s", batchPhase))
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
	var stepErr string
	if resp.StatusCode == 402 {
		success = false
		stepErr = describePaymentFailure(responseData, resp)
	} else if resp.StatusCode >= 400 {
		success = false
		stepErr = describeRequestFailure(responseData, resp)
	} else if settleResp, ok := paymentResponse.(*x402.SettleResponse); ok && settleResp != nil {
		success = settleResp.Success
		if !success {
			if settleResp.ErrorReason != "" {
				stepErr = fmt.Sprintf("Payment failed: %s", settleResp.ErrorReason)
			} else {
				stepErr = fmt.Sprintf("Payment failed (status %d)", resp.StatusCode)
			}
		}
	}

	return StepResult{
		Success:         success,
		Data:            responseData,
		StatusCode:      resp.StatusCode,
		PaymentResponse: paymentResponse,
		Error:           stepErr,
	}
}

// describePaymentFailure builds an actionable error for a 402 response that
// carries no PAYMENT-RESPONSE (verify rejection). It prefers the response
// body's error field, then the decoded PAYMENT-REQUIRED error reason (so
// batch-settlement corrective mismatches surface as
// "invalid_batch_settlement_evm_*" instead of "missing payment response").
func describePaymentFailure(responseData interface{}, resp *http.Response) string {
	if m, ok := responseData.(map[string]interface{}); ok {
		if msg, ok := m["error"].(string); ok && msg != "" {
			return fmt.Sprintf("Payment failed (402): %s", msg)
		}
	}
	if header := resp.Header.Get("PAYMENT-REQUIRED"); header != "" {
		if reason := decodePaymentRequiredError(header); reason != "" {
			return fmt.Sprintf("Payment failed (402): %s", reason)
		}
		return fmt.Sprintf("Payment failed (402): missing payment response (PAYMENT-REQUIRED present, body: %v)", responseData)
	}
	return fmt.Sprintf("Payment failed (402): %v", responseData)
}

// decodePaymentRequiredError extracts the 402 error reason from a base64
// PAYMENT-REQUIRED header. Returns "" when the header cannot be decoded.
func decodePaymentRequiredError(header string) string {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(header))
	if err != nil {
		return ""
	}
	var required struct {
		Error   string `json:"error"`
		Accepts []struct {
			Scheme string `json:"scheme"`
			Extra  map[string]interface{} `json:"extra"`
		} `json:"accepts"`
	}
	if err := json.Unmarshal(decoded, &required); err != nil {
		return ""
	}
	return required.Error
}

// describeRequestFailure builds an actionable error for a non-402 error
// response that carries no PAYMENT-RESPONSE (e.g. a 500 from a misconfigured
// route). It prefers the response body's error field.
func describeRequestFailure(responseData interface{}, resp *http.Response) string {
	if m, ok := responseData.(map[string]interface{}); ok {
		if msg, ok := m["error"].(string); ok && msg != "" {
			return fmt.Sprintf("Request failed (%d): %s", resp.StatusCode, msg)
		}
	}
	return fmt.Sprintf("Request failed (%d): %v", resp.StatusCode, responseData)
}

// IssueRefund triggers a cooperative refund on the batch-settlement channel.
// options is optional (nil uses the default plain-HTTP RefundOptions); the
// MCP client passes an HTTPClient whose Transport bridges refund requests
// onto MCP tool calls instead.
func IssueSvmRefund(ctx context.Context, scheme *batchsvmclient.BatchSvmScheme, url string, options *batchsvmclient.BatchRefundOptions) StepResult {
	if scheme == nil {
		return StepResult{Success: false, Error: "SVM batch-settlement scheme not configured"}
	}
	if options == nil {
		options = &batchsvmclient.BatchRefundOptions{}
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

func IssueRefund(ctx context.Context, scheme *batchedclient.BatchSettlementEvmScheme, url string, options *batchedclient.RefundOptions) StepResult {
	if scheme == nil {
		return StepResult{Success: false, Error: "EVM batch-settlement scheme not configured"}
	}
	if options == nil {
		options = &batchedclient.RefundOptions{}
	}
	settle, err := scheme.Refund(ctx, url, options)
	if err != nil {
		return StepResult{
			Success:    false,
			Error:      fmt.Sprintf("Refund failed: %v", err),
			StatusCode: 500,
			Data:       map[string]bool{"refund": false},
		}
	}
	refundStatus := 200
	if !settle.Success {
		refundStatus = 500
	}
	return StepResult{
		Success:         settle.Success,
		Data:            map[string]bool{"refund": settle.Success},
		StatusCode:      refundStatus,
		PaymentResponse: settle,
	}
}

// Aggregate builds the multi-step batchSettlement payload.
// On failure the aggregate status surfaces the first failing step so a
// trailing refund step can no longer mask an earlier 402 as 200.
func Aggregate(phase string, results []StepResult, details map[string]StepResult) AggregateResult {
	last := results[len(results)-1]
	statusCode := last.StatusCode
	paymentResponse := last.PaymentResponse
	allOk := true
	for _, r := range results {
		if !r.Success {
			allOk = false
			statusCode = r.StatusCode
			paymentResponse = r.PaymentResponse
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
		StatusCode:      statusCode,
		PaymentResponse: paymentResponse,
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

func batchSettlementChannelSalt() string {
	if salt := strings.TrimSpace(os.Getenv("BATCH_SETTLEMENT_CHANNEL")); salt != "" {
		return salt
	}
	return strings.TrimSpace(os.Getenv("EVM_BATCH_SETTLEMENT_CHANNEL"))
}

// svmChannelSaltU64 maps the harness hex salt to the uint64 channel salt the SVM
// batch client uses, matching the TypeScript e2e client.
func svmChannelSaltU64(channelSalt string) (uint64, error) {
	hexSalt := strings.TrimPrefix(strings.TrimSpace(channelSalt), "0x")
	if hexSalt == "" {
		return 0, fmt.Errorf("empty salt")
	}
	value, ok := new(big.Int).SetString(hexSalt, 16)
	if !ok {
		return 0, fmt.Errorf("invalid hex salt %q", channelSalt)
	}
	mask := new(big.Int).Lsh(big.NewInt(1), 64)
	value.Mod(value, mask)
	return value.Uint64(), nil
}

func parseCommaSeparated(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// OutputError prints a step error and exits.
func OutputError(errorMsg string) {
	data, _ := json.Marshal(StepResult{Success: false, Error: errorMsg})
	fmt.Println(string(data))
	os.Exit(1)
}
