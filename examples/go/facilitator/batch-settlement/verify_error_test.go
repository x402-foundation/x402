package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
)

func TestWriteVerifyErrorReturnsInvalidVerifyResponse(t *testing.T) {
	recorder := httptest.NewRecorder()
	want := &x402.VerifyError{
		InvalidReason:  "invalid_signature",
		InvalidMessage: "signature does not match payer",
		Payer:          "0x1234",
	}

	writeVerifyError(recorder, fmt.Errorf("verification failed: %w", want))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var got x402.VerifyResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.IsValid || got.InvalidReason != want.InvalidReason || got.InvalidMessage != want.InvalidMessage ||
		got.Payer != want.Payer {
		t.Errorf("response = %+v, want invalid verify fields from %+v", got, want)
	}
}

func TestWriteVerifyErrorKeepsUnexpectedErrorsAsServerErrors(t *testing.T) {
	recorder := httptest.NewRecorder()

	writeVerifyError(recorder, errors.New("rpc unavailable"))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	var got map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got["error"] != "rpc unavailable" {
		t.Errorf("body = %v, want generic error response", got)
	}
}
