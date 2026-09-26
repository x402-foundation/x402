package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// verifyEIP3009 verifies an EIP-3009 payment payload. On success it also returns the signature
// classification, so settle can reuse the payer code lookup instead of issuing a second
// eth_getCode for the same address.
func (f *ExactEvmScheme) verifyEIP3009(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	simulate bool,
) (*x402.VerifyResponse, *EIP3009SignatureClassification, error) {
	if payload.Accepted.Scheme != evm.SchemeExact {
		return nil, nil, x402.NewVerifyError(ErrInvalidScheme, "", fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}

	if payload.Accepted.Network != requirements.Network {
		return nil, nil, x402.NewVerifyError(ErrNetworkMismatch, "", fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}

	evmPayload, err := evm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, nil, x402.NewVerifyError(ErrInvalidPayload, "", fmt.Sprintf("failed to parse EVM payload: %s", err.Error()))
	}

	if evmPayload.Signature == "" {
		return nil, nil, x402.NewVerifyError(ErrMissingSignature, "", "missing signature")
	}

	chainID, err := evm.GetEvmChainId(string(requirements.Network))
	if err != nil {
		return nil, nil, x402.NewVerifyError(ErrFailedToGetNetworkConfig, "", err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	if !strings.EqualFold(evmPayload.Authorization.To, requirements.PayTo) {
		return nil, nil, x402.NewVerifyError(ErrRecipientMismatch, "", fmt.Sprintf("recipient mismatch: %s != %s", evmPayload.Authorization.To, requirements.PayTo))
	}

	parsedAuthorization, err := ParseEIP3009Authorization(evmPayload.Authorization)
	if err != nil {
		return nil, nil, x402.NewVerifyError(ErrInvalidPayload, evmPayload.Authorization.From, err.Error())
	}

	requiredValue, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, nil, x402.NewVerifyError(ErrInvalidRequiredAmount, "", fmt.Sprintf("invalid required amount: %s", requirements.Amount))
	}

	if parsedAuthorization.Value.Cmp(requiredValue) != 0 {
		return nil, nil, x402.NewVerifyError(ErrAuthorizationValueMismatch, evmPayload.Authorization.From, fmt.Sprintf("authorization value mismatch: %s != %s", parsedAuthorization.Value.String(), requiredValue.String()))
	}

	now := time.Now().Unix()
	if parsedAuthorization.ValidBefore.Cmp(big.NewInt(now+6)) < 0 {
		return nil, nil, x402.NewVerifyError(ErrValidBeforeExpired, evmPayload.Authorization.From, fmt.Sprintf("valid before expired: %s", parsedAuthorization.ValidBefore.String()))
	}

	if parsedAuthorization.ValidAfter.Cmp(big.NewInt(now)) > 0 {
		return nil, nil, x402.NewVerifyError(ErrValidAfterInFuture, evmPayload.Authorization.From, fmt.Sprintf("valid after in future: %s", parsedAuthorization.ValidAfter.String()))
	}

	tokenName, _ := requirements.Extra["name"].(string)
	tokenVersion, _ := requirements.Extra["version"].(string)
	if tokenName == "" || tokenVersion == "" {
		return nil, nil, x402.NewVerifyError(ErrMissingEip712Domain, evmPayload.Authorization.From, "missing EIP-712 domain name/version in requirements.extra")
	}

	signatureBytes, err := evm.HexToBytes(evmPayload.Signature)
	if err != nil {
		return nil, nil, x402.NewVerifyError(ErrInvalidSignatureFormat, evmPayload.Authorization.From, err.Error())
	}

	// Run the asset-contract check concurrently with signature classification.
	assetCheck := evm.StartAssetContractCheck(ctx, f.signer, string(requirements.Network), requirements.Asset)

	// SimulateEIP3009Transfer branches only on Factory/FactoryCalldata and the inner signature
	// length, never on SigData.CodeDeployed, so it does not need the eth_getCode classification
	// issues and can start concurrently. Its result is still read after the classification and
	// asset checks below, leaving error precedence unchanged.
	var simulationCh chan simulationResult
	if simulate && f.config.EnableParallelVerifySimulation {
		if parsedSigData, parseErr := evm.ParseERC6492Signature(signatureBytes); parseErr == nil {
			var cancelSimulation context.CancelFunc
			simulationCh, cancelSimulation = startSimulation(ctx, func(ctx context.Context) (bool, error) {
				return SimulateEIP3009Transfer(ctx, f.signer, tokenAddress, parsedAuthorization, parsedSigData)
			})
			defer cancelSimulation()
		}
	}

	nonCanonical, err := IsPlainNonCanonicalECDSASignature(ctx, f.signer, evmPayload.Authorization.From, signatureBytes)
	if err != nil {
		return nil, x402.NewVerifyError(ErrFailedToVerifySignature, evmPayload.Authorization.From, err.Error())
	}
	if nonCanonical {
		return nil, x402.NewVerifyError(ErrInvalidSignatureS, evmPayload.Authorization.From, "invalid signature s")
	}

	classification, err := ClassifyEIP3009Signature(
		ctx,
		f.signer,
		evmPayload.Authorization,
		signatureBytes,
		chainID,
		tokenAddress,
		tokenName,
		tokenVersion,
	)
	if err != nil {
		return nil, nil, x402.NewVerifyError(ErrFailedToVerifySignature, evmPayload.Authorization.From, err.Error())
	}

	if !classification.Valid && classification.IsUndeployed && !HasEIP6492Deployment(classification.SigData) {
		return nil, nil, x402.NewVerifyError(ErrUndeployedSmartWallet, evmPayload.Authorization.From, "")
	}

	if !classification.Valid && !classification.IsSmartWallet {
		return nil, nil, x402.NewVerifyError(ErrInvalidSignature, evmPayload.Authorization.From, fmt.Sprintf("invalid signature: %s", evmPayload.Signature))
	}

	// Counterfactual ERC-6492 wallet: settle deploys via the factory, gated by the
	// allowlist. Enforce the same gate here so verify mirrors settle (a payment that
	// settle rejects with ErrFactoryNotAllowed must not verify as valid).
	if !classification.Valid && classification.IsUndeployed && HasEIP6492Deployment(classification.SigData) {
		if !evm.IsFactoryAllowed(classification.SigData.Factory, f.config.EIP6492AllowedFactories) {
			return nil, nil, x402.NewVerifyError(ErrFactoryNotAllowed, evmPayload.Authorization.From, "factory not in EIP6492AllowedFactories allowlist")
		}
	}

	assetReason, assetErr := assetCheck.Await()
	if assetErr != nil {
		return nil, nil, fmt.Errorf("asset contract check failed: %w", assetErr)
	}
	if assetReason != "" {
		return nil, nil, x402.NewVerifyError(assetReason, evmPayload.Authorization.From, fmt.Sprintf("asset %s is not a deployed contract", requirements.Asset))
	}

	if simulate {
		simulationSucceeded, err := awaitSimulation(simulationCh, func() (bool, error) {
			return SimulateEIP3009Transfer(ctx, f.signer, tokenAddress, parsedAuthorization, classification.SigData)
		})
		if err != nil {
			return nil, nil, x402.NewVerifyError(ErrEip3009SimulationFailed, evmPayload.Authorization.From, err.Error())
		}
		if !simulationSucceeded {
			reason := DiagnoseEIP3009SimulationFailure(
				ctx,
				f.signer,
				tokenAddress,
				evmPayload.Authorization,
				requiredValue,
				tokenName,
				tokenVersion,
			)
			return nil, nil, x402.NewVerifyError(reason, evmPayload.Authorization.From, "")
		}
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   evmPayload.Authorization.From,
	}, classification, nil
}

// settleEIP3009 settles an EIP-3009 payment on-chain.
func (f *ExactEvmScheme) settleEIP3009(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	// Fast path: a prior settle attempt for this exact payload already broadcast
	// a transaction whose receipt wait failed (settlement_pending). The resource
	// server's single automatic retry resends the identical payload, so check the
	// pending-settlement store before re-verifying/re-broadcasting — reconcile
	// against the already-broadcast transaction instead of creating a second one.
	if evmPayload, parseErr := evm.PayloadFromMap(payload.Payload); parseErr == nil && evmPayload.Signature != "" {
		if txHash, ok, _ := f.pendingStore.Get(ctx, evmPayload.Signature); ok {
			// Remove before reconciling (rather than after) so a concurrent retry
			// of the same payload misses here instead of also reconciling: it
			// falls through to the normal broadcast path, which independently
			// rejects it as an on-chain replay (nonce already consumed).
			_ = f.pendingStore.Delete(ctx, evmPayload.Signature)
			return f.reconcilePendingEIP3009(ctx, evmPayload, requirements, network, txHash)
		}
	}

	verifyResp, classification, err := f.verifyEIP3009(ctx, payload, requirements, f.config.SimulateInSettle)
	if err != nil {
		ve := &x402.VerifyError{}
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}

	evmPayload, err := evm.PayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	tokenAddress := evm.NormalizeAddress(requirements.Asset)

	if classification == nil {
		return nil, x402.NewSettleError(ErrFailedToParseSignature, verifyResp.Payer, network, "", "verify returned no signature classification")
	}
	sigData := classification.SigData

	if HasEIP6492Deployment(sigData) {
		// CodeDeployed comes from the eth_getCode the verify above already issued for this payer.
		// Both reads happen before any deploy transaction, so reusing it does not reintroduce the
		// post-deploy re-read that races RPC state propagation across replicas.
		if !sigData.CodeDeployed {
			if !evm.IsFactoryAllowed(sigData.Factory, f.config.EIP6492AllowedFactories) {
				return nil, x402.NewSettleError(ErrFactoryNotAllowed, verifyResp.Payer, network, "", "")
			}

			if err := SendDeployTransaction(ctx, f.signer, sigData); err != nil {
				return nil, x402.NewSettleError(ErrSmartWalletDeploymentFailed, verifyResp.Payer, network, "", err.Error())
			}

			// Do NOT re-simulate the transfer here. The single authoritative pre-check is the
			// atomic deploy+transfer simulation that runs in verify (one eth_call via
			// Multicall3, state carried across both sub-calls). A second standalone eth_call
			// after the real deploy tx is unreliable — the read can race the deploy's state
			// propagation across load-balanced RPC nodes — and was producing false
			// inner-signature-unsupported rejections for valid wallets (e.g.
			// Coinbase Smart Wallet). The on-chain transferWithAuthorization below is the
			// definitive signature check; a genuinely unsupported inner signature reverts
			// there and is classified by parseEIP3009TransferError.
		}
	}

	parsedAuthorization, err := ParseEIP3009Authorization(evmPayload.Authorization)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	dataSuffix, err := evm.ResolveDataSuffix(fctx, evm.DataSuffixContext{Payload: payload, Requirements: requirements})
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, verifyResp.Payer, network, "", err.Error())
	}

	txHash, err := ExecuteTransferWithAuthorization(ctx, f.signer, tokenAddress, parsedAuthorization, sigData, dataSuffix)
	if err != nil {
		return nil, x402.NewSettleError(parseEIP3009TransferError(err), verifyResp.Payer, network, "", err.Error())
	}

	return f.awaitEIP3009Settlement(ctx, evmPayload.Signature, tokenAddress, parsedAuthorization, network, verifyResp.Payer, txHash)
}

// reconcilePendingEIP3009 handles a pending-settlement store hit: it skips
// verify and broadcast entirely (the payer is taken directly from the
// payload, exactly as the original attempt did) and awaits the previously
// broadcast transaction.
func (f *ExactEvmScheme) reconcilePendingEIP3009(
	ctx context.Context,
	evmPayload *evm.ExactEIP3009Payload,
	requirements types.PaymentRequirements,
	network x402.Network,
	txHash string,
) (*x402.SettleResponse, error) {
	tokenAddress := evm.NormalizeAddress(requirements.Asset)
	parsedAuthorization, err := ParseEIP3009Authorization(evmPayload.Authorization)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, evmPayload.Authorization.From, network, "", err.Error())
	}
	return f.awaitEIP3009Settlement(ctx, evmPayload.Signature, tokenAddress, parsedAuthorization, network, evmPayload.Authorization.From, txHash)
}

// awaitEIP3009Settlement waits for the broadcast transaction's receipt (via
// WaitForSettleReceiptWithPendingStore) and additionally verifies its
// Transfer event, shared by both the normal broadcast path and the
// pending-settlement reconciliation path above. A confirmed-but-mismatched
// receipt is terminal and clears the pending entry (unlike a receipt-wait
// failure, which WaitForSettleReceiptWithPendingStore already records for
// reconciliation); an unparseable-but-successful receipt re-records it as
// non-terminal, since the transfer's effect is unknown.
func (f *ExactEvmScheme) awaitEIP3009Settlement(
	ctx context.Context,
	pendingKey string,
	tokenAddress string,
	parsedAuthorization *ParsedEIP3009Authorization,
	network x402.Network,
	payer string,
	txHash string,
) (*x402.SettleResponse, error) {
	receipt, err := evm.WaitForSettleReceiptWithPendingStore(ctx, f.pendingStore, pendingKey, f.signer, txHash, payer, network,
		ErrTransactionFailed, ErrTransactionFailed)
	if err != nil {
		return nil, err
	}

	if receipt.Logs != nil {
		transferMatched, err := verifyEIP3009TransferEvent(receipt.Logs, common.HexToAddress(tokenAddress), expectedTransferEvent{
			From:  parsedAuthorization.From,
			To:    parsedAuthorization.To,
			Value: parsedAuthorization.Value,
		})
		if err != nil {
			// The receipt succeeded but its logs could not be parsed, so the transfer's effect
			// is unknown. A parsed-but-absent event below is terminal; this is not.
			if setErr := f.pendingStore.Set(ctx, pendingKey, txHash); setErr != nil {
				// Can't guarantee a later retry will find this to reconcile against — a
				// blind retry could re-verify/re-broadcast and double-send. Downgrade to
				// terminal, preserving the transaction hash for manual reconciliation.
				return nil, x402.NewSettleError(ErrTransactionFailed, payer, network, txHash,
					fmt.Sprintf("settlement_pending, but failed to persist for retry: %s", setErr.Error()))
			}
			return nil, x402.NewSettleError(ErrSettlementPending, payer, network, txHash,
				evm.TruncateErrorMessage(err.Error()))
		}
		if !transferMatched {
			_ = f.pendingStore.Delete(ctx, pendingKey)
			return nil, x402.NewSettleError(ErrTransferEventMismatch, payer, network, txHash, "")
		}
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       payer,
	}, nil
}
