package http

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPFacilitatorClientKeepsExactNumbers(t *testing.T) {
	const exact = "9007199254740993"
	payload := []byte(`{"x402Version":2,"payload":{"counter":` + exact + `},"accepted":{"scheme":"exact","network":"eip155:8453","amount":"1","asset":"0x1","payTo":"0x2","maxTimeoutSeconds":60}}`)
	requirements := []byte(`{"scheme":"exact","network":"eip155:8453","amount":"1","asset":"0x1","payTo":"0x2","maxTimeoutSeconds":60,"extra":{"counter":` + exact + `}}`)

	bodies := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies[r.URL.Path] = string(b)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/verify" {
			_, _ = w.Write([]byte(`{"isValid":true,"payer":"0xp"}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"payer":"0xp","transaction":"0xt","network":"eip155:8453"}`))
	}))
	defer server.Close()

	client := NewHTTPFacilitatorClient(&FacilitatorConfig{URL: server.URL})
	if _, err := client.Verify(context.Background(), payload, requirements); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Settle(context.Background(), payload, requirements); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/verify", "/settle"} {
		body := bodies[path]
		if got := strings.Count(body, `"counter":`+exact); got != 2 {
			t.Fatalf("%s body has %d exact counters, want 2: %s", path, got, body)
		}
		var decoded map[string]interface{}
		if err := json.Unmarshal([]byte(body), &decoded); err != nil {
			t.Fatalf("%s body is not valid JSON: %v", path, err)
		}
	}
}

func TestHTTPFacilitatorClientRejectsNonObjectPayload(t *testing.T) {
	client := NewHTTPFacilitatorClient(&FacilitatorConfig{URL: "http://127.0.0.1:0"})
	if _, err := client.Verify(context.Background(), []byte(`{"x402Version":2}`), []byte(`[]`)); err == nil ||
		!strings.Contains(err.Error(), "failed to unmarshal requirements") {
		t.Fatalf("got %v", err)
	}
}
