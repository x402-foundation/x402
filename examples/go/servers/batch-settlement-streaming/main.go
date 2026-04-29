package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	batchedserver "github.com/x402-foundation/x402/go/mechanisms/evm/batched/server"
	"github.com/x402-foundation/x402/go/types"
)

// Streaming batch-settlement server. Streams LLM-style tokens as SSE while
// requesting voucher renewals from the client mid-stream.
//
// Mirrors `examples/typescript/servers/batch-settlement-streaming/index.ts`.
//
// Routes:
//   GET  /llm/stream                  — SSE stream gated by batch-settlement payment
//   POST /x402/voucher/{channelId}    — voucher renewal side-channel

const (
	defaultPort   = "4021"
	network       = x402.Network("eip155:84532")
	pricePerChunk = "$0.001"
)

func main() {
	_ = godotenv.Load()

	verboseFlag := flag.Bool("verbose", false, "verbose voucher logging")
	flag.BoolVar(verboseFlag, "v", false, "alias for --verbose")
	flag.Parse()
	verbose := *verboseFlag || isTruthyEnvFlag(os.Getenv("VERBOSE"))

	evmAddress := os.Getenv("EVM_ADDRESS")
	if !regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`).MatchString(evmAddress) {
		fmt.Println("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)")
		os.Exit(1)
	}
	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("Missing required FACILITATOR_URL environment variable")
		os.Exit(1)
	}

	chunkSize := atoiOr("CHUNK_SIZE", 100)
	if chunkSize <= 0 {
		fmt.Println("CHUNK_SIZE must be a positive integer")
		os.Exit(1)
	}

	withdrawDelay := batched.MinWithdrawDelay
	if v := os.Getenv("DEFERRED_WITHDRAW_DELAY_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			withdrawDelay = n
		}
	}

	cfg := &batchedserver.BatchedEvmSchemeConfig{WithdrawDelay: withdrawDelay}
	if storageDir := os.Getenv("STORAGE_DIR"); storageDir != "" {
		cfg.Storage = batchedserver.NewFileChannelStorage(batched.FileChannelStorageOptions{
			Directory: storageDir,
		})
	}
	if key := os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"); key != "" {
		signer, err := newReceiverAuthorizerSigner(key)
		if err != nil {
			fmt.Printf("Invalid EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
			os.Exit(1)
		}
		cfg.ReceiverAuthorizerSigner = signer
	}

	scheme := batchedserver.NewBatchedEvmScheme(evmAddress, cfg)
	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{URL: facilitatorURL})

	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitator),
		x402.WithSchemeServer(network, scheme),
	)
	if err := resourceServer.Initialize(context.Background()); err != nil {
		fmt.Printf("Failed to initialize resource server: %v\n", err)
		os.Exit(1)
	}

	// Resolve chunk price into atomic units once at startup.
	chunkAssetAmount, err := scheme.ParsePrice(pricePerChunk, network)
	if err != nil {
		fmt.Printf("Failed to parse chunk price: %v\n", err)
		os.Exit(1)
	}
	chunkAmountAtomic := chunkAssetAmount.Amount

	resourceConfig := x402.ResourceConfig{
		Scheme:  batched.SchemeBatched,
		PayTo:   evmAddress,
		Price:   pricePerChunk,
		Network: network,
	}
	supportedKind := types.SupportedKind{
		X402Version: 2,
		Scheme:      batched.SchemeBatched,
		Network:     string(network),
	}

	pendingVouchers := newVoucherRegistry()
	streamSrv := &streamServer{
		scheme:            scheme,
		resourceServer:    resourceServer,
		resourceConfig:    resourceConfig,
		supportedKind:     supportedKind,
		chunkSize:         chunkSize,
		chunkAmountAtomic: chunkAmountAtomic,
		pendingVouchers:   pendingVouchers,
		verbose:           verbose,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /llm/stream", streamSrv.handleStream)
	mux.HandleFunc("POST /x402/voucher/{channelId}", streamSrv.handleVoucherPost)

	fmt.Printf("Batch-settlement streaming server listening at http://localhost:%s\n", defaultPort)
	fmt.Println("  GET  /llm/stream          — SSE endpoint")
	fmt.Println("  POST /x402/voucher/:id    — voucher renewal side-channel")
	fmt.Printf("  Chunk size:  %d tokens\n", chunkSize)
	fmt.Printf("  Chunk price: %s (%s atomic)\n", pricePerChunk, chunkAmountAtomic)
	if cfg.ReceiverAuthorizerSigner != nil {
		fmt.Printf("  Receiver authorizer: local signer %s\n", cfg.ReceiverAuthorizerSigner.Address())
	} else {
		fmt.Println("  Receiver authorizer: facilitator")
	}

	server := &http.Server{Addr: ":" + defaultPort, Handler: mux}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("Server error: %v\n", err)
			os.Exit(1)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

// streamServer captures dependencies and per-server config.
type streamServer struct {
	scheme            *batchedserver.BatchedEvmScheme
	resourceServer    *x402.X402ResourceServer
	resourceConfig    x402.ResourceConfig
	supportedKind     types.SupportedKind
	chunkSize         int
	chunkAmountAtomic string
	pendingVouchers   *voucherRegistry
	verbose           bool
}

func (s *streamServer) logVerbose(format string, args ...interface{}) {
	if !s.verbose {
		return
	}
	fmt.Printf(format+"\n", args...)
}

// handleStream is the GET /llm/stream handler.
func (s *streamServer) handleStream(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	requirements, err := s.resourceServer.BuildPaymentRequirements(ctx, s.resourceConfig, s.supportedKind, nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	resourceInfo := &types.ResourceInfo{
		URL:         "/llm/stream",
		Description: "SSE LLM stream",
		MimeType:    "text/event-stream",
	}

	paymentHeader := r.Header.Get("PAYMENT-SIGNATURE")
	if paymentHeader == "" {
		s.logVerbose("\033[31m[payment-required]\033[0m %s", r.URL.RequestURI())
		s.writePaymentRequired(w, []types.PaymentRequirements{requirements}, resourceInfo, "")
		return
	}

	payload, err := decodePaymentSignatureHeader(paymentHeader)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Malformed PAYMENT-SIGNATURE header"})
		return
	}
	matched := s.resourceServer.FindMatchingRequirements([]types.PaymentRequirements{requirements}, *payload)
	if matched == nil {
		writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": "No matching payment requirements"})
		return
	}

	requestChannelId, _ := getChannelIdFromPayload(payload)
	requestStartCharged := "0"
	if requestChannelId != "" {
		if session, _ := s.scheme.GetStorage().Get(requestChannelId); session != nil {
			requestStartCharged = session.ChargedCumulativeAmount
		}
	}

	verifyResult, err := s.resourceServer.VerifyPayment(ctx, *payload, *matched)
	if err != nil || verifyResult == nil || !verifyResult.IsValid {
		reason := ""
		if verifyResult != nil {
			reason = verifyResult.InvalidReason
		}
		s.writePaymentRequired(w, []types.PaymentRequirements{*matched}, resourceInfo, reason)
		return
	}

	isDeposit := batched.IsDepositPayload(payload.Payload)
	firstChunkSettled := false
	var trailingSettleResponse *x402.SettleResponse

	s.logVerbose("\033[32m[payment-accepted]\033[0m channel=%s kind=%s",
		formatChannelId(requestChannelId), depositKind(isDeposit))

	if isDeposit {
		settleResult, err := s.resourceServer.SettlePayment(ctx, *payload, *matched, nil)
		if err != nil || settleResult == nil || !settleResult.Success {
			writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": "Deposit settlement failed"})
			return
		}
		trailingSettleResponse = settleResult
		firstChunkSettled = true
	}

	channelId, currentPayload, err := toVoucherPayload(payload, matched)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	currentRequirements := *matched

	// Begin SSE.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Trailer", "PAYMENT-RESPONSE")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	tokenIndex := 0
	chunkTokenCount := 0
	prompt := r.URL.Query().Get("prompt")
	if prompt == "" {
		prompt = "Tell me a fun fact about payments."
	}

	streamErr := func() error {
		for token := range tokenStream(ctx, prompt) {
			sseWrite(w, flusher, "data", map[string]interface{}{
				"token": token, "index": tokenIndex,
			})
			tokenIndex++
			chunkTokenCount++

			if chunkTokenCount < s.chunkSize {
				continue
			}

			// Chunk complete: settle this chunk and request voucher renewal.
			var chargedCumulativeAmount, balance string
			if firstChunkSettled {
				session, _ := s.scheme.GetStorage().Get(channelId)
				if session != nil {
					chargedCumulativeAmount = session.ChargedCumulativeAmount
					balance = session.Balance
				} else {
					chargedCumulativeAmount = s.chunkAmountAtomic
					balance = "0"
				}
				firstChunkSettled = false
			} else {
				settleResult, err := s.resourceServer.SettlePayment(ctx, currentPayload, currentRequirements,
					&x402.SettlementOverrides{Amount: s.chunkAmountAtomic})
				if err != nil || settleResult == nil || !settleResult.Success {
					return fmt.Errorf("chunk settle failed: %v", err)
				}
				trailingSettleResponse = settleResult
				chargedCumulativeAmount = stringFromExtra(settleResult.Extra, "chargedCumulativeAmount", "0")
				balance = stringFromExtra(settleResult.Extra, "balance", "0")
			}

			nextMaxClaimable := bigIntAddString(chargedCumulativeAmount, s.chunkAmountAtomic)
			voucherEndpoint := "/x402/voucher/" + channelId

			s.logVerbose("\033[31m[voucher-requested]\033[0m channel=%s charged=%s next=%s",
				formatChannelId(channelId), chargedCumulativeAmount, nextMaxClaimable)
			sseWrite(w, flusher, "x402-voucher-needed", map[string]interface{}{
				"channelId":               channelId,
				"chargedCumulativeAmount": chargedCumulativeAmount,
				"balance":                 balance,
				"nextMaxClaimableAmount":  nextMaxClaimable,
				"voucherEndpoint":         voucherEndpoint,
			})

			newPayload, err := s.pendingVouchers.wait(ctx, channelId, 30*time.Second)
			if err != nil {
				return fmt.Errorf("voucher wait: %w", err)
			}

			newRequirements := s.resourceServer.FindMatchingRequirements(
				[]types.PaymentRequirements{requirements}, *newPayload)
			if newRequirements == nil {
				sseWrite(w, flusher, "x402-error", map[string]string{
					"code": "requirements_mismatch", "message": "No match",
				})
				return nil
			}
			newVerify, err := s.resourceServer.VerifyPayment(ctx, *newPayload, *newRequirements)
			if err != nil || newVerify == nil || !newVerify.IsValid {
				reason := "Voucher verification failed"
				if newVerify != nil && newVerify.InvalidReason != "" {
					reason = newVerify.InvalidReason
				}
				sseWrite(w, flusher, "x402-error", map[string]string{
					"code": "voucher_invalid", "message": reason,
				})
				return nil
			}

			acceptedCharged := chargedCumulativeAmount
			acceptedBalance := stringFromExtra(newVerify.Extra, "balance", "0")

			if batched.IsDepositPayload(newPayload.Payload) {
				renewalSettle, err := s.resourceServer.SettlePayment(ctx, *newPayload, *newRequirements, nil)
				if err != nil || renewalSettle == nil || !renewalSettle.Success {
					sseWrite(w, flusher, "x402-error", map[string]string{
						"code": "deposit_settlement_failed", "message": "Renewal deposit settlement failed",
					})
					return nil
				}
				trailingSettleResponse = renewalSettle
				newChannelId, renewedPayload, err := toVoucherPayload(newPayload, newRequirements)
				if err != nil {
					return err
				}
				channelId = newChannelId
				currentPayload = renewedPayload
				currentRequirements = *newRequirements
				firstChunkSettled = true
				acceptedCharged = stringFromExtra(renewalSettle.Extra, "chargedCumulativeAmount", acceptedCharged)
				acceptedBalance = stringFromExtra(renewalSettle.Extra, "balance", acceptedBalance)
			} else {
				currentPayload = *newPayload
				currentRequirements = *newRequirements
			}

			signedMaxClaimable, toppedUp := acceptedRenewalSignedMax(newPayload)
			sseWrite(w, flusher, "x402-voucher-accepted", map[string]interface{}{
				"channelId":                  channelId,
				"newChargedCumulativeAmount": acceptedCharged,
				"balance":                    acceptedBalance,
				"signedMaxClaimable":         signedMaxClaimable,
				"toppedUp":                   toppedUp,
			})
			s.logVerbose("\033[32m[voucher-accepted]\033[0m channel=%s signed=%s topped=%v",
				formatChannelId(channelId), signedMaxClaimable, toppedUp)

			chunkTokenCount = 0
		}

		// Stream complete — settle any partial chunk.
		if chunkTokenCount > 0 && !firstChunkSettled {
			partialAmount := chunkChargeAmount(chunkTokenCount, s.chunkSize, s.chunkAmountAtomic)
			finalSettle, err := s.resourceServer.SettlePayment(ctx, currentPayload, currentRequirements,
				&x402.SettlementOverrides{Amount: partialAmount})
			if err == nil && finalSettle != nil && finalSettle.Success {
				trailingSettleResponse = finalSettle
				charged := stringFromExtra(finalSettle.Extra, "chargedCumulativeAmount", "0")
				signed := stringFromExtra(finalSettle.Extra, "signedMaxClaimable", voucherMaxClaimableFallback(currentPayload))
				sseWrite(w, flusher, "x402-settlement", map[string]interface{}{
					"channelId":               channelId,
					"chargedCumulativeAmount": charged,
					"signedMaxClaimable":      signed,
				})
			}
		} else if firstChunkSettled {
			session, _ := s.scheme.GetStorage().Get(channelId)
			charged, signed := "0", "0"
			if session != nil {
				charged = session.ChargedCumulativeAmount
				signed = session.SignedMaxClaimable
			}
			sseWrite(w, flusher, "x402-settlement", map[string]interface{}{
				"channelId":               channelId,
				"chargedCumulativeAmount": charged,
				"signedMaxClaimable":      signed,
			})
		}

		sseWrite(w, flusher, "done", map[string]interface{}{})
		return nil
	}()

	if streamErr != nil {
		s.logVerbose("[stream-error] channel=%s message=%s", formatChannelId(channelId), streamErr.Error())
		sseWrite(w, flusher, "x402-error", map[string]string{
			"code": "stream_error", "message": streamErr.Error(),
		})
	}

	s.pendingVouchers.cancel(channelId)

	if trailingSettleResponse != nil {
		final := buildFinalPaymentResponse(s.scheme, trailingSettleResponse, channelId, requestStartCharged)
		encoded, err := encodePaymentResponseHeader(final)
		if err == nil {
			w.Header().Set("PAYMENT-RESPONSE", encoded)
		}
		s.logVerbose("[payment-response] channel=%s amount=%s",
			formatChannelId(channelId), final.Amount)
	}
}

// handleVoucherPost is the POST /x402/voucher/{channelId} side-channel handler.
func (s *streamServer) handleVoucherPost(w http.ResponseWriter, r *http.Request) {
	channelId := r.PathValue("channelId")
	if channelId == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing channelId"})
		return
	}
	paymentHeader := r.Header.Get("PAYMENT-SIGNATURE")
	if paymentHeader == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing PAYMENT-SIGNATURE header"})
		return
	}
	payload, err := decodePaymentSignatureHeader(paymentHeader)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Malformed PAYMENT-SIGNATURE header"})
		return
	}
	if !s.pendingVouchers.deliver(channelId, payload) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "No pending voucher request for this channel"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// writePaymentRequired writes a 402 with PAYMENT-REQUIRED header + JSON body.
func (s *streamServer) writePaymentRequired(
	w http.ResponseWriter,
	requirements []types.PaymentRequirements,
	resourceInfo *types.ResourceInfo,
	errorMsg string,
) {
	pr := s.resourceServer.CreatePaymentRequiredResponse(requirements, resourceInfo, errorMsg, nil)
	encoded, err := encodePaymentRequiredHeader(pr)
	if err == nil {
		w.Header().Set("PAYMENT-REQUIRED", encoded)
	}
	writeJSON(w, http.StatusPaymentRequired, pr)
}

// ---------------------------------------------------------------------------
// SSE / token stream
// ---------------------------------------------------------------------------

func sseWrite(w io.Writer, flusher http.Flusher, event string, data interface{}) {
	b, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(b))
	if flusher != nil {
		flusher.Flush()
	}
}

// tokenStream yields a simulated word stream. Mirrors the TS server's fallback
// behaviour (the TS variant also supports OpenAI; we keep it simulated here).
func tokenStream(ctx context.Context, prompt string) <-chan string {
	out := make(chan string)
	go func() {
		defer close(out)
		_ = prompt // not used by the simulated stream
		words := strings.Fields(strings.Repeat("The quick brown fox jumps over the lazy dog. ", 30))
		for _, w := range words {
			select {
			case <-ctx.Done():
				return
			case <-time.After(20 * time.Millisecond):
			}
			select {
			case <-ctx.Done():
				return
			case out <- w + " ":
			}
		}
	}()
	return out
}

// ---------------------------------------------------------------------------
// Voucher registry — channelId → pending resolver
// ---------------------------------------------------------------------------

type voucherRegistry struct {
	mu      sync.Mutex
	pending map[string]chan *types.PaymentPayload
}

func newVoucherRegistry() *voucherRegistry {
	return &voucherRegistry{pending: make(map[string]chan *types.PaymentPayload)}
}

func (r *voucherRegistry) wait(ctx context.Context, channelId string, timeout time.Duration) (*types.PaymentPayload, error) {
	ch := make(chan *types.PaymentPayload, 1)
	r.mu.Lock()
	r.pending[channelId] = ch
	r.mu.Unlock()
	defer r.cancel(channelId)

	select {
	case payload := <-ch:
		if payload == nil {
			return nil, fmt.Errorf("voucher wait cancelled")
		}
		return payload, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("voucher renewal timed out")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (r *voucherRegistry) deliver(channelId string, payload *types.PaymentPayload) bool {
	r.mu.Lock()
	ch, ok := r.pending[channelId]
	if ok {
		delete(r.pending, channelId)
	}
	r.mu.Unlock()
	if !ok {
		return false
	}
	ch <- payload
	return true
}

func (r *voucherRegistry) cancel(channelId string) {
	r.mu.Lock()
	ch, ok := r.pending[channelId]
	if ok {
		delete(r.pending, channelId)
	}
	r.mu.Unlock()
	if ok {
		close(ch)
	}
}

// ---------------------------------------------------------------------------
// Header encode/decode
// ---------------------------------------------------------------------------

func encodePaymentRequiredHeader(pr types.PaymentRequired) (string, error) {
	b, err := json.Marshal(pr)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

func encodePaymentResponseHeader(resp *x402.SettleResponse) (string, error) {
	b, err := json.Marshal(resp)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

func decodePaymentSignatureHeader(header string) (*types.PaymentPayload, error) {
	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, err
	}
	var payload types.PaymentPayload
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

// ---------------------------------------------------------------------------
// Batched-payload helpers
// ---------------------------------------------------------------------------

// getChannelIdFromPayload extracts the channel id from a deposit or voucher payload.
func getChannelIdFromPayload(p *types.PaymentPayload) (string, bool) {
	raw := p.Payload
	if batched.IsVoucherPayload(raw) {
		if id, ok := raw["channelId"].(string); ok {
			return id, true
		}
		return "", false
	}
	if !batched.IsDepositPayload(raw) {
		return "", false
	}
	voucher, ok := raw["voucher"].(map[string]interface{})
	if !ok {
		return "", false
	}
	id, ok := voucher["channelId"].(string)
	return id, ok
}

// toVoucherPayload normalizes a deposit payload to its underlying voucher form for
// subsequent settlement; voucher payloads are returned unchanged.
func toVoucherPayload(p *types.PaymentPayload, requirements *types.PaymentRequirements) (string, types.PaymentPayload, error) {
	raw := p.Payload
	if !batched.IsDepositPayload(raw) {
		id, _ := raw["channelId"].(string)
		return id, *p, nil
	}
	voucher, _ := raw["voucher"].(map[string]interface{})
	deposit, _ := raw["deposit"].(map[string]interface{})
	if voucher == nil || deposit == nil {
		return "", types.PaymentPayload{}, fmt.Errorf("malformed deposit payload")
	}
	channelId, _ := voucher["channelId"].(string)
	voucherPayload := types.PaymentPayload{
		X402Version: p.X402Version,
		Accepted:    *requirements,
		Payload: map[string]interface{}{
			"type":               "voucher",
			"channelConfig":      deposit["channelConfig"],
			"channelId":          voucher["channelId"],
			"maxClaimableAmount": voucher["maxClaimableAmount"],
			"signature":          voucher["signature"],
		},
	}
	return channelId, voucherPayload, nil
}

func acceptedRenewalSignedMax(p *types.PaymentPayload) (string, bool) {
	raw := p.Payload
	if batched.IsDepositPayload(raw) {
		voucher, _ := raw["voucher"].(map[string]interface{})
		signed, _ := voucher["maxClaimableAmount"].(string)
		return signed, true
	}
	signed, _ := raw["maxClaimableAmount"].(string)
	return signed, false
}

func voucherMaxClaimableFallback(p types.PaymentPayload) string {
	if !batched.IsVoucherPayload(p.Payload) {
		return "0"
	}
	if signed, ok := p.Payload["maxClaimableAmount"].(string); ok {
		return signed
	}
	return "0"
}

// buildFinalPaymentResponse augments the trailing settle response with totals
// for the request lifetime.
func buildFinalPaymentResponse(
	scheme *batchedserver.BatchedEvmScheme,
	resp *x402.SettleResponse,
	channelId string,
	requestStartCharged string,
) *x402.SettleResponse {
	if channelId == "" {
		return resp
	}
	session, _ := scheme.GetStorage().Get(channelId)
	if session == nil {
		return resp
	}
	totalAmount := bigIntSubString(session.ChargedCumulativeAmount, requestStartCharged)
	out := *resp
	out.Amount = totalAmount
	extra := map[string]interface{}{}
	for k, v := range resp.Extra {
		extra[k] = v
	}
	extra["channelId"] = channelId
	extra["chargedCumulativeAmount"] = session.ChargedCumulativeAmount
	extra["balance"] = session.Balance
	extra["totalClaimed"] = session.TotalClaimed
	extra["withdrawRequestedAt"] = session.WithdrawRequestedAt
	out.Extra = extra
	return &out
}

// ---------------------------------------------------------------------------
// Numeric / formatting helpers
// ---------------------------------------------------------------------------

func chunkChargeAmount(tokenCount, chunkSize int, chunkAmountAtomic string) string {
	if tokenCount <= 0 {
		return "0"
	}
	if tokenCount >= chunkSize {
		return chunkAmountAtomic
	}
	chunkAmt, ok := new(big.Int).SetString(chunkAmountAtomic, 10)
	if !ok {
		return "0"
	}
	chunkAmt.Mul(chunkAmt, big.NewInt(int64(tokenCount)))
	chunkAmt.Quo(chunkAmt, big.NewInt(int64(chunkSize)))
	return chunkAmt.String()
}

func bigIntAddString(a, b string) string {
	x, _ := new(big.Int).SetString(a, 10)
	y, _ := new(big.Int).SetString(b, 10)
	if x == nil {
		x = new(big.Int)
	}
	if y == nil {
		y = new(big.Int)
	}
	return new(big.Int).Add(x, y).String()
}

func bigIntSubString(a, b string) string {
	x, _ := new(big.Int).SetString(a, 10)
	y, _ := new(big.Int).SetString(b, 10)
	if x == nil {
		x = new(big.Int)
	}
	if y == nil {
		y = new(big.Int)
	}
	return new(big.Int).Sub(x, y).String()
}

func stringFromExtra(extra map[string]interface{}, key, fallback string) string {
	if extra == nil {
		return fallback
	}
	v, ok := extra[key]
	if !ok {
		return fallback
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fallback
}

func formatChannelId(id string) string {
	if id == "" {
		return "unknown"
	}
	if len(id) <= 14 {
		return id
	}
	return id[:6] + " ... " + id[len(id)-5:]
}

func depositKind(isDeposit bool) string {
	if isDeposit {
		return "deposit"
	}
	return "voucher"
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func atoiOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
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
