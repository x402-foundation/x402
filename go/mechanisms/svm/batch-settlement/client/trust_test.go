package client

import (
	"context"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestServerSignedTrustPolicy(t *testing.T) {
	h := newHarness(t)
	operator := newKey(t)
	other := newKey(t)

	t.Run("rejects malformed policies", func(t *testing.T) {
		_, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{AllowedOperators: []string{""}})
		require.ErrorContains(t, err, "non-empty")
		_, err = NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
			MaxDeposit:       "$0",
		})
		require.ErrorContains(t, err, "positive")
		_, err = NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedAssets: []ServerSignedChannelsAsset{{
				Asset:      testMint,
				MaxDeposit: "$1",
				Network:    testNetwork,
			}},
			AllowedOperators: []string{operator.Address().String()},
		})
		require.ErrorContains(t, err, "integer atomic amount, not a dollar value")
		require.True(t, IsServerSignedAccept(h.serverAccept(operator.Address().String(), nil)))
		require.False(t, IsServerSignedAccept(h.requirements("", nil)))
	})

	t.Run("grants only listed operators and refuses everything without a policy", func(t *testing.T) {
		empty, err := NewServerSignedTrustPolicy(nil)
		require.NoError(t, err)
		_, err = empty.GrantFor(h.serverAccept(operator.Address().String(), nil))
		require.ErrorAs(t, err, new(*UntrustedOperatorError))

		policy, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
		})
		require.NoError(t, err)
		_, err = policy.GrantFor(h.serverAccept(other.Address().String(), nil))
		require.ErrorContains(t, err, other.Address().String())
		require.ErrorContains(t, err, "allowedOperators")
		_, err = policy.GrantFor(h.requirements("", nil))
		require.ErrorAs(t, err, new(*UntrustedOperatorError))
	})

	t.Run("resolves the escrow cap like the core spend controls", func(t *testing.T) {
		policy, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
		})
		require.NoError(t, err)
		grant, err := policy.GrantFor(h.serverAccept(operator.Address().String(), nil))
		require.NoError(t, err)
		require.Equal(t, operator.Address().String(), grant.Operator)
		require.NotNil(t, grant.MaxDeposit)
		require.Equal(t, uint64(1_000_000), *grant.MaxDeposit)

		capped, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
			MaxDeposit:       "$0.05",
		})
		require.NoError(t, err)
		grant, err = capped.GrantFor(h.serverAccept(operator.Address().String(), nil))
		require.NoError(t, err)
		require.Equal(t, uint64(50_000), *grant.MaxDeposit)

		uncapped, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedOperators:  []string{operator.Address().String()},
			DisableMaxDeposit: true,
		})
		require.NoError(t, err)
		grant, err = uncapped.GrantFor(h.serverAccept(operator.Address().String(), nil))
		require.NoError(t, err)
		require.Nil(t, grant.MaxDeposit)

		exotic := h.serverAccept(operator.Address().String(), nil)
		exotic.Asset = h.feePayer.String()
		_, err = policy.GrantFor(exotic)
		require.ErrorContains(t, err, "not a default asset")
		require.ErrorContains(t, err, "allowedAssets")

		listed, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedAssets: []ServerSignedChannelsAsset{{
				Asset:      h.feePayer.String(),
				MaxDeposit: "777",
				Network:    "solana:*",
			}},
			AllowedOperators: []string{operator.Address().String()},
		})
		require.NoError(t, err)
		grant, err = listed.GrantFor(exotic)
		require.NoError(t, err)
		require.Equal(t, uint64(777), *grant.MaxDeposit)

		openAsset, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedAssets:    []ServerSignedChannelsAsset{{Asset: h.feePayer.String(), Network: testNetwork}},
			AllowedOperators: []string{operator.Address().String()},
		})
		require.NoError(t, err)
		grant, err = openAsset.GrantFor(exotic)
		require.NoError(t, err)
		require.Nil(t, grant.MaxDeposit)

		symbol, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedAssets:    []ServerSignedChannelsAsset{{Asset: "usdc", MaxDeposit: "42", Network: testNetwork}},
			AllowedOperators: []string{operator.Address().String()},
		})
		require.NoError(t, err)
		grant, err = symbol.GrantFor(h.serverAccept(operator.Address().String(), nil))
		require.NoError(t, err)
		require.Equal(t, uint64(42), *grant.MaxDeposit)
	})

	t.Run("filters accepts: drops untrusted server-signed ones and prefers trusted ones", func(t *testing.T) {
		policy, err := NewServerSignedTrustPolicy(&BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
		})
		require.NoError(t, err)
		evm := evmAccept()
		client := h.requirements("", nil)
		trusted := h.serverAccept(operator.Address().String(), nil)
		untrusted := h.serverAccept(other.Address().String(), nil)

		filtered, err := policy.FilterAccepts([]types.PaymentRequirements{untrusted, client, evm})
		require.NoError(t, err)
		require.Equal(t, []types.PaymentRequirements{client, evm}, filtered)

		filtered, err = policy.FilterAccepts([]types.PaymentRequirements{evm, client, trusted})
		require.NoError(t, err)
		require.Equal(t, []types.PaymentRequirements{evm, trusted, client}, filtered)

		filtered, err = policy.FilterAccepts([]types.PaymentRequirements{client, evm})
		require.NoError(t, err)
		require.Equal(t, []types.PaymentRequirements{client, evm}, filtered)

		_, err = policy.FilterAccepts([]types.PaymentRequirements{untrusted})
		require.ErrorContains(t, err, other.Address().String())
		require.ErrorContains(t, err, "allowedOperators")
	})
}

func TestServerSignedChannelsOnTheClientScheme(t *testing.T) {
	h := newHarness(t)
	operator := newKey(t)
	other := newKey(t)

	t.Run("never opens a server-signed channel without a grant", func(t *testing.T) {
		scheme := h.scheme(t, &BatchSvmClientConfig{})
		_, err := scheme.CreatePaymentPayload(context.Background(), h.serverAccept(operator.Address().String(), nil), x402.PaymentPayloadContext{})
		require.ErrorAs(t, err, new(*UntrustedOperatorError))

		listed := h.scheme(t, &BatchSvmClientConfig{ServerSignedChannelsPolicy: &BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{other.Address().String()},
		}})
		_, err = listed.CreatePaymentPayload(context.Background(), h.serverAccept(operator.Address().String(), nil), x402.PaymentPayloadContext{})
		require.ErrorContains(t, err, "Trust it explicitly")
	})

	t.Run("opens a server-signed channel for a listed operator on any transport", func(t *testing.T) {
		scheme := h.scheme(t, &BatchSvmClientConfig{ServerSignedChannelsPolicy: &BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
		}})
		payment := mustCreate(t, scheme, h.serverAccept(operator.Address().String(), nil), x402.PaymentPayloadContext{})
		require.Equal(t, "deposit", payment.Payload["type"])
		config := asMap(t, payment.Payload["channelConfig"])
		require.Equal(t, operator.Address().String(), config["payerAuthorizer"])
		require.Equal(t, "server", config["voucherSigner"])
	})

	t.Run("falls back to the client-signed accept through its own creation-failure hook", func(t *testing.T) {
		scheme := h.scheme(t, &BatchSvmClientConfig{})
		server := h.serverAccept(operator.Address().String(), nil)
		fallback := h.requirements("", nil)
		payloadCtx := x402.PaymentPayloadContext{MaxAmountPerPayment: "1000"}
		resource := &types.ResourceInfo{URL: "https://api.example.test/v1/infer"}
		required := &types.PaymentRequired{Accepts: []types.PaymentRequirements{server, fallback}, Resource: resource, X402Version: 2}
		_, err := scheme.CreatePaymentPayload(context.Background(), server, payloadCtx)
		require.ErrorAs(t, err, new(*UntrustedOperatorError))

		recovered, hookErr := scheme.OnPaymentCreationFailure(context.Background(), failureContext(err, required, server))
		require.NoError(t, hookErr)
		require.NotNil(t, recovered)
		require.True(t, recovered.Recovered)
		payload, ok := recovered.Payload.(types.PaymentPayload)
		require.True(t, ok)
		require.Equal(t, fallback, payload.Accepted)
		require.Equal(t, resource, payload.Resource)
		require.Equal(t, 2, payload.X402Version)
		require.Equal(t, "deposit", payload.Payload["type"])
		require.Equal(t, h.payer.Address().String(), asMap(t, payload.Payload["channelConfig"])["payerAuthorizer"])
		require.Equal(t, "5000", nestedString(t, payload.Payload, "deposit", "amount"))

		for _, accepts := range [][]types.PaymentRequirements{
			{server},
			{server, h.serverAccept(other.Address().String(), nil)},
			{server, h.requirements("2000", nil)},
		} {
			result, hookErr := scheme.OnPaymentCreationFailure(context.Background(), failureContext(err, &types.PaymentRequired{Accepts: accepts, Resource: resource, X402Version: 2}, server))
			require.NoError(t, hookErr)
			require.Nil(t, result)
		}
		result, hookErr := scheme.OnPaymentCreationFailure(context.Background(), failureContext(context.Canceled, required, server))
		require.NoError(t, hookErr)
		require.Nil(t, result)
	})

	t.Run("caps the escrow at the grant, ignoring larger server hints and fixed deposits", func(t *testing.T) {
		trust := &BatchServerSignedChannelsPolicy{AllowedOperators: []string{operator.Address().String()}, MaxDeposit: "$0.0025"}
		hinted := h.serverAccept(operator.Address().String(), map[string]any{batchsettlement.ExtraMinDeposit: "100000"})
		scheme := h.scheme(t, &BatchSvmClientConfig{ServerSignedChannelsPolicy: trust})
		payment := mustCreate(t, scheme, hinted, x402.PaymentPayloadContext{})
		require.Equal(t, "2500", nestedString(t, payment.Payload, "deposit", "amount"))

		fixed := h.scheme(t, &BatchSvmClientConfig{DepositAmount: uint64(50_000), ServerSignedChannelsPolicy: trust})
		payment = mustCreate(t, fixed, hinted, x402.PaymentPayloadContext{})
		require.Equal(t, "2500", nestedString(t, payment.Payload, "deposit", "amount"))

		over, err := NewBatchSvmScheme(h.payer, &BatchSvmClientConfig{
			RPCURL:                     h.rpcURL,
			DiscoverChannels:           boolPtr(false),
			ServerSignedChannelsPolicy: trust,
		})
		require.NoError(t, err)
		tooMuch := h.serverAccept(operator.Address().String(), nil)
		tooMuch.Amount = "3000"
		_, err = over.CreatePaymentPayload(context.Background(), tooMuch, x402.PaymentPayloadContext{})
		require.ErrorContains(t, err, "exceeds the remaining serverSignedChannelsPolicy maxDeposit")
	})

	t.Run("refuses a top-up that would push the escrow past the grant", func(t *testing.T) {
		scheme := h.scheme(t, &BatchSvmClientConfig{ServerSignedChannelsPolicy: &BatchServerSignedChannelsPolicy{
			AllowedOperators: []string{operator.Address().String()},
			MaxDeposit:       "$0.0025",
		}})
		accept := h.serverAccept(operator.Address().String(), nil)
		opened := mustCreate(t, scheme, accept, x402.PaymentPayloadContext{})
		channelID := nestedString(t, opened.Payload, "authorization", "channelId")
		settle := func(payment types.PaymentPayload, cumulative uint64) {
			t.Helper()
			respond(t, scheme, accept, payment, settleSuccess(map[string]any{
				"channelState": map[string]any{"chargedCumulativeAmount": strconv.FormatUint(cumulative, 10)},
				"commitmentId": channelID + ":" + strconv.FormatUint(cumulative, 10),
				"voucher":      signedVoucher(t, operator, channelID, cumulative),
			}), nil)
		}
		settle(opened, 1000)
		settle(mustCreate(t, scheme, accept, x402.PaymentPayloadContext{}), 2000)
		_, err := scheme.CreatePaymentPayload(context.Background(), accept, x402.PaymentPayloadContext{})
		require.ErrorContains(t, err, "2500 total, 2500 already escrowed")
	})

	t.Run("refunds server-signed channels with payer authorization only", func(t *testing.T) {
		accept := h.serverAccept(operator.Address().String(), nil)
		scheme := h.scheme(t, &BatchSvmClientConfig{
			DepositAmount: uint64(10_000),
			ServerSignedChannelsPolicy: &BatchServerSignedChannelsPolicy{
				AllowedOperators: []string{operator.Address().String()},
			},
		})
		opened := mustCreate(t, scheme, accept, x402.PaymentPayloadContext{})
		channelID := nestedString(t, opened.Payload, "authorization", "channelId")
		settle := func(payment types.PaymentPayload, cumulative uint64) {
			t.Helper()
			respond(t, scheme, accept, payment, settleSuccess(serverSettle(t, operator, channelID, cumulative)), nil)
		}
		settle(opened, 1000)
		settle(mustCreate(t, scheme, accept, x402.PaymentPayloadContext{}), 2000)
		refund, err := scheme.CreateRefundPayload(context.Background(), 2, accept, RefundPayloadOptions{})
		require.NoError(t, err)
		require.Equal(t, "refund", refund.Payload["type"])
		require.Equal(t, "0", nestedString(t, refund.Payload, "authorization", "authorizedAmount"))
		require.Equal(t, channelID, nestedString(t, refund.Payload, "authorization", "channelId"))
		_, hasVoucher := refund.Payload["voucher"]
		require.False(t, hasVoucher)
	})

	t.Run("refunds a server-signed channel when the probe returns a client-signed accept", func(t *testing.T) {
		accept := h.serverAccept(operator.Address().String(), nil)
		scheme := h.scheme(t, &BatchSvmClientConfig{
			DepositAmount: uint64(10_000),
			ServerSignedChannelsPolicy: &BatchServerSignedChannelsPolicy{
				AllowedOperators: []string{operator.Address().String()},
			},
		})
		opened := mustCreate(t, scheme, accept, x402.PaymentPayloadContext{})
		channelID := nestedString(t, opened.Payload, "authorization", "channelId")
		respond(t, scheme, accept, opened, settleSuccess(serverSettle(t, operator, channelID, 1000)), nil)
		refund, err := scheme.CreateRefundPayload(context.Background(), 2, h.requirements("", nil), RefundPayloadOptions{})
		require.NoError(t, err)
		require.Equal(t, "refund", refund.Payload["type"])
		require.Equal(t, "0", nestedString(t, refund.Payload, "authorization", "authorizedAmount"))
		require.Equal(t, channelID, nestedString(t, refund.Payload, "authorization", "channelId"))
		_, hasVoucher := refund.Payload["voucher"]
		require.False(t, hasVoucher)
	})

	t.Run("adopts a corrective 402 only up to what this client authorized", func(t *testing.T) {
		trust := &BatchServerSignedChannelsPolicy{AllowedOperators: []string{operator.Address().String()}}
		accept := h.serverAccept(operator.Address().String(), nil)
		run := func(corrective uint64) x402.PaymentResponseResult {
			t.Helper()
			scheme := h.scheme(t, &BatchSvmClientConfig{
				DepositAmount:              uint64(10_000),
				ServerSignedChannelsPolicy: trust,
			})
			opened := mustCreate(t, scheme, accept, x402.PaymentPayloadContext{})
			channelID := nestedString(t, opened.Payload, "authorization", "channelId")
			respond(t, scheme, accept, opened, settleSuccess(serverSettle(t, operator, channelID, 1000)), nil)
			next := mustCreate(t, scheme, accept, x402.PaymentPayloadContext{})
			voucher := signedVoucher(t, operator, channelID, corrective)
			return respond(t, scheme, accept, next, &x402.SettleResponse{
				Success:     false,
				ErrorReason: batchsettlement.ErrCumulativeAmountMismatch,
			}, &types.PaymentRequired{
				Error: batchsettlement.ErrCumulativeAmountMismatch,
				Accepts: []types.PaymentRequirements{withExtra(accept, map[string]any{
					batchsettlement.ExtraChannelState: map[string]any{
						"balance":                 "10000",
						"channelId":               channelID,
						"chargedCumulativeAmount": strconv.FormatUint(corrective, 10),
						"totalClaimed":            "0",
						"withdrawRequestedAt":     0,
					},
					batchsettlement.ExtraVoucherState: map[string]any{
						"expiresAt":          0,
						"signature":          voucher.Signature,
						"signedMaxClaimable": strconv.FormatUint(corrective, 10),
					},
				})},
			})
		}
		require.True(t, run(2000).Recovered)
		require.False(t, run(5000).Recovered)
	})
}

func failureContext(err error, required *types.PaymentRequired, selected types.PaymentRequirements) x402.PaymentCreationFailureContext {
	return x402.PaymentCreationFailureContext{
		PaymentCreationContext: x402.PaymentCreationContext{SelectedRequirements: selected},
		Error:                  err,
		PaymentRequired:        required,
	}
}

func (h *harness) serverAccept(operator string, extra map[string]any) types.PaymentRequirements {
	merged := map[string]any{
		batchsettlement.ExtraOperator:      operator,
		batchsettlement.ExtraVoucherSigner: batchsettlement.VoucherSignerServer,
	}
	for key, value := range extra {
		merged[key] = value
	}
	return h.requirements("", merged)
}

func evmAccept() types.PaymentRequirements {
	return types.PaymentRequirements{
		Amount:            "1000",
		Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		Extra:             map[string]any{},
		MaxTimeoutSeconds: 300,
		Network:           "eip155:84532",
		PayTo:             "0x0000000000000000000000000000000000000001",
		Scheme:            batchsettlement.Scheme,
	}
}

func asMap(t *testing.T, value any) map[string]any {
	t.Helper()
	record, ok := value.(map[string]any)
	require.True(t, ok)
	return record
}

func withExtra(requirements types.PaymentRequirements, extra map[string]any) types.PaymentRequirements {
	merged := map[string]any{}
	for key, value := range requirements.Extra {
		merged[key] = value
	}
	for key, value := range extra {
		merged[key] = value
	}
	requirements.Extra = merged
	return requirements
}
