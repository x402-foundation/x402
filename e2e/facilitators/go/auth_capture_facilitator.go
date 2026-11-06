package main

import (
	"os"
	"strings"

	authcapturefacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
)

const defaultAuthCaptureForwardingOperator = "0x8FE415CdB559fBF5B235B81CC4F7a69684A274bb"

func authCaptureCustomOperators() []authcapturefacilitator.OperatorAllowlistEntry {
	raw := strings.TrimSpace(os.Getenv("FACILITATOR_EVM_AUTH_CAPTURE_CUSTOM_OPERATORS"))
	if raw == "" {
		raw = defaultAuthCaptureForwardingOperator
	}
	operators := make([]authcapturefacilitator.OperatorAllowlistEntry, 0)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		operators = append(operators, authcapturefacilitator.OperatorAllowlistEntry{
			Address:      part,
			OperatorType: "custom",
		})
	}
	return operators
}
