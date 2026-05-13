package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/authCapture/core"
	"github.com/x402-foundation/x402/go/types"
)

// AuthCaptureEvmScheme implements the SchemeNetworkFacilitator interface for EVM authCapture payments.
type AuthCaptureEvmScheme struct {
	signer evm.FacilitatorEvmSigner
}

// NewAuthCaptureEvmScheme creates a new AuthCaptureEvmScheme.
func NewAuthCaptureEvmScheme(signer evm.FacilitatorEvmSigner) *AuthCaptureEvmScheme {
	return &AuthCaptureEvmScheme{
		signer: signer,
	}
}

// Scheme returns the scheme identifier.
func (f *AuthCaptureEvmScheme) Scheme() string {
	return evm.SchemeAuthCapture
}

// CaipFamily returns the CAIP family pattern this facilitator supports.
func (f *AuthCaptureEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
func (f *AuthCaptureEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	return nil
}

// GetSigners returns signer addresses used by this facilitator.
func (f *AuthCaptureEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies an authCapture payment payload against requirements.
func (f *AuthCaptureEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	_ *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	return f.verify(ctx, payload, requirements)
}

// verify performs the authCapture-specific verification steps per the spec.
func (f *AuthCaptureEvmScheme) verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.VerifyResponse, error) {
	// Step 1: Type guard — payload must be an EIP-3009 or Permit2 authCapture payload
	// (must have "signature" and "salt"; must NOT have legacy "paymentInfo")
	isEip3009 := evm.IsAuthCaptureEip3009Payload(payload.Payload)
	isPermit2 := evm.IsAuthCapturePermit2Payload(payload.Payload)
	if !isEip3009 && !isPermit2 {
		return nil, x402.NewVerifyError(ErrInvalidPayload, "", "payload must be an authCapture EIP-3009 or Permit2 payload with 'signature' and 'salt' fields")
	}

	// Step 2: Scheme match
	if payload.Accepted.Scheme != evm.SchemeAuthCapture {
		return nil, x402.NewVerifyError(ErrInvalidScheme, "", fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}

	// Step 3: Network match
	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, "", fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}
	if !strings.HasPrefix(requirements.Network, "eip155:") {
		return nil, x402.NewVerifyError(ErrInvalidNetworkFormat, "", fmt.Sprintf("invalid network format: %s", requirements.Network))
	}

	// Step 4: Extra validation — all required fields must be present
	if requirements.Extra == nil {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "requirements.extra is nil")
	}
	captureAuthorizer, ok := requirements.Extra["captureAuthorizer"].(string)
	if !ok || captureAuthorizer == "" {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "missing captureAuthorizer in requirements.extra")
	}
	captureDeadlineRaw, hasCaptureDeadline := requirements.Extra["captureDeadline"]
	if !hasCaptureDeadline {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "missing captureDeadline in requirements.extra")
	}
	captureDeadline, err := toUint48(captureDeadlineRaw)
	if err != nil {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", fmt.Sprintf("invalid captureDeadline: %s", err))
	}
	refundDeadlineRaw, hasRefundDeadline := requirements.Extra["refundDeadline"]
	if !hasRefundDeadline {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "missing refundDeadline in requirements.extra")
	}
	refundDeadline, err := toUint48(refundDeadlineRaw)
	if err != nil {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", fmt.Sprintf("invalid refundDeadline: %s", err))
	}
	feeRecipient, ok := requirements.Extra["feeRecipient"].(string)
	if !ok {
		return nil, x402.NewVerifyError(ErrMissingExtraFields, "", "missing feeRecipient in requirements.extra")
	}
	tokenName, ok := requirements.Extra["name"].(string)
	if !ok || tokenName == "" {
		return nil, x402.NewVerifyError(ErrMissingEip712Domain, "", "missing name in requirements.extra")
	}
	tokenVersion, ok := requirements.Extra["version"].(string)
	if !ok || tokenVersion == "" {
		return nil, x402.NewVerifyError(ErrMissingEip712Domain, "", "missing version in requirements.extra")
	}

	minFeeBps := uint16(0)
	if v, ok := requirements.Extra["minFeeBps"].(float64); ok {
		minFeeBps = uint16(v)
	}
	maxFeeBps := uint16(0)
	if v, ok := requirements.Extra["maxFeeBps"].(float64); ok {
		maxFeeBps = uint16(v)
	}

	assetTransferMethod := "eip3009"
	if v, ok := requirements.Extra["assetTransferMethod"].(string); ok && v != "" {
		assetTransferMethod = strings.ToLower(v)
	}

	// Step 5: Method routing — assetTransferMethod must match payload shape
	switch assetTransferMethod {
	case "eip3009":
		if !isEip3009 {
			return nil, x402.NewVerifyError(ErrPayloadMethodMismatch, "", "assetTransferMethod is 'eip3009' but payload is Permit2")
		}
	case "permit2":
		if !isPermit2 {
			return nil, x402.NewVerifyError(ErrPayloadMethodMismatch, "", "assetTransferMethod is 'permit2' but payload is EIP-3009")
		}
	default:
		return nil, x402.NewVerifyError(ErrUnsupportedAssetTransferMethod, "", fmt.Sprintf("unsupported assetTransferMethod: %s", assetTransferMethod))
	}

	// Step 6: Deadline ordering
	now := time.Now().Unix()
	if int64(captureDeadline) <= now+6 {
		return nil, x402.NewVerifyError(ErrCaptureDeadlineExpired, "", fmt.Sprintf("captureDeadline %d is not > now+6 (%d)", captureDeadline, now+6))
	}
	if refundDeadline < captureDeadline {
		return nil, x402.NewVerifyError(ErrInvalidDeadlineOrdering, "", fmt.Sprintf("refundDeadline %d < captureDeadline %d", refundDeadline, captureDeadline))
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToGetNetworkConfig, "", err.Error())
	}

	if isEip3009 {
		return f.verifyEip3009(ctx, payload, requirements, chainID,
			captureAuthorizer, captureDeadline, refundDeadline,
			feeRecipient, minFeeBps, maxFeeBps, tokenName, tokenVersion, now)
	}
	return f.verifyPermit2(ctx, payload, requirements, chainID,
		captureAuthorizer, captureDeadline, refundDeadline,
		feeRecipient, minFeeBps, maxFeeBps, now)
}

func (f *AuthCaptureEvmScheme) verifyEip3009(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	chainID *big.Int,
	captureAuthorizer string,
	captureDeadline uint64,
	refundDeadline uint64,
	feeRecipient string,
	minFeeBps uint16,
	maxFeeBps uint16,
	tokenName string,
	tokenVersion string,
	now int64,
) (*x402.VerifyResponse, error) {
	p, err := evm.AuthCaptureEip3009PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, "", fmt.Sprintf("failed to parse EIP-3009 payload: %s", err))
	}

	// Step 7: Time window (EIP-3009 validBefore / validAfter)
	validBefore, ok := new(big.Int).SetString(p.Authorization.ValidBefore, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, p.Authorization.From, "invalid validBefore format")
	}
	if validBefore.Cmp(big.NewInt(now+6)) < 0 {
		return nil, x402.NewVerifyError(ErrValidBeforeExpired, p.Authorization.From,
			fmt.Sprintf("validBefore expired: %s", validBefore))
	}
	// validBefore must also be <= captureDeadline
	if validBefore.Cmp(new(big.Int).SetUint64(captureDeadline)) > 0 {
		return nil, x402.NewVerifyError(ErrInvalidDeadlineOrdering, p.Authorization.From,
			fmt.Sprintf("validBefore %s > captureDeadline %d", validBefore, captureDeadline))
	}

	validAfter, ok := new(big.Int).SetString(p.Authorization.ValidAfter, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, p.Authorization.From, "invalid validAfter format")
	}
	if validAfter.Cmp(big.NewInt(now)) > 0 {
		return nil, x402.NewVerifyError(ErrValidAfterInFuture, p.Authorization.From,
			fmt.Sprintf("validAfter in future: %s", validAfter))
	}

	// Step 8: Spender / collector match — to must be the canonical EIP-3009 token collector
	if !strings.EqualFold(p.Authorization.To, evm.EIP3009TokenCollectorAddress) {
		return nil, x402.NewVerifyError(ErrTokenCollectorMismatch, p.Authorization.From,
			fmt.Sprintf("authorization.to %s != EIP3009TokenCollectorAddress %s",
				p.Authorization.To, evm.EIP3009TokenCollectorAddress))
	}

	// Step 10: Signature verification (EIP-712 ReceiveWithAuthorization)
	tokenAddress := evm.NormalizeAddress(requirements.Asset)
	sigBytes, err := evm.HexToBytes(p.Signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidSignatureFormat, p.Authorization.From, err.Error())
	}

	hash, err := evm.HashReceiveWithAuthorization(p.Authorization, chainID, tokenAddress, tokenName, tokenVersion)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, p.Authorization.From, err.Error())
	}

	var hash32 [32]byte
	copy(hash32[:], hash)

	valid, _, err := evm.VerifyUniversalSignature(ctx, f.signer, p.Authorization.From, hash32, sigBytes, true)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, p.Authorization.From, err.Error())
	}
	if !valid {
		return nil, x402.NewVerifyError(ErrInvalidSignature, p.Authorization.From, "EIP-712 signature verification failed")
	}

	// Step 11: Amount match
	authValue, ok := new(big.Int).SetString(p.Authorization.Value, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidAuthorizationValue, p.Authorization.From,
			fmt.Sprintf("invalid authorization value: %s", p.Authorization.Value))
	}
	requiredValue, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidRequiredAmount, p.Authorization.From,
			fmt.Sprintf("invalid required amount: %s", requirements.Amount))
	}
	if authValue.Cmp(requiredValue) != 0 {
		return nil, x402.NewVerifyError(ErrAmountMismatch, p.Authorization.From,
			fmt.Sprintf("amount mismatch: %s != %s", authValue, requiredValue))
	}

	// Step 12: Nonce match — reconstruct PaymentInfo and recompute payer-agnostic hash
	preApprovalExpiry := uint64(validBefore.Int64())
	reconstructed := evm.AuthCapturePaymentInfo{
		Operator:            captureAuthorizer,
		Payer:               p.Authorization.From,
		Receiver:            requirements.PayTo,
		Token:               requirements.Asset,
		MaxAmount:           requirements.Amount,
		PreApprovalExpiry:   preApprovalExpiry,
		AuthorizationExpiry: captureDeadline,
		RefundExpiry:        refundDeadline,
		MinFeeBps:           minFeeBps,
		MaxFeeBps:           maxFeeBps,
		FeeReceiver:         feeRecipient,
		Salt:                p.Salt,
	}
	expectedNonce, err := core.ComputeAuthCaptureNonce(chainID, evm.AuthCaptureEscrowAddress, reconstructed)
	if err != nil {
		return nil, x402.NewVerifyError(ErrNonceMismatch, p.Authorization.From, fmt.Sprintf("failed to compute nonce: %s", err))
	}
	if !strings.EqualFold(p.Authorization.Nonce, expectedNonce) {
		return nil, x402.NewVerifyError(ErrNonceMismatch, p.Authorization.From,
			fmt.Sprintf("nonce mismatch: wire=%s expected=%s", p.Authorization.Nonce, expectedNonce))
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   p.Authorization.From,
	}, nil
}

func (f *AuthCaptureEvmScheme) verifyPermit2(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	chainID *big.Int,
	captureAuthorizer string,
	captureDeadline uint64,
	refundDeadline uint64,
	feeRecipient string,
	minFeeBps uint16,
	maxFeeBps uint16,
	now int64,
) (*x402.VerifyResponse, error) {
	p, err := evm.AuthCapturePermit2PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, "", fmt.Sprintf("failed to parse Permit2 payload: %s", err))
	}

	// Step 7: Deadline check (Permit2 deadline)
	deadline, ok := new(big.Int).SetString(p.Permit2Authorization.Deadline, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidPayload, p.Permit2Authorization.From, "invalid deadline format")
	}
	if deadline.Cmp(big.NewInt(now+6)) < 0 {
		return nil, x402.NewVerifyError(ErrValidBeforeExpired, p.Permit2Authorization.From,
			fmt.Sprintf("Permit2 deadline expired: %s", deadline))
	}
	if deadline.Cmp(new(big.Int).SetUint64(captureDeadline)) > 0 {
		return nil, x402.NewVerifyError(ErrInvalidDeadlineOrdering, p.Permit2Authorization.From,
			fmt.Sprintf("Permit2 deadline %s > captureDeadline %d", deadline, captureDeadline))
	}

	// Step 8: Spender must be canonical Permit2 token collector
	if !strings.EqualFold(p.Permit2Authorization.Spender, evm.PERMIT2TokenCollectorAddress) {
		return nil, x402.NewVerifyError(ErrTokenCollectorMismatch, p.Permit2Authorization.From,
			fmt.Sprintf("spender %s != PERMIT2TokenCollectorAddress %s",
				p.Permit2Authorization.Spender, evm.PERMIT2TokenCollectorAddress))
	}

	// Step 9: Token match (Permit2 only)
	if !strings.EqualFold(p.Permit2Authorization.Permitted.Token, requirements.Asset) {
		return nil, x402.NewVerifyError(ErrTokenMismatch, p.Permit2Authorization.From,
			fmt.Sprintf("permitted.token %s != requirements.asset %s",
				p.Permit2Authorization.Permitted.Token, requirements.Asset))
	}

	// Step 10: Signature verification (Permit2 PermitTransferFrom)
	sigBytes, err := evm.HexToBytes(p.Signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidSignatureFormat, p.Permit2Authorization.From, err.Error())
	}

	// Build the minimal Permit2Authorization (no witness for authCapture) for hashing
	permit2Auth := evm.Permit2Authorization{
		From: p.Permit2Authorization.From,
		Permitted: evm.Permit2TokenPermissions{
			Token:  p.Permit2Authorization.Permitted.Token,
			Amount: p.Permit2Authorization.Permitted.Amount,
		},
		Spender:  p.Permit2Authorization.Spender,
		Nonce:    p.Permit2Authorization.Nonce,
		Deadline: p.Permit2Authorization.Deadline,
		Witness:  evm.Permit2Witness{To: "", ValidAfter: "0"},
	}
	// Use a no-witness Permit2 hash (standard PermitTransferFrom, not PermitWitnessTransferFrom)
	hash, err := hashAuthCapturePermit2(permit2Auth, chainID)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, p.Permit2Authorization.From, err.Error())
	}

	var hash32 [32]byte
	copy(hash32[:], hash)

	valid, _, err := evm.VerifyUniversalSignature(ctx, f.signer, p.Permit2Authorization.From, hash32, sigBytes, true)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, p.Permit2Authorization.From, err.Error())
	}
	if !valid {
		return nil, x402.NewVerifyError(ErrInvalidSignature, p.Permit2Authorization.From, "Permit2 signature verification failed")
	}

	// Step 11: Amount match
	permittedAmount, ok := new(big.Int).SetString(p.Permit2Authorization.Permitted.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidAuthorizationValue, p.Permit2Authorization.From,
			fmt.Sprintf("invalid permitted amount: %s", p.Permit2Authorization.Permitted.Amount))
	}
	requiredValue, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidRequiredAmount, p.Permit2Authorization.From,
			fmt.Sprintf("invalid required amount: %s", requirements.Amount))
	}
	if permittedAmount.Cmp(requiredValue) != 0 {
		return nil, x402.NewVerifyError(ErrAmountMismatch, p.Permit2Authorization.From,
			fmt.Sprintf("amount mismatch: %s != %s", permittedAmount, requiredValue))
	}

	// Step 12: Nonce match — reconstruct PaymentInfo and recompute payer-agnostic hash
	preApprovalExpiry := uint64(deadline.Int64())
	reconstructed := evm.AuthCapturePaymentInfo{
		Operator:            captureAuthorizer,
		Payer:               p.Permit2Authorization.From,
		Receiver:            requirements.PayTo,
		Token:               requirements.Asset,
		MaxAmount:           requirements.Amount,
		PreApprovalExpiry:   preApprovalExpiry,
		AuthorizationExpiry: captureDeadline,
		RefundExpiry:        refundDeadline,
		MinFeeBps:           minFeeBps,
		MaxFeeBps:           maxFeeBps,
		FeeReceiver:         feeRecipient,
		Salt:                p.Salt,
	}
	expectedNonce, err := core.ComputeAuthCaptureNonce(chainID, evm.AuthCaptureEscrowAddress, reconstructed)
	if err != nil {
		return nil, x402.NewVerifyError(ErrNonceMismatch, p.Permit2Authorization.From,
			fmt.Sprintf("failed to compute nonce: %s", err))
	}
	// Wire nonce is decimal; expectedNonce is hex — normalize both to big.Int for comparison
	wireNonce, ok := new(big.Int).SetString(p.Permit2Authorization.Nonce, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrNonceMismatch, p.Permit2Authorization.From,
			fmt.Sprintf("invalid wire nonce: %s", p.Permit2Authorization.Nonce))
	}
	expectedNonceBytes, err := evm.HexToBytes(expectedNonce)
	if err != nil {
		return nil, x402.NewVerifyError(ErrNonceMismatch, p.Permit2Authorization.From, err.Error())
	}
	expectedNonceBig := new(big.Int).SetBytes(expectedNonceBytes)
	if wireNonce.Cmp(expectedNonceBig) != 0 {
		return nil, x402.NewVerifyError(ErrNonceMismatch, p.Permit2Authorization.From,
			fmt.Sprintf("nonce mismatch: wire=%s expected=%s", wireNonce, expectedNonceBig))
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   p.Permit2Authorization.From,
	}, nil
}

// Settle settles an authCapture payment by calling AuthCaptureEscrow.authorize() or .charge().
func (f *AuthCaptureEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	// Step 1: Re-verify
	verifyResp, err := f.verify(ctx, payload, requirements)
	if err != nil {
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToGetNetworkConfig, verifyResp.Payer, network, "", err.Error())
	}

	captureAuthorizer := requirements.Extra["captureAuthorizer"].(string)
	captureDeadline, _ := toUint48(requirements.Extra["captureDeadline"])
	refundDeadline, _ := toUint48(requirements.Extra["refundDeadline"])
	feeRecipient := requirements.Extra["feeRecipient"].(string)

	minFeeBps := uint16(0)
	if v, ok := requirements.Extra["minFeeBps"].(float64); ok {
		minFeeBps = uint16(v)
	}
	maxFeeBps := uint16(0)
	if v, ok := requirements.Extra["maxFeeBps"].(float64); ok {
		maxFeeBps = uint16(v)
	}

	// Step 2: Determine function (autoCapture flag)
	autoCapture := false
	if v, ok := requirements.Extra["autoCapture"].(bool); ok {
		autoCapture = v
	}
	settleFn := "authorize"
	if autoCapture {
		settleFn = "charge"
	}

	assetTransferMethod := "eip3009"
	if v, ok := requirements.Extra["assetTransferMethod"].(string); ok && v != "" {
		assetTransferMethod = strings.ToLower(v)
	}

	// Step 3–4: Resolve collector and encode collectorData
	var tokenCollector common.Address
	var collectorData []byte
	var amount *big.Int
	var preApprovalExpiry uint64

	if assetTransferMethod == "permit2" {
		p, _ := evm.AuthCapturePermit2PayloadFromMap(payload.Payload)
		tokenCollector = common.HexToAddress(evm.PERMIT2TokenCollectorAddress)
		sigBytes, err := evm.HexToBytes(p.Signature)
		if err != nil {
			return nil, x402.NewSettleError(ErrFailedToParseSignature, verifyResp.Payer, network, "", err.Error())
		}
		// For Permit2, collectorData is the ABI-encoded signature
		collectorData = sigBytes
		amount, _ = new(big.Int).SetString(p.Permit2Authorization.Permitted.Amount, 10)
		dl, _ := new(big.Int).SetString(p.Permit2Authorization.Deadline, 10)
		preApprovalExpiry = uint64(dl.Int64())
	} else {
		p, _ := evm.AuthCaptureEip3009PayloadFromMap(payload.Payload)
		tokenCollector = common.HexToAddress(evm.EIP3009TokenCollectorAddress)
		sigBytes, err := evm.HexToBytes(p.Signature)
		if err != nil {
			return nil, x402.NewSettleError(ErrFailedToParseSignature, verifyResp.Payer, network, "", err.Error())
		}
		collectorData = sigBytes
		amount, _ = new(big.Int).SetString(p.Authorization.Value, 10)
		vb, _ := new(big.Int).SetString(p.Authorization.ValidBefore, 10)
		preApprovalExpiry = uint64(vb.Int64())
	}

	// Reconstruct PaymentInfo for the contract call
	var saltBytes []byte
	var salt *big.Int
	if assetTransferMethod == "permit2" {
		p, _ := evm.AuthCapturePermit2PayloadFromMap(payload.Payload)
		saltBytes, _ = evm.HexToBytes(p.Salt)
	} else {
		p, _ := evm.AuthCaptureEip3009PayloadFromMap(payload.Payload)
		saltBytes, _ = evm.HexToBytes(p.Salt)
	}
	salt = new(big.Int).SetBytes(saltBytes)

	maxAmount, _ := new(big.Int).SetString(requirements.Amount, 10)

	// The PaymentInfo struct matches the Solidity layout
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
		Operator:            common.HexToAddress(captureAuthorizer),
		Payer:               common.HexToAddress(verifyResp.Payer),
		Receiver:            common.HexToAddress(requirements.PayTo),
		Token:               common.HexToAddress(requirements.Asset),
		MaxAmount:           maxAmount,
		PreApprovalExpiry:   new(big.Int).SetUint64(preApprovalExpiry),
		AuthorizationExpiry: new(big.Int).SetUint64(captureDeadline),
		RefundExpiry:        new(big.Int).SetUint64(refundDeadline),
		MinFeeBps:           minFeeBps,
		MaxFeeBps:           maxFeeBps,
		FeeReceiver:         common.HexToAddress(feeRecipient),
		Salt:                salt,
	}

	// Step 5: Call AuthCaptureEscrow directly
	_ = chainID // chain is implicit via RPC endpoint
	var txHash string

	switch settleFn {
	case "authorize":
		txHash, err = f.signer.WriteContract(
			ctx,
			evm.AuthCaptureEscrowAddress,
			core.EscrowAuthorizeABI,
			"authorize",
			paymentInfoTuple,
			amount,
			tokenCollector,
			collectorData,
		)
	case "charge":
		txHash, err = f.signer.WriteContract(
			ctx,
			evm.AuthCaptureEscrowAddress,
			core.EscrowChargeABI,
			"charge",
			paymentInfoTuple,
			amount,
			tokenCollector,
			collectorData,
			maxFeeBps,
			common.HexToAddress(feeRecipient),
		)
	}

	if err != nil {
		return nil, x402.NewSettleError(ErrFailedToExecuteSettle, verifyResp.Payer, network, "", err.Error())
	}

	// Step 6: Wait for receipt
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

// toUint48 converts an interface{} extra field value to uint64 (uint48 on-chain).
func toUint48(v interface{}) (uint64, error) {
	switch t := v.(type) {
	case float64:
		if t < 0 {
			return 0, fmt.Errorf("negative value")
		}
		return uint64(t), nil
	case int64:
		if t < 0 {
			return 0, fmt.Errorf("negative value")
		}
		return uint64(t), nil
	case int:
		if t < 0 {
			return 0, fmt.Errorf("negative value")
		}
		return uint64(t), nil
	case uint64:
		return t, nil
	default:
		return 0, fmt.Errorf("unsupported type %T", v)
	}
}

// hashAuthCapturePermit2 hashes a Permit2 PermitTransferFrom message (no witness).
// authCapture does not use PermitWitnessTransferFrom; merchant binding is via the nonce.
func hashAuthCapturePermit2(auth evm.Permit2Authorization, chainID *big.Int) ([]byte, error) {
	domain := evm.TypedDataDomain{
		Name:              "Permit2",
		ChainID:           chainID,
		VerifyingContract: evm.PERMIT2Address,
	}

	eip712Types := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"PermitTransferFrom": {
			{Name: "permitted", Type: "TokenPermissions"},
			{Name: "spender", Type: "address"},
			{Name: "nonce", Type: "uint256"},
			{Name: "deadline", Type: "uint256"},
		},
		"TokenPermissions": {
			{Name: "token", Type: "address"},
			{Name: "amount", Type: "uint256"},
		},
	}

	amount, ok := new(big.Int).SetString(auth.Permitted.Amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid permitted amount: %s", auth.Permitted.Amount)
	}
	nonce, ok := new(big.Int).SetString(auth.Nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce: %s", auth.Nonce)
	}
	deadline, ok := new(big.Int).SetString(auth.Deadline, 10)
	if !ok {
		return nil, fmt.Errorf("invalid deadline: %s", auth.Deadline)
	}

	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  auth.Permitted.Token,
			"amount": amount,
		},
		"spender":  auth.Spender,
		"nonce":    nonce,
		"deadline": deadline,
	}

	return evm.HashTypedData(domain, eip712Types, "PermitTransferFrom", message)
}
