package main

import (
	"errors"
	"net/http"

	x402 "github.com/x402-foundation/x402/go/v2"
)

func writeSettleError(w http.ResponseWriter, err error) {
	var settleErr *x402.SettleError
	if errors.As(err, &settleErr) {
		writeJSON(w, http.StatusOK, x402.SettleResponse{
			Success:      false,
			ErrorReason:  settleErr.ErrorReason,
			ErrorMessage: settleErr.ErrorMessage,
			Payer:        settleErr.Payer,
			Transaction:  settleErr.Transaction,
			Network:      settleErr.Network,
		})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}
