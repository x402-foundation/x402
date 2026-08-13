package facilitator

import (
	"context"
	"fmt"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// BatchSettlementEvmSchemeConfig holds optional facilitator configuration.
type BatchSettlementEvmSchemeConfig struct {
	// EIP6492AllowedFactories is the allowlist of factory contract addresses (hex strings,
	// case-insensitive) the facilitator will call to deploy an undeployed (ERC-6492
	// counterfactual) smart wallet before an ERC-3009 deposit. A non-empty list enables
	// counterfactual deposit support; an empty list (the default) denies all factory
	// deployment, so counterfactual deposits are rejected with ErrFactoryNotAllowed.
	EIP6492AllowedFactories []string
}

// BatchSettlementEvmScheme implements SchemeNetworkFacilitator for batch settlement on EVM.
type BatchSettlementEvmScheme struct {
	signer           evm.FacilitatorEvmSigner
	authorizerSigner batchsettlement.AuthorizerSigner
	config           BatchSettlementEvmSchemeConfig
}

// NewBatchSettlementEvmScheme creates a new batch settlement facilitator scheme.
// The authorizerSigner is an optional dedicated key that provides EIP-712 signatures
// for claimWithSignature / refundWithSignature. When provided, the facilitator
// advertises its address as receiverAuthorizer in /supported and auto-signs when the
// server omits signatures from the payload. When nil, no receiverAuthorizer is
// advertised and servers must supply their own authorizer signatures.
func NewBatchSettlementEvmScheme(signer evm.FacilitatorEvmSigner, authorizerSigner batchsettlement.AuthorizerSigner) *BatchSettlementEvmScheme {
	return &BatchSettlementEvmScheme{signer: signer, authorizerSigner: authorizerSigner}
}

// NewBatchSettlementEvmSchemeWithConfig creates a batch settlement facilitator scheme with
// optional configuration (e.g. the ERC-6492 factory allowlist for counterfactual deposits).
// A nil config behaves identically to NewBatchSettlementEvmScheme. The authorizerSigner is
// optional; see NewBatchSettlementEvmScheme for its semantics.
func NewBatchSettlementEvmSchemeWithConfig(
	signer evm.FacilitatorEvmSigner,
	authorizerSigner batchsettlement.AuthorizerSigner,
	config *BatchSettlementEvmSchemeConfig,
) *BatchSettlementEvmScheme {
	s := &BatchSettlementEvmScheme{signer: signer, authorizerSigner: authorizerSigner}
	if config != nil {
		s.config = *config
	}
	return s
}

// Scheme returns the scheme identifier.
func (f *BatchSettlementEvmScheme) Scheme() string {
	return batchsettlement.SchemeBatched
}

// CaipFamily returns the CAIP family pattern this facilitator supports.
func (f *BatchSettlementEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// Exposes the receiverAuthorizer address so server and client can embed it in ChannelConfig.
// Returns nil when no authorizer signer is configured, so no receiverAuthorizer is advertised.
func (f *BatchSettlementEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	if f.authorizerSigner == nil {
		return nil
	}
	return map[string]interface{}{
		"receiverAuthorizer": f.authorizerSigner.Address(),
	}
}

// GetSigners returns signer addresses used by this facilitator.
func (f *BatchSettlementEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a batched payment payload.
// Routes to deposit or voucher verification based on payload type.
func (f *BatchSettlementEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	// Defensive scheme and network validation.
	if payload.Accepted.Scheme != batchsettlement.SchemeBatched || requirements.Scheme != batchsettlement.SchemeBatched {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidScheme}, nil
	}
	if payload.Accepted.Network != requirements.Network {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrNetworkMismatch}, nil
	}

	data := payload.Payload

	if batchsettlement.IsDepositPayload(data) {
		depositPayload, err := batchsettlement.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidDepositPayload, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		return VerifyDeposit(ctx, f.signer, depositPayload, requirements, payload.Extensions, fctx, f.config.EIP6492AllowedFactories)
	}

	if batchsettlement.IsVoucherPayload(data) {
		voucherPayload, err := batchsettlement.VoucherPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidVoucherPayload, "",
				fmt.Sprintf("failed to parse voucher payload: %s", err))
		}
		return VerifyVoucher(ctx, f.signer, voucherPayload, requirements, voucherPayload.ChannelConfig)
	}

	// Cooperative refund: client sends a zero-charge voucher with type="refund".
	// Refund and voucher payloads share the same voucher-verification path with
	// a refund-aware cumulative check.
	if batchsettlement.IsRefundPayload(data) {
		refundPayload, err := batchsettlement.RefundPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidRefundPayload, "",
				fmt.Sprintf("failed to parse refund payload: %s", err))
		}
		return VerifyRefundVoucher(ctx, f.signer, refundPayload, requirements, refundPayload.ChannelConfig)
	}

	return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidPayload}, nil
}

// Settle settles a batched payment onchain.
// Routes based on payload type or settleAction field.
func (f *BatchSettlementEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	data := payload.Payload
	network := x402.Network(requirements.Network)

	dataSuffix, err := evm.ResolveDataSuffix(fctx, evm.DataSuffixContext{Payload: payload, Requirements: requirements})
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, "", network, "", err.Error())
	}

	// Check for deposit payload (type="deposit")
	if batchsettlement.IsDepositPayload(data) {
		depositPayload, err := batchsettlement.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		return SettleDeposit(ctx, f.signer, depositPayload, requirements, payload.Extensions, fctx, dataSuffix, f.config.EIP6492AllowedFactories)
	}

	// Enriched refund settle-action (must be checked BEFORE plain claim, since both
	// have type="refund" but enriched also has claims+amount+refundNonce).
	if batchsettlement.IsEnrichedRefundPayload(data) {
		refundPayload, err := batchsettlement.EnrichedRefundPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to parse refund payload: %s", err))
		}
		return ExecuteRefundWithSignature(ctx, f.signer, refundPayload, requirements, f.authorizerSigner, dataSuffix)
	}

	if batchsettlement.IsClaimPayload(data) {
		claimPayload, err := batchsettlement.ClaimPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
				fmt.Sprintf("failed to parse claim payload: %s", err))
		}
		return ExecuteClaimWithSignature(ctx, f.signer, claimPayload, requirements, f.authorizerSigner, dataSuffix)
	}

	if batchsettlement.IsSettlePayload(data) {
		settlePayload, err := batchsettlement.SettlePayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidSettlePayload, "", network, "",
				fmt.Sprintf("failed to parse settle payload: %s", err))
		}
		return ExecuteSettle(ctx, f.signer, settlePayload, requirements, dataSuffix)
	}

	return nil, x402.NewSettleError(ErrUnknownSettleAction, "", network, "",
		"unrecognized batch-settlement settle action or payload type")
}
