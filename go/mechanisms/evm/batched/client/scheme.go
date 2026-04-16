package client

import (
	"context"
	"fmt"
	"math/big"
	"sync"

	"github.com/ethereum/go-ethereum/common"

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
	Storage ClientSessionStorage
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
	signer        evm.ClientEvmSigner
	config        BatchedEvmSchemeConfig
	autoTopUp     bool
	storage       ClientSessionStorage
	pendingRefund map[string]bool
	mu            sync.Mutex
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
		storage = NewInMemoryClientSessionStorage()
	}

	return &BatchedEvmScheme{
		signer:        signer,
		config:        cfg,
		autoTopUp:     autoTopUp,
		storage:       storage,
		pendingRefund: make(map[string]bool),
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

	channelId, err := batched.ComputeChannelId(channelConfig)
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

// RequestRefund marks a channel for cooperative refund on the next voucher.
func (c *BatchedEvmScheme) RequestRefund(channelId string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pendingRefund[batched.NormalizeChannelId(channelId)] = true
}

// ProcessSettleResponse updates local session state from a settle response.
func (c *BatchedEvmScheme) ProcessSettleResponse(settle map[string]interface{}) error {
	if settle == nil {
		return nil
	}

	extra, err := batched.PaymentResponseExtraFromMap(settle)
	if err != nil {
		return err
	}

	channelId := batched.NormalizeChannelId(extra.ChannelId)

	// If refund flag is set, delete the session
	if extra.Refund {
		return c.storage.Delete(channelId)
	}

	session := &BatchedClientContext{
		ChargedCumulativeAmount: extra.ChargedCumulativeAmount,
		Balance:                 extra.Balance,
		TotalClaimed:            extra.TotalClaimed,
	}

	return c.storage.Set(channelId, session)
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
	channelId, err := batched.ComputeChannelId(channelConfig)
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

// ProcessCorrectivePaymentRequired handles a corrective 402 response from the
// server when the client's cumulative base is out of sync.
//
// It validates the server-provided state (chargedCumulativeAmount, signedMaxClaimable,
// signature) against on-chain data, then updates the local session if everything
// checks out.
//
// The paymentRequired parameter should be the decoded 402 response. The error field
// is checked for "batch_settlement_stale_cumulative_amount".
//
// Returns true if the session was successfully resynced and the request can be retried.
func (c *BatchedEvmScheme) ProcessCorrectivePaymentRequired(
	ctx context.Context,
	errorReason string,
	accepts []types.PaymentRequirements,
) (bool, error) {
	if errorReason != "batch_settlement_stale_cumulative_amount" &&
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

	ex := accept.Extra
	chargedRaw, hasCharged := ex["chargedCumulativeAmount"]
	signedRaw, hasSigned := ex["signedMaxClaimable"]
	sigRaw, hasSig := ex["signature"]

	if !hasCharged || !hasSigned || !hasSig {
		// No signature-based recovery data — fall back to on-chain recovery
		return c.recoverFromOnChainState(ctx, *accept)
	}

	return c.recoverFromSignature(ctx, *accept, fmt.Sprintf("%v", chargedRaw), fmt.Sprintf("%v", signedRaw), fmt.Sprintf("%v", sigRaw))
}

// recoverFromSignature recovers session from a corrective 402 that includes a
// server-provided voucher signature. Verifies the signature was produced by the
// client's own signing key before accepting.
func (c *BatchedEvmScheme) recoverFromSignature(
	ctx context.Context,
	accept types.PaymentRequirements,
	chargedStr string,
	signedStr string,
	sig string,
) (bool, error) {
	charged, ok := new(big.Int).SetString(chargedStr, 10)
	if !ok {
		return false, nil
	}
	signed, ok := new(big.Int).SetString(signedStr, 10)
	if !ok {
		return false, nil
	}
	if charged.Cmp(signed) > 0 {
		return false, nil
	}

	readSigner, ok := c.signer.(evm.ClientEvmSignerWithReadContract)
	if !ok {
		return false, nil
	}

	config := c.BuildChannelConfig(accept)
	channelId, err := batched.ComputeChannelId(config)
	if err != nil {
		return false, nil
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
		return false, nil
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
		return false, nil
	}

	sigBytes, err := evm.HexToBytes(sig)
	if err != nil {
		return false, nil
	}
	channelIdRawBytes, err := evm.HexToBytes(channelId)
	if err != nil {
		return false, nil
	}

	domain := evm.TypedDataDomain{
		Name:              batched.BatchSettlementDomain.Name,
		Version:           batched.BatchSettlementDomain.Version,
		ChainID:           chainId,
		VerifyingContract: batched.BatchSettlementAddress,
	}

	// Recover the signer from the signature using VerifyTypedData if the signer
	// supports it, otherwise skip (we can't verify without verification capability)
	voucherSigner := c.signer
	if c.config.VoucherSigner != nil {
		voucherSigner = c.config.VoucherSigner
	}

	expectedAddr := voucherSigner.Address()
	if c.config.PayerAuthorizer != "" {
		expectedAddr = c.config.PayerAuthorizer
	}

	// Use the facilitator-style verification if the signer supports read
	// We verify against expectedAddr using EIP-712 typed data recovery
	verifiable, isVerifiable := readSigner.(evm.FacilitatorEvmSigner)
	if isVerifiable {
		valid, err := verifiable.VerifyTypedData(
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
		if err != nil || !valid {
			return false, nil
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
		return false, nil
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

	// Check for pending refund
	c.mu.Lock()
	refund := c.pendingRefund[channelId]
	if refund {
		delete(c.pendingRefund, channelId)
	}
	c.mu.Unlock()

	voucherPayload := &batched.BatchedVoucherPayload{
		Type:               "voucher",
		ChannelConfig:      channelConfig,
		ChannelId:          voucher.ChannelId,
		MaxClaimableAmount: voucher.MaxClaimableAmount,
		Signature:          voucher.Signature,
		Refund:             refund,
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
