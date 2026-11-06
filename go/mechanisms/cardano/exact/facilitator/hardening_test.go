package facilitator

import (
	"encoding/base64"
	"testing"

	gcbor "github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const mainnetPayTo = "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv"

// rewrite edits the fixture transaction's body, witness set and auxiliary
// data, then re-signs the body with the fixture wallet, so the edit is the
// only thing wrong with the payment.
func rewrite(t *testing.T, fx *fixture, edit func(body, witnesses map[uint64]gcbor.RawMessage, aux *gcbor.RawMessage)) {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(fx.payload.Payload["transaction"].(string))
	require.NoError(t, err)
	var parts []gcbor.RawMessage
	_, err = gcbor.Decode(raw, &parts)
	require.NoError(t, err)
	var body, witnesses map[uint64]gcbor.RawMessage
	_, err = gcbor.Decode(parts[0], &body)
	require.NoError(t, err)
	_, err = gcbor.Decode(parts[1], &witnesses)
	require.NoError(t, err)
	aux := parts[3]
	edit(body, witnesses, &aux)
	bodyBytes, err := gcbor.Encode(body)
	require.NoError(t, err)
	witness, err := fx.wallet.SignTxBody(common.Blake2b256Hash(bodyBytes))
	require.NoError(t, err)
	witnesses[0], err = gcbor.Encode(gcbor.Tag{Number: 258, Content: []any{[]any{witness.Vkey, witness.Signature}}})
	require.NoError(t, err)
	tx, err := gcbor.Encode([]any{gcbor.RawMessage(bodyBytes), witnesses, true, aux})
	require.NoError(t, err)
	fx.payload.Payload["transaction"] = base64.StdEncoding.EncodeToString(tx)
}

func encode(t *testing.T, v any) gcbor.RawMessage {
	t.Helper()
	b, err := gcbor.Encode(v)
	require.NoError(t, err)
	return b
}

// Shapes the node rejects but the built-in checks cannot judge are refused
// without a complete phase-1 validator, before the resource handler runs.
func TestVerifyRefusesUnverifiableShapes(t *testing.T) {
	keyHash := make([]byte, 28)
	refInput := []any{make([]byte, 32), 0}
	cases := map[string]func(body, witnesses map[uint64]gcbor.RawMessage, aux *gcbor.RawMessage){
		"required signer": func(body, _ map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) {
			body[14] = encode(t, gcbor.Tag{Number: 258, Content: []any{keyHash}})
		},
		"reference input": func(body, _ map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) {
			body[18] = encode(t, gcbor.Tag{Number: 258, Content: []any{refInput}})
		},
		"collateral": func(body, _ map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) {
			body[13] = encode(t, gcbor.Tag{Number: 258, Content: []any{refInput}})
		},
		"bootstrap witness": func(_, witnesses map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) {
			witnesses[2] = encode(t, gcbor.Tag{Number: 258, Content: []any{[]any{make([]byte, 32), make([]byte, 64), make([]byte, 32), []byte{0xa0}}}})
		},
		"extraneous native script": func(_, witnesses map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) {
			witnesses[1] = encode(t, gcbor.Tag{Number: 258, Content: []any{[]any{0, keyHash}}})
		},
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			fx := newFixture(t, buildOpts{})
			rewrite(t, fx, edit)
			resp := verify(t, fx.scheme(nil), fx)
			assert.Equal(t, cardano.ErrTransactionPhase1Invalid, resp.InvalidReason, resp.InvalidMessage)
		})
	}
}

func TestVerifyRefusesAuxiliaryDataMismatch(t *testing.T) {
	cases := map[string]func(body, witnesses map[uint64]gcbor.RawMessage, aux *gcbor.RawMessage){
		"hash without data": func(body, _ map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) {
			body[7] = encode(t, make([]byte, 32))
		},
		"data without hash": func(_, _ map[uint64]gcbor.RawMessage, aux *gcbor.RawMessage) {
			*aux = encode(t, map[uint64]any{674: "x"})
		},
		"wrong hash": func(body, _ map[uint64]gcbor.RawMessage, aux *gcbor.RawMessage) {
			*aux = encode(t, map[uint64]any{674: "x"})
			body[7] = encode(t, make([]byte, 32))
		},
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			fx := newFixture(t, buildOpts{})
			rewrite(t, fx, edit)
			resp := verify(t, fx.scheme(nil), fx)
			assert.Equal(t, cardano.ErrTransactionPhase1Invalid, resp.InvalidReason, resp.InvalidMessage)
			assert.Contains(t, resp.InvalidMessage, "auxiliary data")
		})
	}
	// Matching metadata is a plain payment.
	fx := newFixture(t, buildOpts{})
	rewrite(t, fx, func(body, _ map[uint64]gcbor.RawMessage, aux *gcbor.RawMessage) {
		*aux = encode(t, map[uint64]any{674: "x"})
		body[7] = encode(t, cardano.Blake2b256(*aux))
	})
	resp := verify(t, fx.scheme(nil), fx)
	assert.NotContains(t, resp.InvalidMessage, "auxiliary data")
}

func TestVerifyRefusesMissingTTL(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	rewrite(t, fx, func(body, _ map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) { delete(body, 3) })
	assert.Equal(t, cardano.ErrTTLMissing, verify(t, fx.scheme(nil), fx).InvalidReason)
}

func TestVerifyRefusesWrongNetworkAddresses(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	fx.reqs.PayTo, fx.payload.Accepted.PayTo = mainnetPayTo, mainnetPayTo
	assert.Equal(t, cardano.ErrRequirementsInvalid, verify(t, fx.scheme(nil), fx).InvalidReason)

	fx = newFixture(t, buildOpts{})
	rewrite(t, fx, func(body, _ map[uint64]gcbor.RawMessage, _ *gcbor.RawMessage) {
		var outputs []gcbor.RawMessage
		_, err := gcbor.Decode(body[1], &outputs)
		require.NoError(t, err)
		var change []gcbor.RawMessage
		_, err = gcbor.Decode(outputs[len(outputs)-1], &change)
		require.NoError(t, err)
		var addr []byte
		_, err = gcbor.Decode(change[0], &addr)
		require.NoError(t, err)
		addr[0] |= 0x01 // mainnet network id in the header
		change[0] = encode(t, addr)
		outputs[len(outputs)-1] = encode(t, change)
		body[1] = encode(t, outputs)
	})
	assert.Equal(t, cardano.ErrNetworkIDMismatch, verify(t, fx.scheme(nil), fx).InvalidReason)
}

func TestVerifyRefusesOversizedTransactionAndValue(t *testing.T) {
	saved := params
	defer func() { params = saved }()
	fx := newFixture(t, buildOpts{})
	params.MaxTxSize = 100
	resp := verify(t, fx.scheme(nil), fx)
	assert.Equal(t, cardano.ErrTransactionPhase1Invalid, resp.InvalidReason)
	assert.Contains(t, resp.InvalidMessage, "protocol maximum")
	params = saved
	params.MaxValueSize = 10
	resp = verify(t, fx.scheme(nil), fx)
	assert.Equal(t, cardano.ErrTransactionPhase1Invalid, resp.InvalidReason)
	assert.Contains(t, resp.InvalidMessage, "value is")
}
