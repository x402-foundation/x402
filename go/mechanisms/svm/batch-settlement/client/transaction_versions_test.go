package client

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func TestBatchClientFailsClosedOnTransactionVersions(t *testing.T) {
	h := newHarness(t)
	for _, test := range []struct {
		name     string
		versions any
		client   []int
	}{
		{name: "only version 1 advertised to a v0-only client", versions: []any{float64(1)}, client: []int{0}},
		{name: "legacy entry invalidates the field", versions: []any{"legacy", float64(0)}},
		{name: "non-array value", versions: "0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := h.scheme(t, &BatchSvmClientConfig{TransactionVersions: test.client})
			requirements := h.requirements("", map[string]any{svm.ExtraTransactionVersions: test.versions})

			_, err := scheme.CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
			require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)

			_, err = scheme.CreateRefundPayload(context.Background(), 2, requirements, RefundPayloadOptions{})
			require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
		})
	}
}

func decodeVersion(t *testing.T, wire string) *solana.Transaction {
	t.Helper()
	tx, err := svm.DecodeTransaction(wire)
	require.NoError(t, err)
	return tx
}

func requireNoComputeBudgetInstruction(t *testing.T, tx *solana.Transaction) {
	t.Helper()
	for _, ix := range tx.Message.Instructions {
		program, err := tx.Message.Program(ix.ProgramIDIndex)
		require.NoError(t, err)
		require.False(t, program.Equals(solana.ComputeBudget), "a version-1 transaction carries its budget in the message config")
	}
	require.NotNil(t, tx.Message.TransactionConfig.ComputeUnitLimit)
	require.NotNil(t, tx.Message.TransactionConfig.LoadedAccountsDataSizeLimit)
}

func TestBatchClientBuildsTheNegotiatedTransactionVersion(t *testing.T) {
	both := map[string]any{svm.ExtraTransactionVersions: []any{float64(0), float64(1)}}
	for _, test := range []struct {
		name   string
		client []int
		want   solana.MessageVersion
	}{
		{name: "default client builds v1", want: solana.MessageVersionV1},
		{name: "v0-only client builds v0", client: []int{0}, want: solana.MessageVersionV0},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := newHarness(t)

			// Opening deposit.
			opener := h.scheme(t, &BatchSvmClientConfig{DepositAmount: uint64(3000), TransactionVersions: test.client})
			opened := mustCreate(t, opener, h.requirements("", both), x402.PaymentPayloadContext{})
			open := decodeVersion(t, nestedString(t, opened.Payload, "deposit", "transaction"))
			require.Equal(t, test.want, open.Message.GetVersion())
			if test.want == solana.MessageVersionV1 {
				requireNoComputeBudgetInstruction(t, open)
			}

			// Top-up of an exhausted channel.
			scheme := h.scheme(t, &BatchSvmClientConfig{DepositAmount: uint64(1500), TransactionVersions: test.client})
			req := h.requirements("", both)
			key := scheme.channelKey(req, h.feePayer.String(), 900)
			scheme.channels[key] = openChannel{
				deposit: 1000,
				tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, h.clientConfig(), h.payer, 1000),
			}
			topUp := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
			topUpTx := decodeVersion(t, nestedString(t, topUp.Payload, "deposit", "transaction"))
			require.Equal(t, test.want, topUpTx.Message.GetVersion())
			if test.want == solana.MessageVersionV1 {
				requireNoComputeBudgetInstruction(t, topUpTx)
			}

			// Payer-signed request_close fallback, verified as the facilitator would.
			refunder := h.scheme(t, &BatchSvmClientConfig{TransactionVersions: test.client})
			refunder.channels[key] = openChannel{
				deposit: 5000,
				tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, h.clientConfig(), h.payer, 1000),
			}
			refund, err := refunder.CreateRefundPayload(context.Background(), 2, req, RefundPayloadOptions{WithTransaction: true})
			require.NoError(t, err)
			wire, _ := refund.Payload["transaction"].(string)
			require.NotEmpty(t, wire)
			closeTx := decodeVersion(t, wire)
			require.Equal(t, test.want, closeTx.Message.GetVersion())
			require.NoError(t, paymentchannels.VerifyRequestCloseTransaction(wire, paymentchannels.VerifyRequestCloseExpected{
				Payer:     h.payer.Address(),
				FeePayer:  h.feePayer,
				ChannelID: solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress),
			}))
		})
	}
}
