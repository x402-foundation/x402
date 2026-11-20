package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go/v2"
)

func TestWriteSettleErrorPreservesSettleResponse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	want := &x402.SettleError{
		ErrorReason:  "settlement_pending",
		ErrorMessage: "retry with this transaction",
		Payer:        "0x1234",
		Transaction:  "0xabcd",
		Network:      "eip155:84532",
	}

	writeSettleError(ctx, fmt.Errorf("settlement failed: %w", want))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var got x402.SettleResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Success || got.ErrorReason != want.ErrorReason || got.ErrorMessage != want.ErrorMessage ||
		got.Payer != want.Payer || got.Transaction != want.Transaction || got.Network != want.Network {
		t.Errorf("response = %+v, want failed settlement fields from %+v", got, want)
	}
}

func TestWriteSettleErrorKeepsUnexpectedErrorsAsServerErrors(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)

	writeSettleError(ctx, errors.New("database unavailable"))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	if got := recorder.Body.String(); got != `{"error":"database unavailable"}` {
		t.Errorf("body = %q, want generic error response", got)
	}
}
