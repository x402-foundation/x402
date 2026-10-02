package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// AuthCaptureEvmScheme implements SchemeNetworkClient for auth-capture EVM payments.
type AuthCaptureEvmScheme struct {
	signer evm.ClientEvmSigner
	now    func() time.Time
}

// NewAuthCaptureEvmScheme creates a client-side auth-capture scheme bound to signer.
func NewAuthCaptureEvmScheme(signer evm.ClientEvmSigner) *AuthCaptureEvmScheme {
	return &AuthCaptureEvmScheme{
		signer: signer,
		now:    time.Now,
	}
}

// Scheme returns the scheme identifier.
func (c *AuthCaptureEvmScheme) Scheme() string {
	return authcapture.SchemeAuthCapture
}

func (c *AuthCaptureEvmScheme) FindDefaultAsset(asset string, network x402.Network) *x402.DefaultAsset {
	info := evm.FindDefaultAsset(asset, string(network))
	if info == nil {
		return nil
	}
	return &x402.DefaultAsset{Asset: info.Asset, Decimals: info.Decimals, Symbol: info.Symbol}
}

// CreatePaymentPayload builds and signs an auth-capture collect payload for the given requirements.
func (c *AuthCaptureEvmScheme) CreatePaymentPayload(
	ctx context.Context,
	requirements types.PaymentRequirements,
	_ x402.PaymentPayloadContext,
) (types.PaymentPayload, error) {
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	if requirements.MaxTimeoutSeconds <= 0 {
		return types.PaymentPayload{}, fmt.Errorf("'maxTimeoutSeconds' is required in PaymentRequirements (used to derive preApprovalExpiry)")
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return types.PaymentPayload{}, err
	}

	preApprovalExpiry := uint64(c.now().Unix() + int64(requirements.MaxTimeoutSeconds))

	bindOn := authcapture.IsSaltBindingOn(extra)
	saltNonce, err := authcapture.GenerateSalt()
	if err != nil {
		return types.PaymentPayload{}, err
	}
	salt := saltNonce
	if bindOn {
		salt, err = authcapture.DeriveBoundSalt(
			authcapture.ExtraAddress(extra.ReceiverAuthorizer),
			authcapture.ExtraAddress(extra.Policy),
			saltNonce,
		)
		if err != nil {
			return types.PaymentPayload{}, err
		}
	}

	paymentInfo := authcapture.ReconstructPaymentInfo(c.signer.Address(), preApprovalExpiry, salt, requirements, extra)
	nonce, err := authcapture.ComputePayerAgnosticPaymentInfoHash(chainID, paymentInfo, deployment.Escrow)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	params := collectParams{
		requirements:      requirements,
		extra:             extra,
		deployment:        deployment,
		chainID:           chainID,
		nonce:             nonce,
		preApprovalExpiry: preApprovalExpiry,
		salt:              salt,
	}
	if bindOn {
		params.saltNonce = saltNonce
	}

	var authorization map[string]interface{}
	var signature []byte
	if extra.AssetTransferMethod == string(evm.AssetTransferMethodPermit2) {
		authorization, signature, err = c.signPermit2(ctx, params)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		return params.payload("permit2Authorization", authorization, signature), nil
	}
	authorization, signature, err = c.signEIP3009(ctx, params)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	return params.payload("authorization", authorization, signature), nil
}

// collectParams are the values shared by the EIP-3009 and Permit2 collect payloads.
// saltNonce is empty when the salt binding is off.
type collectParams struct {
	requirements      types.PaymentRequirements
	extra             authcapture.AuthCaptureExtra
	deployment        authcapture.AuthCaptureDeployment
	chainID           *big.Int
	nonce             string
	preApprovalExpiry uint64
	salt              string
	saltNonce         string
}

func (p collectParams) payload(authorizationKey string, authorization map[string]interface{}, signature []byte) types.PaymentPayload {
	payload := map[string]interface{}{
		authorizationKey: authorization,
		"signature":      evm.BytesToHex(signature),
		"salt":           p.salt,
	}
	if p.saltNonce != "" {
		payload["saltNonce"] = p.saltNonce
	}
	return types.PaymentPayload{X402Version: 2, Payload: payload}
}

func (c *AuthCaptureEvmScheme) signEIP3009(ctx context.Context, p collectParams) (map[string]interface{}, []byte, error) {
	authorization := authcapture.Eip3009Authorization{
		From:        c.signer.Address(),
		To:          p.deployment.EIP3009Collector,
		Value:       p.requirements.Amount,
		ValidAfter:  "0",
		ValidBefore: fmt.Sprintf("%d", p.preApprovalExpiry),
		Nonce:       p.nonce,
	}
	signature, err := authcapture.SignERC3009(ctx, c.signer, authorization, p.extra, p.requirements.Asset, p.chainID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to sign ERC-3009 authorization: %w", err)
	}
	return map[string]interface{}{
		"from":        authorization.From,
		"to":          authorization.To,
		"value":       authorization.Value,
		"validAfter":  authorization.ValidAfter,
		"validBefore": authorization.ValidBefore,
		"nonce":       authorization.Nonce,
	}, signature, nil
}

func (c *AuthCaptureEvmScheme) signPermit2(ctx context.Context, p collectParams) (map[string]interface{}, []byte, error) {
	permitNonce, err := authcapture.NonceHexToDecimalString(p.nonce)
	if err != nil {
		return nil, nil, err
	}
	permit := authcapture.Permit2Authorization{
		From: c.signer.Address(),
		Permitted: authcapture.Permit2TokenPermissions{
			Token:  p.requirements.Asset,
			Amount: p.requirements.Amount,
		},
		Spender:  p.deployment.Permit2Collector,
		Nonce:    permitNonce,
		Deadline: fmt.Sprintf("%d", p.preApprovalExpiry),
	}
	signature, err := authcapture.SignPermit2(ctx, c.signer, permit, p.chainID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to sign Permit2 authorization: %w", err)
	}
	return map[string]interface{}{
		"from": permit.From,
		"permitted": map[string]interface{}{
			"token":  permit.Permitted.Token,
			"amount": permit.Permitted.Amount,
		},
		"spender":  permit.Spender,
		"nonce":    permit.Nonce,
		"deadline": permit.Deadline,
	}, signature, nil
}
