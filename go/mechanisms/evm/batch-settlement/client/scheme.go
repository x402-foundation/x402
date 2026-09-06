package client

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	// DefaultDepositMultiplier is the default multiplier for the initial deposit.
	// It is applied to the per-request amount.
	DefaultDepositMultiplier = 5
	// DefaultWithdrawDelay is the default withdraw delay in seconds (15 min).
	DefaultWithdrawDelay = 900
	// DefaultSalt is the default channel salt (zero).
	DefaultSalt = "0x0000000000000000000000000000000000000000000000000000000000000000"
)

// DepositStrategyContext is supplied to a DepositStrategy callback before the
// client signs a deposit authorization.
type DepositStrategyContext struct {
	PaymentRequirements  types.PaymentRequirements
	ChannelConfig        batchsettlement.ChannelConfig
	ChannelId            string
	ClientContext        *BatchSettlementClientContext
	RequestAmount        string
	MaxClaimableAmount   string
	CurrentBalance       string
	MinimumDepositAmount string
	DepositAmount        string
}

// DepositStrategyResult is the return value of a DepositStrategy callback.
//
//   - Skip=true tells the client to send a voucher-only payload even when the
//     channel balance is insufficient. The downstream request will fail at
//     verify time; the caller is opting out of auto-top-up.
//   - Amount overrides the computed deposit. Must be a positive integer string
//     (base units) and at least MinimumDepositAmount, or the call errors.
//   - Both empty/zero means "use the SDK-computed amount".
type DepositStrategyResult struct {
	Skip   bool
	Amount string
}

// DepositStrategy is an optional caller hook for per-request deposit sizing.
type DepositStrategy func(ctx context.Context, c DepositStrategyContext) (DepositStrategyResult, error)

// BatchSettlementEvmSchemeOptions configures the batched client scheme.
//
// Use `DepositStrategy` for app-specific sizing or skipping.
type BatchSettlementEvmSchemeOptions struct {
	// DepositMultiplier is the multiplier applied to the required amount for deposits.
	// E.g., 5 means deposit 5× the per-request amount. Defaults to 5.
	DepositMultiplier int
	// DepositStrategy lets the caller override the computed deposit amount or
	// skip the deposit entirely (returning Skip=true sends a voucher-only
	// payload that will fail at verify if the channel balance is insufficient).
	// Optional.
	DepositStrategy DepositStrategy
	// Storage is the session persistence backend. Defaults to in-memory.
	Storage ClientChannelStorage
	// Salt is the channel salt for differentiating identical configs. Defaults to zero.
	Salt string
	// PayerAuthorizer is the EOA address used for voucher signing (separate from payer).
	// Zero address means the payer signs vouchers directly (ERC-1271).
	PayerAuthorizer string
	// VoucherSigner is an optional separate key for signing vouchers.
	VoucherSigner evm.ClientEvmSigner
}

// BatchSettlementEvmScheme implements SchemeNetworkClient for batched EVM payments.
type BatchSettlementEvmScheme struct {
	signer  evm.ClientEvmSigner
	config  BatchSettlementEvmSchemeOptions
	storage ClientChannelStorage
}

// NewBatchSettlementEvmScheme creates a new batched client scheme.
func NewBatchSettlementEvmScheme(signer evm.ClientEvmSigner, config *BatchSettlementEvmSchemeOptions) *BatchSettlementEvmScheme {
	cfg := BatchSettlementEvmSchemeOptions{
		DepositMultiplier: DefaultDepositMultiplier,
		Salt:              DefaultSalt,
	}
	if config != nil {
		if config.DepositMultiplier > 0 {
			cfg.DepositMultiplier = config.DepositMultiplier
		}
		if config.Storage != nil {
			cfg.Storage = config.Storage
		}
		if config.Salt != "" {
			cfg.Salt = config.Salt
		}
		cfg.DepositStrategy = config.DepositStrategy
		cfg.PayerAuthorizer = config.PayerAuthorizer
		cfg.VoucherSigner = config.VoucherSigner
	}

	storage := cfg.Storage
	if storage == nil {
		storage = NewInMemoryClientChannelStorage()
	}

	return &BatchSettlementEvmScheme{
		signer:  signer,
		config:  cfg,
		storage: storage,
	}
}

// Scheme returns the scheme identifier.
func (c *BatchSettlementEvmScheme) Scheme() string {
	return batchsettlement.SchemeBatched
}

func (c *BatchSettlementEvmScheme) FindDefaultAsset(asset string, network x402.Network) *x402.DefaultAsset {
	info := evm.FindDefaultAsset(asset, string(network))
	if info == nil {
		return nil
	}
	return &x402.DefaultAsset{Asset: info.Asset, Decimals: info.Decimals, Symbol: info.Symbol}
}

// CreatePaymentPayload creates a batched payment payload.
//
// The client loads local session state, falls back to onchain recovery when
// storage is empty, then chooses deposit vs voucher from the resulting context.
func (c *BatchSettlementEvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	channelConfig, err := c.BuildChannelConfig(requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	channelId, err := batchsettlement.ComputeChannelId(channelConfig, requirements.Network)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to compute channel ID: %w", err)
	}
	channelId, err = batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	session, err := c.storage.Get(channelId)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to get session: %w", err)
	}

	// Cold-start recovery: if storage has nothing, try to rebuild from the
	// onchain channel record. Best-effort — any error means we proceed as a
	// truly fresh deposit. We log the failure so misconfigured signers (e.g.
	// no RPC wired) surface immediately instead of silently signing vouchers
	// the facilitator will reject as cumulative_below_claimed.
	if session == nil {
		if _, ok := c.signer.(evm.ClientEvmSignerWithReadContract); ok {
			recovered, recErr := c.RecoverSession(ctx, requirements)
			if recErr != nil {
				log.Printf("[x402 batch-settlement] onchain channel recovery failed: %v "+
					"(proceeding as fresh deposit; this will fail if the channel already has onchain totalClaimed > 0)", recErr)
			} else {
				session = recovered
			}
		}
	}

	requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf("invalid amount: %s", requirements.Amount)
	}

	balance := big.NewInt(0)
	baseCumulative := big.NewInt(0)
	if session != nil {
		if v, ok := new(big.Int).SetString(session.Balance, 10); ok && v != nil {
			balance = v
		}
		if v, ok := new(big.Int).SetString(session.ChargedCumulativeAmount, 10); ok && v != nil {
			baseCumulative = v
		}
	}

	newCumulative := new(big.Int).Add(baseCumulative, requiredAmount)

	needsInitialDeposit := balance.Sign() == 0
	needsTopUp := !needsInitialDeposit && newCumulative.Cmp(balance) > 0

	if needsInitialDeposit || needsTopUp {
		computedDeposit := c.calculateDepositAmount(requiredAmount)
		minimumDeposit := new(big.Int).Sub(newCumulative, balance)
		if minimumDeposit.Sign() < 0 {
			minimumDeposit = big.NewInt(0)
		}
		strategyCtx := DepositStrategyContext{
			PaymentRequirements:  requirements,
			ChannelConfig:        channelConfig,
			ChannelId:            channelId,
			ClientContext:        session,
			RequestAmount:        requiredAmount.String(),
			MaxClaimableAmount:   newCumulative.String(),
			CurrentBalance:       balance.String(),
			MinimumDepositAmount: minimumDeposit.String(),
			DepositAmount:        computedDeposit.String(),
		}
		resolved, err := c.resolveDepositAmount(ctx, strategyCtx)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		if resolved.skip {
			return c.createVoucherPayload(ctx, channelId, channelConfig, newCumulative.String(), requirements)
		}
		return c.createDepositPayload(ctx, channelConfig, resolved.amount, newCumulative.String(), requirements)
	}

	return c.createVoucherPayload(ctx, channelId, channelConfig, newCumulative.String(), requirements)
}

// resolveDepositAmountResult is the internal output of resolveDepositAmount.
type resolveDepositAmountResult struct {
	amount string
	skip   bool
}

// resolveDepositAmount applies the optional DepositStrategy callback to the
// computed deposit amount.
func (c *BatchSettlementEvmScheme) resolveDepositAmount(
	ctx context.Context,
	strategyCtx DepositStrategyContext,
) (resolveDepositAmountResult, error) {
	if c.config.DepositStrategy == nil {
		return resolveDepositAmountResult{amount: strategyCtx.DepositAmount}, nil
	}
	res, err := c.config.DepositStrategy(ctx, strategyCtx)
	if err != nil {
		return resolveDepositAmountResult{}, fmt.Errorf("deposit strategy: %w", err)
	}
	if res.Skip {
		return resolveDepositAmountResult{skip: true}, nil
	}
	if res.Amount == "" {
		return resolveDepositAmountResult{amount: strategyCtx.DepositAmount}, nil
	}
	amount, ok := new(big.Int).SetString(res.Amount, 10)
	if !ok || amount.Sign() <= 0 {
		return resolveDepositAmountResult{}, fmt.Errorf("depositStrategy must return a positive integer deposit amount, got %q", res.Amount)
	}
	minimum, _ := new(big.Int).SetString(strategyCtx.MinimumDepositAmount, 10)
	if minimum != nil && amount.Cmp(minimum) < 0 {
		return resolveDepositAmountResult{}, fmt.Errorf(
			"depositStrategy returned %s, below required top-up %s",
			amount.String(), minimum.String())
	}
	return resolveDepositAmountResult{amount: amount.String()}, nil
}

// BuildChannelConfig constructs a ChannelConfig from payment requirements and scheme config.
//
// Returns an error when `requirements.Extra["receiverAuthorizer"]` is missing
// or zero — without it the derived channelId would not match the onchain
// channel and the deposit transaction would revert.
func (c *BatchSettlementEvmScheme) BuildChannelConfig(requirements types.PaymentRequirements) (batchsettlement.ChannelConfig, error) {
	var receiverAuthorizer string
	if requirements.Extra != nil {
		if ra, ok := requirements.Extra["receiverAuthorizer"].(string); ok {
			receiverAuthorizer = ra
		}
	}
	if receiverAuthorizer == "" || strings.EqualFold(receiverAuthorizer, "0x0000000000000000000000000000000000000000") {
		return batchsettlement.ChannelConfig{}, fmt.Errorf("payment requirements must include a non-zero extra.receiverAuthorizer")
	}

	withdrawDelay := DefaultWithdrawDelay
	if requirements.Extra != nil {
		switch v := requirements.Extra["withdrawDelay"].(type) {
		case float64:
			withdrawDelay = int(v)
		case int:
			withdrawDelay = v
		}
	}

	// Authorizer resolution order:
	// explicit `PayerAuthorizer` -> `VoucherSigner.Address()` -> `signer.Address()`.
	// Falling straight through to the signer when a voucher signer is configured
	// would commit the wrong authorizer into the channel and the facilitator
	// would later reject vouchers signed by the voucher key.
	payerAuthorizer := c.config.PayerAuthorizer
	if payerAuthorizer == "" {
		if c.config.VoucherSigner != nil {
			payerAuthorizer = c.config.VoucherSigner.Address()
		} else {
			payerAuthorizer = c.signer.Address()
		}
	}

	return batchsettlement.ChannelConfig{
		Payer:              c.signer.Address(),
		PayerAuthorizer:    payerAuthorizer,
		Receiver:           requirements.PayTo,
		ReceiverAuthorizer: receiverAuthorizer,
		Token:              requirements.Asset,
		WithdrawDelay:      withdrawDelay,
		Salt:               c.config.Salt,
	}, nil
}

// Refund sends a cooperative refund request to the channel that backs `url`.
// On success, the local session is updated (or deleted on full refund) and the
// parsed SettleResponse is returned.
func (c *BatchSettlementEvmScheme) Refund(ctx context.Context, url string, options *RefundOptions) (*x402.SettleResponse, error) {
	return RefundChannel(ctx, &refundContextAdapter{scheme: c}, url, options)
}

// ChannelSettleLocal is the client-owned input for applying a deposit or voucher settle.
//
// RequestAmount is the per-request maximum (PaymentRequirements.amount);
// the voucher ceiling was chargedCumulativeAmount + requestAmount.
// DepositAmount is payload.deposit.amount for this payment and is added to
// previous local balance after settle. Omit it on voucher-only.
type ChannelSettleLocal struct {
	ChannelId     string
	RequestAmount string
	DepositAmount *string
}

// ChannelSettleServer is the untrusted settlement response fields used when
// applying a deposit or voucher settle.
type ChannelSettleServer struct {
	ChargedAmount           *string
	ChargedCumulativeAmount *string
}

// OnPaymentResponse implements x402.PaymentResponseHandler so the transport can
// auto-sync local session state after every paid response.
//
// On a successful settle, updates local channel state from previous state plus
// capped chargedAmount and any client-signed deposit. Server channelState
// fields are never copied. Failed settlements leave local state unchanged.
//
// On a corrective 402 (PAYMENT-REQUIRED carrying batch_settlement_cumulative_*
// or signature recovery data), runs ProcessCorrectivePaymentRequired and reports
// Recovered=true so the transport retries once with a freshly built payload.
func (c *BatchSettlementEvmScheme) OnPaymentResponse(
	ctx context.Context,
	prCtx x402.PaymentResponseContext,
) (x402.PaymentResponseResult, error) {
	if prCtx.SettleResponse != nil {
		if !prCtx.SettleResponse.Success {
			return x402.PaymentResponseResult{}, nil
		}

		config, err := c.BuildChannelConfig(prCtx.Requirements)
		if err != nil {
			return x402.PaymentResponseResult{}, err
		}
		channelId, err := batchsettlement.ComputeChannelId(config, prCtx.Requirements.Network)
		if err != nil {
			return x402.PaymentResponseResult{}, fmt.Errorf("compute channel id: %w", err)
		}

		payload := prCtx.PaymentPayload.Payload
		if batchsettlement.IsRefundPayload(payload) {
			var refundAmount *string
			if amount, ok := payload["amount"].(string); ok {
				refundAmount = &amount
			}
			if err := UpdateSessionAfterRefund(c.storage, strings.ToLower(channelId), refundAmount); err != nil {
				return x402.PaymentResponseResult{}, fmt.Errorf("update channel after refund: %w", err)
			}
			return x402.PaymentResponseResult{}, nil
		}

		var chargedAmount *string
		if extra := prCtx.SettleResponse.Extra; extra != nil {
			if v, ok := extra["chargedAmount"]; ok {
				s, isString := v.(string)
				if !isString {
					return x402.PaymentResponseResult{}, fmt.Errorf("invalid chargedAmount: not a non-negative integer")
				}
				chargedAmount = &s
			}
		}
		var chargedCumulativeAmount *string
		if extra := prCtx.SettleResponse.Extra; extra != nil {
			if cs, ok := extra["channelState"].(map[string]interface{}); ok && cs != nil {
				if v, ok := cs["chargedCumulativeAmount"].(string); ok {
					chargedCumulativeAmount = &v
				}
			}
		}
		var depositAmount *string
		if batchsettlement.IsDepositPayload(payload) {
			if deposit, ok := payload["deposit"].(map[string]interface{}); ok {
				if amount, ok := deposit["amount"].(string); ok {
					depositAmount = &amount
				}
			}
		}

		if err := UpdateChannelFromSettle(c.storage, ChannelSettleServer{
			ChargedAmount:           chargedAmount,
			ChargedCumulativeAmount: chargedCumulativeAmount,
		}, ChannelSettleLocal{
			ChannelId:     channelId,
			RequestAmount: prCtx.Requirements.Amount,
			DepositAmount: depositAmount,
		}); err != nil {
			return x402.PaymentResponseResult{}, err
		}
		return x402.PaymentResponseResult{}, nil
	}

	if prCtx.PaymentRequired != nil {
		recovered, err := c.ProcessCorrectivePaymentRequired(
			ctx,
			prCtx.PaymentRequired.Error,
			prCtx.PaymentRequired.Accepts,
		)
		if err != nil {
			return x402.PaymentResponseResult{}, fmt.Errorf("process corrective payment required: %w", err)
		}
		return x402.PaymentResponseResult{Recovered: recovered}, nil
	}

	return x402.PaymentResponseResult{}, nil
}

// UpdateChannelFromSettle updates local channel state after a deposit or voucher settle.
//
// Next cumulative is previous local chargedCumulativeAmount plus
// server.ChargedAmount (capped at local.RequestAmount). Next balance is
// previous local balance plus local.DepositAmount when present;
// voucher-only leaves balance unchanged. The write is skipped when extra
// chargedCumulativeAmount is present and is not a non-negative integer equal
// to that next cumulative. Server channelState fields are never copied.
func UpdateChannelFromSettle(storage ClientChannelStorage, server ChannelSettleServer, local ChannelSettleLocal) error {
	chargedAmount := big.NewInt(0)
	if server.ChargedAmount != nil {
		s := *server.ChargedAmount
		if s == "" {
			return fmt.Errorf("invalid chargedAmount: not a non-negative integer")
		}
		for i := 0; i < len(s); i++ {
			if s[i] < '0' || s[i] > '9' {
				return fmt.Errorf("invalid chargedAmount: not a non-negative integer")
			}
		}
		chargedAmount.SetString(s, 10)
	}
	requestAmount, ok := new(big.Int).SetString(local.RequestAmount, 10)
	if !ok {
		return fmt.Errorf("invalid requestAmount")
	}
	if chargedAmount.Cmp(requestAmount) > 0 {
		return fmt.Errorf("settle response chargedAmount exceeds PaymentRequirements.amount")
	}

	previous, err := storage.Get(local.ChannelId)
	if err != nil {
		return fmt.Errorf("get channel session: %w", err)
	}
	var depositAmount *big.Int
	if local.DepositAmount != nil {
		d, ok := new(big.Int).SetString(*local.DepositAmount, 10)
		if !ok {
			return fmt.Errorf("invalid depositAmount")
		}
		depositAmount = d
	}

	if previous == nil && chargedAmount.Sign() == 0 && depositAmount == nil {
		return nil
	}

	prevCharged := big.NewInt(0)
	if previous != nil && previous.ChargedCumulativeAmount != "" {
		if v, ok := new(big.Int).SetString(previous.ChargedCumulativeAmount, 10); ok {
			prevCharged = v
		}
	}
	nextChargedCumulative := new(big.Int).Add(prevCharged, chargedAmount)
	if server.ChargedCumulativeAmount != nil {
		s := *server.ChargedCumulativeAmount
		valid := s != ""
		for i := 0; valid && i < len(s); i++ {
			if s[i] < '0' || s[i] > '9' {
				valid = false
			}
		}
		if !valid {
			return nil
		}
		reported, _ := new(big.Int).SetString(s, 10)
		if reported.Cmp(nextChargedCumulative) != 0 {
			return nil
		}
	}

	next := &BatchSettlementClientContext{}
	if previous != nil {
		*next = *previous
	}
	next.ChargedCumulativeAmount = nextChargedCumulative.String()
	if depositAmount != nil {
		prevBalance := big.NewInt(0)
		if previous != nil && previous.Balance != "" {
			if v, ok := new(big.Int).SetString(previous.Balance, 10); ok {
				prevBalance = v
			}
		}
		next.Balance = new(big.Int).Add(prevBalance, depositAmount).String()
	}
	return storage.Set(local.ChannelId, next)
}

// HasSession checks if a session exists for the given channel ID.
func (c *BatchSettlementEvmScheme) HasSession(channelId string) bool {
	session, _ := c.storage.Get(channelId)
	return session != nil
}

// GetSession returns the session for the given channel ID.
func (c *BatchSettlementEvmScheme) GetSession(channelId string) (*BatchSettlementClientContext, bool) {
	session, err := c.storage.Get(channelId)
	if err != nil || session == nil {
		return nil, false
	}
	return session, true
}

// RecoverSession rebuilds a client session from onchain channel state.
// Requires the signer to implement ClientEvmSignerWithReadContract.
// This allows recovery after a cold start or in-memory session loss.
func (c *BatchSettlementEvmScheme) RecoverSession(ctx context.Context, requirements types.PaymentRequirements) (*BatchSettlementClientContext, error) {
	readSigner, ok := c.signer.(evm.ClientEvmSignerWithReadContract)
	if !ok {
		return nil, fmt.Errorf("recoverSession requires ClientEvmSigner with ReadContract capability")
	}

	channelConfig, err := c.BuildChannelConfig(requirements)
	if err != nil {
		return nil, err
	}
	channelId, err := batchsettlement.ComputeChannelId(channelConfig, requirements.Network)
	if err != nil {
		return nil, fmt.Errorf("failed to compute channel ID: %w", err)
	}
	channelId, err = batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return nil, err
	}

	channelIdBytes := common.HexToHash(channelId)

	result, err := readSigner.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementChannelsABI,
		"channels",
		channelIdBytes,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to read channel state: %w", err)
	}

	// Parse result: [balance (uint128), totalClaimed (uint128)]
	balanceStr := "0"
	totalClaimedStr := "0"
	if results, ok := result.([]interface{}); ok && len(results) >= 2 {
		if bal, ok := results[0].(*big.Int); ok {
			balanceStr = bal.String()
		}
		if tc, ok := results[1].(*big.Int); ok {
			totalClaimedStr = tc.String()
		}
	}

	session := &BatchSettlementClientContext{
		ChargedCumulativeAmount: totalClaimedStr,
		Balance:                 balanceStr,
		TotalClaimed:            totalClaimedStr,
	}

	if err := c.storage.Set(channelId, session); err != nil {
		return nil, fmt.Errorf("failed to store recovered session: %w", err)
	}

	return session, nil
}

// ProcessCorrectivePaymentRequired handles a corrective 402 response when the
// client's cumulative base is out of sync. It validates the server-provided
// ChannelState (under accept.Extra) against onchain data and updates the local
// session, falling back to pure onchain recovery if no recovery data is sent.
// Returns true when the session was resynced and the request can be retried.
func (c *BatchSettlementEvmScheme) ProcessCorrectivePaymentRequired(
	ctx context.Context,
	errorReason string,
	accepts []types.PaymentRequirements,
) (bool, error) {
	// The corrective recovery handshake arrives under two reasons:
	//   - batchsettlement.ErrCumulativeAmountMismatch — resource-server-emitted
	//     (sibling prefix `batch_settlement_*`)
	//   - batchsettlement.ErrCumulativeBelowClaimed — facilitator-emitted
	//     (canonical `invalid_batch_settlement_evm_*` form)
	// Both signal "your client cumulative is stale; refresh and retry".
	if errorReason != batchsettlement.ErrCumulativeAmountMismatch &&
		errorReason != batchsettlement.ErrCumulativeBelowClaimed {
		return false, nil
	}

	// Find the batched accept
	var accept *types.PaymentRequirements
	for i := range accepts {
		if accepts[i].Scheme == batchsettlement.SchemeBatched {
			accept = &accepts[i]
			break
		}
	}
	if accept == nil {
		return false, nil
	}

	chargedStr, signedStr, sig, ok := readChannelStateFromExtra(accept.Extra)
	if !ok {
		// No signature-based recovery data — fall back to onchain recovery
		return c.recoverFromOnChainState(ctx, *accept)
	}

	return c.recoverFromSignature(ctx, *accept, chargedStr, signedStr, sig)
}

// readChannelStateFromExtra extracts the corrective-402 recovery fields from
// accept.Extra: extra.channelState.chargedCumulativeAmount
// + extra.voucherState.{signedMaxClaimable,signature}.
func readChannelStateFromExtra(ex map[string]interface{}) (charged, signed, sig string, ok bool) {
	if ex == nil {
		return "", "", "", false
	}
	cs, isMap := ex["channelState"].(map[string]interface{})
	if !isMap {
		return "", "", "", false
	}
	vs, isMap := ex["voucherState"].(map[string]interface{})
	if !isMap {
		return "", "", "", false
	}
	c, hasC := cs["chargedCumulativeAmount"]
	s, hasS := vs["signedMaxClaimable"]
	g, hasG := vs["signature"]
	if !hasC || !hasS || !hasG {
		return "", "", "", false
	}
	return fmt.Sprintf("%v", c), fmt.Sprintf("%v", s), fmt.Sprintf("%v", g), true
}

// recoverFromSignature recovers session from a corrective 402 that includes a
// server-provided voucher signature. Verifies the signature was produced by the
// client's own signing key before accepting.
//
// Errors from individual recovery steps are intentionally swallowed (returning
// false), allowing the caller to fall back to alternative recovery or retry.
func (c *BatchSettlementEvmScheme) recoverFromSignature(
	ctx context.Context,
	accept types.PaymentRequirements,
	chargedStr string,
	signedStr string,
	sig string,
) (bool, error) {
	charged, ok := new(big.Int).SetString(chargedStr, 10)
	if !ok {
		return false, nil //nolint:nilerr // parse failure = unrecoverable
	}
	signed, ok := new(big.Int).SetString(signedStr, 10)
	if !ok {
		return false, nil //nolint:nilerr
	}
	if charged.Cmp(signed) > 0 {
		return false, nil
	}

	readSigner, ok := c.signer.(evm.ClientEvmSignerWithReadContract)
	if !ok {
		return false, nil
	}

	config, err := c.BuildChannelConfig(accept)
	if err != nil {
		return false, nil //nolint:nilerr
	}
	channelId, err := batchsettlement.ComputeChannelId(config, accept.Network)
	if err != nil {
		return false, nil //nolint:nilerr
	}
	channelId, err = batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return false, nil //nolint:nilerr
	}

	// Read onchain state to verify
	channelIdBytes := common.HexToHash(channelId)
	result, err := readSigner.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementChannelsABI,
		"channels",
		channelIdBytes,
	)
	if err != nil {
		return false, nil //nolint:nilerr
	}

	var chBalance, chTotalClaimed *big.Int
	if results, ok := result.([]interface{}); ok && len(results) >= 2 {
		chBalance, _ = results[0].(*big.Int)
		chTotalClaimed, _ = results[1].(*big.Int)
	}
	if chBalance == nil || chTotalClaimed == nil {
		return false, nil
	}

	// charged must be >= onchain totalClaimed
	if charged.Cmp(chTotalClaimed) < 0 {
		return false, nil
	}

	// Verify the signature was produced by our key
	chainId, err := evm.GetEvmChainId(string(accept.Network))
	if err != nil {
		return false, nil //nolint:nilerr
	}

	sigBytes, err := evm.HexToBytes(sig)
	if err != nil {
		return false, nil //nolint:nilerr
	}
	channelIdRawBytes, err := evm.HexToBytes(channelId)
	if err != nil {
		return false, nil //nolint:nilerr
	}

	domain := evm.TypedDataDomain{
		Name:              batchsettlement.BatchSettlementDomain.Name,
		Version:           batchsettlement.BatchSettlementDomain.Version,
		ChainID:           chainId,
		VerifyingContract: batchsettlement.BatchSettlementAddress,
	}

	voucherSigner := c.signer
	if c.config.VoucherSigner != nil {
		voucherSigner = c.config.VoucherSigner
	}

	expectedAddr := voucherSigner.Address()
	if c.config.PayerAuthorizer != "" {
		expectedAddr = c.config.PayerAuthorizer
	}

	// Use the facilitator-style verification if the signer supports it
	verifiable, isVerifiable := readSigner.(evm.FacilitatorEvmSigner)
	if isVerifiable {
		valid, verifyErr := verifiable.VerifyTypedData(
			ctx,
			expectedAddr,
			domain,
			batchsettlement.VoucherTypes,
			"Voucher",
			map[string]interface{}{
				"channelId":          channelIdRawBytes,
				"maxClaimableAmount": signed,
			},
			sigBytes,
		)
		if verifyErr != nil || !valid {
			return false, nil //nolint:nilerr // signature mismatch = not recoverable
		}
	}

	session := &BatchSettlementClientContext{
		ChargedCumulativeAmount: charged.String(),
		SignedMaxClaimable:      signed.String(),
		Signature:               sig,
		Balance:                 chBalance.String(),
		TotalClaimed:            chTotalClaimed.String(),
	}

	if err := c.storage.Set(channelId, session); err != nil {
		return false, err
	}

	return true, nil
}

// recoverFromOnChainState recovers session purely from onchain state when no
// server-provided signature is available. The onchain totalClaimed becomes the
// new baseline.
func (c *BatchSettlementEvmScheme) recoverFromOnChainState(
	ctx context.Context,
	accept types.PaymentRequirements,
) (bool, error) {
	_, err := c.RecoverSession(ctx, accept)
	if err != nil {
		return false, nil //nolint:nilerr // recovery failures are non-fatal
	}
	return true, nil
}

func (c *BatchSettlementEvmScheme) createVoucherPayload(
	ctx context.Context,
	channelId string,
	channelConfig batchsettlement.ChannelConfig,
	maxClaimableAmount string,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	networkStr := string(requirements.Network)

	actualSigner := c.signer
	if c.config.VoucherSigner != nil {
		actualSigner = c.config.VoucherSigner
	}

	voucher, err := SignVoucher(ctx, actualSigner, channelId, maxClaimableAmount, networkStr)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to sign voucher: %w", err)
	}

	voucherPayload := &batchsettlement.BatchSettlementVoucherPayload{
		Type:          "voucher",
		ChannelConfig: channelConfig,
		Voucher:       *voucher,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     voucherPayload.ToMap(),
	}, nil
}

// createDepositPayload dispatches the deposit transfer mechanism on
// `requirements.Extra["assetTransferMethod"]`, falling back to EIP-3009 when
// the field is omitted or set to the default value.
func (c *BatchSettlementEvmScheme) createDepositPayload(
	ctx context.Context,
	channelConfig batchsettlement.ChannelConfig,
	depositAmount string,
	maxClaimableAmount string,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	method := batchsettlement.AssetTransferMethodEip3009
	if requirements.Extra != nil {
		if v, ok := requirements.Extra["assetTransferMethod"].(string); ok && v != "" {
			method = batchsettlement.AssetTransferMethod(v)
		}
	}
	switch method {
	case batchsettlement.AssetTransferMethodEip3009:
		return CreateBatchedEIP3009DepositPayload(
			ctx,
			c.signer,
			requirements,
			channelConfig,
			depositAmount,
			maxClaimableAmount,
			c.config.VoucherSigner,
		)
	case batchsettlement.AssetTransferMethodPermit2:
		return CreateBatchedPermit2DepositPayload(
			ctx,
			c.signer,
			requirements,
			channelConfig,
			depositAmount,
			maxClaimableAmount,
			c.config.VoucherSigner,
		)
	default:
		return types.PaymentPayload{}, fmt.Errorf("unsupported batch-settlement assetTransferMethod: %s", method)
	}
}

// refundContextAdapter wires *BatchSettlementEvmScheme into the RefundContext interface.
type refundContextAdapter struct {
	scheme *BatchSettlementEvmScheme
}

func (a *refundContextAdapter) Storage() ClientChannelStorage { return a.scheme.storage }
func (a *refundContextAdapter) Signer() evm.ClientEvmSigner   { return a.scheme.signer }
func (a *refundContextAdapter) VoucherSigner() evm.ClientEvmSigner {
	return a.scheme.config.VoucherSigner
}
func (a *refundContextAdapter) BuildChannelConfig(requirements types.PaymentRequirements) (batchsettlement.ChannelConfig, error) {
	return a.scheme.BuildChannelConfig(requirements)
}
func (a *refundContextAdapter) RecoverSession(ctx context.Context, requirements types.PaymentRequirements) (*BatchSettlementClientContext, error) {
	return a.scheme.RecoverSession(ctx, requirements)
}
func (a *refundContextAdapter) ProcessCorrectivePaymentRequired(ctx context.Context, errorReason string, accepts []types.PaymentRequirements) (bool, error) {
	return a.scheme.ProcessCorrectivePaymentRequired(ctx, errorReason, accepts)
}

// calculateDepositAmount returns `requiredAmount * DepositMultiplier`. Callers
// wanting a cap should use a DepositStrategy callback.
func (c *BatchSettlementEvmScheme) calculateDepositAmount(requiredAmount *big.Int) *big.Int {
	multiplier := big.NewInt(int64(c.config.DepositMultiplier))
	return new(big.Int).Mul(requiredAmount, multiplier)
}
