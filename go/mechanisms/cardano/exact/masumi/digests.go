package masumi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"

	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	inputHashDomain   = "masumi:x402:input:v1\n"
	termsDigestDomain = "masumi:x402:terms:v1\n"
)

func domainDigest(domain string, value interface{}) (string, error) {
	body, err := JCS(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(append([]byte(domain), body...))
	return hex.EncodeToString(sum[:]), nil
}

// CommitmentPartBytes serializes part content to the bytes its digest covers:
// UTF-8(JCS(content)) for jcs, base64url-decode(content) for raw. A nil content
// is JSON null.
func CommitmentPartBytes(canonicalization string, content interface{}) ([]byte, error) {
	if canonicalization != "raw" {
		return JCS(content)
	}
	s, ok := content.(string)
	if !ok {
		return nil, errors.New("commitment raw content must be an unpadded base64url string")
	}
	if !base64URLRegex.MatchString(s) {
		return nil, errors.New("commitment raw content is not unpadded base64url")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != s {
		return nil, errors.New("commitment raw content is not canonical unpadded base64url")
	}
	return decoded, nil
}

// CommitmentPartDigest is the lowercase hex SHA-256 of CommitmentPartBytes.
func CommitmentPartDigest(canonicalization string, content interface{}) (string, error) {
	b, err := CommitmentPartBytes(canonicalization, content)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// ComputeInputHash recomputes inputCommitment.digest over the content-free
// manifest (every part's content and the top-level digest omitted).
func ComputeInputHash(commitment InputCommitment) (string, error) {
	parts := make([]interface{}, len(commitment.Parts))
	for i, part := range commitment.Parts {
		entry := map[string]interface{}{
			"name":             part.Name,
			"canonicalization": part.Canonicalization,
			"digest":           part.Digest,
		}
		if part.MediaType != nil {
			entry["mediaType"] = *part.MediaType
		}
		parts[i] = entry
	}
	return domainDigest(inputHashDomain, map[string]interface{}{
		"version":   commitment.Version,
		"algorithm": commitment.Algorithm,
		"parts":     parts,
	})
}

// BuildSignedTerms reconstructs signedTerms: the terms verbatim (an absent,
// null or empty agentIdentifier stays exactly as signed) plus the seven fields
// projected from the requirements.
func BuildSignedTerms(extra *Extra, requirements types.PaymentRequirements) map[string]interface{} {
	t := extra.Terms
	signed := map[string]interface{}{
		"version":                   t.Version,
		"paymentType":               t.PaymentType,
		"sellerAddress":             t.SellerAddress,
		"sellerNonce":               t.SellerNonce,
		"buyerNonce":                t.BuyerNonce,
		"inputHash":                 t.InputHash,
		"payByTime":                 t.PayByTime,
		"submitResultTime":          t.SubmitResultTime,
		"unlockTime":                t.UnlockTime,
		"externalDisputeUnlockTime": t.ExternalDisputeUnlockTime,
		"scheme":                    requirements.Scheme,
		"assetTransferMethod":       extra.AssetTransferMethod,
		"network":                   requirements.Network,
		"contractAddress":           requirements.PayTo,
		"amount":                    requirements.Amount,
		"asset":                     requirements.Asset,
		"maxTimeoutSeconds":         requirements.MaxTimeoutSeconds,
	}
	if t.SellerReturnAddress != nil {
		signed["sellerReturnAddress"] = *t.SellerReturnAddress
	}
	if t.AgentIdentifier.Set {
		signed["agentIdentifier"] = t.AgentIdentifier.wire()
	}
	return signed
}

// ComputeTermsDigest is the termsDigest the seller authorizes with signData.
func ComputeTermsDigest(signedTerms map[string]interface{}) (string, error) {
	return domainDigest(termsDigestDomain, signedTerms)
}

// TermsDigest validates requirements.extra and returns the termsDigest of the
// requirements.
func TermsDigest(requirements types.PaymentRequirements) (string, error) {
	extra, err := ValidateExtra(requirements.Extra, requirements.Network)
	if err != nil {
		return "", err
	}
	return ComputeTermsDigest(BuildSignedTerms(extra, requirements))
}

// ClaimBinding returns the termsDigest a settlement binds and when those terms
// can no longer pay: payByTime plus maxTimeoutSeconds, in POSIX ms.
func ClaimBinding(requirements types.PaymentRequirements) (string, int64, error) {
	extra, err := ValidateExtra(requirements.Extra, requirements.Network)
	if err != nil {
		return "", 0, err
	}
	digest, err := ComputeTermsDigest(BuildSignedTerms(extra, requirements))
	if err != nil {
		return "", 0, err
	}
	expires, err := paymentWindowEndMs(extra, requirements.MaxTimeoutSeconds)
	return digest, expires, err
}

// paymentWindowEndMs is payByTime plus maxTimeoutSeconds, in POSIX ms.
func paymentWindowEndMs(extra *Extra, maxTimeoutSeconds int) (int64, error) {
	payBy, err := strconv.ParseInt(extra.Terms.PayByTime, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid Masumi payByTime: %w", err)
	}
	return payBy + int64(maxTimeoutSeconds)*1000, nil
}
