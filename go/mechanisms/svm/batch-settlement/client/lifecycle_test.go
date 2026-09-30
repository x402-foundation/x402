package client

import (
	"context"
	"strconv"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchClientLifecycle(t *testing.T) {
	t.Run("commits a signed server voucher without allocating again (restart=false)", func(t *testing.T) {
		testServerVoucherRestart(t, false)
	})
	t.Run("commits a signed server voucher without allocating again (restart=true)", func(t *testing.T) {
		testServerVoucherRestart(t, true)
	})
	t.Run("opens, replays, confirms, and advances a persisted channel", testOpensReplaysConfirms)
	t.Run("treats the commitment identifier as opaque and requires only that it is non-empty", testOpaqueCommitment)
	t.Run("tops up an exhausted channel and commits only the signed deposit", testTopUpSignedDeposit)
	t.Run("tops up by the exact shortfall when the configured increment is smaller", testTopUpShortfall)
	t.Run("uses five request charges as the default top-up target", testDefaultTopUp)
	t.Run("honors a valid minDeposit hint within the local spend ceiling", testMinDepositHint)
	t.Run("falls back from malformed minDeposit and validates depositMultiplier", testMalformedMinDeposit)
	t.Run("rejects a required deposit above the spend-derived ceiling", testDepositCeiling)
	t.Run("treats empty and failed discovery scans as cache misses", testEmptyDiscovery)
	t.Run("adopts a discovered channel before allocating a voucher", testAdoptDiscovered)
	t.Run("preserves the spend-derived deposit ceiling after channel discovery", testDiscoveryCeiling)
	t.Run("restores confirmed state after a failed request", testRestoreAfterFailure)
	t.Run("rejects corrective responses without the required trustworthy state", testRejectsCorrective)
	t.Run("hydrates confirmed and pending records and ignores unrelated responses", testHydrate)
	t.Run("validates client terms and configuration boundaries", testValidatesTerms)
	t.Run("builds a refund from a cached channel and rejects a missing one", testRefundFromCache)
	t.Run("refunds a client-signed channel when the probe lists server-signed first", testRefundServerFirst)
	t.Run("reports no channel when the probe is server-signed and nothing is open", testRefundNoChannelServerProbe)
}

func testServerVoucherRestart(t *testing.T, restart bool) {
	t.Helper()
	h := newHarness(t)
	operator := newKey(t)
	storage := newMemoryStorage()
	trust := &BatchServerSignedChannelsPolicy{AllowedOperators: []string{operator.Address().String()}}
	scheme := h.scheme(t, &BatchSvmClientConfig{
		ChannelStorage:             storage,
		DepositAmount:              uint64(3000),
		ServerSignedChannelsPolicy: trust,
	})
	serverRequirements := h.requirements("1000", map[string]any{
		batchsettlement.ExtraOperator:      operator.Address().String(),
		batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
	})
	opened := mustCreate(t, scheme, serverRequirements, x402.PaymentPayloadContext{})
	require.Equal(t, "deposit", opened.Payload["type"])
	_, hasClaim := opened.Payload["maxClaimableAmount"]
	require.False(t, hasClaim)
	channelID := nestedString(t, opened.Payload, "authorization", "channelId")
	respond(t, scheme, serverRequirements, opened, settleSuccess(map[string]any{
		"channelState": map[string]any{"chargedCumulativeAmount": "400"},
		"commitmentId": channelID + ":400",
		"voucher":      signedVoucher(t, operator, channelID, 400),
	}), nil)
	require.Equal(t, "400", storage.only().ChargedCumulativeAmount)
	require.Equal(t, "3000", storage.only().Deposit)

	if restart {
		scheme = h.scheme(t, &BatchSvmClientConfig{
			ChannelStorage:             storage,
			ServerSignedChannelsPolicy: trust,
		})
	}
	first := mustCreate(t, scheme, serverRequirements, x402.PaymentPayloadContext{})
	_, err := scheme.CreatePaymentPayload(context.Background(), serverRequirements, x402.PaymentPayloadContext{})
	require.ErrorContains(t, err, "pending request")
	require.Equal(t, "authorization", first.Payload["type"])

	respond(t, scheme, serverRequirements, first, settleSuccess(serverSettle(t, operator, channelID, 900)), nil)
	third := mustCreate(t, scheme, serverRequirements, x402.PaymentPayloadContext{})
	require.Equal(t, "authorization", third.Payload["type"])
	require.NotEqual(t,
		nestedString(t, first.Payload, "authorization", "requestId"),
		nestedString(t, third.Payload, "authorization", "requestId"),
	)
	respond(t, scheme, serverRequirements, third, settleSuccess(serverSettle(t, operator, channelID, 1200)), nil)
	require.Equal(t, "1200", storage.only().ChargedCumulativeAmount)
}

func testOpensReplaysConfirms(t *testing.T) {
	h := newHarness(t)
	storage := newMemoryStorage()
	scheme := h.scheme(t, &BatchSvmClientConfig{ChannelStorage: storage, DepositAmount: uint64(3000)})
	req := h.requirements("", nil)
	opened := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	require.Equal(t, "deposit", opened.Payload["type"])
	require.Equal(t, "3000", nestedString(t, opened.Payload, "deposit", "amount"))
	require.Equal(t, "1000", nestedString(t, opened.Payload, "voucher", "maxClaimableAmount"))

	replayed := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	require.Equal(t, opened, replayed)
	_, err := scheme.CreatePaymentPayload(context.Background(), h.requirements("2000", nil), x402.PaymentPayloadContext{})
	require.ErrorContains(t, err, "pending allocation for a different amount")

	channelID := nestedString(t, opened.Payload, "voucher", "channelId")
	respond(t, scheme, req, opened, settleSuccess(map[string]any{
		"chargedAmount": "1000",
		"channelState":  map[string]any{"chargedCumulativeAmount": "1000"},
		"commitmentId":  channelID + ":1000",
	}), nil)
	require.Equal(t, "1000", storage.only().ChargedCumulativeAmount)
	require.Equal(t, "3000", storage.only().Deposit)

	next := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	require.Equal(t, "voucher", next.Payload["type"])
	require.Equal(t, "2000", nestedString(t, next.Payload, "voucher", "maxClaimableAmount"))
	respond(t, scheme, req, next, settleSuccess(map[string]any{
		"chargedAmount": "1000",
		"commitmentId":  nestedString(t, next.Payload, "voucher", "channelId") + ":2000",
	}), nil)
	require.Equal(t, "2000", storage.only().ChargedCumulativeAmount)
	require.Equal(t, "3000", storage.only().Deposit)

	invalid := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	_, err = scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: invalid,
		Requirements:   req,
		SettleResponse: settleSuccess(map[string]any{"chargedAmount": "bad"}),
	})
	require.ErrorContains(t, err, "unexpected amount")
}

func testOpaqueCommitment(t *testing.T) {
	h := newHarness(t)
	storage := newMemoryStorage()
	scheme := h.scheme(t, &BatchSvmClientConfig{ChannelStorage: storage, DepositAmount: uint64(3000)})
	req := h.requirements("", nil)
	opened := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	respond(t, scheme, req, opened, settleSuccess(map[string]any{
		"chargedAmount": "1000",
		"commitmentId":  "receipt-7f3a",
	}), nil)
	require.Equal(t, "1000", storage.only().ChargedCumulativeAmount)
	require.Equal(t, "3000", storage.only().Deposit)

	next := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	result := respond(t, scheme, req, next, settleSuccess(map[string]any{
		"chargedAmount": "1000",
		"commitmentId":  "",
	}), nil)
	require.False(t, result.Recovered)
	require.Equal(t, "1000", storage.only().ChargedCumulativeAmount)
}

func testTopUpSignedDeposit(t *testing.T) {
	h := newHarness(t)
	storage := newMemoryStorage()
	scheme := h.scheme(t, &BatchSvmClientConfig{ChannelStorage: storage, DepositAmount: uint64(1500)})
	req := h.requirements("", nil)
	config := h.clientConfig()
	key := scheme.channelKey(req, h.feePayer.String(), 900)
	scheme.channels[key] = openChannel{
		deposit: 1000,
		tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, config, h.payer, 1000),
	}
	topUp := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	require.Equal(t, "deposit", topUp.Payload["type"])
	require.Equal(t, "1500", nestedString(t, topUp.Payload, "deposit", "amount"))
	require.Equal(t, "2000", nestedString(t, topUp.Payload, "voucher", "maxClaimableAmount"))
	respond(t, scheme, req, topUp, settleSuccess(map[string]any{
		"chargedAmount": "1000",
		"channelState":  map[string]any{"balance": "999999", "chargedCumulativeAmount": "2000"},
		"commitmentId":  svm.USDCMainnetAddress + ":2000",
	}), nil)
	saved, err := storage.Get(key)
	require.NoError(t, err)
	require.Equal(t, "2000", saved.ChargedCumulativeAmount)
	require.Equal(t, "2500", saved.Deposit)
}

func testTopUpShortfall(t *testing.T) {
	h := newHarness(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{DepositAmount: uint64(500)})
	req := h.requirements("", nil)
	key := scheme.channelKey(req, h.feePayer.String(), 900)
	scheme.channels[key] = openChannel{
		deposit: 1000,
		tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, h.clientConfig(), h.payer, 1000),
	}
	payment := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	require.Equal(t, "deposit", payment.Payload["type"])
	require.Equal(t, "1000", nestedString(t, payment.Payload, "deposit", "amount"))
}

func testDefaultTopUp(t *testing.T) {
	h := newHarness(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{})
	req := h.requirements("", nil)
	key := scheme.channelKey(req, h.feePayer.String(), 900)
	scheme.channels[key] = openChannel{
		deposit: 1000,
		tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, h.clientConfig(), h.payer, 1000),
	}
	payment := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	require.Equal(t, "deposit", payment.Payload["type"])
	require.Equal(t, "5000", nestedString(t, payment.Payload, "deposit", "amount"))
}

func testMinDepositHint(t *testing.T) {
	h := newHarness(t)
	hinted := h.requirements("", map[string]any{batchsettlement.ExtraMinDeposit: "15000"})
	scheme := h.scheme(t, &BatchSvmClientConfig{})
	payment := mustCreate(t, scheme, hinted, x402.PaymentPayloadContext{})
	require.Equal(t, "15000", nestedString(t, payment.Payload, "deposit", "amount"))

	capped := h.scheme(t, &BatchSvmClientConfig{})
	payment = mustCreate(t, capped, hinted, x402.PaymentPayloadContext{MaxAmountPerPayment: "2000"})
	require.Equal(t, "10000", nestedString(t, payment.Payload, "deposit", "amount"))
}

func testMalformedMinDeposit(t *testing.T) {
	h := newHarness(t)
	malformed := h.requirements("", map[string]any{batchsettlement.ExtraMinDeposit: "500"})
	three := 3
	scheme := h.scheme(t, &BatchSvmClientConfig{DepositPolicy: &DepositPolicy{DepositMultiplier: &three}})
	payment := mustCreate(t, scheme, malformed, x402.PaymentPayloadContext{})
	require.Equal(t, "3000", nestedString(t, payment.Payload, "deposit", "amount"))

	two := 2
	_, err := NewBatchSvmScheme(h.payer, &BatchSvmClientConfig{DepositPolicy: &DepositPolicy{DepositMultiplier: &two}})
	require.ErrorContains(t, err, "integer >= 3")
}

func testDepositCeiling(t *testing.T) {
	h := newHarness(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{})
	_, err := scheme.CreatePaymentPayload(context.Background(), h.requirements("", nil), x402.PaymentPayloadContext{MaxAmountPerPayment: "100"})
	require.ErrorContains(t, err, "required deposit 1000 exceeds")

	malformed := h.scheme(t, &BatchSvmClientConfig{})
	req := h.requirements("", map[string]any{batchsettlement.ExtraMinDeposit: "not-an-amount"})
	payment := mustCreate(t, malformed, req, x402.PaymentPayloadContext{MaxAmountPerPayment: "not-an-amount"})
	require.Equal(t, "5000", nestedString(t, payment.Payload, "deposit", "amount"))
}

func testEmptyDiscovery(t *testing.T) {
	h := newHarness(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{DiscoverChannels: nil})
	scheme.config.DiscoverChannels = nil
	req := h.requirements("", nil)
	terms, err := scheme.resolveTerms(context.Background(), req)
	require.NoError(t, err)
	found, err := scheme.discoverChannel(context.Background(), req, terms)
	require.NoError(t, err)
	require.Nil(t, found)

	h.rpc.mu.Lock()
	h.rpc.programAccountsErr = true
	h.rpc.mu.Unlock()
	found, err = scheme.discoverChannel(context.Background(), req, terms)
	require.NoError(t, err)
	require.Nil(t, found)
}

func testAdoptDiscovered(t *testing.T) {
	h := newHarness(t)
	storage := newMemoryStorage()
	scheme := h.scheme(t, &BatchSvmClientConfig{ChannelStorage: storage, DiscoverChannels: nil})
	scheme.config.DiscoverChannels = nil
	config := h.clientConfig()
	scheme.discoverFn = func(context.Context, types.PaymentRequirements, resolvedTerms) (*openChannel, error) {
		return &openChannel{
			deposit: 5000,
			tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, config, h.payer, 1000),
		}, nil
	}
	payment := mustCreate(t, scheme, h.requirements("", nil), x402.PaymentPayloadContext{})
	require.Equal(t, "voucher", payment.Payload["type"])
	require.Equal(t, "2000", nestedString(t, payment.Payload, "voucher", "maxClaimableAmount"))
	require.Equal(t, "1000", storage.only().ChargedCumulativeAmount)
}

func testDiscoveryCeiling(t *testing.T) {
	h := newHarness(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{DiscoverChannels: nil})
	scheme.config.DiscoverChannels = nil
	config := h.clientConfig()
	scheme.discoverFn = func(context.Context, types.PaymentRequirements, resolvedTerms) (*openChannel, error) {
		return &openChannel{
			deposit: 0,
			tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, config, h.payer, 0),
		}, nil
	}
	_, err := scheme.CreatePaymentPayload(context.Background(), h.requirements("", nil), x402.PaymentPayloadContext{MaxAmountPerPayment: "100"})
	require.ErrorContains(t, err, "required deposit 1000 exceeds")
}

func testRestoreAfterFailure(t *testing.T) {
	h := newHarness(t)
	storage := newMemoryStorage()
	scheme := h.scheme(t, &BatchSvmClientConfig{ChannelStorage: storage, DiscoverChannels: nil})
	scheme.config.DiscoverChannels = nil
	req := h.requirements("", nil)
	key := scheme.channelKey(req, h.feePayer.String(), 900)
	scheme.channels[key] = openChannel{
		deposit: 5000,
		tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, h.clientConfig(), h.payer, 1000),
	}
	payment := mustCreate(t, scheme, req, x402.PaymentPayloadContext{})
	respond(t, scheme, req, payment, &x402.SettleResponse{Success: false}, nil)
	saved, err := storage.Get(key)
	require.NoError(t, err)
	require.Equal(t, "1000", saved.ChargedCumulativeAmount)
	require.Equal(t, "5000", saved.Deposit)
}

func testRejectsCorrective(t *testing.T) {
	h := newHarness(t)
	base := h.requirements("", nil)
	corrections := []*types.PaymentRequired{
		{Accepts: []types.PaymentRequirements{base}, Error: "other", X402Version: 2},
		{Accepts: []types.PaymentRequirements{base}, Error: batchsettlement.ErrCumulativeAmountMismatch, X402Version: 2},
		{
			Accepts: []types.PaymentRequirements{h.requirements("", map[string]any{
				batchsettlement.ExtraChannelState: map[string]any{
					"balance":                 "10000",
					"channelId":               svm.USDCMainnetAddress,
					"chargedCumulativeAmount": "1",
					"totalClaimed":            "2",
					"withdrawRequestedAt":     0,
				},
			})},
			Error:       batchsettlement.ErrCumulativeAmountMismatch,
			X402Version: 2,
		},
	}
	for _, required := range corrections {
		scheme := h.scheme(t, &BatchSvmClientConfig{})
		payment := mustCreate(t, scheme, base, x402.PaymentPayloadContext{})
		result := respond(t, scheme, base, payment, &x402.SettleResponse{Success: false}, required)
		require.False(t, result.Recovered)
	}
}

func testHydrate(t *testing.T) {
	h := newHarness(t)
	storage := newMemoryStorage()
	config := h.clientConfig()
	require.NoError(t, storage.Set("confirmed", BatchClientChannelRecord{
		ChannelConfig:           config,
		ChannelID:               svm.USDCMainnetAddress,
		ChargedCumulativeAmount: "1000",
		Deposit:                 "5000",
	}))
	scheme := h.scheme(t, &BatchSvmClientConfig{ChannelStorage: storage, DiscoverChannels: nil})
	scheme.config.DiscoverChannels = nil
	loaded, err := scheme.loadChannel("confirmed")
	require.NoError(t, err)
	require.NotNil(t, loaded)
	require.Equal(t, uint64(5000), loaded.deposit)
	again, err := scheme.loadChannel("confirmed")
	require.NoError(t, err)
	require.NotNil(t, again)
	missing, err := scheme.loadChannel("missing")
	require.NoError(t, err)
	require.Nil(t, missing)

	req := h.requirements("", nil)
	result, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Accepted: req, Payload: map[string]any{"type": "not-batch"}, X402Version: 2},
		Requirements:   req,
	})
	require.NoError(t, err)
	require.False(t, result.Recovered)

	voucher, err := NewBatchChannelTracker(svm.USDCMainnetAddress, config, h.payer, 0).PreviewVoucher(context.Background(), 1000)
	require.NoError(t, err)
	body, err := batchsettlement.WireMap(batchsettlement.BatchVoucherPayload{
		Type:          batchsettlement.PayloadTypeVoucher,
		ChannelConfig: config,
		Voucher:       voucher,
	})
	require.NoError(t, err)
	result, err = scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload: types.PaymentPayload{Accepted: req, Payload: body, X402Version: 2},
		Requirements:   req,
		SettleResponse: &x402.SettleResponse{Success: false},
	})
	require.NoError(t, err)
	require.False(t, result.Recovered)
}

func testValidatesTerms(t *testing.T) {
	h := newHarness(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{DiscoverChannels: nil})
	scheme.config.DiscoverChannels = nil
	req := h.requirements("", nil)
	terms, err := scheme.resolveTerms(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, h.feePayer.String(), terms.feePayer)
	require.Equal(t, solana.TokenProgramID.String(), terms.tokenProgram)
	require.Equal(t, 900, terms.withdrawDelay)

	memoReq := h.requirements("", map[string]any{
		batchsettlement.ExtraMemo:               "invoice",
		batchsettlement.ExtraReceiverAuthorizer: h.payer.Address().String(),
	})
	terms, err = scheme.resolveTerms(context.Background(), memoReq)
	require.NoError(t, err)
	require.NotNil(t, terms.memo)
	require.Equal(t, "invoice", *terms.memo)
	require.Equal(t, h.payer.Address().String(), terms.receiverAuthorizer)

	serverMode := h.requirements("", map[string]any{
		batchsettlement.ExtraOperator:      h.feePayer.String(),
		batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
	})
	_, err = scheme.resolveTerms(context.Background(), serverMode)
	require.ErrorContains(t, err, "Trust it explicitly")

	trusted, err := NewBatchSvmScheme(h.payer, &BatchSvmClientConfig{
		RPCURL: h.rpcURL,
		ServerSignedChannelsPolicy: &BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{h.feePayer.String()},
			MaxDeposit:       "$0.005",
		},
	})
	require.NoError(t, err)
	terms, err = trusted.resolveTerms(context.Background(), serverMode)
	require.NoError(t, err)
	require.Equal(t, h.feePayer.String(), terms.operator)
	require.Equal(t, batchsettlement.VoucherSignerServer, terms.voucherSigner)
	require.NotNil(t, terms.trust)
	require.Equal(t, h.feePayer.String(), terms.trust.Operator)
	require.NotNil(t, terms.trust.MaxDeposit)
	require.Equal(t, uint64(5000), *terms.trust.MaxDeposit)

	invalid := []types.PaymentRequirements{
		{Scheme: batchsettlement.Scheme, Network: testNetwork, Asset: testMint, Amount: "1000", PayTo: svm.USDCMainnetAddress, MaxTimeoutSeconds: 300},
		h.requirements("", map[string]any{batchsettlement.ExtraPaymentFlow: "upfront"}),
		h.requirements("", map[string]any{batchsettlement.ExtraFeePayer: ""}),
		h.requirements("", map[string]any{batchsettlement.ExtraWithdrawDelay: 899}),
		h.requirements("", map[string]any{batchsettlement.ExtraTokenProgram: h.payer.Address().String()}),
		h.requirements("", map[string]any{batchsettlement.ExtraReceiverAuthorizer: 1}),
		h.requirements("", map[string]any{batchsettlement.ExtraMemo: 1}),
		h.requirements("", map[string]any{batchsettlement.ExtraVoucherSigner: "other"}),
		h.requirements("", map[string]any{batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer}),
		h.requirements("", map[string]any{batchsettlement.ExtraOperator: h.feePayer.String()}),
	}
	for _, value := range invalid {
		_, err := scheme.resolveTerms(context.Background(), value)
		require.Error(t, err)
	}

	h.rpc.mu.Lock()
	h.rpc.owner = solana.Token2022ProgramID
	h.rpc.mu.Unlock()
	unowned, err := NewBatchSvmScheme(h.payer, &BatchSvmClientConfig{RPCURL: h.rpcURL})
	require.NoError(t, err)
	_, err = unowned.resolveTerms(context.Background(), req)
	require.ErrorContains(t, err, "does not own")
	h.rpc.mu.Lock()
	h.rpc.owner = solana.TokenProgramID
	h.rpc.mu.Unlock()

	badSalt, err := NewBatchSvmScheme(h.payer, &BatchSvmClientConfig{RPCURL: h.rpcURL, Salt: "bad"})
	require.NoError(t, err)
	_, err = badSalt.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.Error(t, err)

	short, err := NewBatchSvmScheme(h.payer, &BatchSvmClientConfig{
		RPCURL:           h.rpcURL,
		DepositAmount:    uint64(999),
		DiscoverChannels: boolPtr(false),
	})
	require.NoError(t, err)
	_, err = short.CreatePaymentPayload(context.Background(), req, x402.PaymentPayloadContext{})
	require.ErrorContains(t, err, "must cover")

	zero, err := NewBatchSvmScheme(h.payer, &BatchSvmClientConfig{RPCURL: h.rpcURL})
	require.NoError(t, err)
	_, err = zero.CreatePaymentPayload(context.Background(), h.requirements("0", nil), x402.PaymentPayloadContext{})
	require.ErrorContains(t, err, "must be positive")

	plain := h.scheme(t, &BatchSvmClientConfig{})
	payment := mustCreate(t, plain, req, x402.PaymentPayloadContext{})
	require.Equal(t, "deposit", payment.Payload["type"])
	require.Equal(t, "5000", nestedString(t, payment.Payload, "deposit", "amount"))
}

func testRefundFromCache(t *testing.T) {
	h := newHarness(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{})
	req := h.requirements("", nil)
	config := h.clientConfig()
	key := scheme.channelKey(req, h.feePayer.String(), 900)
	scheme.channels[key] = openChannel{
		deposit: 5000,
		tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, config, h.payer, 1000),
	}
	cooperative, err := scheme.CreateRefundPayload(context.Background(), 2, req, RefundPayloadOptions{})
	require.NoError(t, err)
	require.Equal(t, 2, cooperative.X402Version)
	require.Equal(t, "refund", cooperative.Payload["type"])
	require.Equal(t, svm.USDCMainnetAddress, nestedString(t, cooperative.Payload, "voucher", "channelId"))
	require.Equal(t, "1000", nestedString(t, cooperative.Payload, "voucher", "maxClaimableAmount"))
	_, hasTx := cooperative.Payload["transaction"]
	require.False(t, hasTx)

	fallback, err := scheme.CreateRefundPayload(context.Background(), 2, req, RefundPayloadOptions{WithTransaction: true})
	require.NoError(t, err)
	tx, _ := fallback.Payload["transaction"].(string)
	require.NotEmpty(t, tx)
	require.Equal(t, "1000", nestedString(t, fallback.Payload, "voucher", "maxClaimableAmount"))

	serverConfig := config
	serverConfig.VoucherSigner = batchsettlement.VoucherSignerServer
	scheme.channels[key] = openChannel{
		deposit: 5000,
		tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, serverConfig, h.payer, 1000),
	}
	serverRefund, err := scheme.CreateRefundPayload(context.Background(), 2, req, RefundPayloadOptions{})
	require.NoError(t, err)
	require.Equal(t, "0", nestedString(t, serverRefund.Payload, "authorization", "authorizedAmount"))
	require.Equal(t, svm.USDCMainnetAddress, nestedString(t, serverRefund.Payload, "authorization", "channelId"))
	_, hasVoucher := serverRefund.Payload["voucher"]
	require.False(t, hasVoucher)

	missing := h.scheme(t, &BatchSvmClientConfig{})
	_, err = missing.CreateRefundPayload(context.Background(), 2, req, RefundPayloadOptions{})
	require.ErrorIs(t, err, ErrNoBatchChannelToRefund)
}

func testRefundServerFirst(t *testing.T) {
	h := newHarness(t)
	operator := newKey(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{})
	req := h.requirements("", nil)
	config := h.clientConfig()
	config.VoucherSigner = batchsettlement.VoucherSignerClient
	key := scheme.channelKey(req, h.feePayer.String(), 900)
	scheme.channels[key] = openChannel{
		deposit: 5000,
		tracker: NewBatchChannelTracker(svm.USDCMainnetAddress, config, h.payer, 1000),
	}
	scheme.channelOrder = append(scheme.channelOrder, key)
	probe := h.requirements("", map[string]any{
		batchsettlement.ExtraOperator:      operator.Address().String(),
		batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
	})
	cooperative, err := scheme.CreateRefundPayload(context.Background(), 2, probe, RefundPayloadOptions{})
	require.NoError(t, err)
	require.Equal(t, 2, cooperative.X402Version)
	require.Equal(t, "refund", cooperative.Payload["type"])
	require.Equal(t, svm.USDCMainnetAddress, nestedString(t, cooperative.Payload, "voucher", "channelId"))
	require.Equal(t, "1000", nestedString(t, cooperative.Payload, "voucher", "maxClaimableAmount"))
}

func testRefundNoChannelServerProbe(t *testing.T) {
	h := newHarness(t)
	operator := newKey(t)
	scheme := h.scheme(t, &BatchSvmClientConfig{})
	probe := h.requirements("", map[string]any{
		batchsettlement.ExtraOperator:      operator.Address().String(),
		batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
	})
	_, err := scheme.CreateRefundPayload(context.Background(), 2, probe, RefundPayloadOptions{})
	require.ErrorContains(t, err, "no batch-settlement channel")
	require.ErrorIs(t, err, ErrNoBatchChannelToRefund)
}

func (h *harness) clientConfig() batchsettlement.BatchChannelConfig {
	return batchsettlement.BatchChannelConfig{
		OpenSlot:           123,
		Payer:              h.payer.Address().String(),
		PayerAuthorizer:    h.payer.Address().String(),
		Receiver:           svm.USDCMainnetAddress,
		ReceiverAuthorizer: h.receiverAuthorizer.String(),
		Salt:               "0",
		Token:              testMint,
		WithdrawDelay:      900,
	}
}

func mustCreate(t *testing.T, scheme *BatchSvmScheme, requirements types.PaymentRequirements, payloadCtx x402.PaymentPayloadContext) types.PaymentPayload {
	t.Helper()
	payment, err := scheme.CreatePaymentPayload(context.Background(), requirements, payloadCtx)
	require.NoError(t, err)
	return payment
}

func signedVoucher(t *testing.T, operator *PrivateKeySigner, channelID string, cumulative uint64) batchsettlement.BatchVoucher {
	t.Helper()
	signature, err := paymentchannels.SignVoucher(context.Background(), operator, solana.MustPublicKeyFromBase58(channelID), cumulative, 0)
	require.NoError(t, err)
	return batchsettlement.BatchVoucher{
		ChannelID:          channelID,
		MaxClaimableAmount: strconv.FormatUint(cumulative, 10),
		ExpiresAt:          0,
		Signature:          signature,
	}
}

func serverSettle(t *testing.T, operator *PrivateKeySigner, channelID string, cumulative uint64) map[string]any {
	t.Helper()
	return map[string]any{
		"channelState": map[string]any{"chargedCumulativeAmount": strconv.FormatUint(cumulative, 10)},
		"commitmentId": channelID + ":" + strconv.FormatUint(cumulative, 10),
		"voucher":      signedVoucher(t, operator, channelID, cumulative),
	}
}
