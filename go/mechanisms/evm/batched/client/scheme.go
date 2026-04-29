package client

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

const (
	// DefaultDepositMultiplier is the default multiplier for the initial deposit.
	// Matches the TypeScript SDK default of 10x the per-request amount.
	DefaultDepositMultiplier = 10
	// DefaultWithdrawDelay is the default withdraw delay in seconds (15 min).
	DefaultWithdrawDelay = 900
	// DefaultSalt is the default channel salt (zero).
	DefaultSalt = "0x0000000000000000000000000000000000000000000000000000000000000000"
)

// BatchedEvmSchemeConfig configures the batched client scheme.
type BatchedEvmSchemeConfig struct {
	// DepositMultiplier is the multiplier applied to the required amount for deposits.
	// E.g., 10 means deposit 10x the per-request amount. Defaults to 10.
	DepositMultiplier int
	// MaxDeposit caps the maximum deposit amount in atomic units.
	MaxDeposit string
	// AutoTopUp automatically creates a new deposit when balance is insufficient.
	// Defaults to true. Set to false to disable.
	AutoTopUp *bool
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

// BatchedEvmScheme implements SchemeNetworkClient for batched EVM payments.
type BatchedEvmScheme struct {
	signer    evm.ClientEvmSigner
	config    BatchedEvmSchemeConfig
	autoTopUp bool
	storage   ClientChannelStorage
}

// NewBatchedEvmScheme creates a new batched client scheme.
func NewBatchedEvmScheme(signer evm.ClientEvmSigner, config *BatchedEvmSchemeConfig) *BatchedEvmScheme {
	cfg := BatchedEvmSchemeConfig{
		DepositMultiplier: DefaultDepositMultiplier,
		Salt:              DefaultSalt,
	}
	// autoTopUp defaults to true (matching TS: depositPolicy?.autoTopUp !== false)
	autoTopUp := true
	if config != nil {
		if config.DepositMultiplier > 0 {
			cfg.DepositMultiplier = config.DepositMultiplier
		}
		if config.MaxDeposit != "" {
			cfg.MaxDeposit = config.MaxDeposit
		}
		if config.AutoTopUp != nil {
			autoTopUp = *config.AutoTopUp
		}
		if config.Storage != nil {
			cfg.Storage = config.Storage
		}
		if config.Salt != "" {
			cfg.Salt = config.Salt
		}
		cfg.PayerAuthorizer = config.PayerAuthorizer
		cfg.VoucherSigner = config.VoucherSigner
	}

	storage := cfg.Storage
	if storage == nil {
		storage = NewInMemoryClientChannelStorage()
	}

	return &BatchedEvmScheme{
		signer:    signer,
		config:    cfg,
		autoTopUp: autoTopUp,
		storage:   storage,
	}
}

// Scheme returns the scheme identifier.
func (c *BatchedEvmScheme) Scheme() string {
	return batched.SchemeBatched
}

// CreatePaymentPayload creates a batched payment payload.
// Checks for existing session to determine deposit vs. voucher.
func (c *BatchedEvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	channelConfig := c.BuildChannelConfig(requirements)

	channelId, err := batched.ComputeChannelId(channelConfig, requirements.Network)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to compute channel ID: %w", err)
	}
	channelId = batched.NormalizeChannelId(channelId)

	// Check for existing session
	session, err := c.storage.Get(channelId)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to get session: %w", err)
	}

	requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf("invalid amount: %s", requirements.Amount)
	}

	if session != nil {
		// Check if we have enough balance for another request
		balance, _ := new(big.Int).SetString(session.Balance, 10)
		charged, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
		if balance == nil {
			balance = big.NewInt(0)
		}
		if charged == nil {
			charged = big.NewInt(0)
		}

		newCumulative := new(big.Int).Add(charged, requiredAmount)

		if newCumulative.Cmp(balance) <= 0 {
			// Enough balance - create voucher-only payload
			return c.createVoucherPayload(ctx, channelId, channelConfig, newCumulative.String(), requirements)
		}

		// Insufficient balance - need deposit if autoTopUp is enabled
		if c.autoTopUp {
			depositAmount := c.calculateDepositAmount(requiredAmount)
			return c.createDepositPayload(ctx, channelConfig, depositAmount.String(), newCumulative.String(), requirements)
		}

		// No autoTopUp - still create voucher, server will handle
		return c.createVoucherPayload(ctx, channelId, channelConfig, newCumulative.String(), requirements)
	}

	// No session - first request, need deposit
	depositAmount := c.calculateDepositAmount(requiredAmount)
	maxClaimable := requiredAmount.String()

	return c.createDepositPayload(ctx, channelConfig, depositAmount.String(), maxClaimable, requirements)
}

// BuildChannelConfig constructs a ChannelConfig from payment requirements and scheme config.
func (c *BatchedEvmScheme) BuildChannelConfig(requirements types.PaymentRequirements) batched.ChannelConfig {
	receiverAuthorizer := requirements.PayTo
	if requirements.Extra != nil {
		if ra, ok := requirements.Extra["receiverAuthorizer"].(string); ok && ra != "" {
			receiverAuthorizer = ra
		}
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

	payerAuthorizer := c.config.PayerAuthorizer
	if payerAuthorizer == "" {
		// Use signer address as payerAuthorizer for EOA path
		payerAuthorizer = c.signer.Address()
	}

	return batched.ChannelConfig{
		Payer:              c.signer.Address(),
		PayerAuthorizer:    payerAuthorizer,
		Receiver:           requirements.PayTo,
		ReceiverAuthorizer: receiverAuthorizer,
		Token:              requirements.Asset,
		WithdrawDelay:      withdrawDelay,
		Salt:               c.config.Salt,
	}
}

// Refund sends a cooperative refund request to the channel that backs `url`.
// On success, the local session is updated (or deleted on full refund) and the
// parsed SettleResponse is returned.
func (c *BatchedEvmScheme) Refund(ctx context.Context, url string, options *RefundOptions) (*x402.SettleResponse, error) {
	return RefundChannel(ctx, &refundContextAdapter{scheme: c}, url, options)
}

// ProcessSettleResponse updates local session state from a settle response.
// Mirrors TS processSettleResponse: merges present fields into existing session.
// Refund-specific reconciliation is handled at the refund call site via
// UpdateSessionAfterRefund. Reads the canonical nested wire shape (channelState)
// and falls back to legacy flat keys.
func (c *BatchedEvmScheme) ProcessSettleResponse(settle map[string]interface{}) error {
	if settle == nil {
		return nil
	}

	parsed, _ := batched.PaymentResponseExtraFromMap(settle)
	if parsed == nil {
		return nil
	}

	channelId := ""
	if parsed.ChannelState != nil {
		channelId = parsed.ChannelState.ChannelId
	}
	if channelId == "" {
		channelId = parsed.ChannelId
	}
	if channelId == "" {
		return nil
	}
	channelId = batched.NormalizeChannelId(channelId)

	prev, _ := c.storage.Get(channelId)
	next := &BatchedClientContext{}
	if prev != nil {
		*next = *prev
	}

	if parsed.ChannelState != nil {
		if v := parsed.ChannelState.ChargedCumulativeAmount; v != "" {
			next.ChargedCumulativeAmount = v
		}
		if v := parsed.ChannelState.Balance; v != "" {
			next.Balance = v
		}
		if v := parsed.ChannelState.TotalClaimed; v != "" {
			next.TotalClaimed = v
		}
	} else {
		if v := parsed.ChargedCumulativeAmount; v != "" {
			next.ChargedCumulativeAmount = v
		}
		if v := parsed.Balance; v != "" {
			next.Balance = v
		}
		if v := parsed.TotalClaimed; v != "" {
			next.TotalClaimed = v
		}
	}

	return c.storage.Set(channelId, next)
}

// HasSession checks if a session exists for the given channel ID.
func (c *BatchedEvmScheme) HasSession(channelId string) bool {
	session, _ := c.storage.Get(batched.NormalizeChannelId(channelId))
	return session != nil
}

// GetSession returns the session for the given channel ID.
func (c *BatchedEvmScheme) GetSession(channelId string) (*BatchedClientContext, bool) {
	session, err := c.storage.Get(batched.NormalizeChannelId(channelId))
	if err != nil || session == nil {
		return nil, false
	}
	return session, true
}

// RecoverSession rebuilds a client session from on-chain channel state.
// Requires the signer to implement ClientEvmSignerWithReadContract.
// This allows recovery after a cold start or in-memory session loss.
func (c *BatchedEvmScheme) RecoverSession(ctx context.Context, requirements types.PaymentRequirements) (*BatchedClientContext, error) {
	readSigner, ok := c.signer.(evm.ClientEvmSignerWithReadContract)
	if !ok {
		return nil, fmt.Errorf("recoverSession requires ClientEvmSigner with ReadContract capability")
	}

	channelConfig := c.BuildChannelConfig(requirements)
	channelId, err := batched.ComputeChannelId(channelConfig, requirements.Network)
	if err != nil {
		return nil, fmt.Errorf("failed to compute channel ID: %w", err)
	}
	channelId = batched.NormalizeChannelId(channelId)

	channelIdBytes := common.HexToHash(channelId)

	result, err := readSigner.ReadContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementChannelsABI,
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

	session := &BatchedClientContext{
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
// ChannelState (under accept.Extra) against on-chain data and updates the local
// session, falling back to pure on-chain recovery if no recovery data is sent.
// Returns true when the session was resynced and the request can be retried.
func (c *BatchedEvmScheme) ProcessCorrectivePaymentRequired(
	ctx context.Context,
	errorReason string,
	accepts []types.PaymentRequirements,
) (bool, error) {
	if errorReason != batched.ErrCumulativeAmountMismatch &&
		errorReason != "batch_settlement_evm_cumulative_below_claimed" {
		return false, nil
	}

	// Find the batched accept
	var accept *types.PaymentRequirements
	for i := range accepts {
		if accepts[i].Scheme == batched.SchemeBatched {
			accept = &accepts[i]
			break
		}
	}
	if accept == nil {
		return false, nil
	}

	chargedStr, signedStr, sig, ok := readChannelStateFromExtra(accept.Extra)
	if !ok {
		// No signature-based recovery data — fall back to on-chain recovery
		return c.recoverFromOnChainState(ctx, *accept)
	}

	return c.recoverFromSignature(ctx, *accept, chargedStr, signedStr, sig)
}

// readChannelStateFromExtra extracts the corrective-402 recovery fields from
// accept.Extra. Prefers the nested `ChannelState` object (current TS shape) and
// falls back to the legacy flat keys for backward compatibility.
func readChannelStateFromExtra(ex map[string]interface{}) (charged, signed, sig string, ok bool) {
	if ex == nil {
		return "", "", "", false
	}
	if nested, isMap := ex["ChannelState"].(map[string]interface{}); isMap {
		c, hasC := nested["chargedCumulativeAmount"]
		s, hasS := nested["signedMaxClaimable"]
		g, hasG := nested["signature"]
		if hasC && hasS && hasG {
			return fmt.Sprintf("%v", c), fmt.Sprintf("%v", s), fmt.Sprintf("%v", g), true
		}
	}
	c, hasC := ex["chargedCumulativeAmount"]
	s, hasS := ex["signedMaxClaimable"]
	g, hasG := ex["signature"]
	if hasC && hasS && hasG {
		return fmt.Sprintf("%v", c), fmt.Sprintf("%v", s), fmt.Sprintf("%v", g), true
	}
	return "", "", "", false
}

// recoverFromSignature recovers session from a corrective 402 that includes a
// server-provided voucher signature. Verifies the signature was produced by the
// client's own signing key before accepting.
//
// Errors from individual recovery steps are intentionally swallowed (returning
// false) to match the TypeScript SDK behavior where catch blocks silently return
// false, allowing the caller to fall back to alternative recovery or retry.
func (c *BatchedEvmScheme) recoverFromSignature(
	ctx context.Context,
	accept types.PaymentRequirements,
	chargedStr string,
	signedStr string,
	sig string,
) (bool, error) {
	charged, ok := new(big.Int).SetString(chargedStr, 10)
	if !ok {
		return false, nil //nolint:nilerr // parse failure = unrecoverable, matches TS try/catch
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

	config := c.BuildChannelConfig(accept)
	channelId, err := batched.ComputeChannelId(config, accept.Network)
	if err != nil {
		return false, nil //nolint:nilerr // matches TS catch-all
	}
	channelId = batched.NormalizeChannelId(channelId)

	// Read on-chain state to verify
	channelIdBytes := common.HexToHash(channelId)
	result, err := readSigner.ReadContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementChannelsABI,
		"channels",
		channelIdBytes,
	)
	if err != nil {
		return false, nil //nolint:nilerr // matches TS catch
	}

	var chBalance, chTotalClaimed *big.Int
	if results, ok := result.([]interface{}); ok && len(results) >= 2 {
		chBalance, _ = results[0].(*big.Int)
		chTotalClaimed, _ = results[1].(*big.Int)
	}
	if chBalance == nil || chTotalClaimed == nil {
		return false, nil
	}

	// charged must be >= on-chain totalClaimed
	if charged.Cmp(chTotalClaimed) < 0 {
		return false, nil
	}

	// Verify the signature was produced by our key
	chainId, err := evm.GetEvmChainId(string(accept.Network))
	if err != nil {
		return false, nil //nolint:nilerr // matches TS catch
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
		Name:              batched.BatchSettlementDomain.Name,
		Version:           batched.BatchSettlementDomain.Version,
		ChainID:           chainId,
		VerifyingContract: batched.BatchSettlementAddress,
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
			batched.VoucherTypes,
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

	session := &BatchedClientContext{
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

// recoverFromOnChainState recovers session purely from on-chain state when no
// server-provided signature is available. The on-chain totalClaimed becomes the
// new baseline.
func (c *BatchedEvmScheme) recoverFromOnChainState(
	ctx context.Context,
	accept types.PaymentRequirements,
) (bool, error) {
	_, err := c.RecoverSession(ctx, accept)
	if err != nil {
		return false, nil //nolint:nilerr // matches TS catch returning false
	}
	return true, nil
}

func (c *BatchedEvmScheme) createVoucherPayload(
	ctx context.Context,
	channelId string,
	channelConfig batched.ChannelConfig,
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

	voucherPayload := &batched.BatchedVoucherPayload{
		Type:          "voucher",
		ChannelConfig: channelConfig,
		Voucher:       *voucher,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     voucherPayload.ToMap(),
	}, nil
}

func (c *BatchedEvmScheme) createDepositPayload(
	ctx context.Context,
	channelConfig batched.ChannelConfig,
	depositAmount string,
	maxClaimableAmount string,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	return CreateBatchedEIP3009DepositPayload(
		ctx,
		c.signer,
		requirements,
		channelConfig,
		depositAmount,
		maxClaimableAmount,
		c.config.VoucherSigner,
	)
}

// refundContextAdapter wires *BatchedEvmScheme into the RefundContext interface.
type refundContextAdapter struct {
	scheme *BatchedEvmScheme
}

func (a *refundContextAdapter) Storage() ClientChannelStorage { return a.scheme.storage }
func (a *refundContextAdapter) Signer() evm.ClientEvmSigner   { return a.scheme.signer }
func (a *refundContextAdapter) VoucherSigner() evm.ClientEvmSigner {
	return a.scheme.config.VoucherSigner
}
func (a *refundContextAdapter) BuildChannelConfig(requirements types.PaymentRequirements) batched.ChannelConfig {
	return a.scheme.BuildChannelConfig(requirements)
}
func (a *refundContextAdapter) RecoverSession(ctx context.Context, requirements types.PaymentRequirements) (*BatchedClientContext, error) {
	return a.scheme.RecoverSession(ctx, requirements)
}
func (a *refundContextAdapter) ProcessCorrectivePaymentRequired(ctx context.Context, errorReason string, accepts []types.PaymentRequirements) (bool, error) {
	return a.scheme.ProcessCorrectivePaymentRequired(ctx, errorReason, accepts)
}

func (c *BatchedEvmScheme) calculateDepositAmount(requiredAmount *big.Int) *big.Int {
	multiplier := big.NewInt(int64(c.config.DepositMultiplier))
	deposit := new(big.Int).Mul(requiredAmount, multiplier)

	if c.config.MaxDeposit != "" {
		maxDeposit, ok := new(big.Int).SetString(c.config.MaxDeposit, 10)
		if ok && deposit.Cmp(maxDeposit) > 0 {
			deposit = maxDeposit
		}
	}

	return deposit
}
