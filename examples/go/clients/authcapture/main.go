// Package main is a minimal x402 client that pays with the authCapture scheme.
//
// It first probes the endpoint (raw GET) to surface any 402 payment requirements,
// logs them with validation notes, then retries through the x402-aware HTTP client
// which signs and attaches the PAYMENT-SIGNATURE header automatically.
//
// Usage:
//
//	cp .env-example .env   # fill in your values
//	go run .
//
// Or pass env vars directly:
//
//	EVM_PRIVATE_KEY=0x... SERVER_URL=https://... go run .
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	authcaptureclient "github.com/x402-foundation/x402/go/mechanisms/evm/authCapture/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

func main() {
	_ = godotenv.Load()

	privateKey := os.Getenv("EVM_PRIVATE_KEY")
	if privateKey == "" {
		fmt.Fprintln(os.Stderr, "error: EVM_PRIVATE_KEY is required")
		os.Exit(1)
	}

	serverURL := os.Getenv("SERVER_URL")
	if serverURL == "" {
		fmt.Fprintln(os.Stderr, "error: SERVER_URL is required")
		os.Exit(1)
	}

	signer, err := evmsigners.NewClientSignerFromPrivateKey(privateKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: invalid EVM_PRIVATE_KEY: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Wallet address: %s\n", signer.Address())
	fmt.Printf("Target URL:     %s\n\n", serverURL)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// ── Step 1: Probe the endpoint to inspect the 402 requirements ───────────
	fmt.Println("━━━ Step 1: Probing endpoint (raw GET, no payment) ━━━")
	raw402, err := probeEndpoint(ctx, serverURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "probe failed: %v\n", err)
		os.Exit(1)
	}

	// ── Step 2: Attempt payment with the x402-aware client ───────────────────
	fmt.Println("\n━━━ Step 2: Paying with authCapture scheme ━━━")

	client := x402.Newx402Client()
	client.Register("eip155:*", authcaptureclient.NewAuthCaptureEvmScheme(signer))

	loggingTransport := &loggingRoundTripper{inner: http.DefaultTransport}
	innerHTTPClient := &http.Client{Transport: loggingTransport}

	httpClient := x402http.WrapHTTPClientWithPayment(
		innerHTTPClient,
		x402http.Newx402HTTPClient(client),
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serverURL, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error building request: %v\n", err)
		os.Exit(1)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		// If the server returned a 402 that the client couldn't satisfy, the
		// wrapped client surfaces a descriptive error here.
		fmt.Fprintf(os.Stderr, "payment request failed: %v\n", err)
		if raw402 != nil {
			fmt.Fprintln(os.Stderr, "(see payment requirements logged above)")
		}
		os.Exit(1)
	}
	defer resp.Body.Close()

	fmt.Printf("Final status: %s\n\n", resp.Status)

	bodyBytes, _ := io.ReadAll(resp.Body)
	var bodyJSON interface{}
	if json.Unmarshal(bodyBytes, &bodyJSON) == nil {
		pretty, _ := json.MarshalIndent(bodyJSON, "", "  ")
		fmt.Println("Response body:")
		fmt.Println(string(pretty))
	} else {
		fmt.Printf("Response body (raw): %s\n", bodyBytes)
	}

	// Decode and display the PAYMENT-RESPONSE header if present
	if ph := resp.Header.Get("PAYMENT-RESPONSE"); ph != "" {
		fmt.Println("\n━━━ Payment Response ━━━")
		decoded, decErr := base64.StdEncoding.DecodeString(ph)
		if decErr == nil {
			var pr interface{}
			if json.Unmarshal(decoded, &pr) == nil {
				pretty, _ := json.MarshalIndent(pr, "", "  ")
				fmt.Println(string(pretty))
			} else {
				fmt.Println(string(decoded))
			}
		} else {
			fmt.Printf("PAYMENT-RESPONSE (raw): %s\n", ph)
		}
	}
}

// paymentRequired is a minimal struct for logging 402 body fields.
type paymentRequired struct {
	X402Version int                      `json:"x402Version"`
	Error       string                   `json:"error"`
	Resource    map[string]interface{}   `json:"resource"`
	Accepts     []map[string]interface{} `json:"accepts"`
	Extensions  map[string]interface{}   `json:"extensions"`
}

// probeEndpoint sends an unauthenticated GET and, if the server responds with
// 402, logs and validates the payment requirements.  Returns the parsed body
// (nil if not a 402).
func probeEndpoint(ctx context.Context, url string) (*paymentRequired, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build probe request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("probe request: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)

	fmt.Printf("Probe status: %s\n", resp.Status)
	fmt.Printf("Response headers:\n")
	for k, v := range resp.Header {
		fmt.Printf("  %s: %s\n", k, v)
	}
	fmt.Printf("Raw body:\n%s\n\n", bodyBytes)

	if resp.StatusCode != http.StatusPaymentRequired {
		fmt.Printf("(non-402 response)\n")
		return nil, nil
	}

	// Prefer the Payment-Required header (base64-encoded JSON) over the error body.
	var pr paymentRequired
	if hdr := resp.Header.Get("Payment-Required"); hdr != "" {
		decoded, decErr := base64.StdEncoding.DecodeString(hdr)
		if decErr == nil {
			if err := json.Unmarshal(decoded, &pr); err != nil {
				fmt.Printf("Payment-Required header (decode error): %v\n", err)
			}
		} else {
			fmt.Printf("Payment-Required header (not base64): %s\n", hdr)
		}
	} else if err := json.Unmarshal(bodyBytes, &pr); err != nil {
		fmt.Printf("402 body (not JSON): %s\n", bodyBytes)
		return nil, nil
	}

	fmt.Printf("x402Version: %d\n", pr.X402Version)
	if pr.Error != "" {
		fmt.Printf("server error: %s\n", pr.Error)
	}
	if pr.Resource != nil {
		if u, ok := pr.Resource["url"]; ok {
			fmt.Printf("resource.url: %s\n", u)
		}
	}

	fmt.Printf("\nPayment requirements (%d offer(s)):\n", len(pr.Accepts))
	for i, req := range pr.Accepts {
		fmt.Printf("\n  [%d] scheme:            %v\n", i, req["scheme"])
		fmt.Printf("      network:           %v\n", req["network"])
		fmt.Printf("      asset:             %v\n", req["asset"])
		fmt.Printf("      amount:            %v\n", req["amount"])
		fmt.Printf("      payTo:             %v\n", req["payTo"])
		fmt.Printf("      maxTimeoutSeconds: %v\n", req["maxTimeoutSeconds"])

		extra, _ := req["extra"].(map[string]interface{})
		if extra != nil {
			fmt.Printf("      extra:\n")
			extraJSON, _ := json.MarshalIndent(extra, "        ", "  ")
			fmt.Printf("        %s\n", extraJSON)

			// ── Validation checks ────────────────────────────────────────────
			fmt.Printf("      validation:\n")
			issues := validateAuthCaptureExtra(req["scheme"], extra)
			if len(issues) == 0 {
				fmt.Printf("        ✓ all required authCapture extra fields present\n")
			} else {
				for _, iss := range issues {
					fmt.Printf("        ✗ %s\n", iss)
				}
			}
		} else {
			fmt.Printf("      extra: (none)\n")
			fmt.Printf("      validation: ✗ missing extra entirely\n")
		}
	}

	if len(pr.Accepts) == 0 {
		fmt.Println("  (no offers — cannot pay)")
	}

	return &pr, nil
}

// loggingRoundTripper logs outgoing request headers (especially PAYMENT-SIGNATURE)
// and response status before forwarding.
type loggingRoundTripper struct {
	inner http.RoundTripper
}

func (l *loggingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	sig := req.Header.Get("PAYMENT-SIGNATURE")
	if sig != "" {
		fmt.Println("\n━━━ Outgoing PAYMENT-SIGNATURE ━━━")
		decoded, err := base64.StdEncoding.DecodeString(sig)
		if err == nil {
			var obj interface{}
			if json.Unmarshal(decoded, &obj) == nil {
				pretty, _ := json.MarshalIndent(obj, "", "  ")
				fmt.Println(string(pretty))
			} else {
				fmt.Println(string(decoded))
			}
		} else {
			fmt.Printf("(raw, not base64): %s\n", sig)
		}
		fmt.Println()
	}
	resp, err := l.inner.RoundTrip(req)
	if resp != nil {
		fmt.Printf("→ server responded: %s\n", resp.Status)
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body = io.NopCloser(strings.NewReader(string(body)))
			fmt.Printf("  error body: %s\n\n", body)
		}
	}
	return resp, err
}

// validateAuthCaptureExtra checks that all required authCapture extra fields
// are present and returns a list of human-readable problems.
func validateAuthCaptureExtra(scheme interface{}, extra map[string]interface{}) []string {
	if scheme != "authCapture" {
		return []string{fmt.Sprintf("scheme is %q (expected authCapture)", scheme)}
	}

	required := []string{
		"captureAuthorizer",
		"captureDeadline",
		"refundDeadline",
		"feeRecipient",
		"minFeeBps",
		"maxFeeBps",
	}

	var issues []string
	for _, field := range required {
		if _, ok := extra[field]; !ok {
			issues = append(issues, fmt.Sprintf("missing field: %s", field))
		}
	}

	// Deadline ordering
	cd, cdOK := extra["captureDeadline"].(float64)
	rd, rdOK := extra["refundDeadline"].(float64)
	if cdOK && rdOK && rd < cd {
		issues = append(issues, fmt.Sprintf(
			"refundDeadline (%v) < captureDeadline (%v) — invalid ordering", rd, cd,
		))
	}

	// EIP-712 domain fields needed for signing
	for _, field := range []string{"name", "version"} {
		if v, ok := extra[field]; !ok || v == "" {
			issues = append(issues, fmt.Sprintf("missing EIP-712 domain field: %s", field))
		}
	}

	return issues
}
