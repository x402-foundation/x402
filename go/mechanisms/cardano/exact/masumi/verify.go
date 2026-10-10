package masumi

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

// now is the package clock (issuance and deadline checks); tests replace it.
var now = time.Now

// LockCheck is the outcome of a Masumi check: OK, or the failure reason.
type LockCheck struct {
	OK     bool
	Reason string
	Detail string
}

func pass() LockCheck { return LockCheck{OK: true} }

func fail(reason, detail string) LockCheck { return LockCheck{Reason: reason, Detail: detail} }

func checkFromError(err error) LockCheck {
	var e *Error
	if errors.As(err, &e) {
		return fail(e.Reason, e.Detail)
	}
	return fail(cardano.ErrMasumiSchema, err.Error())
}

// RegistryClaim is a non-empty agentIdentifier to validate on the network.
type RegistryClaim struct {
	AgentIdentifier string
	SellerAddress   string
	Network         string
	Amount          string
	Asset           string
	Resource        types.ResourceInfo
}

// RegistryValidator independently validates a Masumi V2 registry claim: true
// when it is authentic and resolves to the signed price.
type RegistryValidator func(ctx context.Context, claim RegistryClaim) (bool, error)

// DeploymentClaim is a non-canonical deployment awaiting application approval.
type DeploymentClaim struct {
	Network    string
	PayTo      string
	Deployment Deployment
}

// DeploymentValidator explicitly approves one non-canonical deployment.
type DeploymentValidator func(ctx context.Context, claim DeploymentClaim) (bool, error)

// AuthorizationOptions configure VerifyAuthorization.
type AuthorizationOptions struct {
	// ValidateRegistryClaim is required to honour a non-empty agentIdentifier.
	ValidateRegistryClaim RegistryValidator
	// Resource is the protected resource a registry claim must cover.
	Resource *types.ResourceInfo
	// ValidateCustomDeployment is required to accept extra.deployment.
	ValidateCustomDeployment DeploymentValidator
	// LocalCommitmentContent is the buyer's own request content by part name.
	// It is authoritative: each supplied entry must match its part digest, and
	// it stands in for parts the issuer did not echo.
	LocalCommitmentContent map[string]interface{}
	// RequireAllPartContent rejects a part whose content is neither echoed
	// nor supplied locally. Clients MUST set it; facilitators leave it false.
	RequireAllPartContent bool
	// MaxDeadlineHorizonMs bounds how far past now externalDisputeUnlockTime
	// may sit. Buyer policy: a client sets it, a verifier does not.
	MaxDeadlineHorizonMs *int64
}

// Authorization is a verified seller authorization.
type Authorization struct {
	EscrowAddress string
	TermsDigest   string
}

func reject(reason, format string, args ...interface{}) *Error {
	return &Error{Reason: reason, Detail: fmt.Sprintf(format, args...)}
}

func sameCredentials(a, b AddressCredentials) bool {
	if a.Payment != b.Payment {
		return false
	}
	var sa, sb Credential
	if a.Stake != nil {
		sa = *a.Stake
	}
	if b.Stake != nil {
		sb = *b.Stake
	}
	if sa != sb {
		return false
	}
	pointerPart := func(p *Pointer, pick func(*Pointer) *big.Int) *big.Int {
		if p == nil {
			return big.NewInt(-1)
		}
		return pick(p)
	}
	for _, pick := range []func(*Pointer) *big.Int{
		func(p *Pointer) *big.Int { return p.Slot },
		func(p *Pointer) *big.Int { return p.TxIndex },
		func(p *Pointer) *big.Int { return p.CertIndex },
	} {
		if pointerPart(a.Pointer, pick).Cmp(pointerPart(b.Pointer, pick)) != 0 {
			return false
		}
	}
	return true
}

func returnAddressMatches(declared *string, actual *AddressCredentials) bool {
	if declared == nil {
		return actual == nil
	}
	if actual == nil {
		return false
	}
	creds, err := ExtractAddressCredentials(*declared)
	return err == nil && sameCredentials(*actual, creds)
}

func unsupportedAddressForm(c AddressCredentials) string {
	switch {
	case c.Payment.IsScript:
		return "script payment credential"
	case c.Stake != nil && c.Stake.IsScript:
		return "script stake credential"
	case c.Pointer != nil:
		return "pointer stake reference"
	}
	return ""
}

// VerifyDatumInvariants checks the invariants that make a fresh lock datum
// spendable: FundsLocked, empty result_hash, zero cooldowns, key-only address
// forms, a reference signature of at least 16 bytes, no address equal to the
// escrow, distinct payout targets and the minimum deadline intervals. Client
// preflight and facilitator share it.
func VerifyDatumInvariants(view *DatumView, escrowAddress string) LockCheck {
	if view.State != StateFundsLocked {
		return fail(cardano.ErrMasumiDatumInvalid, "state")
	}
	if view.ResultHash != "" {
		return fail(cardano.ErrMasumiDatumInvalid, "result_hash")
	}
	if view.SellerCooldownTime.Sign() != 0 || view.BuyerCooldownTime.Sign() != 0 {
		return fail(cardano.ErrMasumiDatumInvalid, "cooldown")
	}
	forms := []struct {
		field string
		creds *AddressCredentials
	}{
		{"buyer", &view.Buyer},
		{"seller", &view.Seller},
		{"buyer_return_address", view.BuyerReturnAddress},
		{"seller_return_address", view.SellerReturnAddress},
	}
	for _, f := range forms {
		if f.creds == nil {
			continue
		}
		if unsupported := unsupportedAddressForm(*f.creds); unsupported != "" {
			return fail(cardano.ErrMasumiDatumInvalid, f.field+" is a "+unsupported)
		}
	}
	if len(view.ReferenceSignature) < 32 {
		return fail(cardano.ErrMasumiDatumInvalid, "reference_signature shorter than 16 bytes")
	}

	escrow, err := ExtractAddressCredentials(escrowAddress)
	if err != nil {
		return fail(cardano.ErrMasumiDatumInvalid, "escrow address: "+err.Error())
	}
	buyerTarget, sellerTarget := view.Buyer, view.Seller
	if view.BuyerReturnAddress != nil {
		buyerTarget = *view.BuyerReturnAddress
	}
	if view.SellerReturnAddress != nil {
		sellerTarget = *view.SellerReturnAddress
	}
	if sameCredentials(view.Buyer, escrow) || sameCredentials(view.Seller, escrow) ||
		sameCredentials(buyerTarget, escrow) || sameCredentials(sellerTarget, escrow) {
		return fail(cardano.ErrMasumiDatumInvalid, "datum address is the escrow")
	}
	if sameCredentials(buyerTarget, sellerTarget) {
		return fail(cardano.ErrMasumiDatumInvalid, "buyer and seller payout targets are equal")
	}
	if !DeadlineIntervalsHold(view.PayByTime, view.SubmitResultTime, view.UnlockTime, view.ExternalDisputeUnlockTime) {
		return fail(cardano.ErrMasumiDeadline, "deadline intervals below the minimum")
	}
	return pass()
}

func verifyTermDeadlines(terms Terms, maxDeadlineHorizonMs *int64) *Error {
	external := parseBig(terms.ExternalDisputeUnlockTime)
	if !DeadlineIntervalsHold(parseBig(terms.PayByTime), parseBig(terms.SubmitResultTime), parseBig(terms.UnlockTime), external) {
		return reject(cardano.ErrMasumiDeadline, "deadline intervals below the minimum")
	}
	if maxDeadlineHorizonMs != nil {
		limit := new(big.Int).Add(big.NewInt(now().UnixMilli()), big.NewInt(*maxDeadlineHorizonMs))
		if external.Cmp(limit) > 0 {
			return reject(cardano.ErrMasumiDeadline, "deadlines extend beyond the accepted horizon")
		}
	}
	return nil
}

// partContent resolves the content a part digest is checked against: the
// issuer's non-null content, else the buyer's local content.
func partContent(part CommitmentPart, local map[string]interface{}) (interface{}, bool) {
	if part.Content.Set && part.Content.Value != nil {
		return part.Content.Value, true
	}
	if local == nil {
		return nil, false
	}
	content, ok := local[part.Name]
	return content, ok
}

// VerifyAuthorization verifies the seller authorization carried in a
// schema-validated extra: deadlines (and the optional buyer horizon), every
// part digest and the input hash, the deployment-derived escrow equal to
// payTo, the seller's COSE signature over termsDigest, application approval
// of a custom deployment, the registry claim, and the compatibility
// identifier. A client runs it before signing; the facilitator runs it on
// every payment. Rejections are *Error.
func VerifyAuthorization(ctx context.Context, extra *Extra, requirements types.PaymentRequirements, opts AuthorizationOptions) (*Authorization, error) {
	terms := extra.Terms
	if err := verifyTermDeadlines(terms, opts.MaxDeadlineHorizonMs); err != nil {
		return nil, err
	}

	for _, part := range extra.InputCommitment.Parts {
		content, ok := partContent(part, opts.LocalCommitmentContent)
		if !ok {
			if opts.RequireAllPartContent {
				return nil, reject(cardano.ErrMasumiCommitment, "part %s carries no content to verify its digest against", part.Name)
			}
			continue
		}
		digest, err := CommitmentPartDigest(part.Canonicalization, content)
		if err != nil {
			return nil, &Error{Reason: cardano.ErrMasumiCommitment, Detail: err.Error()}
		}
		if digest != part.Digest {
			return nil, reject(cardano.ErrMasumiCommitment, "part %s digest mismatch", part.Name)
		}
		// The buyer's own request content is authoritative: an echo with a
		// self-consistent digest must not substitute a different request.
		if local, ok := opts.LocalCommitmentContent[part.Name]; ok {
			localDigest, err := CommitmentPartDigest(part.Canonicalization, local)
			if err != nil || localDigest != part.Digest {
				return nil, reject(cardano.ErrMasumiCommitment, "part %s does not commit to the buyer's request", part.Name)
			}
		}
	}
	inputHash, err := ComputeInputHash(extra.InputCommitment)
	if err != nil || inputHash != extra.InputCommitment.Digest {
		return nil, reject(cardano.ErrMasumiCommitment, "commitment digest mismatch")
	}

	deployment, ok := ResolveDeployment(requirements.Network, extra.Deployment)
	if !ok {
		return nil, reject(cardano.ErrMasumiDeployment, "network has no canonical deployment; extra.deployment is required")
	}
	escrowAddress, err := EscrowAddress(requirements.Network, deployment)
	if err != nil {
		return nil, &Error{Reason: cardano.ErrMasumiDeployment, Detail: err.Error()}
	}
	if escrowAddress != requirements.PayTo {
		return nil, reject(cardano.ErrMasumiDeployment, "derived escrow %s does not equal payTo", escrowAddress)
	}
	termsDigest, err := ComputeTermsDigest(BuildSignedTerms(extra, requirements))
	if err != nil || !VerifySellerTermsSignature(extra.ReferenceKey, extra.ReferenceSignature, terms.SellerAddress, termsDigest) {
		return nil, &Error{Reason: cardano.ErrMasumiSellerSignature}
	}

	if extra.Deployment != nil {
		if opts.ValidateCustomDeployment == nil {
			return nil, reject(cardano.ErrMasumiDeployment, "custom deployment requires explicit application approval")
		}
		approved, err := opts.ValidateCustomDeployment(ctx, DeploymentClaim{
			Network: requirements.Network, PayTo: requirements.PayTo, Deployment: *extra.Deployment,
		})
		if err != nil {
			return nil, reject(cardano.ErrMasumiDeployment, "custom deployment validation failed: %v", err)
		}
		if !approved {
			return nil, reject(cardano.ErrMasumiDeployment, "custom deployment was not approved")
		}
	}

	agentIdentifier := terms.AgentIdentifier.Hex()
	if agentIdentifier != "" {
		if !strings.HasPrefix(agentIdentifier, RegistryPolicyID) {
			return nil, reject(cardano.ErrMasumiAgentIdentifier, "agentIdentifier does not carry the Masumi V2 registry policy id")
		}
		if opts.ValidateRegistryClaim == nil {
			return nil, reject(cardano.ErrMasumiAgentIdentifier, "registry claims require an independent on-network validator")
		}
		if opts.Resource == nil {
			return nil, reject(cardano.ErrMasumiAgentIdentifier, "registry claims require the protected resource for endpoint validation")
		}
		valid, err := opts.ValidateRegistryClaim(ctx, RegistryClaim{
			AgentIdentifier: agentIdentifier,
			SellerAddress:   terms.SellerAddress,
			Network:         requirements.Network,
			Amount:          requirements.Amount,
			Asset:           requirements.Asset,
			Resource:        *opts.Resource,
		})
		if err != nil {
			return nil, reject(cardano.ErrMasumiAgentIdentifier, "registry validation failed: %v", err)
		}
		if !valid {
			return nil, reject(cardano.ErrMasumiAgentIdentifier, "registry validation rejected the claim")
		}
	}

	decoded, ok := DecodeBlockchainIdentifier(extra.BlockchainIdentifier)
	if !ok || decoded.SellerNonce != terms.SellerNonce || decoded.AgentIdentifier != agentIdentifier ||
		decoded.BuyerNonce != terms.BuyerNonce || decoded.ReferenceSignature != extra.ReferenceSignature ||
		decoded.ReferenceKey != extra.ReferenceKey || decoded.ContractAddress != requirements.PayTo {
		return nil, &Error{Reason: cardano.ErrMasumiIdentifier}
	}
	return &Authorization{EscrowAddress: escrowAddress, TermsDigest: termsDigest}, nil
}

// VerifyContext is what VerifyLock needs beyond the requirements and the
// decoded transaction.
type VerifyContext struct {
	// Payer is the address owning the nonce UTxO, i.e. the resolved buyer.
	Payer string
	// CoinsPerUtxoByte enables the post-result min-UTxO check when set.
	CoinsPerUtxoByte         *uint64
	ValidateRegistryClaim    RegistryValidator
	Resource                 *types.ResourceInfo
	ValidateCustomDeployment DeploymentValidator
	// MaxDeadlineHorizonMs is buyer policy; a facilitator leaves it nil.
	MaxDeadlineHorizonMs *int64
}

// VerifyLock verifies that a transaction locks the requested funds into the
// Masumi vested_pay escrow with a well-formed FundsLocked datum matching the
// seller-signed terms.
func VerifyLock(ctx context.Context, rawExtra map[string]interface{}, requirements types.PaymentRequirements, decoded *cardano.DecodedTransaction, vctx VerifyContext) LockCheck {
	extra, err := ValidateExtra(rawExtra, requirements.Network)
	if err != nil {
		return checkFromError(err)
	}
	terms := extra.Terms
	authorization, err := VerifyAuthorization(ctx, extra, requirements, AuthorizationOptions{
		ValidateRegistryClaim:    vctx.ValidateRegistryClaim,
		Resource:                 vctx.Resource,
		ValidateCustomDeployment: vctx.ValidateCustomDeployment,
		MaxDeadlineHorizonMs:     vctx.MaxDeadlineHorizonMs,
	})
	if err != nil {
		return checkFromError(err)
	}
	escrowAddress := authorization.EscrowAddress

	var escrowOutputs []cardano.UtxoOutput
	for _, o := range decoded.Outputs {
		if o.Address == escrowAddress {
			escrowOutputs = append(escrowOutputs, o)
		}
	}
	if len(escrowOutputs) != 1 {
		return fail(cardano.ErrMasumiEscrowOutputCount, "")
	}
	output := escrowOutputs[0]
	if output.Datum == "" {
		return fail(cardano.ErrMasumiDatumMissing, "")
	}
	if output.HasReferenceScript {
		return fail(cardano.ErrMasumiReferenceScript, "")
	}
	view, err := ParseLockDatum(output.Datum)
	if err != nil {
		return fail(cardano.ErrMasumiDatumInvalid, "datum does not match masumi.vested_pay.v2")
	}
	if check := VerifyDatumInvariants(view, escrowAddress); !check.OK {
		return check
	}
	if decoded.TTLSlot == nil {
		return fail(cardano.ErrMasumiDeadline, "no validity upper bound")
	}
	ttlMs, err := cardano.SlotToPosixMs(requirements.Network, *decoded.TTLSlot)
	if err != nil {
		return fail(cardano.ErrMasumiDeadline, err.Error())
	}
	if big.NewInt(ttlMs).Cmp(view.PayByTime) > 0 {
		return fail(cardano.ErrMasumiDeadline, "TTL is after pay_by_time")
	}

	payer, err := ExtractAddressCredentials(vctx.Payer)
	if err != nil || view.Buyer.Payment.Hash != payer.Payment.Hash {
		return fail(cardano.ErrMasumiDatumMismatch, "buyer does not control the nonce input")
	}
	if !slices.Contains(decoded.VkeyHashes, view.Buyer.Payment.Hash) {
		return fail(cardano.ErrMasumiDatumMismatch, "no witness for the buyer credential")
	}

	seller, err := ExtractAddressCredentials(terms.SellerAddress)
	if err != nil || !sameCredentials(view.Seller, seller) {
		return fail(cardano.ErrMasumiDatumMismatch, "seller")
	}
	if !returnAddressMatches(terms.SellerReturnAddress, view.SellerReturnAddress) {
		return fail(cardano.ErrMasumiDatumMismatch, "seller_return_address")
	}
	byteFields := []struct{ field, declared, actual string }{
		{"reference_key", extra.ReferenceKey, view.ReferenceKey},
		{"reference_signature", extra.ReferenceSignature, view.ReferenceSignature},
		{"seller_nonce", terms.SellerNonce, view.SellerNonce},
		{"buyer_nonce", terms.BuyerNonce, view.BuyerNonce},
		{"agent_identifier", terms.AgentIdentifier.Hex(), view.AgentIdentifier},
		{"input_hash", terms.InputHash, view.InputHash},
	}
	for _, f := range byteFields {
		if strings.ToLower(f.declared) != f.actual {
			return fail(cardano.ErrMasumiDatumMismatch, f.field)
		}
	}
	timeFields := []struct {
		field    string
		declared string
		actual   *big.Int
	}{
		{"pay_by_time", terms.PayByTime, view.PayByTime},
		{"submit_result_time", terms.SubmitResultTime, view.SubmitResultTime},
		{"unlock_time", terms.UnlockTime, view.UnlockTime},
		{"external_dispute_unlock_time", terms.ExternalDisputeUnlockTime, view.ExternalDisputeUnlockTime},
	}
	for _, f := range timeFields {
		if parseBig(f.declared).Cmp(f.actual) != 0 {
			return fail(cardano.ErrMasumiDatumMismatch, f.field)
		}
	}

	amount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return fail(cardano.ErrMasumiAsset, "amount is not an integer")
	}
	assetKey := strings.ToLower(requirements.Asset)
	isLovelace := assetKey == cardano.LovelaceAsset
	requested := big.NewInt(0)
	if isLovelace {
		requested = amount
	}
	collateral := view.CollateralReturnLovelace
	if collateral.Sign() < 0 || (collateral.Sign() > 0 && collateral.Cmp(new(big.Int).SetUint64(MinCollateralLovelace)) < 0) {
		return fail(cardano.ErrMasumiCollateral, fmt.Sprintf("collateral %s below the floor", collateral))
	}
	expected := new(big.Int).Add(requested, collateral)
	coin := new(big.Int).SetUint64(output.Coin)
	if coin.Cmp(expected) != 0 {
		return fail(cardano.ErrMasumiCollateral, fmt.Sprintf("locked %d lovelace, expected %s", output.Coin, expected))
	}
	if !isLovelace {
		quantity, present := output.Assets[assetKey]
		if !present || new(big.Int).SetUint64(quantity).Cmp(amount) != 0 {
			return fail(cardano.ErrMasumiAsset, "native token amount is not exact")
		}
	}
	wantAssets := 0
	if !isLovelace {
		wantAssets = 1
	}
	if len(output.Assets) != wantAssets {
		return fail(cardano.ErrMasumiAsset, "escrow output carries extra native tokens")
	}
	if vctx.CoinsPerUtxoByte != nil {
		required := MinUtxoLovelace(len(output.Datum)/2, len(output.Assets), *vctx.CoinsPerUtxoByte)
		if output.Coin < required {
			return fail(cardano.ErrMasumiMinUtxo, fmt.Sprintf("locked %d, post-result minimum %d", output.Coin, required))
		}
	}
	return pass()
}
