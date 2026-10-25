package main

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go/v2"
)

func writeVerifyError(c *gin.Context, err error) {
	var verifyErr *x402.VerifyError
	if errors.As(err, &verifyErr) {
		c.JSON(http.StatusOK, x402.VerifyResponse{
			IsValid:        false,
			InvalidReason:  verifyErr.InvalidReason,
			InvalidMessage: verifyErr.InvalidMessage,
			Payer:          verifyErr.Payer,
		})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}
