package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/types"
)

// AuthCaptureEvmScheme implements the SchemeNetworkClient interface for EVM authCapture payments.
type AuthCaptureEvmScheme struct {
	signer evm.ClientEvmSigner
}

// NewAuthCaptureEvmScheme creates a new AuthCaptureEvmScheme.
func NewAuthCaptureEvmScheme(signer evm.ClientEvmSigner) *AuthCaptureEvmScheme {
	return &AuthCaptureEvmScheme{
		signer: signer,
	}
}

// Scheme returns the scheme identifier.
func (c *AuthCaptureEvmScheme) Scheme() string {
	return evm.SchemeAuthCapture
}

// CreatePaymentPayload creates an authCapture payment payload.
//
// The payload wire format is minimal: { authorization, signature, salt } for EIP-3009 or
// { permit2Authorization, signature, salt } for Permit2.  The facilitator reconstructs
// the full PaymentInfo from requirements.extra + salt + payer.
//
// Nonce is payer-agnostic: payer is zeroed in the PaymentInfo hash so concurrent payers
// with the same payment terms produce distinct nonces (differentiated by their fresh salt).
func (c *AuthCaptureEvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (types.PaymentPayload, error) {
	// 1. Extract required extra fields
	captureAuthorizer, ok := requirements.Extra["captureAuthorizer"].(string)
	if !ok || captureAuthorizer == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingCaptureAuthorizer)
	}

	captureDeadlineRaw, ok := requirements.Extra["captureDeadline"]
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingCaptureDeadline)
	}
	captureDeadline, err := toUint48(captureDeadlineRaw)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidCaptureDeadline+": %w", err)
	}

	refundDeadlineRaw, ok := requirements.Extra["refundDeadline"]
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingRefundDeadline)
	}
	refundDeadline, err := toUint48(refundDeadlineRaw)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidRefundDeadline+": %w", err)
	}

	feeRecipient, ok := requirements.Extra["feeRecipient"].(string)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingFeeRecipient)
	}

	tokenName, ok := requirements.Extra["name"].(string)
	if !ok || tokenName == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingTokenName)
	}
	tokenVersion, ok := requirements.Extra["version"].(string)
	if !ok || tokenVersion == "" {
		return types.PaymentPayload{}, fmt.Errorf(ErrMissingTokenVersion)
	}

	// 2. Extract optional extra fields with defaults
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
		assetTransferMethod = v
	}

	// autoCapture is informational for the client; the facilitator uses it at settle time.
	// The client doesn't need it to construct the payload.

	// 3. Get chain ID
	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToGetChainID+": %w", err)
	}

	// 4. Validate amount
	_, ok = new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidAmount+": %s", requirements.Amount)
	}

	// 5. Compute timestamps
	now := time.Now().Unix()
	// preApprovalExpiry is derived from now + maxTimeoutSeconds (matches validBefore)
	preApprovalExpiry := uint64(now + int64(requirements.MaxTimeoutSeconds))

	// Validate deadline ordering: preApprovalExpiry <= captureDeadline <= refundDeadline
	if captureDeadline < preApprovalExpiry {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidDeadlineOrdering+": captureDeadline (%d) must be >= preApprovalExpiry (%d)", captureDeadline, preApprovalExpiry)
	}
	if refundDeadline < captureDeadline {
		return types.PaymentPayload{}, fmt.Errorf(ErrInvalidDeadlineOrdering+": refundDeadline (%d) must be >= captureDeadline (%d)", refundDeadline, captureDeadline)
	}

	// 6. Generate fresh random 32-byte salt
	saltBytes := make([]byte, 32)
	if _, err := rand.Read(saltBytes); err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToGenerateSalt+": %w", err)
	}
	salt := "0x" + hex.EncodeToString(saltBytes)

	// 7. Build PaymentInfo for nonce computation.
	// Payer is set to the actual payer here; ComputeAuthCaptureNonce zeroes it internally.
	paymentInfo := evm.AuthCapturePaymentInfo{
		Operator:            captureAuthorizer,
		Payer:               c.signer.Address(),
		Receiver:            requirements.PayTo,
		Token:               requirements.Asset,
		MaxAmount:           requirements.Amount,
		PreApprovalExpiry:   preApprovalExpiry,
		AuthorizationExpiry: captureDeadline,
		RefundExpiry:        refundDeadline,
		MinFeeBps:           minFeeBps,
		MaxFeeBps:           maxFeeBps,
		FeeReceiver:         feeRecipient,
		Salt:                salt,
	}

	// 8. Compute payer-agnostic nonce (payer is zeroed inside ComputeAuthCaptureNonce)
	nonce, err := evm.ComputeAuthCaptureNonce(chainID, evm.AuthCaptureEscrowAddress, paymentInfo)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToComputeNonce+": %w", err)
	}

	switch strings.ToLower(assetTransferMethod) {
	case "permit2":
		return c.createPermit2Payload(ctx, requirements, chainID, paymentInfo, nonce, salt, now)
	default:
		return c.createEip3009Payload(ctx, requirements, chainID, paymentInfo, nonce, salt, now)
	}
}

// createEip3009Payload builds an EIP-3009 authCapture payload.
func (c *AuthCaptureEvmScheme) createEip3009Payload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	chainID *big.Int,
	paymentInfo evm.AuthCapturePaymentInfo,
	nonce string,
	salt string,
	now int64,
) (types.PaymentPayload, error) {
	tokenName, _ := requirements.Extra["name"].(string)
	tokenVersion, _ := requirements.Extra["version"].(string)

	// validAfter = 0 (ERC3009PaymentCollector hardcodes the lower bound check)
	// validBefore = preApprovalExpiry (= now + maxTimeoutSeconds)
	validBefore := big.NewInt(int64(paymentInfo.PreApprovalExpiry))

	authorization := evm.ExactEIP3009Authorization{
		From:        c.signer.Address(),
		To:          evm.EIP3009TokenCollectorAddress,
		Value:       requirements.Amount,
		ValidAfter:  "0",
		ValidBefore: validBefore.String(),
		Nonce:       nonce,
	}

	signature, err := c.signReceiveAuthorization(ctx, authorization, chainID, requirements.Asset, tokenName, tokenVersion)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignAuthorization+": %w", err)
	}

	p := &evm.AuthCaptureEip3009Payload{
		Authorization: authorization,
		Signature:     evm.BytesToHex(signature),
		Salt:          salt,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     p.ToMap(),
	}, nil
}

// createPermit2Payload builds a Permit2 authCapture payload.
func (c *AuthCaptureEvmScheme) createPermit2Payload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	chainID *big.Int,
	paymentInfo evm.AuthCapturePaymentInfo,
	nonce string,
	salt string,
	now int64,
) (types.PaymentPayload, error) {
	// Permit2 nonce is uint256(payerAgnosticPaymentInfoHash); we re-derive it as a decimal.
	// ComputeAuthCaptureNonce returns a hex-encoded bytes32; convert to decimal for Permit2.
	nonceBytes, err := evm.HexToBytes(nonce)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf("failed to parse nonce hex: %w", err)
	}
	nonceDecimal := new(big.Int).SetBytes(nonceBytes).String()

	// deadline = preApprovalExpiry
	deadline := fmt.Sprintf("%d", paymentInfo.PreApprovalExpiry)

	auth := evm.AuthCapturePermit2Authorization{
		From: c.signer.Address(),
		Permitted: evm.Permit2TokenPermissions{
			Token:  requirements.Asset,
			Amount: requirements.Amount,
		},
		Spender:  evm.PERMIT2TokenCollectorAddress,
		Nonce:    nonceDecimal,
		Deadline: deadline,
	}

	// Sign using Permit2 EIP-712 (no witness for authCapture; binding is via nonce)
	signature, err := c.signPermit2(ctx, auth, chainID)
	if err != nil {
		return types.PaymentPayload{}, fmt.Errorf(ErrFailedToSignAuthorization+": %w", err)
	}

	p := &evm.AuthCapturePermit2Payload{
		Permit2Authorization: auth,
		Signature:            evm.BytesToHex(signature),
		Salt:                 salt,
	}

	return types.PaymentPayload{
		X402Version: 2,
		Payload:     p.ToMap(),
	}, nil
}

// signReceiveAuthorization signs a ReceiveWithAuthorization using EIP-712.
func (c *AuthCaptureEvmScheme) signReceiveAuthorization(
	ctx context.Context,
	authorization evm.ExactEIP3009Authorization,
	chainID *big.Int,
	verifyingContract string,
	tokenName string,
	tokenVersion string,
) ([]byte, error) {
	domain := evm.TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainID,
		VerifyingContract: verifyingContract,
	}

	eip712Types := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"ReceiveWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	value, ok := new(big.Int).SetString(authorization.Value, 10)
	if !ok {
		return nil, fmt.Errorf("invalid authorization value: %s", authorization.Value)
	}
	validAfter, ok := new(big.Int).SetString(authorization.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", authorization.ValidAfter)
	}
	validBefore, ok := new(big.Int).SetString(authorization.ValidBefore, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validBefore: %s", authorization.ValidBefore)
	}
	nonceBytes, err := evm.HexToBytes(authorization.Nonce)
	if err != nil {
		return nil, fmt.Errorf("invalid nonce: %w", err)
	}

	message := map[string]interface{}{
		"from":        authorization.From,
		"to":          authorization.To,
		"value":       value,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       nonceBytes,
	}

	return c.signer.SignTypedData(ctx, domain, eip712Types, "ReceiveWithAuthorization", message)
}

// signPermit2 signs a Permit2 PermitTransferFrom for authCapture (no witness).
func (c *AuthCaptureEvmScheme) signPermit2(
	ctx context.Context,
	auth evm.AuthCapturePermit2Authorization,
	chainID *big.Int,
) ([]byte, error) {
	domain := evm.TypedDataDomain{
		Name:              "Permit2",
		ChainID:           chainID,
		VerifyingContract: evm.PERMIT2Address,
	}

	// authCapture Permit2 uses PermitTransferFrom (no witness — binding via nonce)
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

	return c.signer.SignTypedData(ctx, domain, eip712Types, "PermitTransferFrom", message)
}

// toUint48 converts an interface{} extra field value to uint64 (uint48 on-chain).
// Accepts float64 (from JSON) or int64/int/uint64 variants.
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
