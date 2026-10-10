package cardano

import (
	"context"
	"encoding/base64"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	cardanofacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/facilitator"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestSubmissionErrorClassification(t *testing.T) {
	_, bf := newFakeBlockfrost(t)
	signer, err := NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf})
	require.NoError(t, err)
	cases := []struct {
		name              string
		err               error
		definite, notSent bool
	}{
		{"ledger rejection", &APIError{Path: submitPath, StatusCode: 400}, true, false},
		{"400 elsewhere", &APIError{Path: "/txs/x", StatusCode: 400}, false, false},
		{"rate limited", &APIError{Path: submitPath, StatusCode: 429}, false, true},
		{"mempool full", &APIError{Path: submitPath, StatusCode: 425}, false, true},
		{"quota", &APIError{Path: submitPath, StatusCode: 402}, false, true},
		{"forbidden", &APIError{Path: submitPath, StatusCode: 403}, false, true},
		{"server error is ambiguous", &APIError{Path: submitPath, StatusCode: 500}, false, false},
		{"dial failure", &net.OpError{Op: "dial", Err: errors.New("connection refused")}, false, true},
		{"dns failure", &net.DNSError{Err: "no such host", Name: "x"}, false, true},
		{"read timeout is ambiguous", &net.OpError{Op: "read", Err: errors.New("timeout")}, false, false},
		{"deadline is ambiguous", context.DeadlineExceeded, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wrapped := errors.Join(errors.New("blockfrost /tx/submit"), tc.err)
			assert.Equal(t, tc.definite, signer.IsDefinitiveSubmissionRejection(wrapped))
			assert.Equal(t, tc.notSent, signer.IsSubmissionNotSent(wrapped))
		})
	}
}

// A submit Blockfrost refuses before forwarding (429) releases the claim, so
// the retry re-verifies and submits the same transaction again.
func TestSettleRecoversFromSubmitNotSent(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	w := testWallet(t)
	inputs := []Utxo{
		{TxHash: strings.Repeat("0a", 32), Index: 0, Address: w.Address(), Coin: 3_000_000},
		{TxHash: strings.Repeat("0b", 32), Index: 0, Address: w.Address(), Coin: 30_000_000},
	}
	fake.set("GET /txs/"+inputs[0].TxHash+"/utxos", 200, map[string]interface{}{"outputs": []map[string]interface{}{{
		"output_index": 0, "address": w.Address(), "amount": []map[string]string{amount("lovelace", "3000000")}, "consumed_by_tx": nil,
	}}})
	fake.set("GET /txs/"+inputs[1].TxHash+"/utxos", 200, map[string]interface{}{"outputs": []map[string]interface{}{{
		"output_index": 0, "address": w.Address(), "amount": []map[string]string{amount("lovelace", "30000000")}, "consumed_by_tx": nil,
	}}})
	fake.set("GET /epochs/latest/parameters", 200, map[string]interface{}{"min_fee_a": 44, "min_fee_b": 155381, "coins_per_utxo_size": "4310", "max_tx_size": 16384})

	ttl, err := x402cardano.PosixMsToSlot("cardano:preprod", time.Now().Add(2*time.Minute).UnixMilli())
	require.NoError(t, err)
	built, err := BuildPaymentTx(PaymentTx{
		Utxos: inputs, ChangeAddress: w.Address(), TTLSlot: ttl,
		Payment: PaymentOutput{Address: payToAddress, Coin: 5_000_000},
		Params:  ProtocolParameters{MinFeeA: 44, MinFeeB: 155381, CoinsPerUtxoByte: 4310},
	}, signWith(w))
	require.NoError(t, err)

	signer, err := NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf})
	require.NoError(t, err)
	scheme := cardanofacilitator.NewExactCardanoScheme(signer, &cardanofacilitator.Config{
		ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond,
	})
	requirements := types.PaymentRequirements{
		Scheme: "exact", Network: "cardano:preprod", Asset: "lovelace", Amount: "5000000", PayTo: payToAddress,
		MaxTimeoutSeconds: 300, Extra: map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": float64(0)}},
	}
	payload := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: x402cardano.ExactCardanoPayload{
		Transaction: base64.StdEncoding.EncodeToString(built.Bytes), Nonce: built.Nonce,
	}.ToMap()}

	fake.set("POST /tx/submit", 429, map[string]string{"message": "rate limited"})
	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.Equal(t, x402cardano.ErrSettlementFailed, resp.ErrorReason)

	fake.set("POST /tx/submit", 200, built.TxHash)
	fake.set("GET /txs/"+built.TxHash, 200, map[string]interface{}{"block_height": 10, "valid_contract": true})
	fake.set("GET /blocks/latest", 200, map[string]interface{}{"height": 10})
	resp, err = scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success, resp.ErrorReason+" "+resp.ErrorMessage)
	submits := 0
	for _, r := range fake.requests {
		if r == "POST /tx/submit" {
			submits++
		}
	}
	assert.Equal(t, 2, submits, "the released claim lets the retry submit the same transaction")
}
