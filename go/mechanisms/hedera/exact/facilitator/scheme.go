package facilitator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"math/rand/v2"
	"regexp"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	"github.com/x402-foundation/x402/go/v2/types"
)

var amountPattern = regexp.MustCompile(`^\d+$`)

type verifyFailure struct {
	Reason  string
	Payer   string
	Message string
}

func (e *verifyFailure) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Reason
}

// ExactHederaScheme implements SchemeNetworkFacilitator for Hedera exact (V2).
type ExactHederaScheme struct {
	signer          hedera.FacilitatorHederaSigner
	settlementCache hedera.SettlementTracker
	pendingStore    x402.PendingSettlementStore
	aliasPolicy     string
}

// NewExactHederaScheme creates a Hedera exact facilitator scheme.
// An optional SettlementTracker may be shared; if nil a new in-memory cache is created.
// Multi-replica deployments must inject a shared tracker (process-local cache is not HA-safe).
func NewExactHederaScheme(
	signer hedera.FacilitatorHederaSigner,
	cache ...hedera.SettlementTracker,
) *ExactHederaScheme {
	var c hedera.SettlementTracker
	if len(cache) > 0 && cache[0] != nil {
		c = cache[0]
	} else {
		c = hedera.NewSettlementCache()
	}
	return &ExactHederaScheme{
		signer:          signer,
		settlementCache: c,
		pendingStore:    x402.NewInMemoryPendingSettlementStore(),
		aliasPolicy:     hedera.AliasPolicyReject,
	}
}

// SetPendingSettlementStore overrides the default in-memory PendingSettlementStore
// used to reconcile a submitted transaction whose outcome is unknown
// (settlement_pending). A nil store is a no-op.
func (f *ExactHederaScheme) SetPendingSettlementStore(store x402.PendingSettlementStore) {
	if store != nil {
		f.pendingStore = store
	}
}

// WithAliasPolicy sets payTo alias policy (reject|allow). Default reject.
func (f *ExactHederaScheme) WithAliasPolicy(policy string) *ExactHederaScheme {
	if policy == hedera.AliasPolicyAllow || policy == hedera.AliasPolicyReject {
		f.aliasPolicy = policy
	}
	return f
}

var _ x402.SchemeNetworkFacilitator = (*ExactHederaScheme)(nil)

func (f *ExactHederaScheme) Scheme() string { return hedera.SchemeExact }

func (f *ExactHederaScheme) CaipFamily() string { return "hedera:*" }

func (f *ExactHederaScheme) GetExtra(network x402.Network) map[string]interface{} {
	addresses := f.signer.GetAddresses(context.Background(), string(network))
	if len(addresses) == 0 {
		return map[string]interface{}{}
	}
	return map[string]interface{}{
		"feePayer": addresses[rand.IntN(len(addresses))],
	}
}

func (f *ExactHederaScheme) GetSigners(network x402.Network) []string {
	return f.signer.GetAddresses(context.Background(), string(network))
}

func (f *ExactHederaScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	_ *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	payer, err := f.verifyPayment(ctx, payload, requirements)
	if err != nil {
		var vf *verifyFailure
		if errors.As(err, &vf) {
			return nil, x402.NewVerifyError(vf.Reason, vf.Payer, vf.Message)
		}
		return nil, x402.NewVerifyError(ErrVerificationFailed, "", err.Error())
	}
	return &x402.VerifyResponse{IsValid: true, Payer: payer}, nil
}

func (f *ExactHederaScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	// A prior settle of this exact payload was submitted with an unknown outcome.
	// Reconcile its receipt instead of re-verifying: verify would reject it as a
	// replay, and balances may already reflect the transfer. Delete before
	// reconciling so a concurrent retry falls through to the replay check.
	txB64, inspected, decodeErr := decodePayloadTransaction(payload)
	if decodeErr == nil {
		key := pendingKey(requirements, txB64)
		if txID, hit, _ := f.pendingStore.Get(ctx, key); hit {
			_ = f.pendingStore.Delete(ctx, key)
			return f.reconcilePendingSettlement(ctx, key, txID, payerOf(inspected, requirements.Asset), network)
		}
	}

	verifyResp, err := f.Verify(ctx, payload, requirements, fctx)
	if err != nil {
		var ve *x402.VerifyError
		if errors.As(err, &ve) {
			return nil, x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
		}
		return nil, x402.NewSettleError(ErrVerificationFailed, "", network, "", err.Error())
	}
	if !verifyResp.IsValid {
		return nil, x402.NewSettleError(ErrVerificationFailed, verifyResp.Payer, network, "", verifyResp.InvalidMessage)
	}

	txID, err := f.settlePayment(ctx, txB64, inspected, requirements)
	if err != nil {
		return nil, f.settleFailure(ctx, pendingKey(requirements, txB64), txID, verifyResp.Payer, network, err)
	}
	return &x402.SettleResponse{
		Success:     true,
		Payer:       verifyResp.Payer,
		Transaction: txID,
		Network:     network,
	}, nil
}

func (f *ExactHederaScheme) reconcilePendingSettlement(
	ctx context.Context,
	key, txID, payer string,
	network x402.Network,
) (*x402.SettleResponse, error) {
	if err := f.signer.AwaitTransaction(ctx, txID, string(network)); err != nil {
		return nil, f.settleFailure(ctx, key, txID, payer, network, err)
	}
	return &x402.SettleResponse{
		Success:     true,
		Payer:       payer,
		Transaction: txID,
		Network:     network,
	}, nil
}

// settleFailure records an unknown outcome for reconciliation and returns
// settlement_pending. If the record cannot be stored, a retry could not
// reconcile, so the failure is reported as terminal with the transaction id.
func (f *ExactHederaScheme) settleFailure(
	ctx context.Context,
	key, txID, payer string,
	network x402.Network,
	err error,
) error {
	var submitted *hedera.TransactionSubmittedError
	if txID == "" || !errors.As(err, &submitted) || !submitted.OutcomeUnknown {
		return x402.NewSettleError(ErrTransactionFailed, payer, network, txID, err.Error())
	}
	if setErr := f.pendingStore.Set(ctx, key, txID); setErr != nil {
		return x402.NewSettleError(ErrTransactionFailed, payer, network, txID,
			fmt.Sprintf("settlement_pending, but failed to persist for retry: %s", setErr.Error()))
	}
	return x402.NewSettleError(x402.ErrSettlementPending, payer, network, txID, err.Error())
}

// pendingKey binds a pending record to the exact signed payload and the
// requirements it was verified against, since reconciliation skips verify.
func pendingKey(requirements types.PaymentRequirements, txB64 string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		requirements.Network, requirements.PayTo, requirements.Asset, requirements.Amount, txB64,
	}, "\x00")))
	return hex.EncodeToString(sum[:])
}

func (f *ExactHederaScheme) verifyPayment(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (string, error) {
	if payload.X402Version != 2 {
		return "", &verifyFailure{Reason: ErrInvalidX402Version, Message: "expected x402 version 2"}
	}
	if payload.Accepted.Scheme != hedera.SchemeExact || requirements.Scheme != hedera.SchemeExact {
		return "", &verifyFailure{Reason: ErrUnsupportedScheme, Message: "expected exact scheme"}
	}
	if payload.Accepted.Network != requirements.Network {
		return "", &verifyFailure{Reason: ErrNetworkMismatch, Message: "network mismatch"}
	}
	if !hedera.IsSupportedNetwork(requirements.Network) {
		return "", &verifyFailure{Reason: ErrNetworkMismatch, Message: "unsupported hedera network"}
	}
	if err := acceptedMatchesRequirements(payload.Accepted, requirements); err != nil {
		return "", err
	}
	switch method, ok := hedera.AssetTransferMethod(requirements.Extra); {
	case ok && method == hedera.AssetTransferMethodCryptoTransfer:
	case ok && method == hedera.AssetTransferMethodTransferExecutor:
		return "", &verifyFailure{Reason: ErrUnsupportedAssetTransferMethod, Message: "transferExecutor is not supported"}
	default:
		return "", &verifyFailure{Reason: ErrInvalidAssetTransferMethod, Message: fmt.Sprintf("invalid assetTransferMethod: %v", requirements.Extra["assetTransferMethod"])}
	}
	if !hedera.IsValidAsset(requirements.Asset) {
		return "", &verifyFailure{Reason: ErrInvalidAsset, Message: "invalid asset"}
	}
	if !amountPattern.MatchString(requirements.Amount) {
		return "", &verifyFailure{Reason: ErrInvalidAmount, Message: "invalid amount"}
	}

	feePayer, ok := extraString(requirements.Extra)
	if !ok || !hedera.IsValidEntityID(feePayer) {
		return "", &verifyFailure{Reason: ErrMissingFeePayer, Message: "missing feePayer"}
	}
	if !f.feePayerManaged(ctx, requirements.Network, feePayer) {
		return "", &verifyFailure{Reason: ErrFeePayerNotManaged, Message: "feePayer is not managed by this facilitator"}
	}

	aliasPolicy := f.aliasPolicy
	if aliasPolicy == "" {
		aliasPolicy = hedera.AliasPolicyReject
	}
	if aliasPolicy == hedera.AliasPolicyReject && !hedera.IsValidEntityID(requirements.PayTo) {
		return "", &verifyFailure{Reason: ErrPayToAliasNotAllowed, Message: "payTo alias not allowed"}
	}
	if requirements.PayTo == "" {
		return "", &verifyFailure{Reason: ErrInvalidPayTo, Message: "invalid payTo"}
	}

	txB64, inspected, err := decodePayloadTransaction(payload)
	if err != nil {
		return "", &verifyFailure{Reason: ErrTransactionDecode, Message: err.Error()}
	}
	if err := validateInspected(inspected); err != nil {
		return "", err
	}
	if f.settlementCache != nil && f.settlementCache.Seen(inspected.TransactionID) {
		return "", &verifyFailure{Reason: ErrReplay, Message: "transaction already settled"}
	}

	payerTransfers, err := validateTransferSemantics(inspected, requirements, feePayer)
	if err != nil {
		return "", err
	}
	payers := hedera.InferPayers(payerTransfers)
	payer := ""
	if len(payers) > 0 {
		payer = payers[0].AccountID
	}

	if aliasPolicy == hedera.AliasPolicyReject {
		resolved, resolveErr := f.signer.ResolveAccount(ctx, requirements.PayTo, requirements.Network)
		if resolveErr != nil {
			return payer, &verifyFailure{Reason: ErrPayToAliasNotAllowed, Payer: payer, Message: resolveErr.Error()}
		}
		if !resolved.Exists || resolved.IsAlias {
			return payer, &verifyFailure{Reason: ErrPayToAliasNotAllowed, Payer: payer, Message: "payTo must resolve to an existing account"}
		}
	}

	for _, sender := range payers {
		sig := f.signer.VerifyPayerSignature(ctx, sender.AccountID, txB64, requirements.Network)
		if !sig.OK {
			msg := sig.Message
			if sig.Reason != "" && msg != "" {
				msg = sig.Reason + ": " + msg
			} else if sig.Reason != "" {
				msg = sig.Reason
			}
			return payer, &verifyFailure{Reason: ErrSignatureInvalid, Payer: payer, Message: msg}
		}
	}

	for _, sender := range payers {
		preflight := f.signer.PreflightTransfer(ctx, sender.AccountID, requirements.PayTo, requirements.Asset, sender.Amount, requirements.Network)
		if !preflight.OK {
			msg := preflight.Message
			if preflight.Reason != "" && msg != "" {
				msg = preflight.Reason + ": " + msg
			} else if preflight.Reason != "" {
				msg = preflight.Reason
			}
			return payer, &verifyFailure{Reason: ErrPreflightFailed, Payer: payer, Message: msg}
		}
	}

	return payer, nil
}

func (f *ExactHederaScheme) feePayerManaged(ctx context.Context, network, feePayer string) bool {
	for _, addr := range f.signer.GetAddresses(ctx, network) {
		if hedera.AccountIDsEqual(addr, feePayer) {
			return true
		}
	}
	return false
}

func decodePayloadTransaction(payload types.PaymentPayload) (string, hedera.InspectedTransaction, error) {
	txB64, err := hedera.ExtractTransaction(payload.Payload)
	if err != nil {
		return "", hedera.InspectedTransaction{}, err
	}
	inspected, err := hedera.InspectTransaction(txB64)
	if err != nil {
		return "", hedera.InspectedTransaction{}, err
	}
	return txB64, inspected, nil
}

// payerOf is a best-effort payer for responses on the reconciliation path.
func payerOf(inspected hedera.InspectedTransaction, asset string) string {
	transfers, err := hedera.AssetTransfers(inspected, asset)
	if err != nil {
		return ""
	}
	if payers := hedera.InferPayers(transfers); len(payers) > 0 {
		return payers[0].AccountID
	}
	return ""
}

func (f *ExactHederaScheme) settlePayment(
	ctx context.Context,
	txB64 string,
	inspected hedera.InspectedTransaction,
	requirements types.PaymentRequirements,
) (string, error) {
	if f.settlementCache != nil && !f.settlementCache.TryClaim(inspected.TransactionID) {
		return "", fmt.Errorf("transaction already settled")
	}

	feePayer, _ := extraString(requirements.Extra)
	txID, err := f.signer.SignAndSubmitTransaction(ctx, txB64, feePayer, requirements.Network)
	if err != nil {
		var submitted *hedera.TransactionSubmittedError
		if errors.As(err, &submitted) {
			if f.settlementCache != nil {
				f.settlementCache.Confirm(inspected.TransactionID)
			}
			if txID == "" {
				txID = submitted.TransactionID
			}
			return txID, err
		}
		if f.settlementCache != nil {
			f.settlementCache.Release(inspected.TransactionID)
		}
		return "", err
	}
	if f.settlementCache != nil {
		f.settlementCache.Confirm(inspected.TransactionID)
	}
	return txID, nil
}

func acceptedMatchesRequirements(accepted, requirements types.PaymentRequirements) error {
	if accepted.Asset != requirements.Asset ||
		accepted.Amount != requirements.Amount ||
		accepted.PayTo != requirements.PayTo ||
		accepted.MaxTimeoutSeconds != requirements.MaxTimeoutSeconds {
		return &verifyFailure{Reason: ErrAcceptedMismatch, Message: "accepted payment requirements mismatch"}
	}
	acceptedFee, _ := extraString(accepted.Extra)
	reqFee, _ := extraString(requirements.Extra)
	if acceptedFee != reqFee {
		return &verifyFailure{Reason: ErrAcceptedMismatch, Message: "accepted feePayer mismatch"}
	}
	acceptedMethod, acceptedOK := hedera.AssetTransferMethod(accepted.Extra)
	reqMethod, reqOK := hedera.AssetTransferMethod(requirements.Extra)
	if acceptedOK != reqOK || acceptedMethod != reqMethod {
		return &verifyFailure{Reason: ErrAcceptedMismatch, Message: "accepted assetTransferMethod mismatch"}
	}
	return nil
}

func extraString(extra map[string]interface{}) (string, bool) {
	if extra == nil {
		return "", false
	}
	raw, ok := extra["feePayer"]
	if !ok {
		return "", false
	}
	s, ok := raw.(string)
	return s, ok
}

func validateInspected(inspected hedera.InspectedTransaction) error {
	if inspected.TransactionType == "" || inspected.TransactionID == "" || inspected.TransactionIDAccount == "" {
		return &verifyFailure{Reason: ErrTransactionInvalidShape, Message: "invalid transaction shape"}
	}
	if !hedera.IsValidEntityID(inspected.TransactionIDAccount) {
		return &verifyFailure{Reason: ErrTransactionInvalidShape, Message: "invalid fee payer account"}
	}
	lists := [][]hedera.TransferEntry{inspected.HbarTransfers}
	for _, list := range inspected.TokenTransfers {
		lists = append(lists, list)
	}
	for _, list := range lists {
		for _, transfer := range list {
			if transfer.AccountID == "" {
				return &verifyFailure{Reason: ErrTransactionInvalidShape, Message: "invalid transfer account"}
			}
			if _, ok := new(big.Int).SetString(transfer.Amount, 10); !ok {
				return &verifyFailure{Reason: ErrTransactionInvalidShape, Message: "invalid transfer amount"}
			}
		}
	}
	return nil
}

func validateTransferSemantics(
	inspected hedera.InspectedTransaction,
	requirements types.PaymentRequirements,
	feePayer string,
) ([]hedera.TransferEntry, error) {
	if inspected.TransactionIDAccount != feePayer && !hedera.AccountIDsEqual(inspected.TransactionIDAccount, feePayer) {
		return nil, &verifyFailure{Reason: ErrFeePayerMismatch, Message: "fee payer mismatch"}
	}
	if inspected.HasNonTransferOps {
		return nil, &verifyFailure{Reason: ErrNonTransferOps, Message: "non-transfer operations present"}
	}
	if hedera.SumTransfers(inspected.HbarTransfers).Sign() != 0 {
		return nil, &verifyFailure{Reason: ErrHbarSumNonZero, Message: "HBAR transfers do not sum to zero"}
	}
	if hedera.HasNegativeTransfer(inspected.HbarTransfers, feePayer) {
		return nil, &verifyFailure{Reason: ErrFeePayerTransferringHbar, Message: "fee payer cannot send HBAR"}
	}
	if !hedera.IsHbarAsset(requirements.Asset) && len(inspected.HbarTransfers) > 0 {
		return nil, &verifyFailure{Reason: ErrUnexpectedHbarTransfers, Message: "unexpected HBAR transfers"}
	}

	payerTransfers, err := hedera.AssetTransfers(inspected, requirements.Asset)
	if err != nil {
		return nil, &verifyFailure{Reason: ErrAssetMismatch, Message: err.Error()}
	}
	if hedera.SumTransfers(payerTransfers).Sign() != 0 {
		return nil, &verifyFailure{Reason: ErrAssetSumNonZero, Message: "asset transfers do not sum to zero"}
	}
	if hedera.HasNegativeTransfer(payerTransfers, feePayer) {
		return nil, &verifyFailure{Reason: ErrFeePayerTransferringFunds, Message: "fee payer cannot send payment asset"}
	}

	requiredAmount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return nil, &verifyFailure{Reason: ErrInvalidAmount, Message: "invalid amount"}
	}
	netToPayTo := big.NewInt(0)
	for _, entry := range payerTransfers {
		if !hedera.AccountIDsEqual(entry.AccountID, requirements.PayTo) {
			continue
		}
		n, _ := new(big.Int).SetString(entry.Amount, 10)
		netToPayTo.Add(netToPayTo, n)
	}
	if netToPayTo.Cmp(requiredAmount) != 0 {
		return nil, &verifyFailure{Reason: ErrAmountMismatch, Message: "amount to payTo does not match"}
	}

	for _, receiver := range hedera.GetPositiveReceivers(payerTransfers) {
		if !hedera.AccountIDsEqual(receiver, requirements.PayTo) {
			return nil, &verifyFailure{Reason: ErrExtraPositiveTransfers, Message: "extra positive transfers"}
		}
	}
	return payerTransfers, nil
}
