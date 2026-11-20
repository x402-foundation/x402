package main

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go/v2"
)

func writeSettleError(c *gin.Context, err error) {
	var settleErr *x402.SettleError
	if errors.As(err, &settleErr) {
		c.JSON(http.StatusOK, x402.SettleResponse{
			Success:      false,
			ErrorReason:  settleErr.ErrorReason,
			ErrorMessage: settleErr.ErrorMessage,
			Payer:        settleErr.Payer,
			Transaction:  settleErr.Transaction,
			Network:      settleErr.Network,
		})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}
