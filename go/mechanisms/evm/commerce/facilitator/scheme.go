package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// CommerceEvmScheme implements the SchemeNetworkFacilitator interface for EVM commerce payments
type CommerceEvmScheme struct {
	signer evm.FacilitatorEvmSigner
}

// NewCommerceEvmScheme creates a new CommerceEvmScheme
func NewCommerceEvmScheme(signer evm.FacilitatorEvmSigner) *CommerceEvmScheme {
	return &CommerceEvmScheme{
		signer: signer,
	}
}

// Scheme returns the scheme identifier
func (f *CommerceEvmScheme) Scheme() string {
	return evm.SchemeCommerce
}

// CaipFamily returns the CAIP family pattern this facilitator supports
func (f *CommerceEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
func (f *CommerceEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	return nil
}

// GetSigners returns signer addresses used by this facilitator.
func (f *CommerceEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a commerce payment payload against requirements.
func (f *CommerceEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	_ *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	return f.verify(ctx, payload, requirements)
}

// verify performs the commerce-specific verification steps.
func (f *CommerceEvmScheme) verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.VerifyResponse, error) {
	// 1. Type guard: payload has authorization, signature, paymentInfo keys
	if !evm.IsCommercePayload(payload.Payload) {
		return nil, x402.NewVerifyError(ErrInvalidPayload, "", "payload must have authorization, signature, and paymentInfo keys")
	}

	// 2. Scheme match
	if payload.Accepted.Scheme != evm.SchemeCommerce {
		return nil, x402.NewVerifyError(ErrInvalidScheme, "", fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}

	// 3. Network match
	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, "", fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}

	// Validate network format
	if !strings.HasPrefix(requirements.Network, "eip155:") {
		return nil, x402.NewVerifyError(ErrInvalidNetworkFormat, "", fmt.Sprintf("invalid network format: %s", requirements.Network))
	}

	// 4. Extra validation: requirements.Extra has escrowAddress, operatorAddress, tokenCollector
	if requirements.Extra == nil {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "requirements.extra is nil")
	}
	escrowAddress, ok := requirements.Extra["escrowAddress"].(string)
	if !ok || escrowAddress == "" {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "missing escrowAddress in requirements.extra")
	}
	_, ok = requirements.Extra["operatorAddress"].(string)
	if !ok {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "missing operatorAddress in requirements.extra")
	}
	tokenCollector, ok := requirements.Extra["tokenCollector"].(string)
	if !ok || tokenCollector == "" {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "missing tokenCollector in requirements.extra")
	}

	// Parse commerce payload
	commercePayload, err := evm.CommercePayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, "", fmt.Sprintf("failed to parse commerce payload: %s", err.Error()))
	}

	// Validate signature exists
	if commercePayload.Signature == "" {
		return nil, x402.NewVerifyError(ErrMissingSignature, "", "missing signature")
	}

	// 5. Time window: validBefore > now + 6 and validAfter <= now
	now := time.Now().Unix()
	validBefore, ok := new(big.Int).SetString(commercePayload.Authorization.ValidBefore, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, commercePayload.Authorization.From, "invalid validBefore format")
	}
	if validBefore.Cmp(big.NewInt(now+6)) < 0 {
		return nil, x402.NewVerifyError(ErrValidBeforeExpired, commercePayload.Authorization.From,
			fmt.Sprintf("valid before expired: %s", validBefore.String()))
	}

	validAfter, ok := new(big.Int).SetString(commercePayload.Authorization.ValidAfter, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, commercePayload.Authorization.From, "invalid validAfter format")
	}
	if validAfter.Cmp(big.NewInt(now)) > 0 {
		return nil, x402.NewVerifyError(ErrValidAfterInFuture, commercePayload.Authorization.From,
			fmt.Sprintf("valid after in future: %s", validAfter.String()))
	}

	// 6. Signature verification
	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToGetNetworkConfig, "", err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	// Extract EIP-712 domain parameters
	tokenName, _ := requirements.Extra["name"].(string)
	tokenVersion, _ := requirements.Extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		return nil, x402.NewVerifyError(ErrMissingEip712Domain, commercePayload.Authorization.From, "missing EIP-712 domain name/version in requirements.extra")
	}

	signatureBytes, err := evm.HexToBytes(commercePayload.Signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidSignatureFormat, commercePayload.Authorization.From, err.Error())
	}

	// Hash ReceiveWithAuthorization and verify
	hash, err := evm.HashReceiveWithAuthorization(
		commercePayload.Authorization,
		chainID,
		tokenAddress,
		tokenName,
		tokenVersion,
	)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, commercePayload.Authorization.From, err.Error())
	}

	var hash32 [32]byte
	copy(hash32[:], hash)

	valid, _, err := evm.VerifyUniversalSignature(
		ctx,
		f.signer,
		commercePayload.Authorization.From,
		hash32,
		signatureBytes,
		true,
	)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, commercePayload.Authorization.From, err.Error())
	}
	if !valid {
		return nil, x402.NewVerifyError(ErrInvalidSignature, commercePayload.Authorization.From, "signature verification failed")
	}

	// 7. Amount: authorization.value == requirements.Amount (exact equality)
	authValue, ok := new(big.Int).SetString(commercePayload.Authorization.Value, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidAuthorizationValue, commercePayload.Authorization.From,
			fmt.Sprintf("invalid authorization value: %s", commercePayload.Authorization.Value))
	}
	requiredValue, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidRequiredAmount, commercePayload.Authorization.From,
			fmt.Sprintf("invalid required amount: %s", requirements.Amount))
	}
	if authValue.Cmp(requiredValue) != 0 {
		return nil, x402.NewVerifyError(ErrAmountMismatch, commercePayload.Authorization.From,
			fmt.Sprintf("amount mismatch: %s != %s", authValue.String(), requiredValue.String()))
	}

	// 8. Recipient: authorization.to == tokenCollector
	if !strings.EqualFold(commercePayload.Authorization.To, tokenCollector) {
		return nil, x402.NewVerifyError(ErrRecipientMismatch, commercePayload.Authorization.From,
			fmt.Sprintf("recipient mismatch: %s != %s (tokenCollector)", commercePayload.Authorization.To, tokenCollector))
	}

	// 9. Token: paymentInfo.token == requirements.Asset
	if !strings.EqualFold(commercePayload.PaymentInfo.Token, requirements.Asset) {
		return nil, x402.NewVerifyError(ErrTokenMismatch, commercePayload.Authorization.From,
			fmt.Sprintf("token mismatch: %s != %s", commercePayload.PaymentInfo.Token, requirements.Asset))
	}

	// 10. Receiver: paymentInfo.receiver == requirements.PayTo
	if !strings.EqualFold(commercePayload.PaymentInfo.Receiver, requirements.PayTo) {
		return nil, x402.NewVerifyError(ErrReceiverMismatch, commercePayload.Authorization.From,
			fmt.Sprintf("receiver mismatch: %s != %s", commercePayload.PaymentInfo.Receiver, requirements.PayTo))
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   commercePayload.Authorization.From,
	}, nil
}

// Settle settles a commerce payment on-chain by calling AuthCaptureEscrow.authorize() or .charge().
func (f *CommerceEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	// 1. Re-verify
	verifyResp, err := f.verify(ctx, payload, requirements)
	if err != nil {
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	// Parse commerce payload
	commercePayload, err := evm.CommercePayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	// Extract required fields
	escrowAddress := requirements.Extra["escrowAddress"].(string)
	tokenCollector := requirements.Extra["tokenCollector"].(string)

	// 2. Determine settlement function
	settlementMethod := "authorize"
	if method, ok := requirements.Extra["settlementMethod"].(string); ok && method != "" {
		settlementMethod = method
	}

	// Parse signature to get raw bytes for collectorData
	signatureBytes, err := evm.HexToBytes(commercePayload.Signature)
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToParseSignature, verifyResp.Payer, network, "", err.Error())
	}

	// Build the PaymentInfo tuple for the contract call
	maxAmount, _ := new(big.Int).SetString(commercePayload.PaymentInfo.MaxAmount, 10)
	amount, _ := new(big.Int).SetString(commercePayload.Authorization.Value, 10)

	// Parse salt
	var salt *big.Int
	if strings.HasPrefix(commercePayload.PaymentInfo.Salt, "0x") || strings.HasPrefix(commercePayload.PaymentInfo.Salt, "0X") {
		salt, _ = new(big.Int).SetString(strings.TrimPrefix(strings.TrimPrefix(commercePayload.PaymentInfo.Salt, "0x"), "0X"), 16)
	} else {
		salt, _ = new(big.Int).SetString(commercePayload.PaymentInfo.Salt, 10)
	}

	// Build PaymentInfo struct for contract call
	// The struct matches the Solidity PaymentInfo layout
	type PaymentInfoTuple struct {
		Operator            common.Address
		Payer               common.Address
		Receiver            common.Address
		Token               common.Address
		MaxAmount           *big.Int
		PreApprovalExpiry   *big.Int
		AuthorizationExpiry *big.Int
		RefundExpiry        *big.Int
		MinFeeBps           uint16
		MaxFeeBps           uint16
		FeeReceiver         common.Address
		Salt                *big.Int
	}

	paymentInfoTuple := PaymentInfoTuple{
		Operator:            common.HexToAddress(commercePayload.PaymentInfo.Operator),
		Payer:               common.HexToAddress(commercePayload.PaymentInfo.Payer),
		Receiver:            common.HexToAddress(commercePayload.PaymentInfo.Receiver),
		Token:               common.HexToAddress(commercePayload.PaymentInfo.Token),
		MaxAmount:           maxAmount,
		PreApprovalExpiry:   new(big.Int).SetUint64(commercePayload.PaymentInfo.PreApprovalExpiry),
		AuthorizationExpiry: new(big.Int).SetUint64(commercePayload.PaymentInfo.AuthorizationExpiry),
		RefundExpiry:        new(big.Int).SetUint64(commercePayload.PaymentInfo.RefundExpiry),
		MinFeeBps:           commercePayload.PaymentInfo.MinFeeBps,
		MaxFeeBps:           commercePayload.PaymentInfo.MaxFeeBps,
		FeeReceiver:         common.HexToAddress(commercePayload.PaymentInfo.FeeReceiver),
		Salt:                salt,
	}

	var txHash string

	switch settlementMethod {
	case "authorize":
		txHash, err = f.signer.WriteContract(
			ctx,
			escrowAddress,
			evm.EscrowAuthorizeABI,
			"authorize",
			paymentInfoTuple,
			amount,
			common.HexToAddress(tokenCollector),
			signatureBytes,
		)
	case "charge":
		// For charge, use maxFeeBps and feeReceiver from paymentInfo
		feeBps := commercePayload.PaymentInfo.MaxFeeBps
		feeReceiver := common.HexToAddress(commercePayload.PaymentInfo.FeeReceiver)
		txHash, err = f.signer.WriteContract(
			ctx,
			escrowAddress,
			evm.EscrowChargeABI,
			"charge",
			paymentInfoTuple,
			amount,
			common.HexToAddress(tokenCollector),
			signatureBytes,
			feeBps,
			feeReceiver,
		)
	default:
		return nil, x402.NewSettleError(ErrUnsupportedSettleMethod, verifyResp.Payer, network, "",
			fmt.Sprintf("unsupported settlement method: %s", settlementMethod))
	}

	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToExecuteSettle, verifyResp.Payer, network, "", err.Error())
	}

	// Wait for transaction confirmation
	receipt, err := f.signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToGetReceipt, verifyResp.Payer, network, txHash, err.Error())
	}

	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionFailed, verifyResp.Payer, network, txHash, "")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       verifyResp.Payer,
	}, nil
}
