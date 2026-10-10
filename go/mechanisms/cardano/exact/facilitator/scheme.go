// Package facilitator implements the Cardano exact scheme for facilitators.
package facilitator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/script"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	// DefaultConfirmationTimeout bounds one settle call's wait for confirmations.
	DefaultConfirmationTimeout = 75 * time.Second
	// DefaultConfirmationPoll is the evidence polling interval.
	DefaultConfirmationPoll = 5 * time.Second
	// validityCloseGrace is how long past its TTL a transaction may still be
	// reported by a lagging indexer before a resumed settlement calls it expired.
	validityCloseGrace = 120 * time.Second
	// storeTransitionTimeout bounds a claim transition recorded after its
	// request was cancelled.
	storeTransitionTimeout = 10 * time.Second
	// evidenceUnavailable marks a failed or impossible evidence lookup: unlike
	// EvidenceUnknown it proves nothing, so it never ends a settlement as expired.
	evidenceUnavailable = "unavailable"
	// errUnsupportedVersion is the reason TypeScript reports for non-v2 payloads.
	errUnsupportedVersion = cardano.ErrInvalidPayload + "_unsupported_version"
)

// Config is the optional configuration of the Cardano exact facilitator.
type Config struct {
	// SettlementStore guards against double broadcast; defaults to an in-memory store.
	SettlementStore cardano.SettlementStore
	// AcceptMempool lets l1Confirmations -1 settle on mempool acceptance; without
	// it such a policy waits for block inclusion.
	AcceptMempool bool
	// ConfirmationTimeout defaults to DefaultConfirmationTimeout.
	ConfirmationTimeout time.Duration
	// ConfirmationPoll defaults to DefaultConfirmationPoll.
	ConfirmationPoll time.Duration
	// ValidateRegistryClaim approves Masumi agentIdentifier claims.
	ValidateRegistryClaim masumi.RegistryValidator
	// ValidateCustomMasumiDeployment approves non-canonical Masumi deployments.
	ValidateCustomMasumiDeployment masumi.DeploymentValidator
	// OnStoreError observes failed settlement-store transitions.
	OnStoreError func(err error)
}

// ExactCardanoScheme implements x402.SchemeNetworkFacilitator for Cardano.
//
// Like the TypeScript facilitator, it returns failures and settlement_pending
// as VerifyResponse/SettleResponse values rather than errors, so their reason,
// transaction id and extra survive HTTP facilitator servers. A transaction the
// ledger already accepted verifies again: binding a payment to one protected
// operation is the resource server's job. Without a TransactionEvidenceReader
// a resumed settlement stays pending, since nothing can prove it did not land.
type ExactCardanoScheme struct {
	signer cardano.FacilitatorCardanoSigner
	config Config
	sleep  func(ctx context.Context, d time.Duration) error
	now    func() time.Time
}

// NewExactCardanoScheme creates the facilitator scheme.
func NewExactCardanoScheme(signer cardano.FacilitatorCardanoSigner, config ...*Config) *ExactCardanoScheme {
	cfg := Config{}
	if len(config) > 0 && config[0] != nil {
		cfg = *config[0]
	}
	if cfg.SettlementStore == nil {
		cfg.SettlementStore = cardano.NewInMemorySettlementStore(0)
	}
	if cfg.ConfirmationTimeout <= 0 {
		cfg.ConfirmationTimeout = DefaultConfirmationTimeout
	}
	if cfg.ConfirmationPoll <= 0 {
		cfg.ConfirmationPoll = DefaultConfirmationPoll
	}
	return &ExactCardanoScheme{signer: signer, config: cfg, sleep: sleepContext, now: time.Now}
}

// Scheme implements x402.SchemeNetworkFacilitator.
func (f *ExactCardanoScheme) Scheme() string { return cardano.SchemeExact }

// CaipFamily implements x402.SchemeNetworkFacilitator.
func (f *ExactCardanoScheme) CaipFamily() string { return cardano.CaipFamily }

// GetExtra advertises the transfer methods and the confirmation range this facilitator can honour.
func (f *ExactCardanoScheme) GetExtra(_ x402.Network) map[string]interface{} {
	minimum, maximum := 0, 0
	if f.config.AcceptMempool {
		minimum = cardano.MinL1Confirmations
	}
	if f.evidenceReader() != nil {
		maximum = cardano.MaxL1Confirmations
	}
	return map[string]interface{}{
		"assetTransferMethods": []string{
			cardano.AssetTransferMethodDefault,
			cardano.AssetTransferMethodMasumi,
			cardano.AssetTransferMethodScript,
		},
		"areFeesSponsored": false,
		"l1Confirmations":  map[string]interface{}{"minimum": minimum, "maximum": maximum},
	}
}

// GetSigners implements x402.SchemeNetworkFacilitator.
func (f *ExactCardanoScheme) GetSigners(_ x402.Network) []string {
	return append([]string{}, f.signer.GetAddresses()...)
}

// Verify implements x402.SchemeNetworkFacilitator.
func (f *ExactCardanoScheme) Verify(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, _ *x402.FacilitatorContext) (*x402.VerifyResponse, error) {
	response, _ := f.runVerification(ctx, payload, requirements, false)
	return response, nil
}

type verifiedPayment struct {
	payload cardano.ExactCardanoPayload
	decoded *cardano.DecodedTransaction
	policy  cardano.ConfirmationPolicy
	payer   string
}

func invalid(reason, payer, message string) *x402.VerifyResponse {
	return &x402.VerifyResponse{IsValid: false, InvalidReason: reason, InvalidMessage: message, Payer: payer}
}

// envelope is a decoded payment whose structure passed the stateless checks.
type envelope struct {
	payload cardano.ExactCardanoPayload
	policy  cardano.ConfirmationPolicy
	nonce   string
	decoded *cardano.DecodedTransaction
}

// runVerification applies the verification rules in TypeScript order. With
// alreadyBroadcast, or when the ledger already holds the transaction, the
// spent-input, TTL-expiry, phase-1 and evaluation checks are skipped.
func (f *ExactCardanoScheme) runVerification(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, alreadyBroadcast bool) (*x402.VerifyResponse, *verifiedPayment) {
	env, rejection := checkEnvelope(payload, requirements)
	if rejection != nil {
		return rejection, nil
	}
	decoded := env.decoded
	acceptedByLedger := alreadyBroadcast || f.observedOnChain(ctx, decoded.TxHash, requirements.Network)
	if rejection := f.checkValidityWindow(ctx, decoded, requirements, acceptedByLedger); rejection != nil {
		return rejection, nil
	}

	snapshots, err := f.lookupInputs(ctx, decoded.Inputs, requirements.Network)
	if err != nil {
		return invalid(cardano.ErrChainLookupFailed, "", err.Error()), nil
	}
	var nonceSnapshot *cardano.UtxoSnapshot
	for i, in := range decoded.Inputs {
		if in == env.nonce {
			nonceSnapshot = snapshots[i]
		}
	}
	payer := ""
	if nonceSnapshot != nil {
		payer = nonceSnapshot.Address
	}
	if !acceptedByLedger {
		if nonceSnapshot == nil || !nonceSnapshot.Exists {
			return invalid(cardano.ErrNonceNotOnChain, payer, ""), nil
		}
		for _, s := range snapshots {
			if !s.Exists {
				return invalid(cardano.ErrInputNotAvailable, payer, ""), nil
			}
		}
	}
	if payer == "" {
		return invalid(cardano.ErrNonceNotOnChain, "", "could not resolve the owner of the nonce UTXO"), nil
	}
	if reason, detail := f.checkInputWitnesses(decoded, snapshots); reason != "" {
		return invalid(reason, payer, detail), nil
	}

	var params *cardano.ProtocolParameters
	if reader, ok := f.signer.(cardano.ProtocolParametersReader); ok {
		if params, err = reader.GetProtocolParameters(ctx, requirements.Network); err != nil {
			return invalid(cardano.ErrChainLookupFailed, payer, err.Error()), nil
		}
	}
	if !acceptedByLedger {
		if reason, detail := f.checkPhase1(ctx, env.payload.Transaction, decoded, snapshots, params, requirements.Network); reason != "" {
			return invalid(reason, payer, detail), nil
		}
	}

	output, reason, detail := findPayment(decoded, requirements)
	if reason != "" {
		return invalid(reason, payer, detail), nil
	}
	// Phase-1 checked every output's min-UTXO unless the ledger accepted the
	// transaction; the payment output must carry it either way.
	if acceptedByLedger && params != nil {
		if minimum := cardano.MinUtxoLovelace(output.SerializedSize, params.CoinsPerUtxoByte); output.Coin < minimum {
			return invalid(cardano.ErrMinUtxoInsufficient, payer, fmt.Sprintf(
				"output to %s carries %d lovelace, min-UTXO requires %d", requirements.PayTo, output.Coin, minimum)), nil
		}
	}
	var coinsPerUtxoByte *uint64
	if params != nil {
		coinsPerUtxoByte = &params.CoinsPerUtxoByte
	}
	if reason, detail := f.runMethodSpecificChecks(ctx, payload, requirements, decoded, payer, coinsPerUtxoByte); reason != "" {
		return invalid(reason, payer, detail), nil
	}
	if evaluator, ok := f.signer.(cardano.TransactionEvaluator); ok && !acceptedByLedger {
		if err := evaluator.EvaluateTransaction(ctx, env.payload.Transaction, requirements.Network); err != nil {
			return invalid(cardano.ErrChainLookupFailed, payer, err.Error()), nil
		}
	}
	if env.policy.L1Confirmations > 0 && f.evidenceReader() == nil {
		return invalid(cardano.ErrEvidenceUnavailable, payer,
			"confirmation depth above canonical inclusion requires transaction evidence"), nil
	}
	return &x402.VerifyResponse{IsValid: true, Payer: payer},
		&verifiedPayment{payload: env.payload, decoded: decoded, policy: env.policy, payer: payer}
}

// checkEnvelope applies the stateless checks: version, scheme, network,
// requirements, payload, policy, nonce and the transaction's own structure.
func checkEnvelope(payload types.PaymentPayload, requirements types.PaymentRequirements) (*envelope, *x402.VerifyResponse) {
	if payload.X402Version != 2 {
		return nil, invalid(errUnsupportedVersion, "", "")
	}
	if payload.Accepted.Scheme != cardano.SchemeExact || requirements.Scheme != cardano.SchemeExact {
		return nil, invalid(cardano.ErrUnsupportedScheme, "", "")
	}
	if cardano.NormalizeNetwork(payload.Accepted.Network) != cardano.NormalizeNetwork(requirements.Network) ||
		!cardano.IsCardanoNetwork(requirements.Network) {
		return nil, invalid(cardano.ErrNetworkMismatch, "", "")
	}
	if !cardano.IsPositiveCanonicalAmount(requirements.Amount) || !cardano.IsCanonicalAsset(requirements.Asset) {
		return nil, invalid(cardano.ErrRequirementsInvalid, "", "amount and asset must use their positive canonical wire forms")
	}
	cardanoPayload, err := cardano.DecodePayload(payload.Payload)
	if err != nil {
		return nil, invalid(cardano.ErrInvalidPayload, "", err.Error())
	}
	policy, ok := cardano.ResolveConfirmationPolicy(requirements.Extra)
	if !ok {
		return nil, invalid(cardano.ErrPolicyInvalid, "", "")
	}
	nonceHash, nonceIndex, err := cardano.ParseUtxoRef(cardanoPayload.Nonce)
	if err != nil {
		return nil, invalid(cardano.ErrNonceInvalid, "", "")
	}
	nonce := cardano.FormatUtxoRef(nonceHash, nonceIndex)
	decoded, err := cardano.DecodeTransaction(cardanoPayload.Transaction)
	if err != nil {
		return nil, invalid(cardano.ErrTransactionDecodeFailed, "", err.Error())
	}
	if len(decoded.Inputs) > cardano.MaxTransactionInputs {
		return nil, invalid(cardano.ErrTransactionPhase1Invalid, "", fmt.Sprintf(
			"transaction has %d inputs; verification permits at most %d", len(decoded.Inputs), cardano.MaxTransactionInputs))
	}
	expectedNetworkID, _ := cardano.NetworkID(requirements.Network)
	if decoded.NetworkID != nil && *decoded.NetworkID != expectedNetworkID {
		return nil, invalid(cardano.ErrNetworkIDMismatch, "", "")
	}
	if decoded.VkeyWitnessCount == 0 && decoded.ScriptWitnessCount == 0 {
		return nil, invalid(cardano.ErrTransactionUnsigned, "", "")
	}
	if !decoded.SignaturesValid {
		return nil, invalid(cardano.ErrInvalidSignature, "", "")
	}
	inputSet := make(map[string]bool, len(decoded.Inputs))
	for _, in := range decoded.Inputs {
		inputSet[in] = true
	}
	if len(inputSet) != len(decoded.Inputs) {
		return nil, invalid(cardano.ErrTransactionPhase1Invalid, "", "transaction contains duplicate inputs")
	}
	if !inputSet[nonce] {
		return nil, invalid(cardano.ErrNonceNotInInputs, "", "")
	}
	if !decoded.IsValid {
		return nil, invalid(cardano.ErrTransactionPhase2Invalid, "", "")
	}
	return &envelope{payload: cardanoPayload, policy: policy, nonce: nonce, decoded: decoded}, nil
}

// checkValidityWindow requires a TTL that has not passed (unless the ledger
// accepted the transaction) and lies within maxTimeoutSeconds, and a validity
// start that has been reached.
func (f *ExactCardanoScheme) checkValidityWindow(ctx context.Context, decoded *cardano.DecodedTransaction, requirements types.PaymentRequirements, acceptedByLedger bool) *x402.VerifyResponse {
	if decoded.TTLSlot == nil && decoded.ValidityStartSlot == nil {
		return nil
	}
	currentSlot, err := f.signer.GetCurrentSlot(ctx, requirements.Network)
	if err != nil {
		return invalid(cardano.ErrChainLookupFailed, "", err.Error())
	}
	if decoded.TTLSlot != nil {
		if !acceptedByLedger && *decoded.TTLSlot <= currentSlot {
			return invalid(cardano.ErrTTLExpired, "", "")
		}
		ttlMs, ttlErr := cardano.SlotToPosixMs(requirements.Network, *decoded.TTLSlot)
		nowMs, nowErr := cardano.SlotToPosixMs(requirements.Network, currentSlot)
		if ttlErr != nil || nowErr != nil || ttlMs > nowMs+int64(requirements.MaxTimeoutSeconds)*1000 {
			return invalid(cardano.ErrTTLTooFar, "", "")
		}
	}
	if decoded.ValidityStartSlot != nil && *decoded.ValidityStartSlot > currentSlot {
		return invalid(cardano.ErrValidityNotYetValid, "", "")
	}
	return nil
}

// checkInputWitnesses requires every key-locked input to be signed by its
// owner. The node enforces witnesses only at submit, and the protected handler
// may run before that. Script inputs need script validation that only a
// complete phase-1 validator provides.
func (f *ExactCardanoScheme) checkInputWitnesses(decoded *cardano.DecodedTransaction, snapshots []*cardano.UtxoSnapshot) (string, string) {
	witnessed := make(map[string]bool, len(decoded.VkeyHashes))
	for _, hash := range decoded.VkeyHashes {
		witnessed[hash] = true
	}
	_, hasValidator := f.signer.(cardano.Phase1Validator)
	for i, snapshot := range snapshots {
		keyHash := strings.ToLower(snapshot.PaymentKeyHash)
		if keyHash == "" {
			credential, err := cardano.PaymentCredential(snapshot.Address)
			switch {
			case err != nil:
				return cardano.ErrInvalidSignature, fmt.Sprintf("input %s has no readable payment credential", decoded.Inputs[i])
			case credential.IsScript && !hasValidator:
				return cardano.ErrInvalidSignature, fmt.Sprintf("input %s is script-locked; spending it needs a phase-1 validator", decoded.Inputs[i])
			case credential.IsScript:
				continue
			}
			keyHash = credential.HashHex()
		}
		if !witnessed[keyHash] {
			return cardano.ErrInvalidSignature, fmt.Sprintf("input %s is not signed by its owner", decoded.Inputs[i])
		}
	}
	return "", ""
}

// findPayment returns the first output paying at least the required amount of
// the asset to payTo, or the reason none does.
func findPayment(decoded *cardano.DecodedTransaction, requirements types.PaymentRequirements) (*cardano.UtxoOutput, string, string) {
	requested, _ := new(big.Int).SetString(requirements.Amount, 10)
	assetKey := strings.ToLower(requirements.Asset)
	isLovelace := assetKey == cardano.LovelaceAsset
	recipientFound, assetFound := false, false
	best := uint64(0)
	for i := range decoded.Outputs {
		output := &decoded.Outputs[i]
		if output.Address != requirements.PayTo {
			continue
		}
		recipientFound = true
		available, present := output.Coin, true
		if !isLovelace {
			available, present = output.Assets[assetKey]
		}
		if !present {
			continue
		}
		assetFound = true
		best = max(best, available)
		if new(big.Int).SetUint64(available).Cmp(requested) >= 0 {
			return output, "", ""
		}
	}
	switch {
	case !recipientFound:
		return nil, cardano.ErrRecipientMismatch, ""
	case !assetFound:
		return nil, cardano.ErrAssetMismatch, ""
	}
	return nil, cardano.ErrAmountInsufficient, fmt.Sprintf("output to %s pays %d, requires %s", requirements.PayTo, best, requirements.Amount)
}

func (f *ExactCardanoScheme) lookupInputs(ctx context.Context, inputs []string, network string) ([]*cardano.UtxoSnapshot, error) {
	snapshots := make([]*cardano.UtxoSnapshot, len(inputs))
	for offset := 0; offset < len(inputs); offset += cardano.MaxInputLookupConcurrency {
		end := min(offset+cardano.MaxInputLookupConcurrency, len(inputs))
		var wg sync.WaitGroup
		errs := make([]error, end-offset)
		for i := offset; i < end; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				snapshot, err := f.signer.GetUtxo(ctx, inputs[i], network)
				if err == nil && snapshot == nil {
					err = fmt.Errorf("no snapshot for %s", inputs[i])
				}
				snapshots[i], errs[i-offset] = snapshot, err
			}(i)
		}
		wg.Wait()
		if err := errors.Join(errs...); err != nil {
			return nil, err
		}
	}
	return snapshots, nil
}

func (f *ExactCardanoScheme) runMethodSpecificChecks(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, decoded *cardano.DecodedTransaction, payer string, coinsPerUtxoByte *uint64) (string, string) {
	raw, declared := requirements.Extra["assetTransferMethod"]
	method, isString := raw.(string)
	if declared && !isString {
		return cardano.ErrUnsupportedScheme, ""
	}
	switch method {
	case "", cardano.AssetTransferMethodDefault:
		return "", ""
	case cardano.AssetTransferMethodMasumi:
		check := masumi.VerifyLock(ctx, requirements.Extra, requirements, decoded, masumi.VerifyContext{
			Payer:                    payer,
			CoinsPerUtxoByte:         coinsPerUtxoByte,
			ValidateRegistryClaim:    f.config.ValidateRegistryClaim,
			Resource:                 payload.Resource,
			ValidateCustomDeployment: f.config.ValidateCustomMasumiDeployment,
		})
		if !check.OK {
			return check.Reason, check.Detail
		}
		return "", ""
	case cardano.AssetTransferMethodScript:
		extra, err := script.ParseExtra(requirements.Extra)
		if err != nil || (extra.ScriptHash == "" && extra.Script == nil) || !script.AddressMatches(extra, requirements.PayTo) {
			return cardano.ErrScriptAddressMismatch, ""
		}
		return "", ""
	}
	return cardano.ErrUnsupportedScheme, ""
}

// Settle implements x402.SchemeNetworkFacilitator. It claims the transaction,
// verifies it, submits the client's exact bytes once and observes the evidence
// the confirmation policy requires.
func (f *ExactCardanoScheme) Settle(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, _ *x402.FacilitatorContext) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	fail := func(reason, transaction, message string) (*x402.SettleResponse, error) {
		return &x402.SettleResponse{Success: false, ErrorReason: reason, ErrorMessage: message, Transaction: transaction, Network: network}, nil
	}
	cardanoPayload, err := cardano.DecodePayload(payload.Payload)
	if err != nil {
		return fail(cardano.ErrInvalidPayload, "", err.Error())
	}
	decoded, err := cardano.DecodeTransaction(cardanoPayload.Transaction)
	if err != nil {
		return fail(cardano.ErrTransactionDecodeFailed, "", err.Error())
	}
	policy, ok := cardano.ResolveConfirmationPolicy(requirements.Extra)
	if !ok {
		return fail(cardano.ErrPolicyInvalid, "", "")
	}
	txHash := decoded.TxHash
	required := policy.L1Confirmations
	ownerToken := randomToken()
	settlementClaim := cardano.SettlementClaim{TxHash: txHash, OwnerToken: ownerToken, RetainUntilMs: f.retainUntilMs(decoded, requirements)}
	if method, _ := requirements.Extra["assetTransferMethod"].(string); method == cardano.AssetTransferMethodMasumi {
		// Invalid terms are left unbound; verification then rejects them with
		// the same reason /verify gives.
		if digest, expires, err := masumi.ClaimBinding(requirements); err == nil {
			settlementClaim.TermsDigest, settlementClaim.TermsExpireAtMs = digest, expires
		}
	}
	claim, err := f.config.SettlementStore.ClaimSettlement(ctx, settlementClaim)
	if err != nil {
		return fail(cardano.ErrSettlementFailed, txHash, err.Error())
	}
	switch claim {
	case cardano.ClaimCapacityExceeded:
		return fail(cardano.ErrSettlementFailed, txHash, "the Cardano settlement store is at capacity")
	case cardano.ClaimInFlight:
		return fail(cardano.ErrDuplicateSettlement, txHash, "")
	case cardano.ClaimTermsConflict:
		return fail(cardano.ErrDuplicateSettlement, txHash, "termsDigest is already bound to another transaction")
	case cardano.ClaimRejected, cardano.ClaimSubmitted:
		// A rejection is final unless the ledger shows the transaction anyway
		// (another submission path won); then it is only observed, like any
		// resumed settlement.
		if claim == cardano.ClaimRejected && !f.observedOnChain(ctx, txHash, requirements.Network) {
			return fail(cardano.ErrSettlementDefinitivelyRejected, txHash, "this transaction was definitively rejected before ledger acceptance")
		}
		return f.resumeSettlement(ctx, payload, requirements, network, txHash, required)
	}

	verifyResponse, verified := f.runVerification(ctx, payload, requirements, false)
	if !verifyResponse.IsValid {
		f.recordOutcome(ctx, func(ctx context.Context) error {
			return f.config.SettlementStore.ReleaseClaim(ctx, txHash, ownerToken)
		})
		return fail(verifyResponse.InvalidReason, txHash, verifyResponse.InvalidMessage)
	}
	submission, err := f.signer.SubmitTransaction(ctx, verified.payload.Transaction, requirements.Network)
	if err == nil && submission == nil {
		err = errors.New("submitter returned no result")
	}
	hashMismatch := err == nil && !strings.EqualFold(submission.TxHash, txHash)
	if hashMismatch {
		err = fmt.Errorf("submitter returned transaction %s, expected %s", submission.TxHash, txHash)
	}
	if err != nil {
		// A failed evidence lookup proves nothing, so it also counts as
		// "may have landed".
		mayHaveLanded := false
		if reader := f.evidenceReader(); reader != nil {
			observed, evErr := reader.GetTransactionEvidence(ctx, txHash, requirements.Network)
			mayHaveLanded = evErr != nil || (observed != nil && observed.Status != cardano.EvidenceUnknown)
		}
		if mayHaveLanded {
			f.recordOutcome(ctx, func(ctx context.Context) error {
				return f.config.SettlementStore.MarkSubmitted(ctx, txHash, ownerToken)
			})
			evidence := f.awaitEvidence(ctx, txHash, requirements.Network, required)
			return f.evidenceResponse(ctx, evidence, network, required, verified, false), nil
		}
		if classifier, ok := f.signer.(cardano.SubmissionRejectionClassifier); ok && classifier.IsDefinitiveSubmissionRejection(err) {
			f.recordOutcome(ctx, func(ctx context.Context) error {
				return f.config.SettlementStore.MarkRejected(ctx, txHash, ownerToken)
			})
			return fail(cardano.ErrSettlementDefinitivelyRejected, txHash, err.Error())
		}
		// Only an error proving nothing was sent releases the claim; anything
		// ambiguous keeps it, so the transaction is observed, never rebroadcast.
		if classifier, ok := f.signer.(cardano.SubmissionNotSentClassifier); ok && classifier.IsSubmissionNotSent(err) {
			f.recordOutcome(ctx, func(ctx context.Context) error {
				return f.config.SettlementStore.ReleaseClaim(ctx, txHash, ownerToken)
			})
			return fail(cardano.ErrSettlementFailed, txHash, err.Error())
		}
		f.recordOutcome(ctx, func(ctx context.Context) error {
			return f.config.SettlementStore.MarkSubmitted(ctx, txHash, ownerToken)
		})
		if hashMismatch {
			return fail(cardano.ErrSettlementFailed, txHash, err.Error())
		}
		// The transaction may still land: report it pending so the retry
		// reconciles this same transaction instead of the buyer paying again.
		return pendingResponse(txHash, network, verified.payer, nil, "submission outcome unknown: "+err.Error()), nil
	}
	f.recordOutcome(ctx, func(ctx context.Context) error {
		return f.config.SettlementStore.MarkSubmitted(ctx, txHash, ownerToken)
	})

	evidence := cardano.SettlementEvidence{Status: submission.Status, Confirmations: cardano.MinL1Confirmations}
	if submission.Status == cardano.EvidenceConfirmed {
		evidence.Confirmations = 0
	}
	if f.evidenceReader() != nil && (!f.config.AcceptMempool || required != cardano.MinL1Confirmations) {
		evidence = f.awaitEvidence(ctx, txHash, requirements.Network, required)
		// The node just accepted the transaction; an indexer that does not
		// report it yet is lagging, not proof of absence.
		if evidence.Status == cardano.EvidenceUnknown {
			evidence = cardano.SettlementEvidence{Status: cardano.EvidenceMempool, Confirmations: cardano.MinL1Confirmations}
		}
	}
	return f.evidenceResponse(ctx, evidence, network, required, verified, false), nil
}

// resumeSettlement observes a transaction this store already claimed. It
// never broadcasts.
func (f *ExactCardanoScheme) resumeSettlement(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, network x402.Network, txHash string, required int) (*x402.SettleResponse, error) {
	recheck, verified := f.runVerification(ctx, payload, requirements, true)
	if !recheck.IsValid {
		if recheck.InvalidReason == cardano.ErrChainLookupFailed || recheck.InvalidReason == cardano.ErrNonceNotOnChain {
			message := "the chain lookup failed while resuming a broadcast transaction"
			if recheck.InvalidMessage != "" {
				message += ": " + recheck.InvalidMessage
			}
			return pendingResponse(txHash, network, recheck.Payer, nil, message), nil
		}
		return &x402.SettleResponse{Success: false, ErrorReason: recheck.InvalidReason, ErrorMessage: recheck.InvalidMessage,
			Transaction: txHash, Network: network}, nil
	}
	evidence := f.awaitEvidence(ctx, txHash, requirements.Network, required)
	return f.evidenceResponse(ctx, evidence, network, required, verified, true), nil
}

func (f *ExactCardanoScheme) evidenceResponse(ctx context.Context, evidence cardano.SettlementEvidence, network x402.Network, required int, verified *verifiedPayment, resumed bool) *x402.SettleResponse {
	txHash := verified.decoded.TxHash
	base := x402.SettleResponse{Transaction: txHash, Network: network, Payer: verified.payer}
	if evidence.Status == evidenceUnavailable {
		return pendingResponse(txHash, network, verified.payer, nil, "transaction evidence is unavailable; the transaction may still have landed")
	}
	if evidence.Status == cardano.EvidenceUnknown {
		if resumed && f.validityWindowClosed(ctx, verified.decoded, string(network)) {
			base.ErrorReason = cardano.ErrSettlementFailed
			base.ErrorMessage = "the transaction's validity window closed before it was included"
			base.Extra = map[string]interface{}{"status": "expired"}
			return &base
		}
		return pendingResponse(txHash, network, verified.payer, nil, "")
	}
	extra := map[string]interface{}{"status": evidence.Status, "confirmations": evidence.Confirmations}
	if evidence.Status == cardano.EvidenceMempool {
		if f.config.AcceptMempool && cardano.ConfirmationsSatisfy(evidence.Confirmations, required) {
			base.Success, base.Extra = true, extra
			return &base
		}
		if f.evidenceReader() != nil {
			return pendingResponse(txHash, network, verified.payer, extra, "")
		}
		base.ErrorReason, base.Extra = cardano.ErrSettlementNotConfirmed, extra
		return &base
	}
	if !cardano.ConfirmationsSatisfy(evidence.Confirmations, required) {
		return pendingResponse(txHash, network, verified.payer, extra, "")
	}
	base.Success, base.Extra = true, extra
	return &base
}

// retainUntilMs is when the transaction can no longer land, plus grace; never
// earlier than now plus grace, so clock skew cannot release a fresh claim.
func (f *ExactCardanoScheme) retainUntilMs(decoded *cardano.DecodedTransaction, requirements types.PaymentRequirements) int64 {
	nowMs := f.now().UnixMilli()
	expires := nowMs + int64(requirements.MaxTimeoutSeconds)*1000
	if decoded.TTLSlot != nil {
		if ttlMs, err := cardano.SlotToPosixMs(requirements.Network, *decoded.TTLSlot); err == nil {
			expires = max(ttlMs, nowMs)
		}
	}
	return expires + cardano.SettlementRetentionGrace.Milliseconds()
}

// observedOnChain reports whether the evidence reader sees the transaction.
func (f *ExactCardanoScheme) observedOnChain(ctx context.Context, txHash, network string) bool {
	reader := f.evidenceReader()
	if reader == nil {
		return false
	}
	observed, err := reader.GetTransactionEvidence(ctx, txHash, network)
	return err == nil && observed != nil && observed.Status != cardano.EvidenceUnknown
}

// recordOutcome records a claim transition even when the request was
// cancelled, and reports a failure. It never changes the settle result: an
// unrecorded claim stays in flight and, once its lease expires, a retry
// resumes it from chain evidence without rebroadcasting.
func (f *ExactCardanoScheme) recordOutcome(ctx context.Context, transition func(context.Context) error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storeTransitionTimeout)
	defer cancel()
	if err := transition(ctx); err != nil && f.config.OnStoreError != nil {
		f.config.OnStoreError(err)
	}
}

func pendingResponse(txHash string, network x402.Network, payer string, extra map[string]interface{}, message string) *x402.SettleResponse {
	if message == "" {
		message = "the transaction was broadcast and is awaiting the required confirmations"
	}
	merged := map[string]interface{}{}
	for k, v := range extra {
		merged[k] = v
	}
	merged["status"] = "pending"
	merged["transactionId"] = txHash
	return &x402.SettleResponse{
		Success:      false,
		ErrorReason:  cardano.ErrSettlementPending,
		ErrorMessage: message,
		Transaction:  txHash,
		Network:      network,
		Payer:        payer,
		Extra:        merged,
	}
}

func (f *ExactCardanoScheme) validityWindowClosed(ctx context.Context, decoded *cardano.DecodedTransaction, network string) bool {
	if decoded.TTLSlot == nil {
		return false
	}
	currentSlot, err := f.signer.GetCurrentSlot(ctx, network)
	if err != nil {
		return false
	}
	nowMs, err1 := cardano.SlotToPosixMs(network, currentSlot)
	ttlMs, err2 := cardano.SlotToPosixMs(network, *decoded.TTLSlot)
	return err1 == nil && err2 == nil && nowMs > ttlMs+validityCloseGrace.Milliseconds()
}

func (f *ExactCardanoScheme) awaitEvidence(ctx context.Context, txHash, network string, required int) cardano.SettlementEvidence {
	unavailable := cardano.SettlementEvidence{Status: evidenceUnavailable, Confirmations: cardano.MinL1Confirmations - 1}
	reader := f.evidenceReader()
	if reader == nil {
		return unavailable
	}
	latest := cardano.SettlementEvidence{Status: cardano.EvidenceUnknown, Confirmations: cardano.MinL1Confirmations - 1}
	deadline := f.now().Add(f.config.ConfirmationTimeout)
	for {
		if evidence, err := reader.GetTransactionEvidence(ctx, txHash, network); err == nil && evidence != nil {
			latest = *evidence
		} else if latest.Status == cardano.EvidenceUnknown || latest.Status == evidenceUnavailable {
			latest = unavailable
		}
		if latest.Status != cardano.EvidenceUnknown && latest.Status != evidenceUnavailable && cardano.ConfirmationsSatisfy(latest.Confirmations, required) {
			return latest
		}
		if !f.now().Add(f.config.ConfirmationPoll).Before(deadline) {
			return latest
		}
		if f.sleep(ctx, f.config.ConfirmationPoll) != nil {
			return latest
		}
	}
}

func (f *ExactCardanoScheme) evidenceReader() cardano.TransactionEvidenceReader {
	reader, _ := f.signer.(cardano.TransactionEvidenceReader)
	return reader
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
