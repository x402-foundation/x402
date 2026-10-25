package main

import (
	"errors"
	"net/http"

	x402 "github.com/x402-foundation/x402/go/v2"
)

func writeVerifyError(w http.ResponseWriter, err error) {
	var verifyErr *x402.VerifyError
	if errors.As(err, &verifyErr) {
		writeJSON(w, http.StatusOK, x402.VerifyResponse{
			IsValid:        false,
			InvalidReason:  verifyErr.InvalidReason,
			InvalidMessage: verifyErr.InvalidMessage,
			Payer:          verifyErr.Payer,
		})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}
