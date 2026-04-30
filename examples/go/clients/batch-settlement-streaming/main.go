package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	batchedclient "github.com/x402-foundation/x402/go/mechanisms/evm/batched/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

// Streaming batch-settlement client. Opens a channel via deposit on the first
// payment, then consumes an SSE stream while renewing vouchers mid-stream when
// the server signals via `x402-voucher-needed`. Mirrors
// `examples/typescript/clients/batch-settlement-streaming/index.ts`.
func main() {
	_ = godotenv.Load()

	var promptFlag string
	var verboseFlag bool
	flag.StringVar(&promptFlag, "prompt", "", "Prompt to send to the LLM")
	flag.StringVar(&promptFlag, "p", "", "Alias for --prompt")
	flag.BoolVar(&verboseFlag, "verbose", false, "Verbose voucher-event logging")
	flag.BoolVar(&verboseFlag, "v", false, "Alias for --verbose")
	flag.Parse()

	prompt := promptFlag
	if prompt == "" {
		prompt = envOr("PROMPT", "Tell me a fun fact about payments.")
	}
	verbose := verboseFlag || isTruthyEnvFlag(os.Getenv("VERBOSE"))

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}
	baseURL := envOr("RESOURCE_SERVER_URL", "http://localhost:4021")
	rpcURL := envOr("EVM_RPC_URL", "https://sepolia.base.org")
	channelSalt := envOr("CHANNEL_SALT", batchedclient.DefaultSalt)
	storageDir := os.Getenv("STORAGE_DIR")

	// RPC required so the signer can recover channel state when local storage is empty.
	ethClient, err := ethclient.Dial(rpcURL)
	if err != nil {
		fmt.Printf("Failed to dial EVM RPC %s: %v\n", rpcURL, err)
		os.Exit(1)
	}
	defer ethClient.Close()

	signer, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(evmPrivateKey, ethClient)
	if err != nil {
		fmt.Printf("Failed to create signer: %v\n", err)
		os.Exit(1)
	}

	var voucherSigner evm.ClientEvmSigner
	if voucherKey := os.Getenv("EVM_VOUCHER_SIGNER_PRIVATE_KEY"); voucherKey != "" {
		vs, err := evmsigners.NewClientSignerFromPrivateKey(voucherKey)
		if err != nil {
			fmt.Printf("Failed to create voucher signer: %v\n", err)
			os.Exit(1)
		}
		voucherSigner = vs
	}
	effectiveVoucherSigner := signer
	if voucherSigner != nil {
		// only used for printing; voucher signing happens inside the scheme
		_ = effectiveVoucherSigner
	}

	cfg := &batchedclient.BatchedEvmSchemeConfig{
		MaxDeposit:        "10000000",
		DepositMultiplier: 100,
		Salt:              channelSalt,
		VoucherSigner:     voucherSigner,
	}
	if storageDir != "" {
		cfg.Storage = batchedclient.NewFileClientChannelStorage(batched.FileChannelStorageOptions{
			Directory: storageDir,
		})
	}
	scheme := batchedclient.NewBatchedEvmScheme(signer, cfg)

	x402Client := x402.Newx402Client()
	x402Client.Register("eip155:*", scheme)
	httpClient := x402http.Newx402HTTPClient(x402Client)

	streamURL := fmt.Sprintf("%s/llm/stream?prompt=%s", baseURL, url.QueryEscape(prompt))

	authorizerAddr := signer.Address()
	if voucherSigner != nil {
		authorizerAddr = voucherSigner.Address()
	}
	fmt.Printf("Server: %s\n", baseURL)
	fmt.Printf("Payer: %s\n", signer.Address())
	fmt.Printf("VoucherSigner: %s\n", authorizerAddr)
	fmt.Printf("Prompt: %q\n\n", prompt)

	ctx := context.Background()

	// Initial GET — no payment, expect 402.
	fmt.Println("--- Initial request (no payment) ---")
	initial, err := http.Get(streamURL)
	if err != nil {
		fmt.Printf("Initial request failed: %v\n", err)
		os.Exit(1)
	}
	if initial.StatusCode != http.StatusPaymentRequired {
		body, _ := io.ReadAll(initial.Body)
		_ = initial.Body.Close()
		fmt.Printf("Unexpected status %d, expected 402\n%s\n", initial.StatusCode, string(body))
		os.Exit(1)
	}

	bodyBytes, _ := io.ReadAll(initial.Body)
	_ = initial.Body.Close()

	headerMap := flattenHeaders(initial.Header)
	paymentRequired, err := httpClient.GetPaymentRequiredResponse(headerMap, bodyBytes)
	if err != nil {
		fmt.Printf("Failed to parse 402 response: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Received 402 — payment required")

	if len(paymentRequired.Accepts) == 0 {
		fmt.Println("No accepted payment requirements")
		os.Exit(1)
	}
	requirements := paymentRequired.Accepts[0]

	paymentPayload, err := scheme.CreatePaymentPayload(ctx, requirements)
	if err != nil {
		fmt.Printf("Failed to create payment payload: %v\n", err)
		os.Exit(1)
	}

	channelConfig := scheme.BuildChannelConfig(requirements)
	channelId, err := batched.ComputeChannelId(channelConfig, requirements.Network)
	if err != nil {
		fmt.Printf("Failed to compute channel id: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Channel: %s\n\n", channelId)

	// Paid request — receive SSE.
	fmt.Println("--- Paid request (SSE stream) ---")
	paid, err := streamGetWithSignature(ctx, httpClient, streamURL, &paymentPayload)
	if err != nil {
		fmt.Printf("Paid request failed: %v\n", err)
		os.Exit(1)
	}

	if paid.StatusCode == http.StatusPaymentRequired {
		recovered := tryRecoverFromCorrective402(scheme, paid)
		_ = paid.Body.Close()
		if recovered {
			paymentPayload, err = scheme.CreatePaymentPayload(ctx, requirements)
			if err != nil {
				fmt.Printf("Failed to recreate payment payload after corrective 402: %v\n", err)
				os.Exit(1)
			}
			paid, err = streamGetWithSignature(ctx, httpClient, streamURL, &paymentPayload)
			if err != nil {
				fmt.Printf("Retry after corrective 402 failed: %v\n", err)
				os.Exit(1)
			}
		}
	}

	if paid.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(paid.Body)
		_ = paid.Body.Close()
		fmt.Printf("Unexpected status %d\n%s\n", paid.StatusCode, string(body))
		os.Exit(1)
	}

	// SSE consumer.
	tokenCount := 0
	vouchersSent := 1
	events := parseSSE(paid.Body)
	for ev := range events {
		switch ev.Event {
		case "data":
			var d struct {
				Token string `json:"token"`
				Index int    `json:"index"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &d); err == nil {
				fmt.Print(d.Token)
				tokenCount++
			}

		case "x402-voucher-needed":
			var v struct {
				ChannelId               string `json:"channelId"`
				ChargedCumulativeAmount string `json:"chargedCumulativeAmount"`
				Balance                 string `json:"balance"`
				NextMaxClaimableAmount  string `json:"nextMaxClaimableAmount"`
				VoucherEndpoint         string `json:"voucherEndpoint"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &v); err != nil {
				fmt.Printf("\n  [voucher-needed parse error] %v\n", err)
				continue
			}
			if verbose {
				fmt.Printf("\n  [voucher-needed] charged=%s balance=%s next=%s\n",
					v.ChargedCumulativeAmount, v.Balance, v.NextMaxClaimableAmount)
			}

			// Sync local session state from the server's snapshot.
			_ = scheme.ProcessSettleResponse(map[string]interface{}{
				"channelId":               v.ChannelId,
				"chargedCumulativeAmount": v.ChargedCumulativeAmount,
				"balance":                 v.Balance,
			})

			// Build the renewal payload (voucher or top-up deposit).
			renewalPayload, err := scheme.CreatePaymentPayload(ctx, requirements)
			if err != nil {
				fmt.Printf("\n  [voucher-renewal build error] %v\n", err)
				continue
			}
			toppedUp := batched.IsDepositPayload(renewalPayload.Payload)

			renewURL := baseURL + v.VoucherEndpoint
			if err := postPaymentSignature(ctx, httpClient, renewURL, &renewalPayload); err != nil {
				fmt.Printf("\n  [voucher-renewal FAILED] %v\n", err)
			} else {
				vouchersSent++
				if verbose {
					if toppedUp {
						fmt.Println("  [top-up posted]")
					} else {
						fmt.Println("  [voucher posted]")
					}
				}
			}

		case "x402-voucher-accepted":
			var v struct {
				ChannelId                  string `json:"channelId"`
				NewChargedCumulativeAmount string `json:"newChargedCumulativeAmount"`
				Balance                    string `json:"balance"`
				ToppedUp                   bool   `json:"toppedUp"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &v); err != nil {
				continue
			}
			_ = scheme.ProcessSettleResponse(map[string]interface{}{
				"channelId":               v.ChannelId,
				"chargedCumulativeAmount": v.NewChargedCumulativeAmount,
				"balance":                 v.Balance,
			})
			if verbose {
				suffix := ""
				if v.ToppedUp {
					suffix = " (topped up)"
				}
				fmt.Printf("  [voucher-accepted] charged=%s balance=%s%s\n",
					v.NewChargedCumulativeAmount, v.Balance, suffix)
			}

		case "x402-settlement":
			var s struct {
				ChannelId               string `json:"channelId"`
				ChargedCumulativeAmount string `json:"chargedCumulativeAmount"`
				SignedMaxClaimable      string `json:"signedMaxClaimable"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &s); err != nil {
				continue
			}
			if verbose {
				fmt.Printf("\n  [settlement] charged=%s signed=%s\n",
					s.ChargedCumulativeAmount, s.SignedMaxClaimable)
			}
			_ = scheme.ProcessSettleResponse(map[string]interface{}{
				"channelId":               s.ChannelId,
				"chargedCumulativeAmount": s.ChargedCumulativeAmount,
			})

		case "x402-error":
			var e struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &e); err == nil {
				fmt.Fprintf(os.Stderr, "\n  [ERROR] %s: %s\n", e.Code, e.Message)
			}

		case "done":
			// stream end
		}
	}

	// Trailers: PAYMENT-RESPONSE may arrive after the body completes.
	respHeader := paid.Trailer.Get("PAYMENT-RESPONSE")
	if respHeader == "" {
		respHeader = paid.Header.Get("PAYMENT-RESPONSE")
	}
	if respHeader != "" {
		if settle, err := decodePaymentResponseHeader(respHeader); err == nil {
			b, _ := json.MarshalIndent(settle, "  ", "  ")
			fmt.Printf("\n\n[PAYMENT-RESPONSE]\n  %s\n", string(b))
			if settle.Extra != nil {
				_ = scheme.ProcessSettleResponse(settle.Extra)
			}
		}
	}
	_ = paid.Body.Close()

	fmt.Println("\n\n--- Summary ---")
	fmt.Printf("Tokens received: %d\n", tokenCount)
	fmt.Printf("Vouchers sent: %d\n", vouchersSent)
}

// streamGetWithSignature performs a GET with a PAYMENT-SIGNATURE header derived
// from the given payload. The response body must be closed by the caller.
func streamGetWithSignature(
	ctx context.Context,
	httpClient *x402http.HTTPClient,
	streamURL string,
	payload interface{},
) (*http.Response, error) {
	headers, err := encodeSignatureHeaders(httpClient, payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", streamURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return http.DefaultClient.Do(req)
}

// postPaymentSignature POSTs a payment payload to the server's voucher side-channel.
func postPaymentSignature(
	ctx context.Context,
	httpClient *x402http.HTTPClient,
	renewURL string,
	payload interface{},
) error {
	headers, err := encodeSignatureHeaders(httpClient, payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", renewURL, bytes.NewReader(nil))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("renewal status %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func encodeSignatureHeaders(httpClient *x402http.HTTPClient, payload interface{}) (map[string]string, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return httpClient.EncodePaymentSignatureHeader(payloadBytes)
}

// tryRecoverFromCorrective402 reads PAYMENT-REQUIRED (or JSON body fallback)
// and lets the batched scheme reconcile session state. Returns true if a retry
// is warranted.
func tryRecoverFromCorrective402(scheme *batchedclient.BatchedEvmScheme, resp *http.Response) bool {
	body, _ := io.ReadAll(resp.Body)
	headerMap := flattenHeaders(resp.Header)

	var req x402.PaymentRequired
	if h, ok := headerMap["PAYMENT-REQUIRED"]; ok && h != "" {
		decoded, err := base64.StdEncoding.DecodeString(h)
		if err != nil {
			return false
		}
		if json.Unmarshal(decoded, &req) != nil {
			return false
		}
	} else if len(body) > 0 {
		if json.Unmarshal(body, &req) != nil {
			return false
		}
		if req.X402Version == 0 {
			return false
		}
	} else {
		return false
	}

	ok, err := scheme.ProcessCorrectivePaymentRequired(context.Background(), "", req.Accepts)
	if err != nil {
		return false
	}
	return ok
}

func decodePaymentResponseHeader(header string) (*x402.SettleResponse, error) {
	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, err
	}
	var resp x402.SettleResponse
	if err := json.Unmarshal(decoded, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// SSEEvent is a single Server-Sent Event.
type SSEEvent struct {
	Event string
	Data  string
}

// parseSSE returns a channel of SSE events parsed from the given reader. The
// channel is closed when the reader returns EOF.
func parseSSE(r io.Reader) <-chan SSEEvent {
	out := make(chan SSEEvent, 4)
	go func() {
		defer close(out)
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		var event, data string
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if event != "" || data != "" {
					if event == "" {
						event = "message"
					}
					out <- SSEEvent{Event: event, Data: data}
					event = ""
					data = ""
				}
				continue
			}
			switch {
			case strings.HasPrefix(line, "event: "):
				event = strings.TrimSpace(line[7:])
			case strings.HasPrefix(line, "data: "):
				data = line[6:]
			}
		}
		if event != "" || data != "" {
			if event == "" {
				event = "message"
			}
			out <- SSEEvent{Event: event, Data: data}
		}
	}()
	return out
}

func flattenHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		if len(v) > 0 {
			out[strings.ToUpper(k)] = v[0]
		}
	}
	return out
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func isTruthyEnvFlag(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
