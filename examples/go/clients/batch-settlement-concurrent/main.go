package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	batchedclient "github.com/x402-foundation/x402/go/mechanisms/evm/batched/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

// Concurrent batch-settlement demo. Opens N independent channels (unique salts)
// and fires one request per channel per round in parallel. The server serialises
// per-channel, not globally, so concurrent slots make progress independently.
func main() {
	_ = godotenv.Load()

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	baseURL := envOr("RESOURCE_SERVER_URL", "http://localhost:4021")
	endpointPath := envOr("ENDPOINT_PATH", "/api/generate")
	url := baseURL + endpointPath

	baseSalt := envOr("CHANNEL_SALT", batchedclient.DefaultSalt)
	storageDir := os.Getenv("STORAGE_DIR")
	concurrency := atoiOr("CONCURRENCY", 3)
	numberOfChannels := atoiOr("NUMBER_OF_CHANNELS", 3)

	signer, err := evmsigners.NewClientSignerFromPrivateKey(evmPrivateKey)
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

	fmt.Printf("Base URL: %s, endpoint: %s\n", baseURL, endpointPath)
	fmt.Printf("payer: %s\n", signer.Address())
	if voucherSigner != nil {
		fmt.Printf("payerAuthorizer: %s\n", voucherSigner.Address())
	} else {
		fmt.Printf("payerAuthorizer: %s\n", signer.Address())
	}
	fmt.Printf("Concurrency: %d channels\n\n", concurrency)

	type channel struct {
		index      int
		salt       string
		httpClient *http.Client
	}

	channels := make([]channel, concurrency)
	for i := 0; i < concurrency; i++ {
		salt := saltAdd(baseSalt, i)
		cfg := &batchedclient.BatchedEvmSchemeConfig{
			MaxDeposit:        "1000000",
			DepositMultiplier: 5,
			Salt:              salt,
		}
		if voucherSigner != nil {
			cfg.VoucherSigner = voucherSigner
		}
		if storageDir != "" {
			cfg.Storage = batchedclient.NewFileClientChannelStorage(batched.FileChannelStorageOptions{
				Directory: storageDir,
			})
		}
		scheme := batchedclient.NewBatchedEvmScheme(signer, cfg)
		x402Client := x402.Newx402Client()
		x402Client.Register("eip155:*", scheme)
		client := x402http.WrapHTTPClientWithPayment(http.DefaultClient, x402http.Newx402HTTPClient(x402Client))
		channels[i] = channel{index: i, salt: salt, httpClient: client}
	}

	fmt.Println("Channels:")
	for _, ch := range channels {
		fmt.Printf("  [%d] salt %s\n", ch.index, ch.salt)
	}
	fmt.Println()

	type result struct {
		index   int
		body    interface{}
		settle  *map[string]interface{}
		err     error
		elapsed time.Duration
	}

	totalT0 := time.Now()
	for round := 0; round < numberOfChannels; round++ {
		roundT0 := time.Now()
		results := make([]result, concurrency)
		var wg sync.WaitGroup
		for i, ch := range channels {
			wg.Add(1)
			go func(idx int, c channel) {
				defer wg.Done()
				reqT0 := time.Now()
				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				defer cancel()
				req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
				resp, err := c.httpClient.Do(req)
				elapsed := time.Since(reqT0)
				if err != nil {
					results[idx] = result{index: c.index, err: err, elapsed: elapsed}
					return
				}
				defer resp.Body.Close()
				body, _ := readJSON(resp)
				settle, _ := extractSettleResponse(resp)
				results[idx] = result{index: c.index, body: body, settle: settle, elapsed: elapsed}
			}(i, ch)
		}
		wg.Wait()
		roundElapsed := time.Since(roundT0)

		fmt.Printf("── Round %d/%d — %.3fs ──\n", round+1, numberOfChannels, roundElapsed.Seconds())
		for _, r := range results {
			tag := fmt.Sprintf("  [ch %d]", r.index)
			if r.err != nil {
				fmt.Printf("%s %.3fs — ERROR: %v\n", tag, r.elapsed.Seconds(), r.err)
				continue
			}
			b, _ := json.Marshal(r.body)
			fmt.Printf("%s %.3fs — %s\n", tag, r.elapsed.Seconds(), string(b))
		}
		fmt.Println()
	}
	totalElapsed := time.Since(totalT0)
	fmt.Printf("%d rounds × %d channels = %d requests in %.3fs\n",
		numberOfChannels, concurrency, numberOfChannels*concurrency, totalElapsed.Seconds())
}

// saltAdd derives a unique salt by adding offset (BigInt) to base 32-byte hex.
func saltAdd(base string, offset int) string {
	hex := strings.TrimPrefix(base, "0x")
	n, ok := new(big.Int).SetString(hex, 16)
	if !ok {
		n = new(big.Int)
	}
	n.Add(n, big.NewInt(int64(offset)))
	return "0x" + fmt.Sprintf("%064x", n)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func atoiOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
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

func extractSettleResponse(resp *http.Response) (*map[string]interface{}, error) {
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
	var out map[string]interface{}
	if err := json.Unmarshal(decoded, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
