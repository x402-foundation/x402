package client

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestBatchClientFailsClosedOnTransactionVersions(t *testing.T) {
	h := newHarness(t)
	for _, test := range []struct {
		name     string
		versions any
	}{
		{name: "only version 1 advertised", versions: []any{float64(1)}},
		{name: "legacy entry invalidates the field", versions: []any{"legacy", float64(0)}},
		{name: "non-array value", versions: "0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := h.scheme(t, nil)
			requirements := h.requirements("", map[string]any{svm.ExtraTransactionVersions: test.versions})

			_, err := scheme.CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
			require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)

			_, err = scheme.CreateRefundPayload(context.Background(), 2, requirements, RefundPayloadOptions{})
			require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
		})
	}
}
