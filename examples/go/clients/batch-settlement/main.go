// Sequential batch-settlement client (EVM + SVM).
//
// Mirrors examples/typescript/clients/batch-settlement: opens a channel on the
// first request and pays subsequent requests with off-chain vouchers.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	batchsvmclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

func main() {
	_ = godotenv.Load()

	evmPrivateKey := strings.TrimSpace(os.Getenv("EVM_PRIVATE_KEY"))
	svmPrivateKey := strings.TrimSpace(os.Getenv("SVM_PRIVATE_KEY"))
	if evmPrivateKey == "" && svmPrivateKey == "" {
		fmt.Println("At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
		os.Exit(1)
	}

	baseURL := envOr("RESOURCE_SERVER_URL", "http://localhost:4021")
	endpointPath := envOr("ENDPOINT_PATH", "/weather")
	url := baseURL + endpointPath

	storageDir := strings.TrimSpace(os.Getenv("STORAGE_DIR"))
	numberOfRequests := atoiOr("NUMBER_OF_REQUESTS", 3)
	depositMultiplier := atoiOr("DEPOSIT_MULTIPLIER", batchedclient.DefaultDepositMultiplier)
	refundAfterRequests := strings.TrimSpace(os.Getenv("REFUND_AFTER_REQUESTS")) == "true"
	refundAmount := strings.TrimSpace(os.Getenv("REFUND_AMOUNT"))

	x402Client := x402.Newx402Client()
	x402Client.SetSpendControls(x402.SpendControls{
		MaxAmountPerPayment: "$1",
	})

	var evmScheme *batchedclient.BatchSettlementEvmScheme
	var svmScheme *batchsvmclient.BatchSvmScheme

	if evmPrivateKey != "" {
		rpcURL := envOr("EVM_RPC_URL", "https://sepolia.base.org")
		channelSalt := envOr("CHANNEL_SALT", batchedclient.DefaultSalt)

		ethClient, err := ethclient.Dial(rpcURL)
		if err != nil {
			fmt.Printf("Failed to dial EVM RPC %s: %v\n", rpcURL, err)
			os.Exit(1)
		}
		defer ethClient.Close()

		signer, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(evmPrivateKey, ethClient)
		if err != nil {
			fmt.Printf("Failed to create EVM signer: %v\n", err)
			os.Exit(1)
		}

		cfg := &batchedclient.BatchSettlementEvmSchemeOptions{
			DepositMultiplier: depositMultiplier,
			Salt:              channelSalt,
		}
		if voucherKey := strings.TrimSpace(os.Getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY")); voucherKey != "" {
			voucherSigner, err := evmsigners.NewClientSignerFromPrivateKey(voucherKey)
			if err != nil {
				fmt.Printf("Failed to create voucher signer: %v\n", err)
				os.Exit(1)
			}
			cfg.VoucherSigner = voucherSigner
		}
		if storageDir != "" {
			cfg.Storage = batchedclient.NewFileClientChannelStorage(batchsettlement.FileChannelStorageOptions{
				Directory: storageDir,
			})
		}

		evmScheme = batchedclient.NewBatchSettlementEvmScheme(signer, cfg)
		x402Client.Register("eip155:*", evmScheme)

		fmt.Printf("EVM payer: %s\n", signer.Address())
		if cfg.VoucherSigner != nil {
			fmt.Printf("EVM payerAuthorizer: %s\n", cfg.VoucherSigner.Address())
		} else {
			fmt.Printf("EVM payerAuthorizer: %s\n", signer.Address())
		}
	}

	if svmPrivateKey != "" {
		payer, err := batchsvmclient.NewPrivateKeySigner(svmPrivateKey)
		if err != nil {
			fmt.Printf("Failed to create SVM signer: %v\n", err)
			os.Exit(1)
		}

		multiplier := depositMultiplier
		svmCfg := &batchsvmclient.BatchSvmClientConfig{
			DepositPolicy: &batchsvmclient.DepositPolicy{
				DepositMultiplier: &multiplier,
			},
			Salt: envOr("SVM_CHANNEL_SALT", "0"),
		}
		if rpcURL := strings.TrimSpace(os.Getenv("SVM_RPC_URL")); rpcURL != "" {
			svmCfg.RPCURL = rpcURL
		}
		operators := parseOperatorList(os.Getenv("SVM_SERVER_SIGNED_OPERATORS"))
		if len(operators) > 0 {
			maxDeposit := strings.TrimSpace(os.Getenv("SVM_SERVER_SIGNED_MAX_DEPOSIT"))
			if maxDeposit == "" {
				maxDeposit = "$0.05"
			}
			svmCfg.ServerSignedChannelsPolicy = &batchsvmclient.BatchServerSignedChannelsPolicy{
				AllowedOperators: operators,
				MaxDeposit:       maxDeposit,
			}
		}

		svmScheme, err = batchsvmclient.NewBatchSvmScheme(payer, svmCfg)
		if err != nil {
			fmt.Printf("Failed to create SVM batch scheme: %v\n", err)
			os.Exit(1)
		}
		x402Client.Register("solana:*", svmScheme)
		x402Client.RegisterPolicy(svmScheme.PaymentPolicy())

		fmt.Printf("SVM payer: %s\n", payer.Address())
		fmt.Printf("SVM channel salt: %s\n", svmCfg.Salt)
		if len(operators) > 0 {
			maxDeposit := svmCfg.ServerSignedChannelsPolicy.MaxDeposit
			fmt.Printf(
				"SVM server-signed channels: trusted operators %s up to %s per channel\n",
				strings.Join(operators, ", "), maxDeposit,
			)
		} else {
			fmt.Println("SVM server-signed channels: refused (client-signed vouchers only)")
		}
	}

	x402HTTPClient := x402http.Newx402HTTPClient(x402Client)
	httpClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, x402HTTPClient)

	fmt.Printf("\nBase URL: %s, endpoint: %s\n\n", baseURL, endpointPath)

	networksUsed := make(map[string]bool)
	var unsettledRequests int

	for i := 0; i < numberOfRequests; i++ {
		t0 := time.Now()

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
		resp, err := httpClient.Do(req)
		cancel()
		if err != nil {
			fmt.Printf("Request %d failed: %v\n", i+1, err)
			os.Exit(1)
		}

		settle, _ := extractSettleResponse(resp)
		body, errBody := readJSON(resp)
		_ = resp.Body.Close()

		if settle != nil && settle.Success {
			if fam := batchSettlementNetworkFamily(settle.Network); fam != "" {
				networksUsed[fam] = true
			}
			fmt.Printf("Request %d — RESPONSE\n", i+1)
			if errBody != nil {
				fmt.Printf("  body: <not JSON: %v>\n", errBody)
			} else {
				fmt.Println(indent(body))
			}
			fmt.Println(indent(settle))
		} else {
			unsettledRequests++
			fmt.Printf("Request %d — no settlement\n", i+1)
			result := map[string]interface{}{
				"status": resp.Status,
				"body":   body,
			}
			if paymentErr := paymentRequiredError(resp); paymentErr != "" {
				result["paymentError"] = paymentErr
				fmt.Printf("  payment error: %s\n", paymentErr)
			}
			if settle != nil {
				result["paymentResponse"] = settle
			}
			fmt.Println(indent(result))
		}

		fmt.Printf("Request %d — completed in %.3fs\n\n", i+1, time.Since(t0).Seconds())
	}

	if unsettledRequests > 0 {
		fmt.Printf("%d of %d requests did not settle\n", unsettledRequests, numberOfRequests)
		os.Exit(1)
	}

	if refundAfterRequests {
		if len(networksUsed) == 0 {
			fmt.Println("No settled payments to refund")
			os.Exit(1)
		}
		refundEVM := networksUsed["evm"] && evmScheme != nil
		refundSVM := networksUsed["svm"] && svmScheme != nil
		if !refundEVM && !refundSVM {
			fmt.Println("No batch-settlement scheme is available to refund the networks used for payment")
			return
		}
		if refundAmount != "" && !refundEVM {
			fmt.Println("SVM batch settlement supports only a full refund")
			os.Exit(1)
		}
		if refundAmount != "" {
			fmt.Printf("REQUESTING PARTIAL REFUND of %s base units\n", refundAmount)
		} else {
			fmt.Println("REQUESTING FULL REFUND of remaining channel balance")
		}

		if refundEVM {
			refundT0 := time.Now()
			opts := &batchedclient.RefundOptions{}
			if refundAmount != "" {
				opts.Amount = refundAmount
			}
			refundCtx, refundCancel := context.WithTimeout(context.Background(), 60*time.Second)
			settle, err := evmScheme.Refund(refundCtx, url, opts)
			refundCancel()
			if err != nil {
				fmt.Printf("[EVM] Refund failed: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("[EVM]", indent(settle))
			fmt.Printf("[EVM] Refund completed in %.3fs\n", time.Since(refundT0).Seconds())
		}
		if refundSVM {
			refundT0 := time.Now()
			refundCtx, refundCancel := context.WithTimeout(context.Background(), 60*time.Second)
			settle, err := svmScheme.Refund(refundCtx, url, nil)
			refundCancel()
			if errors.Is(err, batchsvmclient.ErrNoBatchChannelToRefund) {
				fmt.Println("[SVM] No open channel to refund (skipped)")
			} else if err != nil {
				fmt.Printf("[SVM] Refund failed: %v\n", err)
				os.Exit(1)
			} else {
				fmt.Println("[SVM]", indent(settle))
				fmt.Printf("[SVM] Refund completed in %.3fs\n", time.Since(refundT0).Seconds())
			}
		}
	}
}

func batchSettlementNetworkFamily(network x402.Network) string {
	switch {
	case strings.HasPrefix(string(network), "eip155:"):
		return "evm"
	case strings.HasPrefix(string(network), "solana:"):
		return "svm"
	default:
		return ""
	}
}

func parseOperatorList(raw string) []string {
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

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func atoiOr(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func readJSON(resp *http.Response) (interface{}, error) {
	var out interface{}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func paymentRequiredError(resp *http.Response) string {
	if resp == nil {
		return ""
	}
	header := resp.Header.Get("Payment-Required")
	if header == "" {
		header = resp.Header.Get("PAYMENT-REQUIRED")
	}
	if header == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return ""
	}
	var required x402.PaymentRequired
	if err := json.Unmarshal(decoded, &required); err != nil {
		return ""
	}
	return required.Error
}

func extractSettleResponse(resp *http.Response) (*x402.SettleResponse, error) {
	header := resp.Header.Get("PAYMENT-RESPONSE")
	if header == "" {
		header = resp.Header.Get("X-PAYMENT-RESPONSE")
	}
	if header == "" {
		return nil, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, err
	}
	var out x402.SettleResponse
	if err := json.Unmarshal(decoded, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func indent(v interface{}) string {
	b, err := json.MarshalIndent(v, "  ", "  ")
	if err != nil {
		return fmt.Sprintf("  %v", v)
	}
	return "  " + string(b)
}
