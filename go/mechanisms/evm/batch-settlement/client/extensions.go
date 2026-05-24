package client

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	exactclient "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	"github.com/x402-foundation/x402/go/types"
)

// Compile-time assertion: BatchSettlementEvmScheme satisfies the optional
// ExtensionAwareClient interface so x402Client routes payments through the
// extension-aware path when the server's 402 advertises gas-sponsoring keys.
var _ x402.ExtensionAwareClient = (*BatchSettlementEvmScheme)(nil)

// CreatePaymentPayloadWithExtensions creates a batched payment payload with
// extension awareness when `paymentRequired.extensions` advertises EIP-2612 or
// ERC-20 approval gas sponsoring.
//
// Behavior matches the exact / upto schemes:
//
//  1. Build the base payload (deposit-or-voucher) via the standard
//     CreatePaymentPayload flow.
//  2. Skip extension enrichment for non-deposit payloads (vouchers don't
//     need a token approve).
//  3. Skip extension enrichment for non-Permit2 deposits (ERC-3009 carries
//     its own gas-funded transfer authorization).
//  4. Try EIP-2612 first; on a successful permit signature, attach
//     `extensions.eip2612GasSponsoring.info` and return.
//  5. Fall back to ERC-20 approval; on success, attach
//     `extensions.erc20ApprovalGasSponsoring.info`.
//  6. If neither extension applies (allowance already sufficient, or token
//     does not advertise EIP-712 domain fields), return the base payload.
//
// Implements the optional `x402.ExtensionAwareClient` interface so
// `x402Client.CreatePaymentPayload` calls this path automatically when the
// server's 402 contains extension declarations.
func (c *BatchSettlementEvmScheme) CreatePaymentPayloadWithExtensions(
	ctx context.Context,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
) (types.PaymentPayload, error) {
	result, err := c.CreatePaymentPayload(ctx, requirements)
	if err != nil {
		return types.PaymentPayload{}, err
	}

	// Vouchers never need a Permit2 approval — the deposit already established
	// the channel balance. Voucher payloads have type="voucher" without a
	// `deposit` field; bail before attempting extension signing.
	if result.Payload != nil {
		if typ, _ := result.Payload["type"].(string); typ != "deposit" {
			return result, nil
		}
	}

	// Only Permit2 deposits gas-sponsor through these extensions; ERC-3009
	// deposits authorize the transfer in the same signature. Read
	// `assetTransferMethod` from requirements.Extra and fall back to inspecting
	// the deposit authorization shape so a missing wire field still routes
	// correctly.
	isPermit2 := false
	if requirements.Extra != nil {
		if v, ok := requirements.Extra["assetTransferMethod"].(string); ok && v != "" {
			isPermit2 = v == "permit2"
		}
	}
	if !isPermit2 && result.Payload != nil {
		if dep, ok := result.Payload["deposit"].(map[string]interface{}); ok {
			if auth, ok := dep["authorization"].(map[string]interface{}); ok {
				if _, has := auth["permit2Authorization"]; has {
					isPermit2 = true
				}
			}
		}
	}
	if !isPermit2 {
		return result, nil
	}

	if extData, eipErr := c.trySignEip2612Permit(ctx, requirements, result, extensions); eipErr == nil && extData != nil {
		result.Extensions = extData
		return result, nil
	}

	if extData, erc20Err := c.trySignErc20Approval(ctx, requirements, extensions); erc20Err == nil && extData != nil {
		result.Extensions = extData
	}

	return result, nil
}

// trySignEip2612Permit attempts to sign an EIP-2612 permit authorizing Permit2
// to spend the deposit amount. Returns nil (no error) when the extension is
// not advertised, the token does not expose name/version, the signer cannot
// read on-chain state, or the user already has sufficient Permit2 allowance.
//
// The signed `info.amount` is the BATCH deposit amount (matches what the
// facilitator's `validateBatchEip2612Permit` enforces), not `requirements.Amount`
// (the per-request charge). The deadline is taken from the just-signed Permit2
// authorization so both signatures share an expiry.
func (c *BatchSettlementEvmScheme) trySignEip2612Permit(
	ctx context.Context,
	requirements types.PaymentRequirements,
	result types.PaymentPayload,
	extensions map[string]interface{},
) (map[string]interface{}, error) {
	if extensions == nil {
		return nil, nil
	}
	if _, ok := extensions[eip2612gassponsor.EIP2612GasSponsoring.Key()]; !ok {
		return nil, nil
	}

	tokenName, _ := requirements.Extra["name"].(string)
	tokenVersion, _ := requirements.Extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		// Without explicit name/version on the requirements, the token's
		// EIP-712 domain is unknown; skip silently so the request falls
		// back to the standard Permit2 path (and 402s with
		// `permit2_allowance_required` if the user has no allowance).
		return nil, nil
	}

	readSigner, ok := c.signer.(evm.ClientEvmSignerWithReadContract)
	if !ok {
		return nil, nil
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, err
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	// Pull `payload.deposit.amount` from the freshly-built batched deposit
	// payload. The signed EIP-2612 `info.amount` must equal the BATCH
	// deposit (what the facilitator's `validateBatchEip2612Permit` checks),
	// not `requirements.Amount` (the per-request charge).
	var depositAmount string
	if result.Payload != nil {
		if dep, ok := result.Payload["deposit"].(map[string]interface{}); ok {
			if amt, ok := dep["amount"].(string); ok && amt != "" {
				depositAmount = amt
			}
		}
	}
	if depositAmount == "" {
		return nil, nil
	}

	// Allowance short-circuit: if the user has already approved Permit2 for
	// at least the deposit amount, no permit is needed. The downstream
	// facilitator simulation will succeed without the EIP-2612 segment.
	if hasSufficientPermit2Allowance(ctx, readSigner, tokenAddress, c.signer.Address(), depositAmount) {
		return nil, nil
	}

	// Align EIP-2612 deadline with the just-signed Permit2 authorization
	// (`payload.deposit.authorization.permit2Authorization.deadline`) so
	// both signatures expire together. Falls back to
	// `now + maxTimeoutSeconds` when the field isn't present.
	deadline := ""
	if result.Payload != nil {
		if dep, ok := result.Payload["deposit"].(map[string]interface{}); ok {
			if auth, ok := dep["authorization"].(map[string]interface{}); ok {
				if permit2, ok := auth["permit2Authorization"].(map[string]interface{}); ok {
					if d, ok := permit2["deadline"].(string); ok {
						deadline = d
					}
				}
			}
		}
	}
	if deadline == "" {
		deadline = fmt.Sprintf("%d", time.Now().Unix()+int64(requirements.MaxTimeoutSeconds))
	}

	info, err := exactclient.SignEip2612Permit(
		ctx,
		readSigner,
		tokenAddress,
		tokenName,
		tokenVersion,
		chainID,
		deadline,
		depositAmount,
	)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}, nil
}

// trySignErc20Approval signs an `approve(Permit2, MaxUint256)` transaction for
// tokens that do not support EIP-2612. The signed tx is attached as the
// `erc20ApprovalGasSponsoring` extension; the facilitator broadcasts it via its
// extension signer before calling BatchSettlement.deposit.
func (c *BatchSettlementEvmScheme) trySignErc20Approval(
	ctx context.Context,
	requirements types.PaymentRequirements,
	extensions map[string]interface{},
) (map[string]interface{}, error) {
	if extensions == nil {
		return nil, nil
	}
	if _, ok := extensions[erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()]; !ok {
		return nil, nil
	}

	txSigner, ok := c.signer.(evm.ClientEvmSignerWithTxSigning)
	if !ok {
		return nil, nil
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, err
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	if readSigner, hasRead := c.signer.(evm.ClientEvmSignerWithReadContract); hasRead {
		// Approximate the deposit amount with the per-request amount —
		// sufficient for the allowance short-circuit since `deposit ≥
		// requirements.Amount` always holds for batched flows. Skip the
		// short-circuit when no per-request amount is available.
		if requirements.Amount != "" &&
			hasSufficientPermit2Allowance(ctx, readSigner, tokenAddress, c.signer.Address(), requirements.Amount) {
			return nil, nil
		}
	}

	info, err := exactclient.SignErc20ApprovalTransaction(ctx, txSigner, tokenAddress, chainID)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}, nil
}

// hasSufficientPermit2Allowance returns true when `owner` has already
// approved at least `requiredAmount` to Permit2 for `tokenAddress`. Returns
// false on any RPC error so we conservatively sign an extension rather than
// silently skipping when the allowance cannot be confirmed.
func hasSufficientPermit2Allowance(
	ctx context.Context,
	readSigner evm.ClientEvmSignerWithReadContract,
	tokenAddress string,
	owner string,
	requiredAmount string,
) bool {
	allowanceResult, err := readSigner.ReadContract(
		ctx,
		tokenAddress,
		evm.ERC20AllowanceABI,
		"allowance",
		common.HexToAddress(owner),
		common.HexToAddress(evm.PERMIT2Address),
	)
	if err != nil {
		return false
	}
	allowanceBig, ok := allowanceResult.(*big.Int)
	if !ok {
		return false
	}
	required, ok := new(big.Int).SetString(requiredAmount, 10)
	if !ok {
		return false
	}
	return allowanceBig.Cmp(required) >= 0
}
