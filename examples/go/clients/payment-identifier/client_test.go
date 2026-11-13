package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/paymentidentifier"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

type hit struct {
	method string
	uri    string
	body   string
	sig    string
	trace  string
}

type recorder struct {
	mu   sync.Mutex
	hits []hit
}

func (r *recorder) add(h hit) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hits = append(r.hits, h)
}

func (r *recorder) snapshot() []hit {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]hit, len(r.hits))
	copy(out, r.hits)
	return out
}

// recordedPayloadContext is what the scheme observed on one CreatePaymentPayload call.
// Fields are copied at the call so later extension enrichment cannot change the record.
type recordedPayloadContext struct {
	maxAmount           string
	paymentIdentifierOK bool
}

type mockExactScheme struct {
	n    atomic.Int64
	mu   sync.Mutex
	seen []recordedPayloadContext
}

func (m *mockExactScheme) Scheme() string { return "exact" }

// CreatePaymentPayload matches current-main SchemeNetworkClient: the third
// argument is PaymentPayloadContext (server extensions and resolved spend cap).
func (m *mockExactScheme) CreatePaymentPayload(_ context.Context, _ x402.PaymentRequirements, payloadCtx x402.PaymentPayloadContext) (x402.PaymentPayload, error) {
	recorded := recordedPayloadContext{maxAmount: payloadCtx.MaxAmountPerPayment}
	if ext, ok := payloadCtx.Extensions[paymentidentifier.PAYMENT_IDENTIFIER]; ok {
		recorded.paymentIdentifierOK = paymentidentifier.IsPaymentIdentifierExtension(ext)
	}
	m.mu.Lock()
	m.seen = append(m.seen, recorded)
	m.mu.Unlock()

	n := m.n.Add(1)
	return x402.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"nonce": n},
	}, nil
}

func (m *mockExactScheme) contexts() []recordedPayloadContext {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]recordedPayloadContext, len(m.seen))
	copy(out, m.seen)
	return out
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func testClient(ext *paymentIdentifierExtension, transport http.RoundTripper) (*http.Client, *mockExactScheme) {
	if ext == nil {
		ext = &paymentIdentifierExtension{}
	}
	scheme := &mockExactScheme{}
	core := x402.Newx402Client().DisableSpendControls().
		Register("eip155:*", scheme).
		RegisterExtension(ext)
	client := x402http.WrapHTTPClientWithPayment(&http.Client{Transport: transport}, x402http.Newx402HTTPClient(core))
	return client, scheme
}

func paymentRequiredHeader(t *testing.T, amount string, extension interface{}) string {
	t.Helper()
	pr := x402.PaymentRequired{
		X402Version: 2,
		Accepts: []x402.PaymentRequirements{{
			Scheme:            "exact",
			Network:           "eip155:84532",
			Asset:             "0x0000000000000000000000000000000000000001",
			Amount:            amount,
			PayTo:             "0x0000000000000000000000000000000000000002",
			MaxTimeoutSeconds: 60,
		}},
	}
	if extension != nil {
		pr.Extensions = map[string]interface{}{
			paymentidentifier.PAYMENT_IDENTIFIER: extension,
		}
	}
	raw, err := json.Marshal(pr)
	if err != nil {
		t.Fatalf("marshal payment required: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func declaredExtension() paymentidentifier.PaymentIdentifierExtension {
	return paymentidentifier.DeclarePaymentIdentifierExtension(true)
}

// newOfferServer returns 402 until PAYMENT-SIGNATURE is present, then 200.
// amountForProbe is called for each unpaid probe, in order.
func newOfferServer(t *testing.T, extension interface{}, amountForProbe func() string) (*httptest.Server, *recorder) {
	t.Helper()
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		sig := r.Header.Get("PAYMENT-SIGNATURE")
		rec.add(hit{
			method: r.Method,
			uri:    r.URL.RequestURI(),
			body:   string(body),
			sig:    sig,
			trace:  r.Header.Get("X-Trace"),
		})
		if sig != "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"paid"}`))
			return
		}
		w.Header().Set("PAYMENT-REQUIRED", paymentRequiredHeader(t, amountForProbe(), extension))
		w.WriteHeader(http.StatusPaymentRequired)
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

func fixedAmount(amount string) func() string {
	return func() string { return amount }
}

func doJSON(t *testing.T, client *http.Client, method, url, body string, headers map[string]string) (int, string, error) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		// A bare ReadCloser leaves GetBody unset so the SDK must preserve the body itself.
		reader = io.NopCloser(strings.NewReader(body))
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return 0, "", err
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(respBody), nil
}

func decodePaid(t *testing.T, sig string) (string, x402.PaymentPayload) {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(sig)
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	id, err := paymentidentifier.ExtractPaymentIdentifierFromBytes(raw, true)
	if err != nil {
		t.Fatalf("extract payment id: %v", err)
	}
	var payload x402.PaymentPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	return id, payload
}

func paidHits(hits []hit) []hit {
	var out []hit
	for _, h := range hits {
		if h.sig != "" {
			out = append(out, h)
		}
	}
	return out
}

func probeHits(hits []hit) []hit {
	var out []hit
	for _, h := range hits {
		if h.sig == "" {
			out = append(out, h)
		}
	}
	return out
}

func TestIdentifierInjectedOn402AndSDKRetryOnly(t *testing.T) {
	ext := &paymentIdentifierExtension{}
	var transportCalls atomic.Int32
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		transportCalls.Add(1)
		return http.DefaultTransport.RoundTrip(r)
	})
	srv, rec := newOfferServer(t, declaredExtension(), fixedAmount("1000"))
	client, scheme := testClient(ext, transport)

	status, body, err := doJSON(t, client, http.MethodPost, srv.URL+"/order?item=widget", `{"item":"widget"}`, map[string]string{"X-Trace": "keep"})
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if status != http.StatusOK || body != `{"status":"paid"}` {
		t.Fatalf("response = %d %s", status, body)
	}
	if transportCalls.Load() != 2 {
		t.Fatalf("caller transport calls = %d, want 2 (unpaid probe + one SDK payment retry)", transportCalls.Load())
	}

	hits := rec.snapshot()
	if len(hits) != 2 {
		t.Fatalf("server hits = %d, want 2", len(hits))
	}
	if hits[0].sig != "" {
		t.Fatalf("probe sent PAYMENT-SIGNATURE %q", hits[0].sig)
	}
	if hits[1].sig == "" {
		t.Fatal("SDK payment retry missing PAYMENT-SIGNATURE")
	}
	for i, h := range hits {
		if h.method != http.MethodPost || h.uri != "/order?item=widget" || h.body != `{"item":"widget"}` || h.trace != "keep" {
			t.Fatalf("hit %d = %+v, want POST /order?item=widget body and X-Trace preserved", i, h)
		}
	}
	id, payload := decodePaid(t, hits[1].sig)
	if id == "" || id != ext.lastPaymentID() || !paymentidentifier.IsValidPaymentID(id) {
		t.Fatalf("payment id = %q, extension recorded %q", id, ext.lastPaymentID())
	}
	if payload.Accepted.Amount != "1000" {
		t.Fatalf("accepted amount = %s, want 1000", payload.Accepted.Amount)
	}
	if payload.Payload["nonce"] != float64(1) {
		t.Fatalf("payload nonce = %v, want a fresh scheme payload", payload.Payload["nonce"])
	}
	seen := scheme.contexts()
	if len(seen) != 1 {
		t.Fatalf("scheme CreatePaymentPayload calls = %d, want 1", len(seen))
	}
	if seen[0].maxAmount != "" {
		t.Fatalf("spend cap = %q, want empty when spend controls are disabled", seen[0].maxAmount)
	}
	if !seen[0].paymentIdentifierOK {
		t.Fatal("scheme PaymentPayloadContext did not include the declared payment-identifier extension")
	}
}

func TestSameTargetDoesNotReplayCredential(t *testing.T) {
	srv, rec := newOfferServer(t, declaredExtension(), fixedAmount("1000"))
	client, _ := testClient(nil, nil)
	const body = `{"item":"widget"}`
	for i := 0; i < 2; i++ {
		status, _, err := doJSON(t, client, http.MethodPost, srv.URL+"/order", body, nil)
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		if status != http.StatusOK {
			t.Fatalf("request %d status = %d", i, status)
		}
	}
	hits := rec.snapshot()
	if len(hits) != 4 {
		t.Fatalf("hits = %d, want 4 (two probes and two fresh payments)", len(hits))
	}
	probes := probeHits(hits)
	paid := paidHits(hits)
	if len(probes) != 2 || len(paid) != 2 {
		t.Fatalf("probes=%d paid=%d, want 2 and 2", len(probes), len(paid))
	}
	if paid[0].sig == paid[1].sig {
		t.Fatal("second purchase replayed the first PAYMENT-SIGNATURE")
	}
	id1, _ := decodePaid(t, paid[0].sig)
	id2, _ := decodePaid(t, paid[1].sig)
	if id1 == "" || id2 == "" || id1 == id2 {
		t.Fatalf("ids = %q and %q, want two distinct identifiers", id1, id2)
	}
	for _, h := range probes {
		if h.sig != "" {
			t.Fatalf("unpaid probe carried %q", h.sig)
		}
	}
}

func TestNoCredentialReplayAcrossURLOrQuery(t *testing.T) {
	srv, rec := newOfferServer(t, declaredExtension(), fixedAmount("1000"))
	client, _ := testClient(nil, nil)
	targets := []string{
		srv.URL + "/order",
		srv.URL + "/order?x=1",
		srv.URL + "/order?x=1&y=2",
		srv.URL + "/forecast?x=1",
	}
	for _, target := range targets {
		status, _, err := doJSON(t, client, http.MethodPost, target, `{"item":"widget"}`, nil)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		if status != http.StatusOK {
			t.Fatalf("%s status = %d", target, status)
		}
	}
	hits := rec.snapshot()
	paid := paidHits(hits)
	probes := probeHits(hits)
	if len(paid) != len(targets) || len(probes) != len(targets) {
		t.Fatalf("probes=%d paid=%d, want %d each", len(probes), len(paid), len(targets))
	}
	seenSig := map[string]string{}
	seenID := map[string]string{}
	for i, h := range paid {
		if seenSig[h.sig] != "" {
			t.Fatalf("signature for %s was reused from %s", h.uri, seenSig[h.sig])
		}
		seenSig[h.sig] = h.uri
		id, _ := decodePaid(t, h.sig)
		if seenID[id] != "" {
			t.Fatalf("payment id %s reused from %s on %s", id, seenID[id], h.uri)
		}
		seenID[id] = h.uri
		if probes[i].uri != h.uri {
			t.Fatalf("probe uri %s does not match paid uri %s", probes[i].uri, h.uri)
		}
		if probes[i].sig != "" {
			t.Fatalf("probe %s carried a credential", probes[i].uri)
		}
	}
}

func TestNoCredentialReplayWhenMethodOrBodyChanges(t *testing.T) {
	srv, rec := newOfferServer(t, declaredExtension(), fixedAmount("1000"))
	client, _ := testClient(nil, nil)
	requests := []struct {
		method string
		body   string
	}{
		{http.MethodPost, `{"item":"widget"}`},
		{http.MethodPost, `{"item":"other"}`},
		{http.MethodPut, `{"item":"widget"}`},
	}
	for _, req := range requests {
		status, _, err := doJSON(t, client, req.method, srv.URL+"/order", req.body, nil)
		if err != nil {
			t.Fatalf("%s: %v", req.method, err)
		}
		if status != http.StatusOK {
			t.Fatalf("%s status = %d", req.method, status)
		}
	}
	hits := rec.snapshot()
	if len(hits) != 6 {
		t.Fatalf("hits = %d, want 6", len(hits))
	}
	paid := paidHits(hits)
	if len(paid) != 3 {
		t.Fatalf("paid hits = %d, want 3", len(paid))
	}
	if paid[0].sig == paid[1].sig || paid[1].sig == paid[2].sig || paid[0].sig == paid[2].sig {
		t.Fatal("changed method or body reused a PAYMENT-SIGNATURE")
	}
	want := requests
	for i := 0; i < 3; i++ {
		probe := hits[i*2]
		retry := hits[i*2+1]
		if probe.sig != "" {
			t.Fatalf("probe %d carried %q", i, probe.sig)
		}
		if probe.method != want[i].method || probe.body != want[i].body {
			t.Fatalf("probe %d = %s %s, want %s %s", i, probe.method, probe.body, want[i].method, want[i].body)
		}
		if retry.method != want[i].method || retry.body != want[i].body {
			t.Fatalf("retry %d = %s %s, want the original method and body", i, retry.method, retry.body)
		}
		id1, _ := decodePaid(t, retry.sig)
		if id1 == "" {
			t.Fatalf("retry %d missing payment id", i)
		}
	}
	idA, _ := decodePaid(t, paid[0].sig)
	idB, _ := decodePaid(t, paid[1].sig)
	idC, _ := decodePaid(t, paid[2].sig)
	if idA == idB || idB == idC || idA == idC {
		t.Fatalf("method/body changes reused an identifier: %s %s %s", idA, idB, idC)
	}
}

func TestNoCredentialReplayWhenOfferedTermsChange(t *testing.T) {
	amounts := []string{"1000", "9999"}
	var n atomic.Int32
	srv, rec := newOfferServer(t, declaredExtension(), func() string {
		i := int(n.Add(1) - 1)
		if i >= len(amounts) {
			t.Errorf("unexpected extra unpaid probe")
			return amounts[len(amounts)-1]
		}
		return amounts[i]
	})
	client, _ := testClient(nil, nil)
	for range amounts {
		status, _, err := doJSON(t, client, http.MethodPost, srv.URL+"/order", `{"item":"widget"}`, nil)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if status != http.StatusOK {
			t.Fatalf("status = %d", status)
		}
	}
	paid := paidHits(rec.snapshot())
	if len(paid) != 2 {
		t.Fatalf("paid hits = %d, want 2", len(paid))
	}
	if paid[0].sig == paid[1].sig {
		t.Fatal("changed offered terms replayed PAYMENT-SIGNATURE")
	}
	id1, payload1 := decodePaid(t, paid[0].sig)
	id2, payload2 := decodePaid(t, paid[1].sig)
	if payload1.Accepted.Amount != "1000" || payload2.Accepted.Amount != "9999" {
		t.Fatalf("accepted amounts = %s and %s, want 1000 and 9999", payload1.Accepted.Amount, payload2.Accepted.Amount)
	}
	if id1 == "" || id1 == id2 {
		t.Fatalf("ids = %q and %q, want distinct identifiers for distinct terms", id1, id2)
	}
	probes := probeHits(rec.snapshot())
	if len(probes) != 2 || probes[0].sig != "" || probes[1].sig != "" {
		t.Fatal("an unpaid probe carried a cached credential")
	}
}

func TestNonExtensionNon402AndMalformedExtension(t *testing.T) {
	t.Run("no extension", func(t *testing.T) {
		ext := &paymentIdentifierExtension{}
		srv, rec := newOfferServer(t, nil, fixedAmount("1000"))
		client, _ := testClient(ext, nil)
		status, _, err := doJSON(t, client, http.MethodPost, srv.URL+"/order", `{"item":"widget"}`, nil)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if status != http.StatusOK {
			t.Fatalf("status = %d", status)
		}
		paid := paidHits(rec.snapshot())
		if len(paid) != 1 {
			t.Fatalf("paid hits = %d, want 1", len(paid))
		}
		id, payload := decodePaid(t, paid[0].sig)
		if id != "" || paymentidentifier.HasPaymentIdentifier(payload) {
			t.Fatalf("identifier injected without a server declaration: %q", id)
		}
		if ext.lastPaymentID() != "" {
			t.Fatalf("recorded id %q without a declaration", ext.lastPaymentID())
		}
	})

	t.Run("malformed extension", func(t *testing.T) {
		ext := &paymentIdentifierExtension{}
		srv, rec := newOfferServer(t, "not-a-valid-extension", fixedAmount("1000"))
		client, _ := testClient(ext, nil)
		status, _, err := doJSON(t, client, http.MethodGet, srv.URL+"/order", "", nil)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if status != http.StatusOK {
			t.Fatalf("status = %d", status)
		}
		paid := paidHits(rec.snapshot())
		if len(paid) != 1 || paid[0].sig == "" {
			t.Fatalf("paid hits = %+v, want one fresh credential", paid)
		}
		raw, err := base64.StdEncoding.DecodeString(paid[0].sig)
		if err != nil {
			t.Fatalf("decode signature: %v", err)
		}
		var payload map[string]interface{}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		extensions, _ := payload["extensions"].(map[string]interface{})
		if extensions[paymentidentifier.PAYMENT_IDENTIFIER] != "not-a-valid-extension" {
			t.Fatalf("malformed extension = %#v, want it left unchanged", extensions[paymentidentifier.PAYMENT_IDENTIFIER])
		}
		if ext.lastPaymentID() != "" {
			t.Fatalf("recorded id %q for a malformed declaration", ext.lastPaymentID())
		}
	})

	t.Run("non-402", func(t *testing.T) {
		var calls atomic.Int32
		transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls.Add(1)
			if r.Header.Get("PAYMENT-SIGNATURE") != "" || r.Header.Get("X-PAYMENT") != "" {
				t.Errorf("non-402 request carried a payment credential")
			}
			return http.DefaultTransport.RoundTrip(r)
		})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		t.Cleanup(srv.Close)
		ext := &paymentIdentifierExtension{}
		client, _ := testClient(ext, transport)
		status, _, err := doJSON(t, client, http.MethodGet, srv.URL+"/health", "", map[string]string{"X-Trace": "plain"})
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		if status != http.StatusNoContent {
			t.Fatalf("status = %d", status)
		}
		if calls.Load() != 1 {
			t.Fatalf("transport calls = %d, want 1", calls.Load())
		}
		if ext.lastPaymentID() != "" {
			t.Fatalf("non-402 recorded payment id %q", ext.lastPaymentID())
		}
	})
}

func TestExplicitCredentialIsNotCached(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.add(hit{
			method: r.Method,
			uri:    r.URL.RequestURI(),
			body:   string(body),
			sig:    r.Header.Get("PAYMENT-SIGNATURE"),
			trace:  r.Header.Get("X-Trace"),
		})
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(srv.Close)
	client, _ := testClient(nil, nil)

	status, _, err := doJSON(t, client, http.MethodPost, srv.URL+"/order", `{"item":"widget"}`, map[string]string{
		"PAYMENT-SIGNATURE": "explicit-credential",
		"X-Trace":           "first",
	})
	if err != nil {
		t.Fatalf("explicit request: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("explicit status = %d", status)
	}
	status, _, err = doJSON(t, client, http.MethodPost, srv.URL+"/order?x=2", `{"item":"other"}`, nil)
	if err != nil {
		t.Fatalf("second request: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("second status = %d", status)
	}
	status, _, err = doJSON(t, client, http.MethodGet, srv.URL+"/order", "", nil)
	if err != nil {
		t.Fatalf("third request: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("third status = %d", status)
	}

	hits := rec.snapshot()
	if len(hits) != 3 {
		t.Fatalf("hits = %d, want 3", len(hits))
	}
	if hits[0].sig != "explicit-credential" || hits[0].trace != "first" || hits[0].body != `{"item":"widget"}` {
		t.Fatalf("explicit request was not forwarded unchanged: %+v", hits[0])
	}
	if hits[1].sig != "" || hits[1].body != `{"item":"other"}` || hits[1].uri != "/order?x=2" {
		t.Fatalf("later request inherited the explicit credential: %+v", hits[1])
	}
	if hits[2].sig != "" || hits[2].method != http.MethodGet {
		t.Fatalf("third request inherited a credential: %+v", hits[2])
	}
}

func TestExplicitCredentialDoesNotStickWhenServerStillRequiresPayment(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sig := r.Header.Get("PAYMENT-SIGNATURE")
		rec.add(hit{
			method: r.Method,
			uri:    r.URL.RequestURI(),
			body:   string(body),
			sig:    sig,
			trace:  r.Header.Get("X-Trace"),
		})
		if sig == "" || sig == "explicit-credential" {
			w.Header().Set("PAYMENT-REQUIRED", paymentRequiredHeader(t, "1000", declaredExtension()))
			w.WriteHeader(http.StatusPaymentRequired)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("paid"))
	}))
	t.Cleanup(srv.Close)

	client, _ := testClient(nil, nil)
	status, body, err := doJSON(t, client, http.MethodPost, srv.URL+"/order", `{"item":"widget"}`, map[string]string{
		"PAYMENT-SIGNATURE": "explicit-credential",
		"X-Trace":           "keep",
	})
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	if status != http.StatusOK || body != "paid" {
		t.Fatalf("first response = %d %s", status, body)
	}
	status, _, err = doJSON(t, client, http.MethodPost, srv.URL+"/order?x=2", `{"item":"other"}`, nil)
	if err != nil {
		t.Fatalf("second request: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("second status = %d", status)
	}

	hits := rec.snapshot()
	if len(hits) != 4 {
		t.Fatalf("hits = %d, want probe+retry for two purchases", len(hits))
	}
	if hits[0].sig != "explicit-credential" || hits[0].trace != "keep" || hits[0].body != `{"item":"widget"}` {
		t.Fatalf("probe did not keep the caller credential and body: %+v", hits[0])
	}
	if hits[1].sig == "" || hits[1].sig == "explicit-credential" {
		t.Fatalf("SDK retry = %q, want a fresh credential", hits[1].sig)
	}
	if hits[1].body != `{"item":"widget"}` || hits[1].trace != "keep" {
		t.Fatalf("SDK retry dropped caller body or header: %+v", hits[1])
	}
	if hits[2].sig != "" || hits[2].uri != "/order?x=2" || hits[2].body != `{"item":"other"}` {
		t.Fatalf("later probe reused a credential: %+v", hits[2])
	}
	if hits[3].sig == "" || hits[3].sig == hits[1].sig || hits[3].sig == "explicit-credential" {
		t.Fatalf("later purchase credential = %q", hits[3].sig)
	}
}

func TestInvalidIdentifierDoesNotSendCredential(t *testing.T) {
	ext := &paymentIdentifierExtension{nextID: func() string { return "short" }}
	srv, rec := newOfferServer(t, declaredExtension(), fixedAmount("1000"))
	client, _ := testClient(ext, nil)
	_, _, err := doJSON(t, client, http.MethodPost, srv.URL+"/order", `{"item":"widget"}`, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid payment ID") {
		t.Fatalf("error = %v, want invalid payment ID", err)
	}
	hits := rec.snapshot()
	if len(hits) != 1 {
		t.Fatalf("hits = %d, want only the unpaid probe", len(hits))
	}
	if hits[0].sig != "" {
		t.Fatalf("failed identifier still sent %q", hits[0].sig)
	}
	if ext.lastPaymentID() != "" {
		t.Fatalf("recorded invalid id %q", ext.lastPaymentID())
	}
}

func TestConcurrentPurchasesDoNotShareCredentialOrIdentifier(t *testing.T) {
	srv, rec := newOfferServer(t, declaredExtension(), fixedAmount("1000"))
	client, _ := testClient(nil, nil)
	var wg sync.WaitGroup
	errCh := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			target := srv.URL + "/order?i=" + string(rune('a'+i))
			status, _, err := doJSON(t, client, http.MethodPost, target, `{"i":`+string(rune('0'+i))+`}`, nil)
			if err != nil {
				errCh <- err
				return
			}
			if status != http.StatusOK {
				errCh <- fmt.Errorf("status %d", status)
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
	hits := rec.snapshot()
	paid := paidHits(hits)
	probes := probeHits(hits)
	if len(paid) != 8 || len(probes) != 8 {
		t.Fatalf("probes=%d paid=%d, want 8 each", len(probes), len(paid))
	}
	sigs := map[string]struct{}{}
	ids := map[string]struct{}{}
	for _, h := range paid {
		if _, ok := sigs[h.sig]; ok {
			t.Fatalf("concurrent purchase reused a credential on %s", h.uri)
		}
		sigs[h.sig] = struct{}{}
		id, _ := decodePaid(t, h.sig)
		if _, ok := ids[id]; ok || id == "" {
			t.Fatalf("concurrent purchase reused identifier %q", id)
		}
		ids[id] = struct{}{}
	}
	for _, h := range probes {
		if h.sig != "" {
			t.Fatalf("concurrent probe %s carried %q", h.uri, h.sig)
		}
	}
}

func TestCreatePaymentPayloadMintsDistinctIdentifiers(t *testing.T) {
	ext := &paymentIdentifierExtension{}
	scheme := &mockExactScheme{}
	core := x402.Newx402Client().DisableSpendControls().
		Register("eip155:*", scheme).
		RegisterExtension(ext)
	requirements := []x402.PaymentRequirements{
		{
			Scheme:            "exact",
			Network:           "eip155:84532",
			Asset:             "0x0000000000000000000000000000000000000001",
			Amount:            "1000",
			PayTo:             "0x0000000000000000000000000000000000000002",
			MaxTimeoutSeconds: 60,
		},
		{
			Scheme:            "exact",
			Network:           "eip155:84532",
			Asset:             "0x0000000000000000000000000000000000000001",
			Amount:            "9999",
			PayTo:             "0x0000000000000000000000000000000000000002",
			MaxTimeoutSeconds: 60,
		},
	}
	var ids []string
	for _, req := range requirements {
		extensions := map[string]interface{}{
			paymentidentifier.PAYMENT_IDENTIFIER: declaredExtension(),
		}
		payload, err := core.CreatePaymentPayload(context.Background(), req, nil, extensions)
		if err != nil {
			t.Fatalf("create payload: %v", err)
		}
		id, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		if err != nil {
			t.Fatalf("extract: %v", err)
		}
		if payload.Accepted.Amount != req.Amount {
			t.Fatalf("accepted amount = %s, want %s", payload.Accepted.Amount, req.Amount)
		}
		ids = append(ids, id)
	}
	if ids[0] == "" || ids[0] == ids[1] {
		t.Fatalf("ids = %q, want distinct fresh identifiers", ids)
	}
	seen := scheme.contexts()
	if len(seen) != len(requirements) {
		t.Fatalf("scheme calls = %d, want %d", len(seen), len(requirements))
	}
	for i, ctx := range seen {
		if ctx.maxAmount != "" {
			t.Fatalf("call %d spend cap = %q, want empty when spend controls are disabled", i, ctx.maxAmount)
		}
		if !ctx.paymentIdentifierOK {
			t.Fatalf("call %d PaymentPayloadContext missing payment-identifier", i)
		}
	}
}
