package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/ethereum/go-ethereum/ethclient"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	batchedclient "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement/client"
	exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	exactevmv1 "github.com/x402-foundation/x402/go/mechanisms/evm/exact/v1/client"
	uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/client"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/client"
	svmv1 "github.com/x402-foundation/x402/go/mechanisms/svm/exact/v1/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
	svmsigners "github.com/x402-foundation/x402/go/signers/svm"
)

// stepResult is the JSON shape the harness expects per request step. Matches
// the fields produced by `e2e/clients/fetch/index.ts` issueRequest():
// {success, data, status_code, payment_response}.
type stepResult struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
	Error           string      `json:"error,omitempty"`
}

// aggregateResult mirrors the TS `aggregateBatchResult()` output so the harness
// validator (`validateBatchPaymentStep` in e2e/test.ts) can read each step via
// `data.batchSettlement.{deposit,voucher,recoveryVoucher,refund}`.
type aggregateResult struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
}

func main() {
	serverURL := os.Getenv("RESOURCE_SERVER_URL")
	if serverURL == "" {
		log.Fatal("RESOURCE_SERVER_URL is required")
	}

	endpointPath := os.Getenv("ENDPOINT_PATH")
	if endpointPath == "" {
		endpointPath = "/protected"
	}

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		log.Fatal("EVM_PRIVATE_KEY environment variable is required")
	}

	svmPrivateKey := os.Getenv("SVM_PRIVATE_KEY")
	if svmPrivateKey == "" {
		log.Fatal("SVM_PRIVATE_KEY environment variable is required")
	}

	evmRpcURL := os.Getenv("EVM_RPC_URL")
	if evmRpcURL == "" {
		evmRpcURL = "https://sepolia.base.org"
	}
	ethClient, err := ethclient.Dial(evmRpcURL)
	if err != nil {
		outputError(fmt.Sprintf("Failed to connect to EVM RPC: %v", err))
		return
	}

	evmSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(evmPrivateKey, ethClient)
	if err != nil {
		outputError(fmt.Sprintf("Failed to create EVM signer: %v", err))
		return
	}

	svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
	if err != nil {
		outputError(fmt.Sprintf("Failed to create SVM signer: %v", err))
		return
	}

	var evmConfig *exactevm.ExactEvmSchemeConfig
	if evmRpcURL != "" {
		evmConfig = &exactevm.ExactEvmSchemeConfig{RPCURL: evmRpcURL}
	}

	var uptoConfig *uptoevm.UptoEvmSchemeConfig
	if evmRpcURL != "" {
		uptoConfig = &uptoevm.UptoEvmSchemeConfig{RPCURL: evmRpcURL}
	}

	// Batch-settlement scheme uses a per-scenario salt (CHANNEL_SALT) so concurrent
	// e2e runs don't collide on the same on-chain channel id. An optional voucher
	// signer (EVM_VOUCHER_SIGNER_PRIVATE_KEY) exercises the alt-EOA voucher branch
	// while deposits keep using the main client signer.
	batchedCfg := &batchedclient.BatchSettlementEvmSchemeOptions{}
	if salt := os.Getenv("CHANNEL_SALT"); salt != "" {
		batchedCfg.Salt = salt
	}
	if voucherKey := os.Getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY"); voucherKey != "" {
		voucherSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(voucherKey, ethClient)
		if err != nil {
			outputError(fmt.Sprintf("Failed to create voucher signer: %v", err))
			return
		}
		batchedCfg.VoucherSigner = voucherSigner
	}
	batchedScheme := batchedclient.NewBatchSettlementEvmScheme(evmSigner, batchedCfg)

	x402Client := x402.Newx402Client().
		Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, evmConfig)).
		Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, uptoConfig)).
		Register("eip155:*", batchedScheme).
		Register("solana:*", svm.NewExactSvmScheme(svmSigner)).
		RegisterV1("base-sepolia", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("base", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("solana-devnet", svmv1.NewExactSvmSchemeV1(svmSigner)).
		RegisterV1("solana", svmv1.NewExactSvmSchemeV1(svmSigner))

	httpClient := x402http.Newx402HTTPClient(x402Client)
	client := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	url := serverURL + endpointPath
	ctx := context.Background()

	// Phased batch-settlement contract — mirrors TS `e2e/clients/fetch/index.ts`.
	// When BATCH_SETTLEMENT_PHASE is unset, fall through to the single-request
	// branch used by non-batch endpoints.
	switch os.Getenv("BATCH_SETTLEMENT_PHASE") {
	case "initial":
		deposit := issueRequest(ctx, client, httpClient, url)
		voucher := issueRequest(ctx, client, httpClient, url)
		emit(aggregate("initial", []stepResult{deposit, voucher}, map[string]stepResult{
			"deposit": deposit,
			"voucher": voucher,
		}))
		return
	case "recovery-refund":
		recoveryVoucher := issueRequest(ctx, client, httpClient, url)
		refund := issueRefund(ctx, batchedScheme, url)
		emit(aggregate("recovery-refund", []stepResult{recoveryVoucher, refund}, map[string]stepResult{
			"recoveryVoucher": recoveryVoucher,
			"refund":          refund,
		}))
		return
	case "full":
		deposit := issueRequest(ctx, client, httpClient, url)
		voucher := issueRequest(ctx, client, httpClient, url)
		refund := issueRefund(ctx, batchedScheme, url)
		emit(aggregate("full", []stepResult{deposit, voucher, refund}, map[string]stepResult{
			"deposit": deposit,
			"voucher": voucher,
			"refund":  refund,
		}))
		return
	case "":
		// Single-request scenario for non-batch endpoints.
		emit(toAggregate(issueRequest(ctx, client, httpClient, url)))
		return
	default:
		outputError(fmt.Sprintf("Unknown BATCH_SETTLEMENT_PHASE: %s", os.Getenv("BATCH_SETTLEMENT_PHASE")))
		return
	}
}

// settleResponseExtractor reads PAYMENT-RESPONSE headers and returns a typed SettleResponse.
type settleResponseExtractor interface {
	GetPaymentSettleResponse(headers map[string]string) (*x402.SettleResponse, error)
}

// issueRequest performs a single paid GET, mirroring the TS fetch client's
// issueRequest() so the per-step JSON shape matches what `validateBatchPaymentStep`
// expects.
func issueRequest(
	ctx context.Context,
	client *http.Client,
	httpClient settleResponseExtractor,
	url string,
) stepResult {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return stepResult{Success: false, Error: fmt.Sprintf("Failed to create request: %v", err)}
	}
	resp, err := client.Do(req)
	if err != nil {
		return stepResult{Success: false, Error: fmt.Sprintf("Request failed: %v", err)}
	}
	defer resp.Body.Close()

	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		return stepResult{Success: false, Error: fmt.Sprintf("Failed to decode response: %v", err), StatusCode: resp.StatusCode}
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

	return stepResult{
		Success:         success,
		Data:            responseData,
		StatusCode:      resp.StatusCode,
		PaymentResponse: paymentResponse,
	}
}

// issueRefund triggers a cooperative refund on the batch-settlement channel,
// mirroring TS `await batchSettlementScheme.refund(url)`.
func issueRefund(ctx context.Context, scheme *batchedclient.BatchSettlementEvmScheme, url string) stepResult {
	settle, err := scheme.Refund(ctx, url, &batchedclient.RefundOptions{})
	if err != nil {
		return stepResult{
			Success:    false,
			Error:      fmt.Sprintf("Refund failed: %v", err),
			StatusCode: 200,
			Data:       map[string]bool{"refund": true},
		}
	}
	return stepResult{
		Success:         settle.Success,
		Data:            map[string]bool{"refund": true},
		StatusCode:      200,
		PaymentResponse: settle,
	}
}

// aggregate builds the multi-step batchSettlement payload expected by the
// harness validator. Mirrors TS `aggregateBatchResult()`.
func aggregate(phase string, results []stepResult, details map[string]stepResult) aggregateResult {
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
	return aggregateResult{
		Success:         allOk,
		Data:            map[string]interface{}{"batchSettlement": batch},
		StatusCode:      last.StatusCode,
		PaymentResponse: last.PaymentResponse,
	}
}

// toAggregate lifts a single stepResult into the wrapper shape used for
// non-batch (single-request) scenarios.
func toAggregate(s stepResult) aggregateResult {
	return aggregateResult{
		Success:         s.Success,
		Data:            s.Data,
		StatusCode:      s.StatusCode,
		PaymentResponse: s.PaymentResponse,
	}
}

func emit(result aggregateResult) {
	data, err := json.Marshal(result)
	if err != nil {
		log.Fatalf("Failed to marshal result: %v", err)
	}
	fmt.Println(string(data))
}

func outputError(errorMsg string) {
	data, _ := json.Marshal(stepResult{Success: false, Error: errorMsg})
	fmt.Println(string(data))
	os.Exit(1)
}
