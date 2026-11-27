package masumi

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"unicode/utf16"

	"github.com/blinklabs-io/gouroboros/ledger/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

var (
	extraKeys = keySet("assetTransferMethod", "confirmationPolicy", "areFeesSponsored", "inputCommitment",
		"terms", "referenceKey", "referenceSignature", "blockchainIdentifier", "deployment")
	commitmentKeys = keySet("version", "algorithm", "parts", "digest")
	partKeys       = keySet("name", "canonicalization", "mediaType", "content", "digest")
	termsKeys      = keySet("version", "paymentType", "sellerAddress", "sellerReturnAddress", "sellerNonce",
		"buyerNonce", "agentIdentifier", "inputHash", "payByTime", "submitResultTime", "unlockTime",
		"externalDisputeUnlockTime")
	deploymentKeys = keySet("requiredAdmins", "adminVkeys", "cooldownPeriod")

	hexRegex            = regexp.MustCompile(`^([0-9a-f]{2})*$`)
	hex32Regex          = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hex28Regex          = regexp.MustCompile(`^[0-9a-f]{56}$`)
	positiveIntRegex    = regexp.MustCompile(`^[1-9][0-9]*$`)
	nonNegativeIntRegex = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	base64URLRegex      = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)
)

const (
	maxJSONDepth               = 64
	maxJSONValues              = 100_000
	maxPartNameChars           = 128
	maxMediaTypeChars          = 256
	maxPosixDigits             = 20
	maxAgentIdentifierHexChars = 120
)

func keySet(keys ...string) map[string]bool {
	set := make(map[string]bool, len(keys))
	for _, k := range keys {
		set[k] = true
	}
	return set
}

func schemaError(format string, args ...interface{}) *Error {
	return &Error{Reason: cardano.ErrMasumiSchema, Detail: fmt.Sprintf(format, args...)}
}

// unknownKey names the first (in sorted order) key outside allowed.
func unknownKey(value map[string]interface{}, allowed map[string]bool) (string, bool) {
	var unknown []string
	for k := range value {
		if !allowed[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) == 0 {
		return "", false
	}
	sort.Strings(unknown)
	return unknown[0], true
}

func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

// isPosixMsString reports a bounded, positive, canonical decimal string.
func isPosixMsString(value interface{}) bool {
	s, ok := value.(string)
	return ok && len(s) <= maxPosixDigits && positiveIntRegex.MatchString(s)
}

func parseBig(s string) *big.Int {
	n, _ := new(big.Int).SetString(s, 10)
	return n
}

// IsKeyCredentialAddressOn reports whether value is a bech32 enterprise address
// with a key payment credential, or a base address whose payment and stake
// credentials are both key hashes, on the selected network.
func IsKeyCredentialAddressOn(value interface{}, network string) bool {
	s, ok := value.(string)
	if !ok || s == "" {
		return false
	}
	addr, err := parseShelleyAddress(s)
	if err != nil {
		return false
	}
	switch addr.Type() {
	case common.AddressTypeKeyNone, common.AddressTypeKeyKey:
	default:
		return false
	}
	networkID, err := cardano.NetworkID(network)
	return err == nil && int(addr.NetworkId()) == networkID
}

// normalizeJSON round-trips a value through encoding/json so validation sees
// only the types JSON decoding produces.
func normalizeJSON(value interface{}) (interface{}, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ValidateExtra validates a masumi extra block against the closed wire schema
// and returns its typed form. Errors are *Error with reason ErrMasumiSchema.
// Digests, signatures, the escrow address and the datum are verified separately.
func ValidateExtra(extra map[string]interface{}, network string) (*Extra, error) {
	if extra == nil {
		return nil, schemaError("extra must be an object")
	}
	normalized, err := normalizeJSON(extra)
	if err != nil {
		return nil, schemaError("extra is not valid JSON")
	}
	value, ok := normalized.(map[string]interface{})
	if !ok {
		return nil, schemaError("extra must be an object")
	}
	if key, bad := unknownKey(value, extraKeys); bad {
		return nil, schemaError("extra has unknown field %s", key)
	}
	if value["assetTransferMethod"] != cardano.AssetTransferMethodMasumi {
		return nil, schemaError("extra.assetTransferMethod must be masumi")
	}
	var policy *cardano.ConfirmationPolicy
	if raw, present := value["confirmationPolicy"]; present {
		p, ok := normalizeConfirmationPolicy(raw)
		if !ok {
			return nil, schemaError("extra.confirmationPolicy must be { l1Confirmations: -1..20 }")
		}
		policy = &p
	}
	var feesSponsored *bool
	if raw, present := value["areFeesSponsored"]; present {
		if raw != false {
			return nil, schemaError("extra.areFeesSponsored must be false")
		}
		f := false
		feesSponsored = &f
	}
	for _, field := range []string{"referenceKey", "referenceSignature", "blockchainIdentifier"} {
		maxBytes := cardano.MaxMasumiCoseBytes
		if field == "blockchainIdentifier" {
			maxBytes = cardano.MaxMasumiIdentifierCompressed
		}
		s, ok := value[field].(string)
		if !ok || s == "" || len(s)/2 > maxBytes || !hexRegex.MatchString(s) {
			return nil, schemaError("extra.%s must be non-empty lowercase even-length hex", field)
		}
	}

	commitment, err := validateCommitment(value["inputCommitment"])
	if err != nil {
		return nil, err
	}
	terms, err := validateTerms(value["terms"], network, commitment.Digest)
	if err != nil {
		return nil, err
	}
	var deployment *Deployment
	if raw, present := value["deployment"]; present {
		if deployment, err = validateDeployment(raw); err != nil {
			return nil, err
		}
	}

	return &Extra{
		AssetTransferMethod:  cardano.AssetTransferMethodMasumi,
		ConfirmationPolicy:   policy,
		AreFeesSponsored:     feesSponsored,
		InputCommitment:      *commitment,
		Terms:                *terms,
		ReferenceKey:         value["referenceKey"].(string),
		ReferenceSignature:   value["referenceSignature"].(string),
		BlockchainIdentifier: value["blockchainIdentifier"].(string),
		Deployment:           deployment,
	}, nil
}

// normalizeConfirmationPolicy accepts exactly { l1Confirmations: integer -1..20 }
// as decoded JSON; the closed Masumi schema is stricter than
// cardano.NormalizeConfirmationPolicy, which also takes typed values.
func normalizeConfirmationPolicy(raw interface{}) (cardano.ConfirmationPolicy, bool) {
	m, ok := raw.(map[string]interface{})
	if !ok || len(m) != 1 {
		return cardano.ConfirmationPolicy{}, false
	}
	n, ok := m["l1Confirmations"].(float64)
	if !ok || n != math.Trunc(n) || n < cardano.MinL1Confirmations || n > cardano.MaxL1Confirmations {
		return cardano.ConfirmationPolicy{}, false
	}
	return cardano.ConfirmationPolicy{L1Confirmations: int(n)}, true
}

func validateDeployment(raw interface{}) (*Deployment, error) {
	value, ok := raw.(map[string]interface{})
	if !ok {
		return nil, schemaError("deployment must be an object")
	}
	if key, bad := unknownKey(value, deploymentKeys); bad {
		return nil, schemaError("deployment has unknown field %s", key)
	}
	vkeys, ok := value["adminVkeys"].([]interface{})
	if !ok || len(vkeys) == 0 || len(vkeys) > cardano.MaxMasumiAdminKeys {
		return nil, schemaError("deployment.adminVkeys must be a non-empty array")
	}
	adminVkeys := make([]string, len(vkeys))
	for i, v := range vkeys {
		s, ok := v.(string)
		if !ok || !hex28Regex.MatchString(s) {
			return nil, schemaError("deployment.adminVkeys must be 28-byte lowercase hex")
		}
		adminVkeys[i] = s
	}
	required, ok := value["requiredAdmins"].(string)
	if !ok || len(required) > 3 || !positiveIntRegex.MatchString(required) {
		return nil, schemaError("deployment.requiredAdmins must be a positive integer string")
	}
	if parseBig(required).Cmp(big.NewInt(int64(len(adminVkeys)))) > 0 {
		return nil, schemaError("deployment.requiredAdmins exceeds adminVkeys length")
	}
	cooldown, ok := value["cooldownPeriod"].(string)
	if !ok || len(cooldown) > maxPosixDigits || !nonNegativeIntRegex.MatchString(cooldown) {
		return nil, schemaError("deployment.cooldownPeriod must be a non-negative integer string")
	}
	return &Deployment{RequiredAdmins: required, AdminVkeys: adminVkeys, CooldownPeriod: cooldown}, nil
}

func validateCommitment(raw interface{}) (*InputCommitment, error) {
	value, ok := raw.(map[string]interface{})
	if !ok {
		return nil, schemaError("inputCommitment must be an object")
	}
	if key, bad := unknownKey(value, commitmentKeys); bad {
		return nil, schemaError("inputCommitment has unknown field %s", key)
	}
	if value["version"] != "1" {
		return nil, schemaError("inputCommitment.version must be '1'")
	}
	if value["algorithm"] != "sha256" {
		return nil, schemaError("inputCommitment.algorithm must be 'sha256'")
	}
	digest, ok := value["digest"].(string)
	if !ok || !hex32Regex.MatchString(digest) {
		return nil, schemaError("inputCommitment.digest must be 32-byte lowercase hex")
	}
	rawParts, ok := value["parts"].([]interface{})
	if !ok || len(rawParts) == 0 || len(rawParts) > cardano.MaxMasumiCommitmentParts {
		return nil, schemaError("inputCommitment.parts must be a non-empty array")
	}
	parts := make([]CommitmentPart, 0, len(rawParts))
	names := map[string]bool{}
	for i, rawPart := range rawParts {
		part, err := validatePart(rawPart, i)
		if err != nil {
			return nil, err
		}
		if names[part.Name] {
			return nil, schemaError("inputCommitment has duplicate part name %s", part.Name)
		}
		names[part.Name] = true
		parts = append(parts, *part)
	}
	return &InputCommitment{Version: "1", Algorithm: "sha256", Parts: parts, Digest: digest}, nil
}

func validatePart(raw interface{}, index int) (*CommitmentPart, error) {
	value, ok := raw.(map[string]interface{})
	if !ok {
		return nil, schemaError("parts[%d] must be an object", index)
	}
	if key, bad := unknownKey(value, partKeys); bad {
		return nil, schemaError("parts[%d] has unknown field %s", index, key)
	}
	name, ok := value["name"].(string)
	if !ok || name == "" || jsLength(name) > maxPartNameChars {
		return nil, schemaError("parts[%d].name must be a non-empty string", index)
	}
	canonicalization, _ := value["canonicalization"].(string)
	if canonicalization != "jcs" && canonicalization != "raw" {
		return nil, schemaError("parts[%d].canonicalization must be jcs or raw", index)
	}
	var mediaType *string
	if rawMedia, present := value["mediaType"]; present {
		s, ok := rawMedia.(string)
		if !ok || jsLength(s) > maxMediaTypeChars {
			return nil, schemaError("parts[%d].mediaType must be a string", index)
		}
		mediaType = &s
	}
	digest, ok := value["digest"].(string)
	if !ok || !hex32Regex.MatchString(digest) {
		return nil, schemaError("parts[%d].digest must be 32-byte lowercase hex", index)
	}
	content, hasContent := value["content"]
	if hasContent {
		if detail := commitmentContentError(content, canonicalization); detail != "" {
			return nil, schemaError("parts[%d].content %s", index, detail)
		}
	}
	return &CommitmentPart{
		Name:             name,
		Canonicalization: canonicalization,
		MediaType:        mediaType,
		Content:          OptionalValue{Set: hasContent, Value: content},
		Digest:           digest,
	}, nil
}

// commitmentContentError bounds a part's content before digest code
// canonicalizes it; it returns an empty string when the content is acceptable.
func commitmentContentError(value interface{}, canonicalization string) string {
	if canonicalization == "raw" {
		s, ok := value.(string)
		if !ok || !base64URLRegex.MatchString(s) {
			return "raw content must be canonical unpadded base64url"
		}
		decoded, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil || len(decoded) > cardano.MaxMasumiCommitmentContentBytes ||
			base64.RawURLEncoding.EncodeToString(decoded) != s {
			return "raw content exceeds the byte limit or is not canonical base64url"
		}
		return ""
	}

	// Values are JSON-decoded (see normalizeJSON), so they cannot be cyclic.
	type frame struct {
		value interface{}
		depth int
	}
	pending := []frame{{value: value}}
	values, size := 0, 0
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		values++
		if values > maxJSONValues {
			return "JCS content exceeds the value limit"
		}
		if current.depth > maxJSONDepth {
			return "JCS content exceeds the nesting limit"
		}
		switch v := current.value.(type) {
		case nil, bool, float64:
			continue
		case string:
			size += len(v)
			if size > cardano.MaxMasumiCommitmentContentBytes {
				return "JCS content exceeds the byte limit"
			}
		case []interface{}:
			for _, item := range v {
				pending = append(pending, frame{value: item, depth: current.depth + 1})
			}
		case map[string]interface{}:
			for key, item := range v {
				size += len(key)
				if size > cardano.MaxMasumiCommitmentContentBytes {
					return "JCS content exceeds the byte limit"
				}
				pending = append(pending, frame{value: item, depth: current.depth + 1})
			}
		default:
			return "JCS content is not valid JSON"
		}
	}
	return ""
}

func validateTerms(raw interface{}, network, commitmentDigest string) (*Terms, error) {
	value, ok := raw.(map[string]interface{})
	if !ok {
		return nil, schemaError("terms must be an object")
	}
	if key, bad := unknownKey(value, termsKeys); bad {
		return nil, schemaError("terms has unknown field %s", key)
	}
	if value["version"] != "1" {
		return nil, schemaError("terms.version must be '1'")
	}
	if value["paymentType"] != PaymentSourceType {
		return nil, schemaError("terms.paymentType must be %s", PaymentSourceType)
	}
	if !IsKeyCredentialAddressOn(value["sellerAddress"], network) {
		return nil, schemaError("terms.sellerAddress must be a key-credential address on network")
	}
	var sellerReturn *string
	if rawReturn, present := value["sellerReturnAddress"]; present {
		if !IsKeyCredentialAddressOn(rawReturn, network) {
			return nil, schemaError("terms.sellerReturnAddress must be a key-credential address on network")
		}
		s := rawReturn.(string)
		sellerReturn = &s
	}
	sellerNonce, ok := value["sellerNonce"].(string)
	if !ok || !hex32Regex.MatchString(sellerNonce) {
		return nil, schemaError("terms.sellerNonce must be 32-byte lowercase hex")
	}
	buyerNonce, ok := value["buyerNonce"].(string)
	if !ok || !hexRegex.MatchString(buyerNonce) || (buyerNonce != "" && (len(buyerNonce) < 14 || len(buyerNonce) > 26)) {
		return nil, schemaError("terms.buyerNonce must be empty or 14-26 lowercase hex chars")
	}
	var agent AgentIdentifier
	if rawAgent, present := value["agentIdentifier"]; present {
		agent.Set = true
		if rawAgent == nil {
			agent.Null = true
		} else {
			s, ok := rawAgent.(string)
			if !ok || len(s) > maxAgentIdentifierHexChars || !hexRegex.MatchString(s) {
				return nil, schemaError("terms.agentIdentifier must be null or lowercase hex")
			}
			agent.Value = s
		}
	}
	inputHash, ok := value["inputHash"].(string)
	if !ok || inputHash != commitmentDigest {
		return nil, schemaError("terms.inputHash must equal inputCommitment.digest")
	}
	times := []string{"payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"}
	for _, field := range times {
		if !isPosixMsString(value[field]) {
			return nil, schemaError("terms.%s must be a positive POSIX-ms integer string", field)
		}
	}
	return &Terms{
		Version:                   "1",
		PaymentType:               PaymentSourceType,
		SellerAddress:             value["sellerAddress"].(string),
		SellerReturnAddress:       sellerReturn,
		SellerNonce:               sellerNonce,
		BuyerNonce:                buyerNonce,
		AgentIdentifier:           agent,
		InputHash:                 inputHash,
		PayByTime:                 value["payByTime"].(string),
		SubmitResultTime:          value["submitResultTime"].(string),
		UnlockTime:                value["unlockTime"].(string),
		ExternalDisputeUnlockTime: value["externalDisputeUnlockTime"].(string),
	}, nil
}
