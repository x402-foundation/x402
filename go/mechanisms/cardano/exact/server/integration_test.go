package server_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go/v2"

	x402http "github.com/x402-foundation/x402/go/v2/http"
	nethttpmw "github.com/x402-foundation/x402/go/v2/http/nethttp"
	mcp402 "github.com/x402-foundation/x402/go/v2/mcp"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	cardanoclient "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/client"
	cardanofacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/facilitator"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
	cardanoserver "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/server"
	cardanosigners "github.com/x402-foundation/x402/go/v2/signers/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	network       = cardano.CardanoPreprodCAIP2
	buyerPhrase   = "test walk nut penalty hip pave soap entry language right filter choice"
	sellerPhrase  = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	merchantPayTo = "addr_test1qpdp327fu3hpm8ljwkvjy7lfqj80x469rukv8q83jegrxumkegy93sy8slex9xny7z7cj3hgdx0ly3elexy4pgd2m4hqflxyfj"
)

// ledger is an in-memory chain shared by the client signer and the facilitator.
type ledger struct {
	mu       sync.Mutex
	utxos    map[string]cardanosigners.Utxo
	spent    map[string]cardanosigners.Utxo
	evidence map[string]bool
	submits  int
}

func newLedger(t *testing.T) (*ledger, *cardanosigners.Wallet) {
	t.Helper()
	w, err := cardanosigners.NewWalletFromMnemonic(buyerPhrase, network, 0)
	require.NoError(t, err)
	l := &ledger{utxos: map[string]cardanosigners.Utxo{}, spent: map[string]cardanosigners.Utxo{}, evidence: map[string]bool{}}
	for i, coin := range []uint64{3_000_000, 60_000_000} {
		u := cardanosigners.Utxo{TxHash: strings.Repeat(string(rune('1'+i)), 64), Index: 0, Address: w.Address(), Coin: coin}
		l.utxos[u.Ref()] = u
	}
	return l, w
}

func (l *ledger) UtxosAt(_ context.Context, address string) ([]cardanosigners.Utxo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []cardanosigners.Utxo
	for _, u := range l.utxos {
		if u.Address == address {
			out = append(out, u)
		}
	}
	return out, nil
}

func (l *ledger) ProtocolParameters(context.Context) (*cardanosigners.ProtocolParameters, error) {
	return &cardanosigners.ProtocolParameters{MinFeeA: 44, MinFeeB: 155381, CoinsPerUtxoByte: 4310}, nil
}

func (l *ledger) GetAddresses() []string { return nil }

func (l *ledger) GetUtxo(_ context.Context, ref, _ string) (*cardano.UtxoSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	u, exists := l.utxos[ref]
	if !exists {
		u = l.spent[ref]
	}
	snapshot := &cardano.UtxoSnapshot{Exists: exists, Address: u.Address}
	if cred, err := cardano.PaymentCredential(u.Address); err == nil && !cred.IsScript {
		snapshot.PaymentKeyHash = cred.HashHex()
	}
	if exists {
		coin := u.Coin
		snapshot.Coin, snapshot.Assets = &coin, u.Assets
	}
	return snapshot, nil
}

func (l *ledger) GetCurrentSlot(_ context.Context, n string) (uint64, error) {
	return cardano.PosixMsToSlot(n, nowMs())
}

func (l *ledger) SubmitTransaction(_ context.Context, tx, _ string) (*cardano.SubmissionResult, error) {
	decoded, err := cardano.DecodeTransaction(tx)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.submits++
	for _, in := range decoded.Inputs {
		l.spent[in] = l.utxos[in]
		delete(l.utxos, in)
	}
	for i, out := range decoded.Outputs {
		u := cardanosigners.Utxo{TxHash: decoded.TxHash, Index: uint32(i), Address: out.Address, Coin: out.Coin, Assets: out.Assets}
		l.utxos[u.Ref()] = u
	}
	l.evidence[decoded.TxHash] = true
	return &cardano.SubmissionResult{TxHash: decoded.TxHash, Status: cardano.EvidenceMempool}, nil
}

func (l *ledger) GetTransactionEvidence(_ context.Context, txHash, _ string) (*cardano.SettlementEvidence, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.evidence[txHash] {
		return &cardano.SettlementEvidence{Status: cardano.EvidenceConfirmed, Confirmations: 1}, nil
	}
	return &cardano.SettlementEvidence{Status: cardano.EvidenceUnknown, Confirmations: -2}, nil
}

func (l *ledger) GetProtocolParameters(context.Context, string) (*cardano.ProtocolParameters, error) {
	return &cardano.ProtocolParameters{CoinsPerUtxoByte: 4310, MinFeeCoefficient: 44, MinFeeConstant: 155381}, nil
}

// localFacilitator adapts the in-process core facilitator to x402.FacilitatorClient.
type localFacilitator struct {
	f interface {
		Verify(ctx context.Context, payload, requirements []byte) (*x402.VerifyResponse, error)
		Settle(ctx context.Context, payload, requirements []byte) (*x402.SettleResponse, error)
		GetSupported() x402.SupportedResponse
	}
}

func (l localFacilitator) Verify(ctx context.Context, p, r []byte) (*x402.VerifyResponse, error) {
	return l.f.Verify(ctx, p, r)
}
func (l localFacilitator) Settle(ctx context.Context, p, r []byte) (*x402.SettleResponse, error) {
	return l.f.Settle(ctx, p, r)
}
func (l localFacilitator) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return l.f.GetSupported(), nil
}

func nowMs() int64 { return time.Now().UnixMilli() }

type stack struct {
	ledger   *ledger
	server   *httptest.Server
	scheme   *cardanoserver.ExactCardanoScheme
	client   *http.Client
	payments *x402http.HTTPClient
	core     interface {
		CreatePaymentPayload(ctx context.Context, r types.PaymentRequirements, res *types.ResourceInfo, ext map[string]interface{}) (types.PaymentPayload, error)
	}
	// onHandle observes protected handler runs.
	onHandle func(path string)
}

func sellerConfig(t *testing.T) *cardanoserver.MasumiIssuerConfig {
	t.Helper()
	address, signer, err := cardanosigners.NewMasumiSellerSigner(sellerPhrase, network, 0)
	require.NoError(t, err)
	return &cardanoserver.MasumiIssuerConfig{
		Seller: func(context.Context, string) (cardanoserver.MasumiSeller, error) {
			return cardanoserver.MasumiSeller{Address: address, SignTerms: signer}, nil
		},
	}
}

func newStack(t *testing.T, routes func(s *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig) *stack {
	t.Helper()
	return newStackWith(t, &cardanoserver.Config{Masumi: sellerConfig(t)}, routes)
}

func newStackWith(t *testing.T, config *cardanoserver.Config, routes func(s *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig) *stack {
	t.Helper()
	l, _ := newLedger(t)
	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{network}, cardanofacilitator.NewExactCardanoScheme(l))
	scheme := cardanoserver.NewExactCardanoScheme(config)
	st := &stack{}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if st.onHandle != nil {
			st.onHandle(r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	handler := nethttpmw.X402Payment(nethttpmw.Config{
		Routes:      routes(scheme),
		Facilitator: localFacilitator{f: facilitator},
		Schemes:     []nethttpmw.SchemeConfig{{Network: network, Server: scheme}},
	})(mux)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	signer, err := cardanosigners.NewClientSigner(cardanosigners.ClientSignerConfig{Mnemonic: buyerPhrase, Network: network, Provider: l})
	require.NoError(t, err)
	core := x402.Newx402Client().DisableSpendControls().Register("cardano:*", cardanoclient.NewExactCardanoScheme(signer))
	payments := x402http.Newx402HTTPClient(core)
	*st = stack{
		ledger: l, server: server, scheme: scheme, core: core, payments: payments,
		client: x402http.WrapHTTPClientWithPayment(http.DefaultClient, payments),
	}
	return st
}

func paymentRequired(t *testing.T, resp *http.Response) types.PaymentRequired {
	t.Helper()
	require.Equal(t, http.StatusPaymentRequired, resp.StatusCode)
	raw, err := base64.StdEncoding.DecodeString(resp.Header.Get("PAYMENT-REQUIRED"))
	require.NoError(t, err)
	var pr types.PaymentRequired
	require.NoError(t, json.Unmarshal(raw, &pr))
	return pr
}

func settleResponse(t *testing.T, resp *http.Response) *x402.SettleResponse {
	t.Helper()
	settled, err := x402http.Newx402HTTPClient(x402.Newx402Client()).GetPaymentSettleResponse(map[string]string{"PAYMENT-RESPONSE": resp.Header.Get("PAYMENT-RESPONSE")})
	require.NoError(t, err)
	return settled
}

func masumiRoutes(t *testing.T) func(s *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
	return func(s *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
		option, err := s.MasumiPaymentOption(cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300})
		require.NoError(t, err)
		return x402http.RoutesConfig{"GET /masumi": {Accepts: x402http.PaymentOptions{option}}}
	}
}

func TestDefaultPaymentEndToEnd(t *testing.T) {
	s := newStack(t, func(*cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
		return x402http.RoutesConfig{"GET /paid": {Accepts: x402http.PaymentOptions{{
			Scheme: "exact", Network: network, PayTo: merchantPayTo, MaxTimeoutSeconds: 300,
			Price: map[string]interface{}{"amount": "5000000", "asset": "lovelace"},
		}}}}
	})
	resp, err := s.client.Get(s.server.URL + "/paid")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	settled := settleResponse(t, resp)
	assert.True(t, settled.Success)
	assert.EqualValues(t, 1, settled.Extra["confirmations"])
	assert.Equal(t, 1, s.ledger.submits)
}

func TestMasumiQuoteIssuedAndResumed(t *testing.T) {
	s := newStack(t, masumiRoutes(t))
	resp, err := http.Get(s.server.URL + "/masumi")
	require.NoError(t, err)
	pr := paymentRequired(t, resp)
	resp.Body.Close()
	require.Len(t, pr.Accepts, 1)
	quote := pr.Accepts[0]
	assert.NotNil(t, quote.Extra["terms"], "the 402 carries seller-signed terms")
	assert.Equal(t, false, quote.Extra["areFeesSponsored"])

	paid, err := s.client.Get(s.server.URL + "/masumi")
	require.NoError(t, err)
	defer paid.Body.Close()
	require.Equal(t, http.StatusOK, paid.StatusCode)
	settled := settleResponse(t, paid)
	assert.True(t, settled.Success, settled.ErrorReason)
	assert.Equal(t, 1, s.ledger.submits)
}

func TestMasumiUnknownQuoteGetsFreshQuote(t *testing.T) {
	s := newStack(t, masumiRoutes(t))
	// A quote issued by another server instance is unknown here.
	other := newStack(t, masumiRoutes(t))
	resp, err := http.Get(other.server.URL + "/masumi")
	require.NoError(t, err)
	foreign := paymentRequired(t, resp)
	resp.Body.Close()

	payload, err := s.core.CreatePaymentPayload(context.Background(), foreign.Accepts[0], foreign.Resource, nil)
	require.NoError(t, err)
	header, err := json.Marshal(payload)
	require.NoError(t, err)
	req, _ := http.NewRequest(http.MethodGet, s.server.URL+"/masumi", nil)
	req.Header.Set("PAYMENT-SIGNATURE", base64.StdEncoding.EncodeToString(header))
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	fresh := paymentRequired(t, resp)
	resp.Body.Close()
	require.Len(t, fresh.Accepts, 1)
	assert.NotEqual(t, foreign.Accepts[0].Extra["terms"], fresh.Accepts[0].Extra["terms"], "a fresh quote replaces the unknown one")
	assert.Equal(t, 0, s.ledger.submits)
}

func TestMasumiOverMCP(t *testing.T) {
	ctx := context.Background()
	l, _ := newLedger(t)
	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{network}, cardanofacilitator.NewExactCardanoScheme(l))
	scheme := cardanoserver.NewExactCardanoScheme(&cardanoserver.Config{Masumi: sellerConfig(t)})
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(localFacilitator{f: facilitator}))
	server.Register(network, scheme)
	require.NoError(t, server.Initialize(ctx))
	ran := 0
	handler, err := scheme.WrapMasumiTool(server, cardanoserver.MasumiToolConfig{
		Route: cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300},
	}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		ran++
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, nil
	})
	require.NoError(t, err)

	request := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Name: "paid"}}
	unpaid, err := handler(ctx, request)
	require.NoError(t, err)
	require.True(t, unpaid.IsError)
	pr, ok := unpaid.StructuredContent.(types.PaymentRequired)
	if !ok {
		raw, _ := json.Marshal(unpaid.StructuredContent)
		require.NoError(t, json.Unmarshal(raw, &pr))
	}
	require.Len(t, pr.Accepts, 1)
	require.NotNil(t, pr.Accepts[0].Extra["terms"])
	assert.Equal(t, "mcp://tool/paid", pr.Resource.URL, "the commitment covers the 402 resource")

	signer, err := cardanosigners.NewClientSigner(cardanosigners.ClientSignerConfig{Mnemonic: buyerPhrase, Network: network, Provider: l})
	require.NoError(t, err)
	core := x402.Newx402Client().DisableSpendControls().Register("cardano:*", cardanoclient.NewExactCardanoScheme(signer))
	payload, err := core.CreatePaymentPayload(ctx, pr.Accepts[0], pr.Resource, nil)
	require.NoError(t, err)
	changed := &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{
		Name: "paid", Arguments: json.RawMessage(`{"job":"other"}`),
		Meta: mcp.Meta{mcp402.PaymentMetaKey: payload},
	}}
	rejected, err := handler(ctx, changed)
	require.NoError(t, err)
	assert.True(t, rejected.IsError, "the quote does not pay for other tool arguments")
	assert.Zero(t, ran)
	assert.Zero(t, l.submits)

	request.Params.Meta = mcp.Meta{mcp402.PaymentMetaKey: payload}
	paid, err := handler(ctx, request)
	require.NoError(t, err)
	assert.False(t, paid.IsError)
	assert.Equal(t, 1, ran)
	assert.Equal(t, 1, l.submits)

	_, err = scheme.WrapMasumiTool(x402.Newx402ResourceServer(), cardanoserver.MasumiToolConfig{
		Route: cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300},
	}, nil)
	assert.Error(t, err, "the scheme must be registered on the server")
}

// A quote commits to its request: paying a /a quote must not unlock /b, even
// when both routes carry identical payment terms.
func TestMasumiQuoteIsBoundToItsResource(t *testing.T) {
	handled := map[string]int{}
	var mu sync.Mutex
	s := newStack(t, func(scheme *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
		route := cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300}
		a, err := scheme.MasumiPaymentOption(route)
		require.NoError(t, err)
		b, err := scheme.MasumiPaymentOption(route)
		require.NoError(t, err)
		return x402http.RoutesConfig{
			"GET /a": {Accepts: x402http.PaymentOptions{a}},
			"GET /b": {Accepts: x402http.PaymentOptions{b}},
		}
	})
	s.onHandle = func(path string) { mu.Lock(); handled[path]++; mu.Unlock() }

	resp, err := http.Get(s.server.URL + "/a")
	require.NoError(t, err)
	quoteA := paymentRequired(t, resp)
	resp.Body.Close()
	payload, err := s.core.CreatePaymentPayload(context.Background(), quoteA.Accepts[0], quoteA.Resource, nil)
	require.NoError(t, err)
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	header := base64.StdEncoding.EncodeToString(raw)

	req, _ := http.NewRequest(http.MethodGet, s.server.URL+"/b", nil)
	req.Header.Set("PAYMENT-SIGNATURE", header)
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	fresh := paymentRequired(t, resp)
	resp.Body.Close()
	assert.NotEqual(t, quoteA.Accepts[0].Extra["terms"], fresh.Accepts[0].Extra["terms"], "/b issues its own quote")
	assert.Zero(t, handled["/b"], "the /a payment must not run the /b handler")
	assert.Zero(t, s.ledger.submits)

	req, _ = http.NewRequest(http.MethodGet, s.server.URL+"/a", nil)
	req.Header.Set("PAYMENT-SIGNATURE", header)
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode, "the payment still settles on its own resource")
	assert.Equal(t, 1, handled["/a"])
}

// The default commitment binds the request inputs: a quote for ?job=1 must not
// pay for ?job=2 on the same route.
func TestMasumiQuoteIsBoundToItsRequestInputs(t *testing.T) {
	handled := 0
	s := newStack(t, func(scheme *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
		option, err := scheme.MasumiPaymentOption(cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300})
		require.NoError(t, err)
		return x402http.RoutesConfig{"GET /job": {Accepts: x402http.PaymentOptions{option}}}
	})
	s.onHandle = func(string) { handled++ }

	resp, err := http.Get(s.server.URL + "/job?id=1")
	require.NoError(t, err)
	quote := paymentRequired(t, resp)
	resp.Body.Close()
	payload, err := s.core.CreatePaymentPayload(context.Background(), quote.Accepts[0], quote.Resource, nil)
	require.NoError(t, err)
	raw, err := json.Marshal(payload)
	require.NoError(t, err)

	req, _ := http.NewRequest(http.MethodGet, s.server.URL+"/job?id=2", nil)
	req.Header.Set("PAYMENT-SIGNATURE", base64.StdEncoding.EncodeToString(raw))
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	paymentRequired(t, resp)
	resp.Body.Close()
	assert.Zero(t, handled)
	assert.Zero(t, s.ledger.submits)
}

// The default commitment cannot see bodies, so it refuses methods that may
// carry one — fixed-length or chunked — instead of quoting an unbound request.
func TestMasumiDefaultCommitmentRefusesBodies(t *testing.T) {
	handled := 0
	s := newStack(t, func(scheme *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
		option, err := scheme.MasumiPaymentOption(cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300})
		require.NoError(t, err)
		return x402http.RoutesConfig{
			"POST /job": {Accepts: x402http.PaymentOptions{option}},
		}
	})
	s.onHandle = func(string) { handled++ }
	for name, body := range map[string]io.Reader{
		"fixed length": strings.NewReader(`{"job":1}`),
		"chunked":      io.MultiReader(strings.NewReader(`{"job":1}`)),
	} {
		resp, err := http.Post(s.server.URL+"/job", "application/json", body)
		require.NoError(t, err, name)
		resp.Body.Close()
		assert.Equal(t, http.StatusInternalServerError, resp.StatusCode, name)
	}
	assert.Zero(t, handled)
}

// A registered seller's quote is payable by the Go client once the caller
// attaches the resource the registry claim must cover.
func TestMasumiRegistryBackedPayment(t *testing.T) {
	ctx := context.Background()
	l, _ := newLedger(t)
	var claims []masumi.RegistryClaim
	approve := func(_ context.Context, claim masumi.RegistryClaim) (bool, error) {
		claims = append(claims, claim)
		return true, nil
	}
	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{network}, cardanofacilitator.NewExactCardanoScheme(l, &cardanofacilitator.Config{ValidateRegistryClaim: approve}))
	config := sellerConfig(t)
	config.AgentIdentifier = masumi.AgentIdentifier{Set: true, Value: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b0101010101010101"}
	scheme := cardanoserver.NewExactCardanoScheme(&cardanoserver.Config{Masumi: config})
	option, err := scheme.MasumiPaymentOption(cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300})
	require.NoError(t, err)
	handler := nethttpmw.X402Payment(nethttpmw.Config{
		Routes:      x402http.RoutesConfig{"GET /agent": {Accepts: x402http.PaymentOptions{option}}},
		Facilitator: localFacilitator{f: facilitator},
		Schemes:     []nethttpmw.SchemeConfig{{Network: network, Server: scheme}},
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	signer, err := cardanosigners.NewClientSigner(cardanosigners.ClientSignerConfig{
		Mnemonic: buyerPhrase, Network: network, Provider: l,
		Masumi: cardanosigners.MasumiClientConfig{ValidateRegistryClaim: approve},
	})
	require.NoError(t, err)
	core := x402.Newx402Client().DisableSpendControls().Register("cardano:*", cardanoclient.NewExactCardanoScheme(signer))

	resp, err := http.Get(server.URL + "/agent")
	require.NoError(t, err)
	quote := paymentRequired(t, resp)
	resp.Body.Close()
	_, err = core.CreatePaymentPayload(ctx, quote.Accepts[0], quote.Resource, nil)
	require.Error(t, err, "without the resource the registry claim cannot be checked")

	payload, err := core.CreatePaymentPayload(cardanoclient.WithResource(ctx, quote.Resource), quote.Accepts[0], quote.Resource, nil)
	require.NoError(t, err)

	claims = nil // drop the client preflight's claim; only server-side checks count below
	forged := payload
	forged.Resource = &types.ResourceInfo{URL: "https://registered.example/other"}
	raw, err := json.Marshal(forged)
	require.NoError(t, err)
	req, _ := http.NewRequest(http.MethodGet, server.URL+"/agent", nil)
	req.Header.Set("PAYMENT-SIGNATURE", base64.StdEncoding.EncodeToString(raw))
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	paymentRequired(t, resp)
	resp.Body.Close()
	assert.Empty(t, claims, "a forged payload resource never reaches the registry check")
	assert.Zero(t, l.submits)

	raw, err = json.Marshal(payload)
	require.NoError(t, err)
	req, _ = http.NewRequest(http.MethodGet, server.URL+"/agent", nil)
	req.Header.Set("PAYMENT-SIGNATURE", base64.StdEncoding.EncodeToString(raw))
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	require.NotEmpty(t, claims)
	assert.Equal(t, quote.Resource.URL, claims[0].Resource.URL)
}

// flakyTerms fails the write that binds a transaction to an issued quote
// once broken is set.
type flakyTerms struct {
	masumi.TermsStorage
	broken *bool
}

func (f flakyTerms) UpdateTerms(ctx context.Context, digest string, update func(*masumi.StoredTerms) *masumi.StoredTerms) (masumi.UpdateResult, error) {
	if *f.broken {
		if current, _ := f.Get(ctx, digest); current != nil && update(current) != current {
			return masumi.UpdateResult{}, errors.New("storage down")
		}
	}
	return f.TermsStorage.UpdateTerms(ctx, digest, update)
}

// A terms storage outage while binding a quote fails closed: the handler does
// not run and nothing is settled.
func TestMasumiTermsStorageOutageFailsClosed(t *testing.T) {
	broken := false
	inner, err := masumi.NewInMemoryTermsStorage(16)
	require.NoError(t, err)
	handled := 0
	s := newStackWith(t, &cardanoserver.Config{Masumi: sellerConfig(t), MasumiStorage: flakyTerms{inner, &broken}},
		func(scheme *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
			option, err := scheme.MasumiPaymentOption(cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300})
			require.NoError(t, err)
			return x402http.RoutesConfig{"GET /job": {Accepts: x402http.PaymentOptions{option}}}
		})
	s.onHandle = func(string) { handled++ }

	resp, err := http.Get(s.server.URL + "/job")
	require.NoError(t, err)
	quote := paymentRequired(t, resp)
	resp.Body.Close()
	payload, err := s.core.CreatePaymentPayload(context.Background(), quote.Accepts[0], quote.Resource, nil)
	require.NoError(t, err)
	raw, err := json.Marshal(payload)
	require.NoError(t, err)

	broken = true
	req, _ := http.NewRequest(http.MethodGet, s.server.URL+"/job", nil)
	req.Header.Set("PAYMENT-SIGNATURE", base64.StdEncoding.EncodeToString(raw))
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.NotEqual(t, http.StatusOK, resp.StatusCode)
	assert.Zero(t, handled)
	assert.Zero(t, s.ledger.submits)
}

// Even when a custom commitment makes two routes' quotes identical, a paid
// retry without payload.resource cannot carry a /a quote over to /b.
func TestMasumiQuoteNeedsItsResourceOnRetry(t *testing.T) {
	config := sellerConfig(t)
	config.Commitment = func(context.Context, cardanoserver.MasumiIssueContext) ([]masumi.CommitmentInput, error) {
		return []masumi.CommitmentInput{{Name: "job", Canonicalization: "jcs", Content: map[string]interface{}{"kind": "same"}}}, nil
	}
	handled := map[string]int{}
	s := newStackWith(t, &cardanoserver.Config{Masumi: config}, func(scheme *cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
		route := cardanoserver.MasumiRoute{Network: network, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300}
		a, err := scheme.MasumiPaymentOption(route)
		require.NoError(t, err)
		b, err := scheme.MasumiPaymentOption(route)
		require.NoError(t, err)
		return x402http.RoutesConfig{"GET /a": {Accepts: x402http.PaymentOptions{a}}, "GET /b": {Accepts: x402http.PaymentOptions{b}}}
	})
	s.onHandle = func(path string) { handled[path]++ }

	resp, err := http.Get(s.server.URL + "/a")
	require.NoError(t, err)
	quote := paymentRequired(t, resp)
	resp.Body.Close()
	payload, err := s.core.CreatePaymentPayload(context.Background(), quote.Accepts[0], quote.Resource, nil)
	require.NoError(t, err)
	payload.Resource = nil
	raw, err := json.Marshal(payload)
	require.NoError(t, err)

	req, _ := http.NewRequest(http.MethodGet, s.server.URL+"/b", nil)
	req.Header.Set("PAYMENT-SIGNATURE", base64.StdEncoding.EncodeToString(raw))
	resp, err = http.DefaultClient.Do(req)
	require.NoError(t, err)
	paymentRequired(t, resp)
	resp.Body.Close()
	assert.Zero(t, handled["/b"])
	assert.Zero(t, s.ledger.submits)
}

func TestMasumiTemplateWithoutHelperFailsLoudly(t *testing.T) {
	s := newStack(t, func(*cardanoserver.ExactCardanoScheme) x402http.RoutesConfig {
		return x402http.RoutesConfig{"GET /broken": {Accepts: x402http.PaymentOptions{{
			Scheme: "exact", Network: network, PayTo: merchantPayTo, MaxTimeoutSeconds: 300,
			Price: map[string]interface{}{"amount": "5000000", "asset": "lovelace"},
			Extra: map[string]interface{}{"assetTransferMethod": "masumi"},
		}}}}
	})
	resp, err := http.Get(s.server.URL + "/broken")
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
}
