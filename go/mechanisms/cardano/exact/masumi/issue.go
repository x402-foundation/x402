package masumi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

const maxSafeInteger = 1<<53 - 1

// CommitmentInput is one part of the request the issuer commits to.
type CommitmentInput struct {
	Name string
	// Canonicalization is "jcs" or "raw".
	Canonicalization string
	MediaType        *string
	// Content is RFC 8785-compatible JSON for jcs, unpadded base64url for raw.
	Content interface{}
	// OmitContent keeps content off the wire for parts derived from the
	// client's own request bytes. Issuer-originated content MUST be echoed.
	OmitContent bool
}

// IssueInput is everything needed to issue one Masumi 402.
type IssueInput struct {
	Network string
	// Asset is lovelace or a canonical policyId.assetNameHex unit.
	Asset string
	// Amount is a positive canonical decimal string in the asset's smallest unit.
	Amount            string
	MaxTimeoutSeconds int
	// SellerAddress is the seller's key-credential address on Network.
	SellerAddress string
	SignTerms     TermsSigner
	Commitment    []CommitmentInput
	// POSIX-millisecond deadlines, ordered and clearing the minimum gaps.
	PayByTime                 string
	SubmitResultTime          string
	UnlockTime                string
	ExternalDisputeUnlockTime string
	// SellerNonce is 64 lowercase hex characters; generated when empty.
	SellerNonce string
	// BuyerNonce is empty or the buyer nonce extracted from the request.
	BuyerNonce string
	// AgentIdentifier is the registry asset identifier; unset, null or empty
	// means unregistered.
	AgentIdentifier     AgentIdentifier
	SellerReturnAddress *string
	ConfirmationPolicy  *cardano.ConfirmationPolicy
	// Deployment is a non-canonical parameterization; required on Preview.
	Deployment *Deployment
	// UnsafeSkipPolicyChecks skips the deadline and window policy. Test-only:
	// it lets fixed vectors be reissued after their deadlines passed.
	UnsafeSkipPolicyChecks bool
	// MaxDeadlineHorizonMs caps the last escrow deadline's distance from now;
	// nil uses the package default of 30 days.
	MaxDeadlineHorizonMs *int64
}

func (in IssueInput) horizon() int64 {
	if in.MaxDeadlineHorizonMs != nil {
		return *in.MaxDeadlineHorizonMs
	}
	return MaxDeadlineHorizonMs
}

func assertIssuePolicy(in IssueInput, nowMs int64) error {
	deadlines := []struct{ name, value string }{
		{"payByTime", in.PayByTime},
		{"submitResultTime", in.SubmitResultTime},
		{"unlockTime", in.UnlockTime},
		{"externalDisputeUnlockTime", in.ExternalDisputeUnlockTime},
	}
	for _, d := range deadlines {
		if !isPosixMsString(d.value) {
			return fmt.Errorf("masumi %s must be a positive POSIX-ms integer string", d.name)
		}
	}
	if !DeadlineIntervalsHold(parseBig(in.PayByTime), parseBig(in.SubmitResultTime), parseBig(in.UnlockTime), parseBig(in.ExternalDisputeUnlockTime)) {
		return errors.New("masumi deadline intervals are below the minimum")
	}
	return assertIssueWindow(in.PayByTime, in.SubmitResultTime, in.ExternalDisputeUnlockTime, in.MaxTimeoutSeconds, nowMs, in.horizon())
}

// assertIssueWindow is the clock-relative half of the issue policy; it runs
// again after signing, which may take arbitrarily long.
func assertIssueWindow(payByTime, submitResultTime, externalDisputeUnlockTime string, maxTimeoutSeconds int, nowMs, horizonMs int64) error {
	payBy := parseBig(payByTime)
	nowBig := big.NewInt(nowMs)
	plus := func(ms int64) *big.Int { return new(big.Int).Add(nowBig, big.NewInt(ms)) }
	if payBy.Cmp(nowBig) <= 0 {
		return errors.New("masumi payByTime must be in the future")
	}
	if parseBig(submitResultTime).Cmp(plus(MinSubmitResultLeadMs)) < 0 {
		return errors.New("masumi submitResultTime must be at least 15 minutes away")
	}
	if parseBig(externalDisputeUnlockTime).Cmp(plus(horizonMs)) > 0 {
		return errors.New("masumi deadlines extend beyond the accepted horizon")
	}
	if payBy.Cmp(plus(int64(maxTimeoutSeconds)*1000)) > 0 {
		return errors.New("masumi payByTime exceeds maxTimeoutSeconds")
	}
	return nil
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// BuildInputCommitment digests the request parts into the inputCommitment
// whose digest becomes terms.inputHash.
func BuildInputCommitment(parts []CommitmentInput) (InputCommitment, error) {
	commitment := InputCommitment{Version: "1", Algorithm: "sha256", Parts: make([]CommitmentPart, len(parts))}
	for i, part := range parts {
		digest, err := CommitmentPartDigest(part.Canonicalization, part.Content)
		if err != nil {
			return InputCommitment{}, fmt.Errorf("masumi commitment part %s: %w", part.Name, err)
		}
		commitment.Parts[i] = CommitmentPart{
			Name:             part.Name,
			Canonicalization: part.Canonicalization,
			MediaType:        part.MediaType,
			Content:          OptionalValue{Set: !part.OmitContent, Value: part.Content},
			Digest:           digest,
		}
	}
	var err error
	if commitment.Digest, err = ComputeInputHash(commitment); err != nil {
		return InputCommitment{}, err
	}
	return commitment, nil
}

// IssueRequirements issues a Masumi PaymentRequirements: payTo derived from the
// deployment, a request commitment, seller-signed terms, the seller's CIP-8
// authorization and the compatibility identifier. The issuer MUST store the
// result keyed by its termsDigest and serve it verbatim on the paid retry.
func IssueRequirements(ctx context.Context, in IssueInput) (types.PaymentRequirements, error) {
	var none types.PaymentRequirements
	if !cardano.IsPositiveCanonicalAmount(in.Amount) {
		return none, fmt.Errorf("masumi amount must be a positive canonical integer: %s", in.Amount)
	}
	if !cardano.IsCanonicalAsset(in.Asset) {
		return none, fmt.Errorf("masumi asset must use canonical lowercase form: %s", in.Asset)
	}
	if in.MaxTimeoutSeconds <= 0 || in.MaxTimeoutSeconds > maxSafeInteger {
		return none, errors.New("masumi maxTimeoutSeconds must be a positive safe integer")
	}
	if in.SignTerms == nil {
		return none, errors.New("masumi issuance requires a terms signer")
	}
	if !in.UnsafeSkipPolicyChecks {
		if err := assertIssuePolicy(in, now().UnixMilli()); err != nil {
			return none, err
		}
	}
	deployment, ok := ResolveDeployment(in.Network, in.Deployment)
	if !ok {
		return none, fmt.Errorf("network %s has no canonical Masumi deployment; supply IssueInput.Deployment", in.Network)
	}
	payTo, err := EscrowAddress(in.Network, deployment)
	if err != nil {
		return none, err
	}

	commitment, err := BuildInputCommitment(in.Commitment)
	if err != nil {
		return none, err
	}

	sellerNonce := in.SellerNonce
	if sellerNonce == "" {
		if sellerNonce, err = randomHex(32); err != nil {
			return none, err
		}
	}
	terms := Terms{
		Version:                   "1",
		PaymentType:               PaymentSourceType,
		SellerAddress:             in.SellerAddress,
		SellerReturnAddress:       in.SellerReturnAddress,
		SellerNonce:               sellerNonce,
		BuyerNonce:                in.BuyerNonce,
		AgentIdentifier:           in.AgentIdentifier,
		InputHash:                 commitment.Digest,
		PayByTime:                 in.PayByTime,
		SubmitResultTime:          in.SubmitResultTime,
		UnlockTime:                in.UnlockTime,
		ExternalDisputeUnlockTime: in.ExternalDisputeUnlockTime,
	}
	requirements := types.PaymentRequirements{
		Scheme:            cardano.SchemeExact,
		Network:           in.Network,
		Asset:             in.Asset,
		Amount:            in.Amount,
		PayTo:             payTo,
		MaxTimeoutSeconds: in.MaxTimeoutSeconds,
	}
	extra := &Extra{
		AssetTransferMethod: cardano.AssetTransferMethodMasumi,
		ConfirmationPolicy:  in.ConfirmationPolicy,
		InputCommitment:     commitment,
		Terms:               terms,
		Deployment:          in.Deployment,
	}
	termsDigest, err := ComputeTermsDigest(BuildSignedTerms(extra, requirements))
	if err != nil {
		return none, err
	}
	authorization, err := in.SignTerms(ctx, in.SellerAddress, termsDigest)
	if err != nil {
		return none, fmt.Errorf("masumi seller signing failed: %w", err)
	}
	extra.ReferenceKey = strings.ToLower(authorization.Key)
	extra.ReferenceSignature = strings.ToLower(authorization.Signature)

	if !in.UnsafeSkipPolicyChecks {
		if err := assertIssueWindow(terms.PayByTime, terms.SubmitResultTime, terms.ExternalDisputeUnlockTime,
			requirements.MaxTimeoutSeconds, now().UnixMilli(), in.horizon()); err != nil {
			return none, err
		}
	}

	if extra.BlockchainIdentifier, err = EncodeBlockchainIdentifier(IdentifierParts{
		SellerNonce:        terms.SellerNonce,
		AgentIdentifier:    terms.AgentIdentifier.Hex(),
		BuyerNonce:         terms.BuyerNonce,
		ReferenceSignature: extra.ReferenceSignature,
		ReferenceKey:       extra.ReferenceKey,
		ContractAddress:    payTo,
	}); err != nil {
		return none, err
	}
	wire, err := extra.ToMap()
	if err != nil {
		return none, err
	}
	if _, err := ValidateExtra(wire, in.Network); err != nil {
		var e *Error
		if errors.As(err, &e) {
			return none, fmt.Errorf("issued Masumi requirements are invalid: %s", e.Detail)
		}
		return none, err
	}
	requirements.Extra = wire
	return requirements, nil
}
