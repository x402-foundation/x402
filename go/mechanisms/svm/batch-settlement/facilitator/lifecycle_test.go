package facilitator

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchclient "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchFacilitatorLifecycle(t *testing.T) {
	ctx := context.Background()
	network := string(svm.SolanaDevnetCAIP2)
	mint := svm.USDCDevnetAddress
	receiver := svm.USDCMainnetAddress
	fixedSig := solana.Signature{1, 2, 3, 4, 5, 6, 7, 8}
	fixedSigStr := fixedSig.String()

	payerKey := mustKey(t)
	feePayerKey := mustKey(t)
	receiverAuthorizerKey := mustKey(t)
	payer, err := batchclient.NewPrivateKeySigner(payerKey.String())
	require.NoError(t, err)
	receiverAuthorizerAddr := receiverAuthorizerKey.PublicKey().String()

	channelID := svm.USDCMainnetAddress
	channelConfig := batchsettlement.BatchChannelConfig{
		OpenSlot:           1,
		Payer:              payer.Address().String(),
		PayerAuthorizer:    payer.Address().String(),
		Receiver:           receiver,
		ReceiverAuthorizer: receiverAuthorizerAddr,
		Salt:               "0",
		Token:              mint,
		WithdrawDelay:      900,
	}
	built, err := batchclient.BuildDepositPayload(ctx, batchclient.BuildDepositArgs{
		Payer:              payer,
		Receiver:           receiver,
		ReceiverAuthorizer: receiverAuthorizerAddr,
		Mint:               mint,
		FeePayer:           feePayerKey.PublicKey().String(),
		TokenProgram:       solana.TokenProgramID.String(),
		Blockhash:          solana.MustHashFromBase58(svm.USDCMainnetAddress),
		OpenSlot:           123,
		DepositAmount:      10_000,
		FirstCharge:        1_000,
		WithdrawDelay:      900,
	})
	require.NoError(t, err)
	actualChannelID := built.ChannelID
	actualDeposit := built.Payload

	requirements := func(overrides ...func(*types.PaymentRequirements)) types.PaymentRequirements {
		req := types.PaymentRequirements{
			Amount: "1000",
			Asset:  mint,
			Extra: map[string]any{
				batchsettlement.ExtraFeePayer:           feePayerKey.PublicKey().String(),
				batchsettlement.ExtraReceiverAuthorizer: receiverAuthorizerAddr,
				batchsettlement.ExtraTokenProgram:       svm.TokenProgramAddress,
				batchsettlement.ExtraWithdrawDelay:      900,
			},
			MaxTimeoutSeconds: 300,
			Network:           network,
			PayTo:             receiver,
			Scheme:            batchsettlement.Scheme,
		}
		for _, override := range overrides {
			override(&req)
		}
		return req
	}

	distHash, err := paymentchannels.GetChannelDistributionHash([]paymentchannels.Split{{
		Recipient: receiver, BPS: batchsettlement.FullSplitBPS,
	}})
	require.NoError(t, err)

	channel := func(overrides ...func(*generated.Channel)) *generated.Channel {
		ch := &generated.Channel{
			Discriminator:    uint8(generated.AccountDiscriminator_Channel),
			Bump:             1,
			Version:          1,
			Status:           uint8(generated.ChannelStatus_Open),
			Salt:             0,
			Deposit:          10_000,
			Settlement:       generated.SettlementWatermarks{},
			GracePeriod:      900,
			DistributionHash: distHash,
			Payer:            payer.Address(),
			Payee:            feePayerKey.PublicKey(),
			AuthorizedSigner: payer.Address(),
			Mint:             solana.MustPublicKeyFromBase58(mint),
			RentPayer:        feePayerKey.PublicKey(),
			OpenSlot:         1,
		}
		for _, override := range overrides {
			override(ch)
		}
		return ch
	}

	newSigner := func(t *testing.T, opts ...func(*lifecycleSigner)) *lifecycleSigner {
		t.Helper()
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayerKey
		s := &lifecycleSigner{
			scriptedSigner: inner,
			owner:          solana.TokenProgramID,
			exist:          true,
		}
		for _, opt := range opts {
			opt(s)
		}
		return s
	}

	newScheme := func(t *testing.T, signer svm.FacilitatorSvmSigner, cfg *Config) *BatchSvmScheme {
		t.Helper()
		if cfg == nil {
			cfg = &Config{}
		}
		return NewBatchSvmScheme(ctx, signer, cfg)
	}

	recordReceiverBinding := func(t *testing.T, storage paymentchannels.PaymentChannelStorage, network, channelID, authorizer string) {
		t.Helper()
		_, err := storage.RecordOpen(ctx, paymentchannels.PaymentChannelRecord{
			Network: network, ChannelID: channelID, ReceiverAuthorizer: authorizer, LastActivityAt: time.Now(),
		})
		require.NoError(t, err)
	}

	defaultTerms := BatchTerms{
		FeePayer:           feePayerKey.PublicKey().String(),
		ReceiverAuthorizer: receiverAuthorizerAddr,
		TokenProgram:       svm.TokenProgramAddress,
		WithdrawDelay:      900,
		VoucherSigner:      batchsettlement.VoucherSignerClient,
	}

	hookTerms := func(scheme *BatchSvmScheme, terms BatchTerms) {
		scheme.hooks.resolveTerms = func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error) {
			return terms, nil
		}
	}
	hookChannelID := func(scheme *BatchSvmScheme, id string) {
		scheme.hooks.deriveChannelID = func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error) {
			return id, nil
		}
	}
	skipWait := func(scheme *BatchSvmScheme) {
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
	}

	payment := func(payload any, req types.PaymentRequirements) types.PaymentPayload {
		return types.PaymentPayload{X402Version: 2, Accepted: req, Payload: asMap(t, payload)}
	}

	t.Run("requires a usable managed signer", func(t *testing.T) {
		require.Panics(t, func() {
			NewBatchSvmScheme(ctx, addressesOnlySigner{addrs: []solana.PublicKey{feePayerKey.PublicKey()}}, nil)
		})
		require.Panics(t, func() {
			s := newScriptedSigner(t, 1)
			s.keys = nil
			NewBatchSvmScheme(ctx, s, nil)
		})
	})

	for _, tc := range []struct {
		label string
		index int
	}{
		{"payer", 0},
		{"recipient", 1},
		{"payment-channel treasury", 2},
	} {
		label, missingIndex := tc.label, tc.index
		t.Run(fmt.Sprintf("identifies a missing %s settlement ATA", label), func(t *testing.T) {
			var readIndex int
			signer := newSigner(t)
			signer.accountFn = func(solana.PublicKey) *rpc.GetAccountInfoResult {
				exists := readIndex != missingIndex
				readIndex++
				if !exists {
					return &rpc.GetAccountInfoResult{}
				}
				return &rpc.GetAccountInfoResult{Value: &rpc.Account{Owner: solana.TokenProgramID}}
			}
			scheme := newScheme(t, signer, nil)
			err := scheme.assertSettlementAccounts(ctx, requirements(), payer.Address().String(), svm.TokenProgramAddress)
			require.ErrorContains(t, err, "missing "+label+" ATA")
			require.Equal(t, missingIndex+1, len(signer.accountCalls()))
		})
	}

	t.Run("identifies a settlement ATA owned by the wrong token program", func(t *testing.T) {
		signer := newSigner(t, func(s *lifecycleSigner) {
			s.owner = solana.Token2022ProgramID
		})
		scheme := newScheme(t, signer, nil)
		err := scheme.assertSettlementAccounts(ctx, requirements(), payer.Address().String(), svm.TokenProgramAddress)
		require.ErrorContains(t, err, "payer ATA is not owned by "+svm.TokenProgramAddress)
	})

	t.Run("requires account reads for settlement-path preflight", func(t *testing.T) {
		require.Panics(t, func() {
			NewBatchSvmScheme(ctx, noAccountSigner{inner: newScriptedSigner(t, 1)}, nil)
		})
	})

	t.Run("rejects a deposit during verify when its settlement path is unavailable", func(t *testing.T) {
		var ataReads int
		signer := newSigner(t)
		mintKey := solana.MustPublicKeyFromBase58(mint)
		signer.accountFn = func(account solana.PublicKey) *rpc.GetAccountInfoResult {
			if account.Equals(mintKey) {
				return &rpc.GetAccountInfoResult{Value: &rpc.Account{Owner: solana.TokenProgramID}}
			}
			// Settlement ATA preflight: first present, second missing (same as the TS mock sequence).
			ataReads++
			if ataReads == 1 {
				return &rpc.GetAccountInfoResult{Value: &rpc.Account{Owner: solana.TokenProgramID}}
			}
			return &rpc.GetAccountInfoResult{}
		}
		scheme := newScheme(t, signer, nil)
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		req := requirements()
		result, err := scheme.Verify(ctx, payment(actualDeposit, req), req, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrSettlementSimulation, result.InvalidReason, "message=%s", result.InvalidMessage)
	})

	t.Run("resolves valid channel terms and rejects malformed requirements", func(t *testing.T) {
		scheme := newScheme(t, newSigner(t), nil)
		terms, err := scheme.resolveTerms(ctx, channelConfig, requirements(), VoucherModeRequirements)
		require.NoError(t, err)
		require.Equal(t, feePayerKey.PublicKey().String(), terms.FeePayer)
		require.Equal(t, svm.TokenProgramAddress, terms.TokenProgram)
		require.Equal(t, 900, terms.WithdrawDelay)

		_, err = scheme.resolveTerms(ctx, channelConfig, requirements(func(r *types.PaymentRequirements) { r.Extra = nil }), VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrPaymentFlow)

		_, err = scheme.resolveTerms(ctx, channelConfig, requirements(func(r *types.PaymentRequirements) {
			delete(r.Extra, batchsettlement.ExtraFeePayer)
		}), VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrFeePayerMismatch)

		_, err = scheme.resolveTerms(ctx, channelConfig, requirements(func(r *types.PaymentRequirements) {
			r.Extra[batchsettlement.ExtraWithdrawDelay] = 10
		}), VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrWithdrawDelayOutOfRange)

		badConfig := channelConfig
		badConfig.Receiver = payer.Address().String()
		_, err = scheme.resolveTerms(ctx, badConfig, requirements(), VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)

		_, err = scheme.resolveTerms(ctx, channelConfig, requirements(func(r *types.PaymentRequirements) {
			r.Extra[batchsettlement.ExtraTokenProgram] = payer.Address().String()
		}), VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrTokenProgram)
	})

	t.Run("covers every facilitator term and channel-binding boundary", func(t *testing.T) {
		resolve := func(scheme *BatchSvmScheme, config batchsettlement.BatchChannelConfig, req types.PaymentRequirements) error {
			_, err := scheme.resolveTerms(ctx, config, req, VoucherModeRequirements)
			return err
		}
		valid := newScheme(t, newSigner(t), nil)
		token2022 := newScheme(t, newSigner(t, func(s *lifecycleSigner) { s.owner = solana.Token2022ProgramID }), nil)
		altAuthorizer := payer.Address().String()

		got, err := token2022.resolveTerms(ctx, func() batchsettlement.BatchChannelConfig {
			c := channelConfig
			c.ReceiverAuthorizer = altAuthorizer
			return c
		}(), requirements(func(r *types.PaymentRequirements) {
			r.Extra[batchsettlement.ExtraMemo] = "invoice"
			r.Extra[batchsettlement.ExtraReceiverAuthorizer] = altAuthorizer
			r.Extra[batchsettlement.ExtraTokenProgram] = svm.Token2022ProgramAddress
		}), VoucherModeRequirements)
		require.NoError(t, err)
		require.NotNil(t, got.Memo)
		require.Equal(t, "invoice", *got.Memo)
		require.Equal(t, altAuthorizer, got.ReceiverAuthorizer)

		cases := []struct {
			config batchsettlement.BatchChannelConfig
			req    types.PaymentRequirements
		}{
			{channelConfig, requirements(func(r *types.PaymentRequirements) {
				r.Extra[batchsettlement.ExtraPaymentFlow] = "upfront"
			})},
			{func() batchsettlement.BatchChannelConfig {
				c := channelConfig
				c.Payer = feePayerKey.PublicKey().String()
				return c
			}(), requirements()},
			{func() batchsettlement.BatchChannelConfig {
				c := channelConfig
				c.PayerAuthorizer = feePayerKey.PublicKey().String()
				return c
			}(), requirements()},
			{channelConfig, requirements(func(r *types.PaymentRequirements) {
				r.Extra[batchsettlement.ExtraWithdrawDelay] = 900.5
			})},
			{channelConfig, requirements(func(r *types.PaymentRequirements) {
				r.Extra[batchsettlement.ExtraWithdrawDelay] = 2_592_001
			})},
			{channelConfig, requirements(func(r *types.PaymentRequirements) { r.MaxTimeoutSeconds = 901 })},
			{func() batchsettlement.BatchChannelConfig {
				c := channelConfig
				c.WithdrawDelay = 901
				return c
			}(), requirements()},
			{func() batchsettlement.BatchChannelConfig {
				c := channelConfig
				c.ReceiverAuthorizer = altAuthorizer
				return c
			}(), requirements()},
			{channelConfig, requirements(func(r *types.PaymentRequirements) {
				r.Extra[batchsettlement.ExtraReceiverAuthorizer] = altAuthorizer
			})},
			{func() batchsettlement.BatchChannelConfig {
				c := channelConfig
				c.ReceiverAuthorizer = altAuthorizer
				return c
			}(), requirements(func(r *types.PaymentRequirements) {
				r.Extra[batchsettlement.ExtraReceiverAuthorizer] = feePayerKey.PublicKey().String()
			})},
			{channelConfig, requirements(func(r *types.PaymentRequirements) {
				r.Extra[batchsettlement.ExtraMemo] = 3
			})},
		}
		for _, c := range cases {
			require.Error(t, resolve(valid, c.config, c.req))
		}

		require.Panics(t, func() {
			NewBatchSvmScheme(ctx, noAccountSigner{inner: newScriptedSigner(t, 1)}, nil)
		})
		missingMint := newScheme(t, newSigner(t, func(s *lifecycleSigner) { s.exist = false }), nil)
		require.ErrorContains(t, resolve(missingMint, channelConfig, requirements()), batchsettlement.ErrTokenProgram)

		termsOK := defaultTerms
		assertClaim := func(value *generated.Channel, config batchsettlement.BatchChannelConfig, allowed []generated.ChannelStatus) error {
			return newScheme(t, newSigner(t), nil).assertClaimChannel(value, config, termsOK, requirements(), allowed)
		}
		mutations := []*generated.Channel{
			channel(func(c *generated.Channel) { c.Discriminator = 0 }),
			channel(func(c *generated.Channel) { c.Status = uint8(generated.ChannelStatus_Closing) }),
			channel(func(c *generated.Channel) { c.Payer = feePayerKey.PublicKey() }),
			channel(func(c *generated.Channel) { c.Payee = payer.Address() }),
			channel(func(c *generated.Channel) { c.RentPayer = payer.Address() }),
			channel(func(c *generated.Channel) { c.AuthorizedSigner = feePayerKey.PublicKey() }),
			channel(func(c *generated.Channel) { c.Mint = solana.MustPublicKeyFromBase58(receiver) }),
			channel(func(c *generated.Channel) { c.GracePeriod = 901 }),
			channel(func(c *generated.Channel) { c.Salt = 1 }),
			channel(func(c *generated.Channel) { c.OpenSlot = 2 }),
			channel(func(c *generated.Channel) { c.DistributionHash = [32]byte{} }),
			channel(func(c *generated.Channel) {
				var filled [32]byte
				for i := range filled {
					filled[i] = 1
				}
				c.DistributionHash = filled
			}),
		}
		for _, value := range mutations {
			require.ErrorContains(t, assertClaim(value, channelConfig, []generated.ChannelStatus{generated.ChannelStatus_Open}), batchsettlement.ErrChannelState)
		}
		require.NoError(t, assertClaim(channel(), channelConfig, []generated.ChannelStatus{generated.ChannelStatus_Open}))
	})

	t.Run("verifies scheme and network envelopes before channel reads", func(t *testing.T) {
		scheme := newScheme(t, newSigner(t), nil)
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 0)
		require.NoError(t, err)
		req := requirements()
		payload := payment(batchsettlement.BatchVoucherPayload{
			Type: batchsettlement.PayloadTypeVoucher, ChannelConfig: channelConfig, Voucher: voucher,
		}, req)
		badScheme := req
		badScheme.Scheme = "exact"
		result, err := scheme.Verify(ctx, payload, badScheme, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, "unsupported_scheme", result.InvalidReason)

		badNet := req
		badNet.Network = "solana:other"
		result, err = scheme.Verify(ctx, payload, badNet, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, "network_mismatch", result.InvalidReason)
	})

	t.Run("routes verify variants and classifies validation failures", func(t *testing.T) {
		scheme := newScheme(t, newSigner(t), nil)
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 0)
		require.NoError(t, err)
		deposit := batchsettlement.BatchDepositPayload{
			Type:          batchsettlement.PayloadTypeDeposit,
			ChannelConfig: channelConfig,
			Deposit:       batchsettlement.BatchDeposit{Amount: "10000", Transaction: "setup"},
			Voucher:       &voucher,
		}
		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{ChannelID: channelID}, nil
		}
		req := requirements()
		result, err := scheme.Verify(ctx, payment(deposit, req), req, nil)
		require.NoError(t, err)
		require.True(t, result.IsValid)
		require.Equal(t, channelID, result.Extra["channelId"])

		hookTerms(scheme, defaultTerms)
		hookChannelID(scheme, channelID)
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(), nil
		}
		scheme.hooks.validateDeposit = nil
		voucherPayment := batchsettlement.BatchVoucherPayload{
			Type: batchsettlement.PayloadTypeVoucher, ChannelConfig: channelConfig, Voucher: voucher,
		}
		result, err = scheme.Verify(ctx, payment(voucherPayment, req), req, nil)
		require.NoError(t, err)
		require.True(t, result.IsValid, "message=%s reason=%s", result.InvalidMessage, result.InvalidReason)
		require.Equal(t, channelID, result.Extra["channelId"])

		hookChannelID(scheme, payer.Address().String())
		result, err = scheme.Verify(ctx, payment(voucherPayment, req), req, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrChannelIDMismatch, result.InvalidReason)

		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{}, errors.New(batchsettlement.ErrVoucherSignature)
		}
		result, err = scheme.Verify(ctx, payment(deposit, req), req, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrVoucherSignature, result.InvalidReason)
		require.Equal(t, batchsettlement.ErrVoucherSignature, result.InvalidMessage)

		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{}, errors.New("plain validation failure")
		}
		result, err = scheme.Verify(ctx, payment(deposit, req), req, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, "transaction_failed", result.InvalidReason)
		require.Equal(t, "plain validation failure", result.InvalidMessage)

		result, err = scheme.Verify(ctx, types.PaymentPayload{
			X402Version: 2, Accepted: req, Payload: map[string]any{"nope": true},
		}, req, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrPayloadType, result.InvalidReason)
	})

	t.Run("verifies the payer proof behind server-mode payloads", func(t *testing.T) {
		operatorKey := mustKey(t)
		operator, err := batchclient.NewPrivateKeySigner(operatorKey.String())
		require.NoError(t, err)
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		recordReceiverBinding(t, storage, network, channelID, receiverAuthorizerAddr)
		scheme := newScheme(t, newSigner(t), &Config{ChannelStorage: storage})
		serverConfig := channelConfig
		serverConfig.PayerAuthorizer = operator.Address().String()
		serverConfig.VoucherSigner = batchsettlement.VoucherSignerServer
		serverReq := requirements(func(r *types.PaymentRequirements) {
			r.Extra[batchsettlement.ExtraOperator] = operator.Address().String()
			r.Extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
		})
		hookTerms(scheme, BatchTerms{
			FeePayer:           feePayerKey.PublicKey().String(),
			ReceiverAuthorizer: receiverAuthorizerAddr,
			TokenProgram:       svm.TokenProgramAddress,
			VoucherSigner:      batchsettlement.VoucherSignerServer,
			WithdrawDelay:      900,
		})
		hookChannelID(scheme, channelID)
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) { c.AuthorizedSigner = operator.Address() }), nil
		}
		expiresAt := time.Now().Unix() + 600
		proof, err := batchsettlement.SignBatchAuthorization(ctx, payer, channelID, operator.Address().String(), "request-1", 1_000, expiresAt)
		require.NoError(t, err)
		verify := func(authorization any) *x402.VerifyResponse {
			t.Helper()
			payload := map[string]any{
				"type":          batchsettlement.PayloadTypeAuthorization,
				"channelConfig": asMap(t, serverConfig),
				"authorization": asMap(t, authorization),
			}
			result, err := scheme.Verify(ctx, types.PaymentPayload{X402Version: 2, Accepted: serverReq, Payload: payload}, serverReq, nil)
			require.NoError(t, err)
			return result
		}
		ok := verify(proof)
		require.True(t, ok.IsValid)
		require.Equal(t, channelID, ok.Extra["channelId"])

		forgedSig := proof.Signature
		if forgedSig[0] == '1' {
			forgedSig = "2" + forgedSig[1:]
		} else {
			forgedSig = "1" + forgedSig[1:]
		}
		wrongOp, err := batchsettlement.SignBatchAuthorization(ctx, payer, channelID, feePayerKey.PublicKey().String(), "request-1", 1_000, expiresAt)
		require.NoError(t, err)
		forged := []batchsettlement.BatchAuthorization{
			func() batchsettlement.BatchAuthorization { a := proof; a.AuthorizedAmount = "2000"; return a }(),
			func() batchsettlement.BatchAuthorization {
				a := proof
				a.ChannelID = payer.Address().String()
				return a
			}(),
			func() batchsettlement.BatchAuthorization {
				a := proof
				a.Payer = feePayerKey.PublicKey().String()
				return a
			}(),
			func() batchsettlement.BatchAuthorization { a := proof; a.RequestID = "request-2"; return a }(),
			func() batchsettlement.BatchAuthorization { a := proof; a.ExpiresAt = expiresAt - 1200; return a }(),
			func() batchsettlement.BatchAuthorization { a := proof; a.Signature = forgedSig; return a }(),
			wrongOp,
		}
		for _, authorization := range forged {
			result := verify(authorization)
			require.False(t, result.IsValid)
			require.Equal(t, batchsettlement.ErrVoucherSignature, result.InvalidReason)
		}
		blank := proof
		blank.RequestID = ""
		for _, authorization := range []any{blank, nil} {
			result := verify(authorization)
			require.False(t, result.IsValid)
			require.Equal(t, batchsettlement.ErrPayloadType, result.InvalidReason)
		}
		deposit := batchsettlement.ParsedBatchPayload{
			Type:          batchsettlement.PayloadTypeDeposit,
			Authorization: &proof,
			ChannelConfig: serverConfig,
			Deposit:       &batchsettlement.BatchDeposit{Amount: "10000", Transaction: "setup"},
		}
		require.NoError(t, scheme.assertServerModeProof(deposit, channelID, serverReq, ProofAmountExact))
		missing := deposit
		missing.Authorization = nil
		require.ErrorContains(t, scheme.assertServerModeProof(missing, channelID, serverReq, ProofAmountExact), "payer proof missing")
	})

	t.Run("treats a server-mode payer proof as a ceiling only at settle", func(t *testing.T) {
		operatorKey := mustKey(t)
		operator, err := batchclient.NewPrivateKeySigner(operatorKey.String())
		require.NoError(t, err)
		scheme := newScheme(t, newSigner(t), nil)
		serverConfig := channelConfig
		serverConfig.PayerAuthorizer = operator.Address().String()
		serverConfig.VoucherSigner = batchsettlement.VoucherSignerServer
		serverReq := requirements(func(r *types.PaymentRequirements) {
			r.Extra[batchsettlement.ExtraOperator] = operator.Address().String()
			r.Extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
		})
		hookTerms(scheme, BatchTerms{
			FeePayer: feePayerKey.PublicKey().String(), ReceiverAuthorizer: receiverAuthorizerAddr,
			TokenProgram: svm.TokenProgramAddress, VoucherSigner: batchsettlement.VoucherSignerServer, WithdrawDelay: 900,
		})
		hookChannelID(scheme, channelID)
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		expiresAt := time.Now().Unix() + 600
		proof, err := batchsettlement.SignBatchAuthorization(ctx, payer, channelID, operator.Address().String(), "request-1", 1_000, expiresAt)
		require.NoError(t, err)
		deposit := map[string]any{
			"type":          batchsettlement.PayloadTypeDeposit,
			"authorization": asMap(t, proof),
			"channelConfig": asMap(t, serverConfig),
			"deposit":       map[string]any{"amount": "10000", "transaction": "setup"},
		}
		verify := func(amount string) *x402.VerifyResponse {
			t.Helper()
			req := serverReq
			req.Amount = amount
			result, err := scheme.Verify(ctx, types.PaymentPayload{X402Version: 2, Accepted: req, Payload: deposit}, req, nil)
			require.NoError(t, err)
			return result
		}
		settle := func(amount string) *x402.SettleResponse {
			t.Helper()
			req := serverReq
			req.Amount = amount
			result, err := scheme.Settle(ctx, types.PaymentPayload{X402Version: 2, Accepted: req, Payload: deposit}, req, nil)
			require.NoError(t, err)
			return result
		}
		v1000 := verify("1000")
		require.False(t, v1000.IsValid)
		require.NotEqual(t, batchsettlement.ErrVoucherSignature, v1000.InvalidReason)
		v500 := verify("500")
		require.False(t, v500.IsValid)
		require.Equal(t, batchsettlement.ErrVoucherSignature, v500.InvalidReason)

		higher, err := batchsettlement.SignBatchAuthorization(ctx, payer, channelID, operator.Address().String(), "request-1", 2_000, expiresAt)
		require.NoError(t, err)
		higherDeposit := map[string]any{
			"type": batchsettlement.PayloadTypeDeposit, "authorization": asMap(t, higher),
			"channelConfig": asMap(t, serverConfig), "deposit": map[string]any{"amount": "10000", "transaction": "setup"},
		}
		result, err := scheme.Verify(ctx, types.PaymentPayload{X402Version: 2, Accepted: serverReq, Payload: higherDeposit}, serverReq, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrVoucherSignature, result.InvalidReason)

		s500 := settle("500")
		require.False(t, s500.Success)
		require.NotEqual(t, batchsettlement.ErrVoucherSignature, s500.ErrorReason)
		s1000 := settle("1000")
		require.False(t, s1000.Success)
		require.NotEqual(t, batchsettlement.ErrVoucherSignature, s1000.ErrorReason)
		s1001 := settle("1001")
		require.False(t, s1001.Success)
		require.Equal(t, batchsettlement.ErrVoucherSignature, s1001.ErrorReason)

		hookTerms(scheme, BatchTerms{
			FeePayer: feePayerKey.PublicKey().String(), ReceiverAuthorizer: receiverAuthorizerAddr,
			TokenProgram: svm.TokenProgramAddress, VoucherSigner: batchsettlement.VoucherSignerClient, WithdrawDelay: 900,
		})
		hookChannelID(scheme, actualChannelID)
		clientSettle, err := scheme.Settle(ctx, payment(actualDeposit, requirements()), requirements(func(r *types.PaymentRequirements) {
			r.Amount = "500"
		}), nil)
		require.NoError(t, err)
		require.False(t, clientSettle.Success)
		require.Equal(t, batchsettlement.ErrCumulativeAmountMismatch, clientSettle.ErrorReason)
	})

	t.Run("redeems a client-signed channel when the worker requirements are server-signed", func(t *testing.T) {
		operatorKey := mustKey(t)
		scheme := newScheme(t, newSigner(t), nil)
		serverReq := requirements(func(r *types.PaymentRequirements) {
			r.Extra[batchsettlement.ExtraOperator] = operatorKey.PublicKey().String()
			r.Extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
		})
		terms, err := scheme.resolveTerms(ctx, channelConfig, serverReq, VoucherModePayload)
		require.NoError(t, err)
		require.Equal(t, batchsettlement.VoucherSignerClient, terms.VoucherSigner)
		_, err = scheme.resolveTerms(ctx, channelConfig, serverReq, VoucherModeRequirements)
		require.ErrorContains(t, err, batchsettlement.ErrChannelState)

		voucher := batchsettlement.BatchVoucher{ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1", Signature: "x"}
		for _, payload := range []any{
			batchsettlement.BatchClaimPayload{Type: batchsettlement.PayloadTypeClaim, Claims: []batchsettlement.BatchVoucherClaim{{
				ChannelConfig: channelConfig, ChannelID: channelID, Voucher: voucher,
			}}},
			batchsettlement.BatchSettlePayload{Type: batchsettlement.PayloadTypeSettle, Channels: []batchsettlement.BatchSettleChannel{{
				ChannelConfig: channelConfig, ChannelID: channelID,
			}}},
			batchsettlement.BatchSealPayload{Type: batchsettlement.PayloadTypeSeal, ChannelConfig: channelConfig, ChannelID: channelID, Voucher: voucher},
		} {
			result, err := scheme.Settle(ctx, payment(payload, serverReq), serverReq, nil)
			require.NoError(t, err)
			require.False(t, result.Success)
			require.NotEqual(t, batchsettlement.ErrChannelState, result.ErrorReason)
		}
	})

	t.Run("validates real open, voucher, and refund transactions", func(t *testing.T) {
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		scheme := newScheme(t, newSigner(t), &Config{ChannelStorage: storage})
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		req := requirements()
		result, err := scheme.Verify(ctx, payment(actualDeposit, req), req, nil)
		require.NoError(t, err)
		require.True(t, result.IsValid)
		require.Equal(t, actualChannelID, result.Extra["channelId"])

		recordReceiverBinding(t, storage, network, actualChannelID, receiverAuthorizerAddr)
		voucherPayment := batchsettlement.BatchVoucherPayload{
			Type: batchsettlement.PayloadTypeVoucher, ChannelConfig: actualDeposit.ChannelConfig, Voucher: *actualDeposit.Voucher,
		}
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.AuthorizedSigner = payer.Address()
				c.OpenSlot = 123
				c.Salt = mustParseU64(t, actualDeposit.ChannelConfig.Salt)
			}), nil
		}
		verified, err := scheme.Verify(ctx, payment(voucherPayment, req), req, nil)
		require.NoError(t, err)
		require.True(t, verified.IsValid)

		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.AuthorizedSigner = payer.Address()
				c.Deposit = 999
				c.OpenSlot = 123
				c.Salt = mustParseU64(t, actualDeposit.ChannelConfig.Salt)
			}), nil
		}
		result, err = scheme.Verify(ctx, payment(voucherPayment, req), req, nil)
		require.NoError(t, err)
		require.False(t, result.IsValid)
		require.Equal(t, batchsettlement.ErrCumulativeExceedsDeposit, result.InvalidReason)

		refund, err := batchclient.BuildRefundPayload(ctx, batchclient.BuildRefundArgs{
			ChannelConfig: actualDeposit.ChannelConfig,
			ChannelID:     actualChannelID,
			FeePayer:      feePayerKey.PublicKey().String(),
			Payer:         payer,
			Voucher:       actualDeposit.Voucher,
		})
		require.NoError(t, err)
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.AuthorizedSigner = payer.Address()
				c.OpenSlot = 123
				c.Salt = mustParseU64(t, actualDeposit.ChannelConfig.Salt)
			}), nil
		}
		verifyRefund := func(payload batchsettlement.BatchRefundPayload) *x402.VerifyResponse {
			t.Helper()
			result, err := scheme.Verify(ctx, payment(payload, req), req, nil)
			require.NoError(t, err)
			return result
		}
		require.True(t, verifyRefund(refund).IsValid)

		require.NoError(t, storage.Delete(ctx, network, actualChannelID))
		unbound := verifyRefund(refund)
		require.False(t, unbound.IsValid)
		require.Equal(t, batchsettlement.ErrReceiverBindingUnavailable, unbound.InvalidReason)

		blockhash := solana.MustHashFromBase58(svm.USDCMainnetAddress)
		fallback, err := batchclient.BuildRefundPayload(ctx, batchclient.BuildRefundArgs{
			ChannelConfig: actualDeposit.ChannelConfig,
			ChannelID:     actualChannelID,
			FeePayer:      feePayerKey.PublicKey().String(),
			Payer:         payer,
			Voucher:       actualDeposit.Voucher,
			Blockhash:     &blockhash,
		})
		require.NoError(t, err)
		require.True(t, verifyRefund(fallback).IsValid)
	})

	t.Run("routes facilitator settlement variants and converts thrown errors", func(t *testing.T) {
		scheme := newScheme(t, newSigner(t), nil)
		req := requirements()
		voucherStub := batchsettlement.BatchVoucher{ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1", Signature: "x"}

		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{
				ChannelID: channelID, Deposit: 1, ExpectedDeposit: 10_000, IsTopUp: false,
				Payload: batchsettlement.BatchDepositPayload{
					Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
					Deposit: batchsettlement.BatchDeposit{Amount: "1", Transaction: "x"}, Voucher: &voucherStub,
				},
				Terms: defaultTerms,
			}, nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(), nil
		}
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(), nil
		}
		depositResult, err := scheme.Settle(ctx, payment(batchsettlement.BatchDepositPayload{
			Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
			Deposit: batchsettlement.BatchDeposit{Amount: "1", Transaction: "x"}, Voucher: &voucherStub,
		}, req), req, nil)
		require.NoError(t, err)
		require.True(t, depositResult.Success, "reason=%s message=%s", depositResult.ErrorReason, depositResult.ErrorMessage)

		voucherResult, err := scheme.Settle(ctx, payment(batchsettlement.BatchVoucherPayload{
			Type: batchsettlement.PayloadTypeVoucher, ChannelConfig: channelConfig, Voucher: voucherStub,
		}, req), req, nil)
		require.NoError(t, err)
		require.False(t, voucherResult.Success)
		require.Equal(t, batchsettlement.ErrPayloadType, voucherResult.ErrorReason)

		// Error conversion through deposit settle path (voucher settle is terminal PAYLOAD_TYPE in Go).
		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{}, errors.New("rpc down")
		}
		failed, err := scheme.Settle(ctx, payment(batchsettlement.BatchDepositPayload{
			Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
			Deposit: batchsettlement.BatchDeposit{Amount: "1", Transaction: "x"}, Voucher: &voucherStub,
		}, req), req, nil)
		require.NoError(t, err)
		require.False(t, failed.Success)
		require.Equal(t, "transaction_failed", failed.ErrorReason)

		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{}, errors.New(batchsettlement.ErrVoucherSignature)
		}
		failed, err = scheme.Settle(ctx, payment(batchsettlement.BatchDepositPayload{
			Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
			Deposit: batchsettlement.BatchDeposit{Amount: "1", Transaction: "x"}, Voucher: &voucherStub,
		}, req), req, nil)
		require.NoError(t, err)
		require.False(t, failed.Success)
		require.Equal(t, batchsettlement.ErrVoucherSignature, failed.ErrorReason)
		require.Equal(t, batchsettlement.ErrVoucherSignature, failed.ErrorMessage)

		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{}, errors.New("duplicate_settlement: channel busy")
		}
		failed, err = scheme.Settle(ctx, payment(batchsettlement.BatchDepositPayload{
			Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
			Deposit: batchsettlement.BatchDeposit{Amount: "1", Transaction: "x"}, Voucher: &voucherStub,
		}, req), req, nil)
		require.NoError(t, err)
		require.False(t, failed.Success)
		require.Equal(t, ChannelBusy, failed.ErrorReason)

		failed, err = scheme.Settle(ctx, types.PaymentPayload{
			X402Version: 2, Accepted: req, Payload: map[string]any{"type": "bad"},
		}, req, nil)
		require.NoError(t, err)
		require.False(t, failed.Success)
		require.Equal(t, batchsettlement.ErrPayloadType, failed.ErrorReason)

		// Claim and settle success paths covered in dedicated subtests below.
		hookTerms(scheme, defaultTerms)
		hookChannelID(scheme, channelID)
		signed, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 0)
		require.NoError(t, err)
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) { return channel(), nil }
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.Settlement = generated.SettlementWatermarks{Settled: 1_000}
			}), nil
		}
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			return durableResult{OK: true, Signature: "claim"}, nil
		}
		skipWait(scheme)
		claimResult, err := scheme.Settle(ctx, payment(batchsettlement.BatchClaimPayload{
			Type: batchsettlement.PayloadTypeClaim,
			Claims: []batchsettlement.BatchVoucherClaim{{
				ChannelConfig: channelConfig, ChannelID: channelID,
				Voucher: batchsettlement.BatchVoucher{
					ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1000", Signature: signed.Signature,
				},
			}},
		}, req), req, nil)
		require.NoError(t, err)
		require.True(t, claimResult.Success)
		require.Equal(t, "claim", claimResult.Transaction)
	})

	t.Run("settles top-ups, idempotent opens, vouchers, and refunds", func(t *testing.T) {
		facilitatorSigner := newSigner(t)
		var simulated []string
		facilitatorSigner.simulateFn = func(_ context.Context, tx *solana.Transaction, _ string) error {
			wire, err := svm.EncodeTransaction(tx)
			if err == nil {
				simulated = append(simulated, wire)
			} else {
				simulated = append(simulated, "setup")
			}
			return nil
		}
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		scheme := newScheme(t, facilitatorSigner, &Config{ChannelStorage: storage})
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 0)
		require.NoError(t, err)
		deposit := batchsettlement.ParsedBatchPayload{
			Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
			Deposit: &batchsettlement.BatchDeposit{Amount: "1000", Transaction: "setup"}, Voucher: &voucher,
		}
		// Build a minimal signed wire for simulation of top-ups.
		tx, err := solana.NewTransaction(
			[]solana.Instruction{solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte("setup"))},
			solana.MustHashFromBase58("11111111111111111111111111111111"),
			solana.TransactionPayer(feePayerKey.PublicKey()),
		)
		require.NoError(t, err)
		_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
			if key.Equals(feePayerKey.PublicKey()) {
				return &feePayerKey
			}
			return nil
		})
		require.NoError(t, err)
		setupWire, err := svm.EncodeTransaction(tx)
		require.NoError(t, err)
		deposit.Deposit.Transaction = setupWire

		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{
				ChannelID: channelID, Deposit: 1_000, ExpectedDeposit: 11_000, IsTopUp: true,
				Payload: batchsettlement.BatchDepositPayload{
					Type: deposit.Type, ChannelConfig: channelConfig, Deposit: *deposit.Deposit, Voucher: &voucher,
				},
				Terms: defaultTerms,
			}, nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		scheme.hooks.broadcastDurably = func(context.Context, string, string, string, func(func(string, string) error) (string, error)) (durableResult, error) {
			return durableResult{OK: true, Signature: fixedSigStr}, nil
		}
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) { c.Deposit = 11_000 }), nil
		}
		req := requirements()
		topUp, err := scheme.settleDeposit(ctx, deposit, req, nil)
		require.NoError(t, err)
		require.True(t, topUp.Success)
		require.Equal(t, "1000", topUp.Amount)
		require.Equal(t, fixedSigStr, topUp.Transaction)
		require.NotEmpty(t, simulated)

		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{
				ChannelID: channelID, Deposit: 1_000, ExpectedDeposit: 10_000, IsTopUp: false,
				Payload: batchsettlement.BatchDepositPayload{
					Type: deposit.Type, ChannelConfig: channelConfig, Deposit: *deposit.Deposit, Voucher: &voucher,
				},
				Terms: defaultTerms,
			}, nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return channel(), nil }
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) { return channel(), nil }
		idempotent, err := scheme.settleDeposit(ctx, deposit, req, nil)
		require.NoError(t, err)
		require.True(t, idempotent.Success)
		require.Equal(t, "", idempotent.Transaction)

		voucherSettle, err := scheme.Settle(ctx, payment(batchsettlement.BatchVoucherPayload{
			Type: batchsettlement.PayloadTypeVoucher, ChannelConfig: channelConfig, Voucher: voucher,
		}, req), req, nil)
		require.NoError(t, err)
		require.False(t, voucherSettle.Success)
		require.Equal(t, batchsettlement.ErrPayloadType, voucherSettle.ErrorReason)

		refund := batchsettlement.BatchRefundPayload{Type: batchsettlement.PayloadTypeRefund, ChannelConfig: channelConfig, Voucher: &voucher}
		hookChannelID(scheme, channelID)
		recordReceiverBinding(t, storage, network, channelID, receiverAuthorizerAddr)
		scheme.hooks.sealDependencies = func() SealDependencies {
			deps := scheme.defaultSealDependencies()
			deps.PrepareRefund = func(context.Context, batchsettlement.BatchRefundPayload, types.PaymentRequirements, RefundLimits, any) (PreparedRefund, error) {
				return PreparedRefund{ChannelID: channelID, Terms: defaultTerms}, nil
			}
			deps.FetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return channel(func(c *generated.Channel) {
					c.ClosureStartedAt = 20
					c.Status = uint8(generated.ChannelStatus_Closing)
				}), nil
			}
			deps.ReadChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return channel(func(c *generated.Channel) {
					c.ClosureStartedAt = 20
					c.Status = uint8(generated.ChannelStatus_Closing)
				}), nil
			}
			return deps
		}
		closing, err := scheme.settleRefund(ctx, refund, req, nil)
		require.NoError(t, err)
		require.True(t, closing.Success)
		require.Equal(t, "", closing.Transaction)
		state, ok := closing.Extra["channelState"].(batchsettlement.BatchChannelState)
		require.True(t, ok)
		require.Equal(t, int64(20), state.WithdrawRequestedAt)

		require.NoError(t, storage.Delete(ctx, network, channelID))
		blockhash := solana.MustHashFromBase58(svm.USDCMainnetAddress)
		fallback, err := batchclient.BuildRefundPayload(ctx, batchclient.BuildRefundArgs{
			Blockhash: &blockhash, ChannelConfig: channelConfig, ChannelID: channelID,
			FeePayer: feePayerKey.PublicKey().String(), Payer: payer, Voucher: &voucher,
		})
		require.NoError(t, err)
		scheme.hooks.sealDependencies = func() SealDependencies {
			deps := scheme.defaultSealDependencies()
			deps.PrepareRefund = func(context.Context, batchsettlement.BatchRefundPayload, types.PaymentRequirements, RefundLimits, any) (PreparedRefund, error) {
				return PreparedRefund{ChannelID: channelID, RequestClose: fallback.Transaction, Terms: defaultTerms}, nil
			}
			return deps
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return channel(), nil }
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) { return channel(), nil }
		scheme.hooks.broadcastDurably = func(context.Context, string, string, string, func(func(string, string) error) (string, error)) (durableResult, error) {
			return durableResult{OK: true, Signature: fixedSigStr}, nil
		}
		skipWait(scheme)
		// beforeSend uses fetchChannel; postcondition uses fetchChannelUntil -> readChannel
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(), nil
		}
		// Re-set readChannel for until after fetchChannel open check: need open first then closing
		var fetchN int
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			fetchN++
			if fetchN == 1 {
				return channel(), nil
			}
			return channel(func(c *generated.Channel) {
				c.ClosureStartedAt = 20
				c.Status = uint8(generated.ChannelStatus_Closing)
			}), nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.ClosureStartedAt = 20
				c.Status = uint8(generated.ChannelStatus_Closing)
			}), nil
		}
		fallbackSettle, err := scheme.settleRefund(ctx, fallback, req, nil)
		require.NoError(t, err)
		require.True(t, fallbackSettle.Success)
		require.Equal(t, fixedSigStr, fallbackSettle.Transaction)
		fbState, ok := fallbackSettle.Extra["channelState"].(batchsettlement.BatchChannelState)
		require.True(t, ok)
		require.Equal(t, int64(20), fbState.WithdrawRequestedAt)

		scheme.hooks.sealDependencies = func() SealDependencies {
			deps := scheme.defaultSealDependencies()
			deps.PrepareRefund = func(context.Context, batchsettlement.BatchRefundPayload, types.PaymentRequirements, RefundLimits, any) (PreparedRefund, error) {
				return PreparedRefund{}, fmt.Errorf("%s", batchsettlement.ErrReceiverBindingUnavailable)
			}
			return deps
		}
		_, err = scheme.settleRefund(ctx, refund, req, nil)
		require.ErrorContains(t, err, batchsettlement.ErrReceiverBindingUnavailable)
	})

	t.Run("serializes opens by channel and releases the lock before broadcast failures", func(t *testing.T) {
		facilitatorSigner := newSigner(t)
		scheme := newScheme(t, facilitatorSigner, nil)
		voucher, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 0)
		require.NoError(t, err)
		deposit := batchsettlement.ParsedBatchPayload{
			Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
			Deposit: &batchsettlement.BatchDeposit{Amount: "1000", Transaction: "open-a"}, Voucher: &voucher,
		}
		scheme.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{
				ChannelID: channelID, Deposit: 1_000, ExpectedDeposit: 1_000, IsTopUp: false,
				Payload: batchsettlement.BatchDepositPayload{
					Type: deposit.Type, ChannelConfig: channelConfig, Deposit: *deposit.Deposit, Voucher: &voucher,
				},
				Terms: defaultTerms,
			}, nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		key := "batch:deposit:" + network + ":" + channelID
		require.False(t, scheme.settlementCache.IsDuplicate(key)) // seed pending
		req := requirements()
		for _, transaction := range []string{"open-a", "open-b"} {
			payload := deposit
			payload.Deposit = &batchsettlement.BatchDeposit{Amount: "1000", Transaction: transaction}
			result, err := scheme.settleDeposit(ctx, payload, req, nil)
			require.NoError(t, err)
			require.False(t, result.Success)
			require.Equal(t, ChannelBusy, result.ErrorReason)
		}

		simSigner := newSigner(t)
		simSigner.simulateFn = func(context.Context, *solana.Transaction, string) error {
			return errors.New("bad simulation")
		}
		simulation := newScheme(t, simSigner, nil)
		tx, err := solana.NewTransaction(
			[]solana.Instruction{solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte("open-a"))},
			solana.MustHashFromBase58("11111111111111111111111111111111"),
			solana.TransactionPayer(feePayerKey.PublicKey()),
		)
		require.NoError(t, err)
		_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
			if key.Equals(feePayerKey.PublicKey()) {
				return &feePayerKey
			}
			return nil
		})
		require.NoError(t, err)
		openWire, err := svm.EncodeTransaction(tx)
		require.NoError(t, err)
		topUpPayload := batchsettlement.ParsedBatchPayload{
			Type: batchsettlement.PayloadTypeDeposit, ChannelConfig: channelConfig,
			Deposit: &batchsettlement.BatchDeposit{Amount: "1000", Transaction: openWire}, Voucher: &voucher,
		}
		simulation.hooks.validateDeposit = func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error) {
			return ValidatedDeposit{
				ChannelID: channelID, Deposit: 1_000, ExpectedDeposit: 11_000, IsTopUp: true,
				Payload: batchsettlement.BatchDepositPayload{
					Type: topUpPayload.Type, ChannelConfig: channelConfig, Deposit: *topUpPayload.Deposit, Voucher: &voucher,
				},
				Terms: defaultTerms,
			}, nil
		}
		simulation.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		_, err = simulation.settleDeposit(ctx, topUpPayload, req, nil)
		require.ErrorContains(t, err, batchsettlement.ErrSettlementSimulation)
		topKey := "batch:topup:" + network + ":" + openWire
		_, held := simulation.settlementCache.Entries()[topKey]
		require.False(t, held)

		classifiedSigner := newSigner(t)
		classifiedSigner.simulateFn = func(context.Context, *solana.Transaction, string) error {
			return errors.New(batchsettlement.ErrSettlementSimulation + ": missing treasury ATA")
		}
		classified := newScheme(t, classifiedSigner, nil)
		classified.hooks.validateDeposit = simulation.hooks.validateDeposit
		classified.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		_, err = classified.settleDeposit(ctx, topUpPayload, req, nil)
		require.ErrorContains(t, err, batchsettlement.ErrSettlementSimulation+": missing treasury ATA")

		indexStorage := newActivityRecordingStorage()
		indexStorage.activityErr = errors.New("storage unavailable")
		indexing := newScheme(t, newSigner(t), &Config{ChannelStorage: indexStorage})
		indexing.hooks.validateDeposit = simulation.hooks.validateDeposit
		indexing.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		_, err = indexing.settleDeposit(ctx, topUpPayload, req, nil)
		require.ErrorContains(t, err, "storage unavailable")
		_, held = indexing.settlementCache.Entries()[topKey]
		require.False(t, held)
	})

	t.Run("prepares and confirms a voucher claim batch", func(t *testing.T) {
		storage := newActivityRecordingStorage()
		scheme := newScheme(t, newSigner(t), &Config{ChannelStorage: storage})
		hookTerms(scheme, defaultTerms)
		hookChannelID(scheme, channelID)
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) { return channel(), nil }
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.Settlement = generated.SettlementWatermarks{Settled: 1_000}
			}), nil
		}
		var submitted int
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			submitted++
			return durableResult{OK: true, Signature: fixedSigStr}, nil
		}
		skipWait(scheme)
		signed, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 0)
		require.NoError(t, err)
		payload := batchsettlement.BatchClaimPayload{
			Type: batchsettlement.PayloadTypeClaim,
			Claims: []batchsettlement.BatchVoucherClaim{{
				ChannelConfig: channelConfig, ChannelID: channelID,
				Voucher: batchsettlement.BatchVoucher{
					ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1000", Signature: signed.Signature,
				},
			}},
		}
		result, err := scheme.settleClaims(ctx, payload, requirements())
		require.NoError(t, err)
		require.True(t, result.Success)
		require.Equal(t, fixedSigStr, result.Transaction)
		accepts, ok := result.Extra["accepts"].([]any)
		require.True(t, ok)
		require.Len(t, accepts, 1)
		require.Equal(t, int32(1), storage.activityCalls.Load())
		require.Equal(t, 1, submitted)
	})

	t.Run("rejects invalid claim batches at each lifecycle boundary", func(t *testing.T) {
		signed, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 0)
		require.NoError(t, err)
		claim := func(overrides ...func(*batchsettlement.BatchVoucher)) batchsettlement.BatchClaimPayload {
			v := batchsettlement.BatchVoucher{
				ChannelID: channelID, ExpiresAt: 0, MaxClaimableAmount: "1000", Signature: signed.Signature,
			}
			for _, o := range overrides {
				o(&v)
			}
			return batchsettlement.BatchClaimPayload{
				Type: batchsettlement.PayloadTypeClaim,
				Claims: []batchsettlement.BatchVoucherClaim{{
					ChannelConfig: channelConfig, ChannelID: channelID, Voucher: v,
				}},
			}
		}
		configured := func(t *testing.T) *BatchSvmScheme {
			t.Helper()
			scheme := newScheme(t, newSigner(t), nil)
			hookTerms(scheme, defaultTerms)
			hookChannelID(scheme, channelID)
			scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) { return channel(), nil }
			scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return channel(func(c *generated.Channel) {
					c.Settlement = generated.SettlementWatermarks{Settled: 1_000}
				}), nil
			}
			scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
				return durableResult{OK: true, Signature: fixedSigStr}, nil
			}
			skipWait(scheme)
			return scheme
		}
		settle := func(scheme *BatchSvmScheme, payload batchsettlement.BatchClaimPayload) (*x402.SettleResponse, error) {
			return scheme.settleClaims(ctx, payload, requirements())
		}

		mismatch := configured(t)
		hookChannelID(mismatch, payer.Address().String())
		_, err = settle(mismatch, claim())
		require.ErrorContains(t, err, batchsettlement.ErrChannelIDMismatch)

		for _, value := range []uint64{0, 10_001} {
			bounds := configured(t)
			v, err := batchclient.SignBatchVoucher(ctx, payer, channelID, value, 0)
			require.NoError(t, err)
			_, err = settle(bounds, claim(func(voucher *batchsettlement.BatchVoucher) {
				voucher.MaxClaimableAmount = fmt.Sprintf("%d", value)
				voucher.Signature = v.Signature
			}))
			require.ErrorContains(t, err, batchsettlement.ErrCumulativeAmountMismatch)
		}
		signature := configured(t)
		_, err = settle(signature, claim(func(v *batchsettlement.BatchVoucher) { v.MaxClaimableAmount = "1001" }))
		require.ErrorContains(t, err, batchsettlement.ErrVoucherSignature)

		rejected := configured(t)
		rejected.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			return durableResult{Response: &x402.SettleResponse{ErrorReason: string(x402.ErrSettlementPending), Success: false}}, nil
		}
		result, err := settle(rejected, claim())
		require.NoError(t, err)
		require.False(t, result.Success)
		require.Equal(t, string(x402.ErrSettlementPending), result.ErrorReason)

		unconfirmed := configured(t)
		unconfirmed.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(), nil // settled watermark never reaches 1000
		}
		result, err = settle(unconfirmed, claim())
		require.NoError(t, err)
		require.False(t, result.Success)
		require.Equal(t, string(x402.ErrSettlementPending), result.ErrorReason)
		require.Equal(t, fixedSigStr, result.Transaction)

		split := configured(t)
		var resolveN int
		split.hooks.resolveTerms = func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error) {
			resolveN++
			if resolveN == 1 {
				return defaultTerms, nil
			}
			t2 := defaultTerms
			t2.FeePayer = payer.Address().String()
			return t2, nil
		}
		two := claim()
		two.Claims = append(two.Claims, two.Claims[0])
		_, err = settle(split, two)
		require.ErrorContains(t, err, batchsettlement.ErrFeePayerMismatch)
	})

	t.Run("prepares and confirms a distribution batch", func(t *testing.T) {
		inner := newScriptedSigner(t, 1)
		inner.keys[0] = feePayerKey
		signer := &capabilitySigner{
			scriptedSigner: inner,
			confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
				return lifecyclePayoutEvidence(t, channelID, receiver, mint, "200", "1000"), nil
			},
		}
		storage := newActivityRecordingStorage()
		scheme := newScheme(t, signer, &Config{ChannelStorage: storage})
		hookTerms(scheme, defaultTerms)
		hookChannelID(scheme, channelID)
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.Settlement = generated.SettlementWatermarks{PayoutWatermark: 200, Settled: 1_000}
			}), nil
		}
		scheme.hooks.distributeInstruction = func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error) {
			return solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress), nil, []byte{7}), nil
		}
		scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			return durableResult{OK: true, Signature: fixedSigStr}, nil
		}
		skipWait(scheme)
		payload := batchsettlement.BatchSettlePayload{
			Type: batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{
				ChannelConfig: channelConfig, ChannelID: channelID,
			}},
		}
		result, err := scheme.settleDistributions(ctx, payload, requirements())
		require.NoError(t, err)
		require.True(t, result.Success)
		require.Equal(t, "800", result.Amount)
		require.Equal(t, fixedSigStr, result.Transaction)
		require.Len(t, storage.activityRecords, 1)
		require.Equal(t, channelID, storage.activityRecords[0].ChannelID)
		require.Equal(t, int64(0), storage.activityRecords[0].ExpiresAt)
		require.Equal(t, network, storage.activityRecords[0].Network)
		require.Equal(t, receiver, storage.activityRecords[0].PayTo)
		require.Equal(t, svm.TokenProgramAddress, storage.activityRecords[0].TokenProgram)

		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel(func(c *generated.Channel) {
				c.Settlement = generated.SettlementWatermarks{PayoutWatermark: 200, Settled: 1_000}
			}), nil
		}
		result, err = scheme.settleDistributions(ctx, payload, requirements())
		require.NoError(t, err)
		require.True(t, result.Success)
		require.Equal(t, "800", result.Amount)
		require.Equal(t, fixedSigStr, result.Transaction)
		require.Equal(t, int32(2), storage.activityCalls.Load())
	})

	t.Run("rejects invalid distribution batches at each lifecycle boundary", func(t *testing.T) {
		payload := batchsettlement.BatchSettlePayload{
			Type: batchsettlement.PayloadTypeSettle,
			Channels: []batchsettlement.BatchSettleChannel{{
				ChannelConfig: channelConfig, ChannelID: channelID,
			}},
		}
		configured := func(t *testing.T) *BatchSvmScheme {
			t.Helper()
			inner := newScriptedSigner(t, 1)
			inner.keys[0] = feePayerKey
			signer := &capabilitySigner{
				scriptedSigner: inner,
				confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
					return lifecyclePayoutEvidence(t, channelID, receiver, mint, "200", "1000"), nil
				},
			}
			scheme := newScheme(t, signer, nil)
			hookTerms(scheme, defaultTerms)
			hookChannelID(scheme, channelID)
			scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
				return channel(func(c *generated.Channel) {
					c.Settlement = generated.SettlementWatermarks{PayoutWatermark: 0, Settled: 1_000}
				}), nil
			}
			scheme.hooks.distributeInstruction = func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error) {
				return solana.NewInstruction(solana.MustPublicKeyFromBase58(receiver), nil, []byte{7}), nil
			}
			scheme.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
				return durableResult{OK: true, Signature: fixedSigStr}, nil
			}
			skipWait(scheme)
			return scheme
		}
		settle := func(scheme *BatchSvmScheme, value batchsettlement.BatchSettlePayload) (*x402.SettleResponse, error) {
			return scheme.settleDistributions(ctx, value, requirements())
		}
		mismatch := configured(t)
		hookChannelID(mismatch, payer.Address().String())
		_, err := settle(mismatch, payload)
		require.ErrorContains(t, err, batchsettlement.ErrChannelIDMismatch)

		rejected := configured(t)
		rejected.hooks.submitRedemption = func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error) {
			return durableResult{Response: &x402.SettleResponse{Success: false, ErrorReason: string(x402.ErrSettlementPending)}}, nil
		}
		result, err := settle(rejected, payload)
		require.NoError(t, err)
		require.False(t, result.Success)

		unconfirmed := configured(t)
		// Go attributes payout from confirmed transaction metadata, not channel watermark polling.
		result, err = settle(unconfirmed, payload)
		require.NoError(t, err)
		require.True(t, result.Success)
		require.Equal(t, "800", result.Amount)
		require.Equal(t, fixedSigStr, result.Transaction)

		split := configured(t)
		_, err = settle(split, batchsettlement.BatchSettlePayload{
			Type:     batchsettlement.PayloadTypeSettle,
			Channels: append(append([]batchsettlement.BatchSettleChannel{}, payload.Channels...), payload.Channels...),
		})
		require.ErrorContains(t, err, batchsettlement.ErrPayloadType)
	})

	t.Run("rejects empty and oversized redemption batches", func(t *testing.T) {
		scheme := newScheme(t, newSigner(t), nil)
		_, err := scheme.settleClaims(ctx, batchsettlement.BatchClaimPayload{Claims: nil, Type: batchsettlement.PayloadTypeClaim}, requirements())
		require.ErrorContains(t, err, batchsettlement.ErrFeePayerMismatch)

		channels := make([]batchsettlement.BatchSettleChannel, MaxChannelsPerSettleTx+1)
		for i := range channels {
			channels[i] = batchsettlement.BatchSettleChannel{ChannelConfig: channelConfig, ChannelID: channelID}
		}
		_, err = scheme.settleDistributions(ctx, batchsettlement.BatchSettlePayload{
			Type: batchsettlement.PayloadTypeSettle, Channels: channels,
		}, requirements())
		require.ErrorContains(t, err, "invalid channel batch")
	})

	t.Run("persists, reconciles, and forgets durable broadcast signatures", func(t *testing.T) {
		facilitatorSigner := &confirmingSigner{scriptedSigner: newSigner(t).scriptedSigner, slot: 1}
		scheme := newScheme(t, facilitatorSigner, nil)
		first, err := scheme.broadcastDurably(ctx, "key", network, payer.Address().String(), func(onBroadcast func(string, string) error) (string, error) {
			require.NoError(t, onBroadcast(fixedSigStr, "signed-wire"))
			return fixedSigStr, nil
		})
		require.NoError(t, err)
		require.True(t, first.OK)
		require.Equal(t, fixedSigStr, first.Signature)

		pendingStore := &scriptedPendingStore{
			get: func(_ context.Context, key string) (string, bool, error) {
				if strings.HasSuffix(key, CompletedBroadcastSuffix) {
					return "", false, nil
				}
				return fixedSigStr, true, nil
			},
		}
		recoveringSigner := &confirmingSigner{scriptedSigner: newSigner(t).scriptedSigner, slot: 1}
		recovering := newScheme(t, recoveringSigner, &Config{
			PendingSettlementStore: pendingStore,
		})
		result, err := recovering.broadcastDurably(ctx, "key", network, payer.Address().String(), func(func(string, string) error) (string, error) {
			t.Fatal("should not broadcast")
			return "", nil
		})
		require.NoError(t, err)
		require.True(t, result.OK)
		require.Equal(t, fixedSigStr, result.Signature)
		calls := recoveringSigner.confirmCalls()
		require.NotEmpty(t, calls)
		require.NotNil(t, calls[0].opts)
		require.True(t, calls[0].opts.SearchTransactionHistory)
		require.Zero(t, pendingStore.deletes)
	})

	t.Run("distinguishes pre-broadcast, pending, and onchain-terminal failures", func(t *testing.T) {
		scheme := newScheme(t, newSigner(t), nil)
		_, err := scheme.broadcastDurably(ctx, "ordinary", network, payer.Address().String(), func(func(string, string) error) (string, error) {
			return "", errors.New("send failed")
		})
		require.ErrorContains(t, err, "send failed")

		pending, err := scheme.broadcastDurably(ctx, "pending", network, payer.Address().String(), func(func(string, string) error) (string, error) {
			return "", &paymentchannels.ChannelBroadcastConfirmationError{Signature: fixedSigStr, Err: errors.New("timeout")}
		})
		require.NoError(t, err)
		require.False(t, pending.OK)
		require.Equal(t, string(x402.ErrSettlementPending), pending.Response.ErrorReason)
		require.Equal(t, fixedSigStr, pending.Response.Transaction)

		terminalStore := &scriptedPendingStore{
			get: func(_ context.Context, key string) (string, bool, error) {
				if strings.HasSuffix(key, CompletedBroadcastSuffix) {
					return "", false, nil
				}
				return fixedSigStr, true, nil
			},
		}
		terminalInner := newSigner(t)
		terminalSigner := &confirmingSigner{scriptedSigner: terminalInner.scriptedSigner, slot: 1}
		terminalSigner.confirmErr = &svm.TransactionOnchainFailureError{Message: "failed"}
		// confirmingSigner.ConfirmTransactionWithOptions ignores confirmErr — wrap
		terminal := newScheme(t, &failConfirmSigner{
			scriptedSigner: terminalInner.scriptedSigner,
			err:            &svm.TransactionOnchainFailureError{Message: "failed"},
		}, &Config{
			PendingSettlementStore: terminalStore,
		})
		terminalResult, err := terminal.broadcastDurably(ctx, "terminal", network, payer.Address().String(), func(func(string, string) error) (string, error) {
			t.Fatal("should not broadcast")
			return "", nil
		})
		require.NoError(t, err)
		require.False(t, terminalResult.OK)
		require.Equal(t, "transaction_failed", terminalResult.Response.ErrorReason)
		require.Equal(t, fixedSigStr, terminalResult.Response.Transaction)
		require.NotZero(t, terminalStore.deletes)

		retryStore := &scriptedPendingStore{
			get: func(_ context.Context, key string) (string, bool, error) {
				if strings.HasSuffix(key, CompletedBroadcastSuffix) {
					return "", false, nil
				}
				return fixedSigStr, true, nil
			},
			deleteErr: errors.New("delete failed"),
		}
		retry := newScheme(t, &failConfirmSigner{
			scriptedSigner: newSigner(t).scriptedSigner,
			err:            errors.New("timeout"),
		}, &Config{
			PendingSettlementStore: retryStore,
		})
		retryResult, err := retry.broadcastDurably(ctx, "retry", network, payer.Address().String(), func(func(string, string) error) (string, error) {
			t.Fatal("should not broadcast")
			return "", nil
		})
		require.NoError(t, err)
		require.False(t, retryResult.OK)
		require.Equal(t, string(x402.ErrSettlementPending), retryResult.Response.ErrorReason)
	})

	t.Run("rejects invalid expiry, fee payer, deposit, and distribution arithmetic", func(t *testing.T) {
		scheme := newScheme(t, newSigner(t), nil)
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) { return nil, nil }
		hookChannelID(scheme, channelID)
		hookTerms(scheme, defaultTerms)
		badVoucher, err := batchclient.SignBatchVoucher(ctx, payer, channelID, 1_000, 1)
		require.NoError(t, err)
		_, err = scheme.validateDeposit(ctx, batchsettlement.ParsedBatchPayload{
			Type:          batchsettlement.PayloadTypeDeposit,
			ChannelConfig: channelConfig,
			Deposit:       &batchsettlement.BatchDeposit{Amount: "10000", Transaction: "setup"},
			Voucher:       &badVoucher,
		}, requirements(), ProofAmountExact)
		require.ErrorContains(t, err, batchsettlement.ErrVoucherExpiry)
		require.ErrorContains(t, scheme.resolveFeePayer(ctx, payer.Address().String()), batchsettlement.ErrFeePayerMismatch)
		require.ErrorContains(t, scheme.assertDepositChannel(
			channel(func(c *generated.Channel) { c.Deposit = 1 }),
			ValidatedDeposit{
				ExpectedDeposit: 2,
				Payload:         batchsettlement.BatchDepositPayload{ChannelConfig: channelConfig},
				Terms:           defaultTerms,
			},
			requirements(),
		), "confirmed deposit mismatch")
		_, err = CalculateDistributionAmount([]struct{ PayoutWatermark, Settled uint64 }{{PayoutWatermark: 2, Settled: 1}})
		require.ErrorContains(t, err, "payout watermark exceeds")
	})
}

type lifecycleSigner struct {
	*scriptedSigner
	owner      solana.PublicKey
	exist      bool
	accountFn  func(solana.PublicKey) *rpc.GetAccountInfoResult
	simulateFn func(context.Context, *solana.Transaction, string) error
	simulateN  int
}

func (s *lifecycleSigner) GetAccountInfo(ctx context.Context, account solana.PublicKey, network string, opts *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
	s.scriptedSigner.GetAccountInfo(ctx, account, network, opts)
	if s.accountFn != nil {
		return s.accountFn(account), nil
	}
	if !s.exist {
		return &rpc.GetAccountInfoResult{}, nil
	}
	return &rpc.GetAccountInfoResult{Value: &rpc.Account{Owner: s.owner}}, nil
}

func (s *lifecycleSigner) SimulateTransaction(ctx context.Context, tx *solana.Transaction, network string, opts *svm.FacilitatorSimulateTransactionOptions) error {
	s.simulateN++
	if s.simulateFn != nil {
		return s.simulateFn(ctx, tx, network)
	}
	return s.scriptedSigner.SimulateTransaction(ctx, tx, network, opts)
}

type addressesOnlySigner struct {
	addrs []solana.PublicKey
}

func (s addressesOnlySigner) GetAddresses(context.Context, string) []solana.PublicKey { return s.addrs }
func (s addressesOnlySigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return errors.New("unimplemented")
}
func (s addressesOnlySigner) SimulateTransaction(context.Context, *solana.Transaction, string, *svm.FacilitatorSimulateTransactionOptions) error {
	return errors.New("unimplemented")
}
func (s addressesOnlySigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	return solana.Signature{}, errors.New("unimplemented")
}
func (s addressesOnlySigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	return errors.New("unimplemented")
}

// noAccountSigner implements FacilitatorSvmSigner without GetAccountInfo.
type noAccountSigner struct{ inner *scriptedSigner }

func (s noAccountSigner) GetAddresses(ctx context.Context, network string) []solana.PublicKey {
	return s.inner.GetAddresses(ctx, network)
}
func (s noAccountSigner) SignTransaction(ctx context.Context, tx *solana.Transaction, feePayer solana.PublicKey, network string) error {
	return s.inner.SignTransaction(ctx, tx, feePayer, network)
}
func (s noAccountSigner) SimulateTransaction(ctx context.Context, tx *solana.Transaction, network string, opts *svm.FacilitatorSimulateTransactionOptions) error {
	return s.inner.SimulateTransaction(ctx, tx, network, opts)
}
func (s noAccountSigner) SendTransaction(ctx context.Context, tx *solana.Transaction, network string) (solana.Signature, error) {
	return s.inner.SendTransaction(ctx, tx, network)
}
func (s noAccountSigner) ConfirmTransaction(ctx context.Context, signature solana.Signature, network string) error {
	return s.inner.ConfirmTransaction(ctx, signature, network)
}

type failConfirmSigner struct {
	*scriptedSigner
	err error
}

func (s *failConfirmSigner) ConfirmTransactionWithOptions(
	_ context.Context, _ solana.Signature, _ string, _ *svm.FacilitatorConfirmOptions,
) (*svm.FacilitatorConfirmationStatus, error) {
	return nil, s.err
}

type scriptedPendingStore struct {
	mu        sync.Mutex
	get       func(context.Context, string) (string, bool, error)
	set       func(context.Context, string, string) error
	deleteErr error
	deletes   int
}

func (s *scriptedPendingStore) Get(ctx context.Context, key string) (string, bool, error) {
	if s.get != nil {
		return s.get(ctx, key)
	}
	return "", false, nil
}

func (s *scriptedPendingStore) Set(ctx context.Context, key, value string) error {
	if s.set != nil {
		return s.set(ctx, key, value)
	}
	return nil
}

func (s *scriptedPendingStore) Delete(context.Context, string) error {
	s.mu.Lock()
	s.deletes++
	s.mu.Unlock()
	return s.deleteErr
}

func lifecyclePayoutEvidence(t *testing.T, channelID, payTo, mintAddr, before, after string) *svm.FacilitatorConfirmedTransaction {
	t.Helper()
	tokenProgram := solana.MustPublicKeyFromBase58(svm.TokenProgramAddress)
	mintKey := solana.MustPublicKeyFromBase58(mintAddr)
	recipient, err := paymentchannels.FindATA(solana.MustPublicKeyFromBase58(payTo), mintKey, tokenProgram)
	require.NoError(t, err)
	escrow, err := paymentchannels.FindATA(solana.MustPublicKeyFromBase58(channelID), mintKey, tokenProgram)
	require.NoError(t, err)
	token := func(index int, owner, amount string) svm.FacilitatorTokenBalance {
		return svm.FacilitatorTokenBalance{
			AccountIndex: index, Mint: mintAddr, Owner: owner,
			UITokenAmount: svm.FacilitatorTokenAmount{Amount: amount},
		}
	}
	return &svm.FacilitatorConfirmedTransaction{
		Slot:        100,
		AccountKeys: []string{recipient.String(), escrow.String()},
		Meta: &svm.FacilitatorConfirmedMeta{
			PreTokenBalances:  []svm.FacilitatorTokenBalance{token(0, payTo, before), token(1, channelID, "9800")},
			PostTokenBalances: []svm.FacilitatorTokenBalance{token(0, payTo, after), token(1, channelID, "9000")},
		},
	}
}

func mustParseU64(t *testing.T, value string) uint64 {
	t.Helper()
	parsed, err := paymentchannels.ParseU64(value, "value")
	require.NoError(t, err)
	return parsed
}
