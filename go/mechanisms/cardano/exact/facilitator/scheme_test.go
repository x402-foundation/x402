package facilitator

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend"
	gcbor "github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/gouroboros/ledger/mary"
	"github.com/blinklabs-io/gouroboros/ledger/shelley"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	cardanosigners "github.com/x402-foundation/x402/go/v2/signers/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	network      = cardano.CardanoPreprodCAIP2
	mnemonic     = "test walk nut penalty hip pave soap entry language right filter choice"
	otherPhrase  = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	payTo        = "addr_test1qpdp327fu3hpm8ljwkvjy7lfqj80x469rukv8q83jegrxumkegy93sy8slex9xny7z7cj3hgdx0ly3elexy4pgd2m4hqflxyfj"
	scriptPayTo  = "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682"
	minimalV3    = "4d01000033222220051200120011"
	currentSlot  = 100_000_000
	coinsPerByte = 4310
)

var params = cardano.ProtocolParameters{CoinsPerUtxoByte: coinsPerByte, MinFeeCoefficient: 44, MinFeeConstant: 155381}

// fakeChain implements every facilitator capability; wrappers below hide some.
type fakeChain struct {
	mu          sync.Mutex
	utxos       map[string]*cardano.UtxoSnapshot
	slot        uint64
	evidence    map[string]cardano.SettlementEvidence
	evidenceErr error
	submitErr   error
	submitHash  string
	definitive  bool
	evaluateErr error
	submits     int
	lookupErr   error
	submitHook  func(txHash string)
}

func (f *fakeChain) GetAddresses() []string { return []string{"addr_test1facilitator"} }
func (f *fakeChain) GetUtxo(_ context.Context, ref, _ string) (*cardano.UtxoSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lookupErr != nil {
		return nil, f.lookupErr
	}
	if s, ok := f.utxos[ref]; ok {
		copy := *s
		return &copy, nil
	}
	return &cardano.UtxoSnapshot{}, nil
}
func (f *fakeChain) GetCurrentSlot(context.Context, string) (uint64, error) { return f.slot, nil }
func (f *fakeChain) SubmitTransaction(_ context.Context, tx, _ string) (*cardano.SubmissionResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.submits++
	if f.submitErr != nil {
		return nil, f.submitErr
	}
	decoded, err := cardano.DecodeTransaction(tx)
	if err != nil {
		return nil, err
	}
	hash := decoded.TxHash
	if f.submitHash != "" {
		hash = f.submitHash
	}
	if f.submitHook != nil {
		f.submitHook(hash)
	}
	return &cardano.SubmissionResult{TxHash: hash, Status: cardano.EvidenceMempool}, nil
}
func (f *fakeChain) GetTransactionEvidence(_ context.Context, txHash, _ string) (*cardano.SettlementEvidence, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.evidenceErr != nil {
		return nil, f.evidenceErr
	}
	if e, ok := f.evidence[txHash]; ok {
		return &e, nil
	}
	return &cardano.SettlementEvidence{Status: cardano.EvidenceUnknown, Confirmations: -2}, nil
}
func (f *fakeChain) GetProtocolParameters(context.Context, string) (*cardano.ProtocolParameters, error) {
	return &params, nil
}
func (f *fakeChain) EvaluateTransaction(context.Context, string, string) error { return f.evaluateErr }
func (f *fakeChain) IsDefinitiveSubmissionRejection(error) bool                { return f.definitive }
func (f *fakeChain) setEvidence(hash string, e cardano.SettlementEvidence) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.evidence[hash] = e
}

// basicChain exposes only the required interface.
type basicChain struct{ f *fakeChain }

func (b basicChain) GetAddresses() []string { return b.f.GetAddresses() }
func (b basicChain) GetUtxo(ctx context.Context, ref, n string) (*cardano.UtxoSnapshot, error) {
	return b.f.GetUtxo(ctx, ref, n)
}
func (b basicChain) GetCurrentSlot(ctx context.Context, n string) (uint64, error) {
	return b.f.GetCurrentSlot(ctx, n)
}
func (b basicChain) SubmitTransaction(ctx context.Context, tx, n string) (*cardano.SubmissionResult, error) {
	return b.f.SubmitTransaction(ctx, tx, n)
}

// confirmingChain is a basicChain whose submitter waits for block inclusion.
type confirmingChain struct{ basicChain }

func (confirmingChain) SubmitsConfirmed() bool { return true }

// testUtxo is a wallet UTxO as both the builder and the fake chain see it.
type testUtxo struct {
	TxHash  string
	Index   uint32
	Address string
	Coin    uint64
	Assets  map[string]uint64
}

func (u testUtxo) Ref() string { return cardano.FormatUtxoRef(u.TxHash, u.Index) }

func (u testUtxo) ledger(t *testing.T) common.Utxo {
	t.Helper()
	in, err := shelley.NewShelleyTransactionInput(u.TxHash, int(u.Index))
	require.NoError(t, err)
	addr, err := common.NewAddress(u.Address)
	require.NoError(t, err)
	value := mary.MaryTransactionOutputValue{Amount: u.Coin}
	if len(u.Assets) > 0 {
		assets := map[common.Blake2b224]map[gcbor.ByteString]*big.Int{}
		for unit, qty := range u.Assets {
			policy, name, err := cardano.ParseAssetUnit(unit)
			require.NoError(t, err)
			pb, _ := hex.DecodeString(policy)
			nb, _ := hex.DecodeString(name)
			id := common.NewBlake2b224(pb)
			if assets[id] == nil {
				assets[id] = map[gcbor.ByteString]*big.Int{}
			}
			assets[id][gcbor.NewByteString(nb)] = new(big.Int).SetUint64(qty)
		}
		multi := common.NewMultiAsset[common.MultiAssetTypeOutput](assets)
		value.Assets = &multi
	}
	return common.Utxo{Id: in, Output: &babbage.BabbageTransactionOutput{OutputAddress: addr, OutputAmount: value}}
}

// signingWallet keeps the fixture wallet's address but signs with key,
// optionally corrupting the signature.
type signingWallet struct {
	*apollo.BursaWallet
	key    *apollo.BursaWallet
	badSig bool
}

func (w signingWallet) SignTxBody(hash common.Blake2b256) (common.VkeyWitness, error) {
	witness, err := w.key.SignTxBody(hash)
	if w.badSig && err == nil {
		witness.Signature = append([]byte(nil), witness.Signature...)
		witness.Signature[0] ^= 1
	}
	return witness, err
}

type fixture struct {
	chain   *fakeChain
	wallet  *apollo.BursaWallet
	inputs  []testUtxo
	payload types.PaymentPayload
	reqs    types.PaymentRequirements
	txHash  string
}

func wallet(t *testing.T, phrase string) *apollo.BursaWallet {
	t.Helper()
	w, err := cardanosigners.NewWallet(phrase, network, 0)
	require.NoError(t, err)
	return w
}

type buildOpts struct {
	payTo   string
	coin    uint64
	assets  map[string]uint64
	datum   []byte
	ttl     uint64
	signer  *apollo.BursaWallet
	badSig  bool
	amount  string
	asset   string
	extra   map[string]interface{}
	inputs  []testUtxo
	timeout int
}

func newFixture(t *testing.T, o buildOpts) *fixture {
	t.Helper()
	w := wallet(t, mnemonic)
	if o.payTo == "" {
		o.payTo = payTo
	}
	if o.coin == 0 && o.assets == nil {
		o.coin = 5_000_000
	}
	if o.ttl == 0 {
		o.ttl = currentSlot + 100
	}
	if o.amount == "" {
		o.amount = "5000000"
	}
	if o.asset == "" {
		o.asset = cardano.LovelaceAsset
	}
	if o.timeout == 0 {
		o.timeout = 300
	}
	if o.inputs == nil {
		o.inputs = []testUtxo{
			{TxHash: strings.Repeat("01", 32), Index: 0, Address: w.Address().String(), Coin: 3_000_000},
			{TxHash: strings.Repeat("02", 32), Index: 1, Address: w.Address().String(), Coin: 30_000_000, Assets: map[string]uint64{cardano.USDMPreprodAsset: 50_000}},
		}
	}
	signer := w
	if o.signer != nil {
		signer = o.signer
	}
	ledgerInputs := make([]common.Utxo, len(o.inputs))
	for i, u := range o.inputs {
		ledgerInputs[i] = u.ledger(t)
	}
	built, err := cardanosigners.BuildPaymentTx(context.Background(), cardanosigners.PaymentTx{
		Nonce: ledgerInputs[0], Utxos: ledgerInputs[1:], TTLSlot: o.ttl,
		Wallet:  signingWallet{BursaWallet: w, key: signer, badSig: o.badSig},
		Payment: cardanosigners.PaymentOutput{Address: o.payTo, Coin: o.coin, Assets: o.assets, Datum: o.datum, RaiseToMinUtxo: o.assets != nil || o.datum != nil},
		Params:  backend.ProtocolParameters{MinFeeCoefficient: 44, MinFeeConstant: 155381, CoinsPerUtxoByte: strconv.Itoa(coinsPerByte)},
	})
	require.NoError(t, err)
	chain := &fakeChain{utxos: map[string]*cardano.UtxoSnapshot{}, slot: currentSlot, evidence: map[string]cardano.SettlementEvidence{}}
	cred, _ := cardano.PaymentCredential(w.Address().String())
	for _, u := range o.inputs {
		coin := u.Coin
		chain.utxos[u.Ref()] = &cardano.UtxoSnapshot{Exists: true, Address: u.Address, Coin: &coin, Assets: u.Assets, PaymentKeyHash: cred.HashHex()}
	}
	reqs := types.PaymentRequirements{
		Scheme: cardano.SchemeExact, Network: network, Asset: o.asset, Amount: o.amount, PayTo: o.payTo,
		MaxTimeoutSeconds: o.timeout, Extra: o.extra,
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    reqs,
		Payload:     cardano.ExactCardanoPayload{Transaction: base64.StdEncoding.EncodeToString(built.Bytes), Nonce: built.Nonce}.ToMap(),
	}
	return &fixture{chain: chain, wallet: w, inputs: o.inputs, payload: payload, reqs: reqs, txHash: built.TxHash}
}

func (fx *fixture) scheme(cfg *Config) *ExactCardanoScheme {
	s := NewExactCardanoScheme(fx.chain, cfg)
	s.sleep = func(context.Context, time.Duration) error { return nil }
	return s
}

func noConfirmPolicy() map[string]interface{} {
	return map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": float64(0)}}
}

func verify(t *testing.T, s *ExactCardanoScheme, fx *fixture) *x402.VerifyResponse {
	t.Helper()
	resp, err := s.Verify(context.Background(), fx.payload, fx.reqs, nil)
	require.NoError(t, err)
	return resp
}

func TestVerifyAcceptsValidPayment(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	resp := verify(t, fx.scheme(nil), fx)
	assert.True(t, resp.IsValid, resp.InvalidReason+" "+resp.InvalidMessage)
	assert.Equal(t, fx.wallet.Address().String(), resp.Payer)
}

func TestVerifyRules(t *testing.T) {
	cases := []struct {
		name   string
		opts   buildOpts
		mutate func(fx *fixture)
		want   string
	}{
		{"unsupported version", buildOpts{}, func(fx *fixture) { fx.payload.X402Version = 1 }, cardano.ErrInvalidPayload + "_unsupported_version"},
		{"scheme", buildOpts{}, func(fx *fixture) { fx.reqs.Scheme = "upto" }, cardano.ErrUnsupportedScheme},
		{"network mismatch", buildOpts{}, func(fx *fixture) { fx.reqs.Network = cardano.CardanoMainnetCAIP2 }, cardano.ErrNetworkMismatch},
		{"non-cardano network", buildOpts{}, func(fx *fixture) { fx.reqs.Network = "eip155:1"; fx.payload.Accepted.Network = "eip155:1" }, cardano.ErrNetworkMismatch},
		{"non-canonical amount", buildOpts{}, func(fx *fixture) { fx.reqs.Amount = "05000000" }, cardano.ErrRequirementsInvalid},
		{"non-canonical asset", buildOpts{}, func(fx *fixture) { fx.reqs.Asset = "LOVELACE" }, cardano.ErrRequirementsInvalid},
		{"missing transaction", buildOpts{}, func(fx *fixture) { delete(fx.payload.Payload, "transaction") }, cardano.ErrInvalidPayload},
		{"bad policy", buildOpts{}, func(fx *fixture) { fx.reqs.Extra = map[string]interface{}{"confirmationPolicy": "x"} }, cardano.ErrPolicyInvalid},
		{"bad nonce", buildOpts{}, func(fx *fixture) { fx.payload.Payload["nonce"] = "nope" }, cardano.ErrNonceInvalid},
		{"undecodable", buildOpts{}, func(fx *fixture) { fx.payload.Payload["transaction"] = "AAAA" }, cardano.ErrTransactionDecodeFailed},
		{"bad signature", buildOpts{badSig: true}, nil, cardano.ErrInvalidSignature},
		{"nonce not in inputs", buildOpts{}, func(fx *fixture) { fx.payload.Payload["nonce"] = strings.Repeat("09", 32) + "#0" }, cardano.ErrNonceNotInInputs},
		{"ttl expired", buildOpts{ttl: currentSlot}, nil, cardano.ErrTTLExpired},
		{"ttl too far", buildOpts{ttl: currentSlot + 1000}, nil, cardano.ErrTTLTooFar},
		{"ttl overflowing time", buildOpts{ttl: 1<<61 + 86400 + currentSlot}, nil, cardano.ErrTTLTooFar},
		{"nonce spent", buildOpts{}, func(fx *fixture) { fx.chain.utxos[fx.payload.Payload["nonce"].(string)].Exists = false }, cardano.ErrNonceNotOnChain},
		{"other input spent", buildOpts{}, func(fx *fixture) { fx.chain.utxos[fx.inputs[1].Ref()].Exists = false }, cardano.ErrInputNotAvailable},
		{"chain lookup fails", buildOpts{}, func(fx *fixture) { fx.chain.lookupErr = errors.New("down") }, cardano.ErrChainLookupFailed},
		{"value not conserved", buildOpts{}, func(fx *fixture) { *fx.chain.utxos[fx.inputs[1].Ref()].Coin += 1 }, cardano.ErrValueNotConserved},
		{"asset not conserved", buildOpts{}, func(fx *fixture) {
			fx.chain.utxos[fx.inputs[1].Ref()].Assets = map[string]uint64{cardano.USDMPreprodAsset: 1}
		}, cardano.ErrValueNotConserved},
		{"input value unknown", buildOpts{}, func(fx *fixture) { fx.chain.utxos[fx.inputs[1].Ref()].Coin = nil }, cardano.ErrInputValueUnavailable},
		{"input not signed by owner", buildOpts{}, func(fx *fixture) {
			other := wallet(t, otherPhrase)
			cred, _ := cardano.PaymentCredential(other.Address().String())
			fx.chain.utxos[fx.inputs[1].Ref()].PaymentKeyHash = cred.HashHex()
		}, cardano.ErrInvalidSignature},
		{"script-locked input without phase-1 validator", buildOpts{}, func(fx *fixture) {
			snapshot := fx.chain.utxos[fx.inputs[1].Ref()]
			snapshot.Address, snapshot.PaymentKeyHash = scriptPayTo, ""
		}, cardano.ErrInvalidSignature},
		{"unwitnessed key input derived from its address", buildOpts{}, func(fx *fixture) {
			snapshot := fx.chain.utxos[fx.inputs[1].Ref()]
			snapshot.Address, snapshot.PaymentKeyHash = wallet(t, otherPhrase).Address().String(), ""
		}, cardano.ErrInvalidSignature},
		{"recipient mismatch", buildOpts{}, func(fx *fixture) { fx.reqs.PayTo = scriptPayTo }, cardano.ErrRecipientMismatch},
		{"asset mismatch", buildOpts{}, func(fx *fixture) { fx.reqs.Asset = strings.Repeat("ab", 28) + ".00" }, cardano.ErrAssetMismatch},
		{"amount insufficient", buildOpts{}, func(fx *fixture) { fx.reqs.Amount = "5000001" }, cardano.ErrAmountInsufficient},
		{"evaluation fails", buildOpts{}, func(fx *fixture) { fx.chain.evaluateErr = errors.New("script failed") }, cardano.ErrChainLookupFailed},
		{"script without descriptor", buildOpts{payTo: scriptPayTo}, func(fx *fixture) {
			fx.reqs.Extra = map[string]interface{}{"assetTransferMethod": "script"}
		}, cardano.ErrScriptAddressMismatch},
		{"script mismatch", buildOpts{payTo: scriptPayTo}, func(fx *fixture) {
			fx.reqs.Extra = map[string]interface{}{"assetTransferMethod": "script", "scriptHash": strings.Repeat("00", 28)}
		}, cardano.ErrScriptAddressMismatch},
		{"unknown method", buildOpts{}, func(fx *fixture) { fx.reqs.Extra = map[string]interface{}{"assetTransferMethod": "teleport"} }, cardano.ErrUnsupportedScheme},
		{"non-string method", buildOpts{}, func(fx *fixture) { fx.reqs.Extra = map[string]interface{}{"assetTransferMethod": 1.0} }, cardano.ErrUnsupportedScheme},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newFixture(t, tc.opts)
			if tc.mutate != nil {
				tc.mutate(fx)
			}
			resp := verify(t, fx.scheme(nil), fx)
			assert.False(t, resp.IsValid)
			assert.Equal(t, tc.want, resp.InvalidReason, resp.InvalidMessage)
		})
	}
}

func TestVerifyFeeBelowMinimum(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	saved := params
	params.MinFeeConstant = 10_000_000
	defer func() { params = saved }()
	resp := verify(t, fx.scheme(nil), fx)
	assert.Equal(t, cardano.ErrFeeBelowMinimum, resp.InvalidReason)
}

// Phase-1 is skipped for a ledger-accepted transaction, but the payTo output
// must still carry its min-UTXO.
func TestVerifyAcceptedByLedgerChecksPayToMinUtxo(t *testing.T) {
	fx := newFixture(t, buildOpts{coin: 1_000_000, amount: "1000000"})
	for _, s := range fx.chain.utxos {
		s.Exists = false
	}
	fx.chain.setEvidence(fx.txHash, cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 0})
	saved := params
	params.CoinsPerUtxoByte = 10_000
	defer func() { params = saved }()
	assert.Equal(t, cardano.ErrMinUtxoInsufficient, verify(t, fx.scheme(nil), fx).InvalidReason)
}

func TestVerifyBelowMinUtxo(t *testing.T) {
	fx := newFixture(t, buildOpts{coin: 1_000_000, amount: "1000000"})
	saved := params
	params.CoinsPerUtxoByte = 10_000
	defer func() { params = saved }()
	assert.Equal(t, cardano.ErrMinUtxoInsufficient, verify(t, fx.scheme(nil), fx).InvalidReason)
}

// Every output must carry its min-UTXO, not only the payment: the ledger
// rejects an undersized change output after the handler already ran.
func TestVerifyChangeBelowMinUtxo(t *testing.T) {
	w := wallet(t, mnemonic)
	fx := newFixture(t, buildOpts{inputs: []testUtxo{
		{TxHash: strings.Repeat("01", 32), Index: 0, Address: w.Address().String(), Coin: 6_200_000},
	}})
	saved := params
	params.CoinsPerUtxoByte = 5_000
	defer func() { params = saved }()
	resp := verify(t, fx.scheme(nil), fx)
	assert.Equal(t, cardano.ErrMinUtxoInsufficient, resp.InvalidReason)
	assert.Contains(t, resp.InvalidMessage, "output 1")
}

func TestVerifyScriptPayment(t *testing.T) {
	datum, _ := hex.DecodeString("d8799f182aff")
	fx := newFixture(t, buildOpts{payTo: scriptPayTo, coin: 2_000_000, amount: "2000000", datum: datum})
	fx.reqs.Extra = map[string]interface{}{
		"assetTransferMethod": "script",
		"script":              map[string]interface{}{"type": "plutusV3", "code": minimalV3},
		"datum":               "d8799f182aff",
	}
	resp := verify(t, fx.scheme(nil), fx)
	assert.True(t, resp.IsValid, resp.InvalidReason)
}

func TestVerifyTokenPayment(t *testing.T) {
	fx := newFixture(t, buildOpts{assets: map[string]uint64{cardano.USDMPreprodAsset: 10_000}, amount: "10000", asset: cardano.USDMPreprodAsset})
	assert.True(t, verify(t, fx.scheme(nil), fx).IsValid)
	fx.reqs.Amount = "10001"
	assert.Equal(t, cardano.ErrAmountInsufficient, verify(t, fx.scheme(nil), fx).InvalidReason)
}

// A policy the facilitator cannot observe is refused before anything is
// broadcast: depth needs evidence, inclusion needs evidence or a submitter
// that waits for it, and mempool acceptance needs AcceptMempool.
func TestVerifyRefusesPoliciesItCannotSettle(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	verify := func(s *ExactCardanoScheme, l1 float64) *x402.VerifyResponse {
		fx.reqs.Extra = map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": l1}}
		resp, _ := s.Verify(context.Background(), fx.payload, fx.reqs, nil)
		return resp
	}
	basic := NewExactCardanoScheme(basicChain{fx.chain})
	for _, l1 := range []float64{-1, 0, 1} {
		assert.Equal(t, cardano.ErrEvidenceUnavailable, verify(basic, l1).InvalidReason, l1)
	}
	confirming := NewExactCardanoScheme(confirmingChain{basicChain{fx.chain}})
	assert.True(t, verify(confirming, 0).IsValid)
	assert.Equal(t, cardano.ErrEvidenceUnavailable, verify(confirming, 1).InvalidReason)
	full := NewExactCardanoScheme(fx.chain)
	assert.Equal(t, cardano.ErrEvidenceUnavailable, verify(full, -1).InvalidReason, "mempool needs AcceptMempool")
	assert.True(t, verify(full, 20).IsValid)
	assert.True(t, verify(NewExactCardanoScheme(fx.chain, &Config{AcceptMempool: true}), -1).IsValid)
}

func TestVerifyAcceptedByLedgerSkipsSpentChecks(t *testing.T) {
	fx := newFixture(t, buildOpts{ttl: currentSlot - 1})
	for _, s := range fx.chain.utxos {
		s.Exists = false
	}
	fx.chain.setEvidence(fx.txHash, cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 0})
	resp := verify(t, fx.scheme(nil), fx)
	assert.True(t, resp.IsValid, "TypeScript parity: a ledger-accepted transaction verifies (%s)", resp.InvalidReason)
}

func TestGetExtra(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	extra := NewExactCardanoScheme(fx.chain).GetExtra(network)
	assert.Equal(t, map[string]interface{}{"minimum": 0, "maximum": cardano.MaxL1Confirmations}, extra["l1Confirmations"])
	assert.Equal(t, false, extra["areFeesSponsored"])
	assert.Equal(t, []string{"default", "masumi", "script"}, extra["assetTransferMethods"])
	extra = NewExactCardanoScheme(basicChain{fx.chain}, &Config{AcceptMempool: true}).GetExtra(network)
	assert.Equal(t, map[string]interface{}{"minimum": -1, "maximum": -1}, extra["l1Confirmations"])
	extra = NewExactCardanoScheme(confirmingChain{basicChain{fx.chain}}, &Config{AcceptMempool: true}).GetExtra(network)
	assert.Equal(t, map[string]interface{}{"minimum": -1, "maximum": 0}, extra["l1Confirmations"])
	s := NewExactCardanoScheme(fx.chain)
	assert.Equal(t, "exact", s.Scheme())
	assert.Equal(t, "cardano:*", s.CaipFamily())
	assert.Equal(t, []string{"addr_test1facilitator"}, s.GetSigners(network))
}

func settle(t *testing.T, s *ExactCardanoScheme, fx *fixture) *x402.SettleResponse {
	t.Helper()
	resp, err := s.Settle(context.Background(), fx.payload, fx.reqs, nil)
	require.NoError(t, err)
	return resp
}

func TestSettleConfirms(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	fx.chain.submitHook = func(h string) {
		fx.chain.evidence[h] = cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 1}
	}
	resp := settle(t, fx.scheme(nil), fx)
	assert.True(t, resp.Success, resp.ErrorReason)
	assert.Equal(t, fx.txHash, resp.Transaction)
	assert.Equal(t, x402.Network(network), resp.Network)
	assert.Equal(t, fx.wallet.Address().String(), resp.Payer)
	assert.Equal(t, map[string]interface{}{"status": "confirmed", "confirmations": 1}, resp.Extra)
	assert.Equal(t, 1, fx.chain.submits)
}

func TestSettlePendingThenResumesWithoutRebroadcast(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	fx.chain.submitHook = func(h string) {
		fx.chain.evidence[h] = cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 0}
	}
	s := fx.scheme(&Config{ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond})
	resp := settle(t, s, fx)
	assert.False(t, resp.Success)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason)
	assert.Equal(t, fx.txHash, resp.Transaction)
	assert.Equal(t, "pending", resp.Extra["status"])
	assert.Equal(t, fx.txHash, resp.Extra["transactionId"])
	assert.Equal(t, 0, resp.Extra["confirmations"])

	for _, snapshot := range fx.chain.utxos {
		snapshot.Exists = false
	}
	fx.chain.setEvidence(fx.txHash, cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 1})
	resp = settle(t, s, fx)
	assert.True(t, resp.Success, resp.ErrorReason+" "+resp.ErrorMessage)
	assert.Equal(t, 1, fx.chain.submits, "the retry never rebroadcasts")
}

// A failing evidence lookup proves nothing: past the validity window the
// settlement stays pending rather than reporting a payment that may have
// landed as expired.
func TestSettleEvidenceOutageNeverReportsExpiry(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	s := fx.scheme(&Config{ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond})
	assert.Equal(t, cardano.ErrSettlementPending, settle(t, s, fx).ErrorReason)
	fx.chain.evidenceErr = errors.New("evidence provider down")
	fx.chain.slot = currentSlot + 100 + 121
	resp := settle(t, s, fx)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason)
	assert.Contains(t, resp.ErrorMessage, "evidence is unavailable")
	assert.Equal(t, 1, fx.chain.submits)
}

// A submit error while evidence lookups fail means the transaction may have
// landed: the claim is kept and nothing is rejected or rebroadcast.
func TestSettleSubmitErrorDuringEvidenceOutageKeepsClaim(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	fx.chain.submitErr = errors.New("BadInputsUTxO")
	fx.chain.definitive = true
	fx.chain.evidenceErr = errors.New("evidence provider down")
	s := fx.scheme(&Config{ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond})
	resp := settle(t, s, fx)
	assert.NotEqual(t, cardano.ErrSettlementDefinitivelyRejected, resp.ErrorReason)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason)

	fx.chain.submitErr = nil
	settle(t, s, fx)
	assert.Equal(t, 1, fx.chain.submits, "the kept claim is observed, never rebroadcast")
}

// Invalid Masumi terms are rejected by Settle with the same reason Verify gives.
func TestSettleInvalidMasumiTermsMatchesVerify(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	fx.reqs.Extra = map[string]interface{}{"assetTransferMethod": "masumi"}
	s := fx.scheme(nil)
	verifyReason := verify(t, s, fx).InvalidReason
	require.NotEmpty(t, verifyReason)
	assert.Equal(t, verifyReason, settle(t, s, fx).ErrorReason)
	assert.Zero(t, fx.chain.submits)
}

// Without an evidence reader nothing proves the transaction did not land, so a
// resumed settlement stays pending past the validity window.
func TestSettleWithoutEvidenceReaderNeverReportsExpiry(t *testing.T) {
	fx := newFixture(t, buildOpts{extra: map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": float64(0)}}})
	fx.chain.submitErr = errors.New("timeout")
	s := NewExactCardanoScheme(confirmingChain{basicChain{fx.chain}})
	s.sleep = func(context.Context, time.Duration) error { return nil }
	resp, err := s.Settle(context.Background(), fx.payload, fx.reqs, nil)
	require.NoError(t, err)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason)

	fx.chain.slot = currentSlot + 100 + 121
	resp, err = s.Settle(context.Background(), fx.payload, fx.reqs, nil)
	require.NoError(t, err)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason, "no authoritative lookup, so never expired")
	assert.Equal(t, 1, fx.chain.submits)
}

func TestSettleUnknownEvidenceStaysPendingUntilValidityCloses(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	s := fx.scheme(&Config{ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond})
	resp := settle(t, s, fx)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason)
	assert.Equal(t, "pending", resp.Extra["status"])
	assert.Equal(t, -1, resp.Extra["confirmations"])
	resp = settle(t, s, fx)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason)
	fx.chain.slot = currentSlot + 100 + 121
	resp = settle(t, s, fx)
	assert.Equal(t, cardano.ErrSettlementFailed, resp.ErrorReason)
	assert.Equal(t, "expired", resp.Extra["status"])
	assert.Equal(t, 1, fx.chain.submits)
}

func TestSettleResumeLookupOutageStaysPending(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	s := fx.scheme(&Config{ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond})
	settle(t, s, fx)
	fx.chain.lookupErr = errors.New("blockfrost down")
	resp := settle(t, s, fx)
	assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason)
	assert.Contains(t, resp.ErrorMessage, "chain lookup failed")
}

func TestSettleSubmitFailures(t *testing.T) {
	t.Run("ambiguous error keeps the claim", func(t *testing.T) {
		fx := newFixture(t, buildOpts{})
		fx.chain.submitErr = errors.New("timeout")
		s := fx.scheme(&Config{ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond})
		resp := settle(t, s, fx)
		assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason, "the transaction may still land")
		assert.Equal(t, fx.txHash, resp.Transaction)
		assert.Contains(t, resp.ErrorMessage, "timeout")
		fx.chain.submitErr = nil
		resp = settle(t, s, fx)
		assert.Equal(t, cardano.ErrSettlementPending, resp.ErrorReason, "the retry resumes observation")
		assert.Equal(t, 1, fx.chain.submits)
	})
	t.Run("definitive rejection is terminal", func(t *testing.T) {
		fx := newFixture(t, buildOpts{})
		fx.chain.submitErr = errors.New("BadInputsUTxO")
		fx.chain.definitive = true
		s := fx.scheme(nil)
		assert.Equal(t, cardano.ErrSettlementDefinitivelyRejected, settle(t, s, fx).ErrorReason)
		assert.Equal(t, cardano.ErrSettlementDefinitivelyRejected, settle(t, s, fx).ErrorReason)
		assert.Equal(t, 1, fx.chain.submits)
	})
	t.Run("rejected claim is reconciled when the transaction lands later", func(t *testing.T) {
		fx := newFixture(t, buildOpts{})
		fx.chain.submitErr = errors.New("BadInputsUTxO")
		fx.chain.definitive = true
		s := fx.scheme(nil)
		assert.Equal(t, cardano.ErrSettlementDefinitivelyRejected, settle(t, s, fx).ErrorReason)

		fx.chain.evidence[fx.txHash] = cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 1}
		for _, snapshot := range fx.chain.utxos {
			snapshot.Exists = false
		}
		resp := settle(t, s, fx)
		assert.True(t, resp.Success, resp.ErrorReason)
		assert.Equal(t, 1, fx.chain.submits, "reconciliation never rebroadcasts")
	})
	t.Run("landed despite the error", func(t *testing.T) {
		fx := newFixture(t, buildOpts{})
		fx.chain.submitErr = errors.New("connection reset")
		s := NewExactCardanoScheme(&fakeChainLanded{fakeChain: fx.chain, hash: fx.txHash})
		s.sleep = func(context.Context, time.Duration) error { return nil }
		resp, err := s.Settle(context.Background(), fx.payload, fx.reqs, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success, resp.ErrorReason)
	})
	t.Run("submitter returns another hash", func(t *testing.T) {
		fx := newFixture(t, buildOpts{})
		fx.chain.submitHash = strings.Repeat("ff", 32)
		resp := settle(t, fx.scheme(nil), fx)
		assert.Equal(t, cardano.ErrSettlementFailed, resp.ErrorReason)
		assert.Contains(t, resp.ErrorMessage, "expected "+fx.txHash)
	})
}

// fakeChainLanded reports the transaction on chain only after a submit attempt.
type fakeChainLanded struct {
	*fakeChain
	hash string
}

func (f *fakeChainLanded) SubmitTransaction(ctx context.Context, tx, n string) (*cardano.SubmissionResult, error) {
	f.setEvidence(f.hash, cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 2})
	return f.fakeChain.SubmitTransaction(ctx, tx, n)
}

// failingStore loses every outcome transition, leaving claims in flight.
type failingStore struct {
	*cardano.InMemorySettlementStore
}

func (failingStore) MarkSubmitted(context.Context, string, string) error {
	return errors.New("store unavailable")
}
func (failingStore) MarkRejected(context.Context, string, string) error {
	return errors.New("store unavailable")
}

func TestSettleSurvivesStoreFailures(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	fx.chain.submitHook = func(h string) {
		fx.chain.evidence[h] = cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 1}
	}
	var storeErrors []error
	store := failingStore{cardano.NewInMemorySettlementStore(0).WithClaimLease(time.Millisecond)}
	s := fx.scheme(&Config{SettlementStore: store, OnStoreError: func(err error) { storeErrors = append(storeErrors, err) }})

	resp := settle(t, s, fx)
	assert.True(t, resp.Success, "a failed store update does not hide a confirmed payment")
	require.Len(t, storeErrors, 1)

	time.Sleep(5 * time.Millisecond)
	for _, snapshot := range fx.chain.utxos {
		snapshot.Exists = false
	}
	resp = settle(t, s, fx)
	assert.True(t, resp.Success, "the abandoned claim is reconciled from chain evidence: %s", resp.ErrorReason)
	assert.Equal(t, 1, fx.chain.submits, "reconciliation never rebroadcasts")
}

// A full store never evicts a claim whose transaction can still land: new
// work is refused and the original retry resumes without rebroadcasting.
func TestSettleKeepsUnresolvedClaimsUnderCapacityPressure(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	fx.chain.submitErr = errors.New("timeout")
	store := cardano.NewInMemorySettlementStore(1)
	s := fx.scheme(&Config{SettlementStore: store, ConfirmationTimeout: time.Millisecond, ConfirmationPoll: time.Millisecond})
	assert.Equal(t, cardano.ErrSettlementPending, settle(t, s, fx).ErrorReason)

	res, err := store.ClaimSettlement(context.Background(), cardano.SettlementClaim{TxHash: strings.Repeat("cd", 32), OwnerToken: "other"})
	require.NoError(t, err)
	assert.Equal(t, cardano.ClaimCapacityExceeded, res, "the unresolved claim is not evicted")

	fx.chain.submitErr = nil
	settle(t, s, fx)
	assert.Equal(t, 1, fx.chain.submits, "the retry observes, never rebroadcasts")
}

// ctxStore honours cancellation like a networked store would.
type ctxStore struct {
	*cardano.InMemorySettlementStore
}

func (s ctxStore) ReleaseClaim(ctx context.Context, txHash, ownerToken string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.InMemorySettlementStore.ReleaseClaim(ctx, txHash, ownerToken)
}

// A cancelled request still releases its claim, so the payment stays settleable.
func TestSettleCancelledRequestStillReleasesClaim(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	var storeErrors []error
	s := fx.scheme(&Config{
		SettlementStore: ctxStore{cardano.NewInMemorySettlementStore(0)},
		OnStoreError:    func(err error) { storeErrors = append(storeErrors, err) },
	})
	saved := fx.reqs.Amount
	fx.reqs.Amount = "99000000"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	resp, err := s.Settle(ctx, fx.payload, fx.reqs, nil)
	require.NoError(t, err)
	assert.Equal(t, cardano.ErrAmountInsufficient, resp.ErrorReason)
	assert.Empty(t, storeErrors)

	fx.reqs.Amount = saved
	fx.chain.submitHook = func(h string) {
		fx.chain.evidence[h] = cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 1}
	}
	assert.True(t, settle(t, s, fx).Success, "the released claim can be retried")
}

func TestSettleVerificationFailureReleasesClaim(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	s := fx.scheme(nil)
	saved := fx.reqs.Amount
	fx.reqs.Amount = "99000000"
	assert.Equal(t, cardano.ErrAmountInsufficient, settle(t, s, fx).ErrorReason)
	fx.reqs.Amount = saved
	fx.chain.submitHook = func(h string) {
		fx.chain.evidence[h] = cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 1}
	}
	assert.True(t, settle(t, s, fx).Success, "the released claim can be retried")
}

func TestSettleInFlightDuplicate(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	store := cardano.NewInMemorySettlementStore(0)
	_, _ = store.ClaimSettlement(context.Background(), cardano.SettlementClaim{TxHash: fx.txHash, OwnerToken: "other"})
	resp := settle(t, fx.scheme(&Config{SettlementStore: store}), fx)
	assert.Equal(t, cardano.ErrDuplicateSettlement, resp.ErrorReason)
	assert.Equal(t, 0, fx.chain.submits)
}

func TestSettleMempoolPolicies(t *testing.T) {
	t.Run("accepted when the policy allows mempool", func(t *testing.T) {
		fx := newFixture(t, buildOpts{extra: map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": float64(-1)}}})
		resp := settle(t, fx.scheme(&Config{AcceptMempool: true}), fx)
		assert.True(t, resp.Success)
		assert.Equal(t, map[string]interface{}{"status": "mempool", "confirmations": -1}, resp.Extra)
	})
	t.Run("refused before broadcast without an evidence reader", func(t *testing.T) {
		fx := newFixture(t, buildOpts{extra: noConfirmPolicy()})
		s := NewExactCardanoScheme(basicChain{fx.chain})
		resp, err := s.Settle(context.Background(), fx.payload, fx.reqs, nil)
		require.NoError(t, err)
		assert.Equal(t, cardano.ErrEvidenceUnavailable, resp.ErrorReason)
		assert.Equal(t, 0, fx.chain.submits, "nothing the facilitator cannot observe is broadcast")
	})
}

func TestSettleRejectsMalformedInput(t *testing.T) {
	fx := newFixture(t, buildOpts{})
	s := fx.scheme(nil)
	fx.payload.Payload = map[string]interface{}{}
	assert.Equal(t, cardano.ErrInvalidPayload, settle(t, s, fx).ErrorReason)
	fx = newFixture(t, buildOpts{})
	fx.payload.Payload["transaction"] = "AAAA"
	assert.Equal(t, cardano.ErrTransactionDecodeFailed, settle(t, s, fx).ErrorReason)
	fx = newFixture(t, buildOpts{})
	fx.reqs.Extra = map[string]interface{}{"confirmationPolicy": 3}
	assert.Equal(t, cardano.ErrPolicyInvalid, settle(t, s, fx).ErrorReason)
}
