package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/signinwithx"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	exactevmclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	exactsvmclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/client"
	evmsigner "github.com/x402-foundation/x402/go/v2/signers/evm"
	svmsigner "github.com/x402-foundation/x402/go/v2/signers/svm"
)

type solanaSIWXSigner struct {
	signer *svmsigner.ClientSigner
}

func (s *solanaSIWXSigner) Address() string {
	return s.signer.Address().String()
}

func (s *solanaSIWXSigner) SignMessage(ctx context.Context, message string) (string, error) {
	return s.signer.SignMessage(ctx, message)
}

func main() {
	_ = godotenv.Load()

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	svmPrivateKey := os.Getenv("SVM_PRIVATE_KEY")
	if evmPrivateKey == "" && svmPrivateKey == "" {
		log.Fatal("EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
	}

	baseURL := strings.TrimRight(os.Getenv("RESOURCE_SERVER_URL"), "/")
	if baseURL == "" {
		baseURL = "http://localhost:4021"
	}

	client := x402.Newx402Client()
	var evmSIWXSigner signinwithx.Signer
	var svmSIWXSigner signinwithx.Signer

	if evmPrivateKey != "" {
		evmSigner, err := evmsigner.NewClientSignerFromPrivateKey(evmPrivateKey)
		if err != nil {
			log.Fatalf("create EVM signer: %v", err)
		}
		siwxSigner, ok := evmSigner.(signinwithx.EVMSigner)
		if !ok {
			log.Fatal("EVM signer does not support SIWX message signing")
		}
		client.Register("eip155:*", exactevmclient.NewExactEvmScheme(evmSigner, nil))
		evmSIWXSigner = signinwithx.NewEVMSIWXSigner(siwxSigner)
		fmt.Printf("Client EVM address: %s\n", evmSigner.Address())
	}

	if svmPrivateKey != "" {
		svmSigner, err := svmsigner.NewClientSignerFromPrivateKey(svmPrivateKey)
		if err != nil {
			log.Fatalf("create SVM signer: %v", err)
		}
		clientSigner, ok := svmSigner.(*svmsigner.ClientSigner)
		if !ok {
			log.Fatal("SVM signer does not support SIWX message signing")
		}
		client.Register("solana:*", exactsvmclient.NewExactSvmScheme(svmSigner))
		svmSIWXSigner = signinwithx.NewSolanaSIWXSigner(&solanaSIWXSigner{signer: clientSigner})
		fmt.Printf("Client SVM address: %s\n", clientSigner.Address())
	}

	client.RegisterExtension(signinwithx.CreateClientExtensionWithSigners(evmSIWXSigner, svmSIWXSigner))
	httpClient := x402http.Newx402HTTPClient(client)
	wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	fmt.Printf("Server: %s\n", baseURL)

	demonstrateAuthOnly(wrappedClient, baseURL)
	demonstrateResource(wrappedClient, httpClient, baseURL, "/weather")
	time.Sleep(300 * time.Millisecond)
	demonstrateResource(wrappedClient, httpClient, baseURL, "/joke")

	fmt.Println("\nDone. /profile used auth-only SIWX. /weather and /joke used payment + SIWX.")
}

func demonstrateAuthOnly(client *http.Client, baseURL string) {
	fmt.Println("\n--- /profile (auth-only, no payment) ---")
	resp, body, err := doJSONRequest(client, baseURL+"/profile")
	if err != nil {
		log.Fatalf("profile request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		fmt.Println("   Authenticated via SIWX (no payment required)")
		fmt.Printf("   Response: %s\n", body)
		return
	}
	fmt.Printf("   Auth failed: status=%d body=%s\n", resp.StatusCode, body)
}

func demonstrateResource(client *http.Client, httpClient *x402http.HTTPClient, baseURL string, path string) {
	url := baseURL + path
	fmt.Printf("\n--- %s ---\n", path)

	fmt.Println("1. First request...")
	resp1, body1, err := doJSONRequest(client, url)
	if err != nil {
		log.Fatalf("%s first request failed: %v", path, err)
	}
	logPaymentResponse(httpClient, resp1)
	printResponse(resp1, body1)
	resp1.Body.Close()

	fmt.Println("2. Second request...")
	resp2, body2, err := doJSONRequest(client, url)
	if err != nil {
		log.Fatalf("%s second request failed: %v", path, err)
	}
	hasPayment := logPaymentResponse(httpClient, resp2)
	if resp2.StatusCode >= 200 && resp2.StatusCode < 300 && !hasPayment {
		fmt.Println("   Authenticated via SIWX (previously paid)")
	}
	printResponse(resp2, body2)
	resp2.Body.Close()
}

func doJSONRequest(client *http.Client, url string) (*http.Response, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		resp.Body.Close()
		return nil, "", err
	}
	resp.Body = io.NopCloser(strings.NewReader(string(bodyBytes)))

	var body interface{}
	if err := json.Unmarshal(bodyBytes, &body); err != nil {
		return resp, string(bodyBytes), nil
	}
	pretty, err := json.MarshalIndent(body, "   ", "  ")
	if err != nil {
		return resp, string(bodyBytes), nil
	}
	return resp, string(pretty), nil
}

func logPaymentResponse(client *x402http.HTTPClient, resp *http.Response) bool {
	settle, err := client.GetPaymentSettleResponse(headerMap(resp.Header))
	if err != nil || settle == nil {
		return false
	}
	fmt.Println("   Paid via payment settlement")
	if details, err := json.MarshalIndent(settle, "   ", "  "); err == nil {
		fmt.Printf("   Payment details: %s\n", details)
	}
	return true
}

func printResponse(resp *http.Response, body string) {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		fmt.Printf("   Response: %s\n", body)
		return
	}
	fmt.Printf("   Request failed: status=%d body=%s\n", resp.StatusCode, body)
}

func headerMap(headers http.Header) map[string]string {
	result := make(map[string]string, len(headers))
	for key, values := range headers {
		if len(values) > 0 {
			result[key] = values[0]
		}
	}
	return result
}
