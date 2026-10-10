package masumi

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blinklabs-io/plutigo/data"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/script"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

func baseQuote(t *testing.T) quoteVector {
	t.Helper()
	var vectors []quoteVector
	loadVector(t, "quote_vectors.json", &vectors)
	return vectors[0]
}

func cloneMap(t *testing.T, m map[string]interface{}) map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(m)
	require.NoError(t, err)
	var out map[string]interface{}
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

func TestValidateExtraRejections(t *testing.T) {
	q := baseQuote(t)
	network := q.Requirements.Network
	terms := func(e map[string]interface{}) map[string]interface{} { return e["terms"].(map[string]interface{}) }
	commitment := func(e map[string]interface{}) map[string]interface{} {
		return e["inputCommitment"].(map[string]interface{})
	}
	part := func(e map[string]interface{}) map[string]interface{} {
		return commitment(e)["parts"].([]interface{})[0].(map[string]interface{})
	}
	cases := []struct {
		name   string
		mutate func(e map[string]interface{})
		detail string
	}{
		{"unknown extra field", func(e map[string]interface{}) { e["contractAddress"] = "x" }, "extra has unknown field contractAddress"},
		{"wrong method", func(e map[string]interface{}) { e["assetTransferMethod"] = "default" }, "extra.assetTransferMethod must be masumi"},
		{"policy out of range", func(e map[string]interface{}) {
			e["confirmationPolicy"] = map[string]interface{}{"l1Confirmations": 21.0}
		}, "extra.confirmationPolicy must be { l1Confirmations: -1..20 }"},
		{"policy null", func(e map[string]interface{}) { e["confirmationPolicy"] = nil }, "extra.confirmationPolicy must be { l1Confirmations: -1..20 }"},
		{"policy fraction", func(e map[string]interface{}) {
			e["confirmationPolicy"] = map[string]interface{}{"l1Confirmations": 1.5}
		}, "extra.confirmationPolicy must be { l1Confirmations: -1..20 }"},
		{"fees sponsored", func(e map[string]interface{}) { e["areFeesSponsored"] = true }, "extra.areFeesSponsored must be false"},
		{"fees sponsored null", func(e map[string]interface{}) { e["areFeesSponsored"] = nil }, "extra.areFeesSponsored must be false"},
		{"uppercase key", func(e map[string]interface{}) { e["referenceKey"] = "AB" }, "extra.referenceKey must be non-empty lowercase even-length hex"},
		{"empty signature", func(e map[string]interface{}) { e["referenceSignature"] = "" }, "extra.referenceSignature must be non-empty lowercase even-length hex"},
		{"oversized identifier", func(e map[string]interface{}) {
			e["blockchainIdentifier"] = strings.Repeat("00", cardano.MaxMasumiIdentifierCompressed+1)
		}, "extra.blockchainIdentifier must be non-empty lowercase even-length hex"},
		{"commitment not object", func(e map[string]interface{}) { e["inputCommitment"] = "x" }, "inputCommitment must be an object"},
		{"commitment unknown", func(e map[string]interface{}) { commitment(e)["x"] = 1.0 }, "inputCommitment has unknown field x"},
		{"commitment version", func(e map[string]interface{}) { commitment(e)["version"] = 1.0 }, "inputCommitment.version must be '1'"},
		{"commitment algorithm", func(e map[string]interface{}) { commitment(e)["algorithm"] = "sha512" }, "inputCommitment.algorithm must be 'sha256'"},
		{"commitment digest", func(e map[string]interface{}) { commitment(e)["digest"] = "00" }, "inputCommitment.digest must be 32-byte lowercase hex"},
		{"no parts", func(e map[string]interface{}) { commitment(e)["parts"] = []interface{}{} }, "inputCommitment.parts must be a non-empty array"},
		{"too many parts", func(e map[string]interface{}) {
			parts := make([]interface{}, cardano.MaxMasumiCommitmentParts+1)
			for i := range parts {
				parts[i] = part(e)
			}
			commitment(e)["parts"] = parts
		}, "inputCommitment.parts must be a non-empty array"},
		{"duplicate part", func(e map[string]interface{}) {
			commitment(e)["parts"] = []interface{}{part(e), part(e)}
		}, "inputCommitment has duplicate part name body"},
		{"part not object", func(e map[string]interface{}) { commitment(e)["parts"] = []interface{}{1.0} }, "parts[0] must be an object"},
		{"part unknown", func(e map[string]interface{}) { part(e)["x"] = 1.0 }, "parts[0] has unknown field x"},
		{"part name empty", func(e map[string]interface{}) { part(e)["name"] = "" }, "parts[0].name must be a non-empty string"},
		{"part name long", func(e map[string]interface{}) { part(e)["name"] = strings.Repeat("😀", 65) }, "parts[0].name must be a non-empty string"},
		{"part canonicalization", func(e map[string]interface{}) { part(e)["canonicalization"] = "cbor" }, "parts[0].canonicalization must be jcs or raw"},
		{"part media null", func(e map[string]interface{}) { part(e)["mediaType"] = nil }, "parts[0].mediaType must be a string"},
		{"part digest", func(e map[string]interface{}) { part(e)["digest"] = "AA" }, "parts[0].digest must be 32-byte lowercase hex"},
		{"raw content padded", func(e map[string]interface{}) {
			part(e)["canonicalization"] = "raw"
			part(e)["content"] = "aGVsbG8="
		}, "parts[0].content raw content must be canonical unpadded base64url"},
		{"raw content noncanonical", func(e map[string]interface{}) {
			part(e)["canonicalization"] = "raw"
			part(e)["content"] = "Zh"
		}, "parts[0].content raw content exceeds the byte limit or is not canonical base64url"},
		{"jcs content too deep", func(e map[string]interface{}) {
			var v interface{} = 1.0
			for i := 0; i < maxJSONDepth+1; i++ {
				v = []interface{}{v}
			}
			part(e)["content"] = v
		}, "parts[0].content JCS content exceeds the nesting limit"},
		{"jcs content too large", func(e map[string]interface{}) {
			part(e)["content"] = strings.Repeat("a", cardano.MaxMasumiCommitmentContentBytes+1)
		}, "parts[0].content JCS content exceeds the byte limit"},
		{"jcs keys too large", func(e map[string]interface{}) {
			part(e)["content"] = map[string]interface{}{strings.Repeat("a", cardano.MaxMasumiCommitmentContentBytes+1): 1.0}
		}, "parts[0].content JCS content exceeds the byte limit"},
		{"jcs too many values", func(e map[string]interface{}) {
			part(e)["content"] = make([]interface{}, maxJSONValues)
		}, "parts[0].content JCS content exceeds the value limit"},
		{"terms not object", func(e map[string]interface{}) { e["terms"] = nil }, "terms must be an object"},
		{"terms projected field", func(e map[string]interface{}) { terms(e)["amount"] = "1" }, "terms has unknown field amount"},
		{"terms version", func(e map[string]interface{}) { terms(e)["version"] = "2" }, "terms.version must be '1'"},
		{"payment type", func(e map[string]interface{}) { terms(e)["paymentType"] = "Web3CardanoV1" }, "terms.paymentType must be Web3CardanoV2"},
		{"seller script", func(e map[string]interface{}) { terms(e)["sellerAddress"] = specEscrow }, "terms.sellerAddress must be a key-credential address on network"},
		{"seller mainnet", func(e map[string]interface{}) {
			terms(e)["sellerAddress"] = "addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d"
		}, "terms.sellerAddress must be a key-credential address on network"},
		{"seller return null", func(e map[string]interface{}) { terms(e)["sellerReturnAddress"] = nil }, "terms.sellerReturnAddress must be a key-credential address on network"},
		{"seller nonce upper", func(e map[string]interface{}) { terms(e)["sellerNonce"] = strings.Repeat("AA", 32) }, "terms.sellerNonce must be 32-byte lowercase hex"},
		{"buyer nonce short", func(e map[string]interface{}) { terms(e)["buyerNonce"] = "0102" }, "terms.buyerNonce must be empty or 14-26 lowercase hex chars"},
		{"buyer nonce long", func(e map[string]interface{}) { terms(e)["buyerNonce"] = strings.Repeat("01", 14) }, "terms.buyerNonce must be empty or 14-26 lowercase hex chars"},
		{"agent number", func(e map[string]interface{}) { terms(e)["agentIdentifier"] = 1.0 }, "terms.agentIdentifier must be null or lowercase hex"},
		{"agent long", func(e map[string]interface{}) { terms(e)["agentIdentifier"] = strings.Repeat("ab", 61) }, "terms.agentIdentifier must be null or lowercase hex"},
		{"input hash", func(e map[string]interface{}) { terms(e)["inputHash"] = strings.Repeat("0", 64) }, "terms.inputHash must equal inputCommitment.digest"},
		{"time leading zero", func(e map[string]interface{}) { terms(e)["payByTime"] = "01" }, "terms.payByTime must be a positive POSIX-ms integer string"},
		{"time too long", func(e map[string]interface{}) { terms(e)["unlockTime"] = strings.Repeat("9", 21) }, "terms.unlockTime must be a positive POSIX-ms integer string"},
		{"time number", func(e map[string]interface{}) { terms(e)["submitResultTime"] = 1.0 }, "terms.submitResultTime must be a positive POSIX-ms integer string"},
		{"deployment null", func(e map[string]interface{}) { e["deployment"] = nil }, "deployment must be an object"},
		{"deployment unknown", func(e map[string]interface{}) {
			e["deployment"] = map[string]interface{}{"x": 1.0}
		}, "deployment has unknown field x"},
		{"deployment no keys", func(e map[string]interface{}) {
			e["deployment"] = map[string]interface{}{"requiredAdmins": "1", "adminVkeys": []interface{}{}, "cooldownPeriod": "0"}
		}, "deployment.adminVkeys must be a non-empty array"},
		{"deployment bad key", func(e map[string]interface{}) {
			e["deployment"] = map[string]interface{}{"requiredAdmins": "1", "adminVkeys": []interface{}{"ab"}, "cooldownPeriod": "0"}
		}, "deployment.adminVkeys must be 28-byte lowercase hex"},
		{"deployment admins zero", func(e map[string]interface{}) {
			e["deployment"] = map[string]interface{}{"requiredAdmins": "0", "adminVkeys": []interface{}{strings.Repeat("ab", 28)}, "cooldownPeriod": "0"}
		}, "deployment.requiredAdmins must be a positive integer string"},
		{"deployment admins exceed", func(e map[string]interface{}) {
			e["deployment"] = map[string]interface{}{"requiredAdmins": "2", "adminVkeys": []interface{}{strings.Repeat("ab", 28)}, "cooldownPeriod": "0"}
		}, "deployment.requiredAdmins exceeds adminVkeys length"},
		{"deployment cooldown", func(e map[string]interface{}) {
			e["deployment"] = map[string]interface{}{"requiredAdmins": "1", "adminVkeys": []interface{}{strings.Repeat("ab", 28)}, "cooldownPeriod": "-1"}
		}, "deployment.cooldownPeriod must be a non-negative integer string"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			extra := cloneMap(t, q.Requirements.Extra)
			c.mutate(extra)
			_, err := ValidateExtra(extra, network)
			var e *Error
			require.True(t, errors.As(err, &e), "expected a schema error")
			assert.Equal(t, cardano.ErrMasumiSchema, e.Reason)
			assert.Equal(t, c.detail, e.Detail)
		})
	}

	_, err := ValidateExtra(nil, network)
	assert.Error(t, err)
	_, err = ValidateExtra(map[string]interface{}{"x": func() {}}, network)
	assert.Error(t, err)

	extra, err := ValidateExtra(q.Requirements.Extra, "cardano:unknown")
	assert.Nil(t, extra)
	assert.Error(t, err)
}

func TestExtraRoundTripsThroughJSON(t *testing.T) {
	var vectors []quoteVector
	loadVector(t, "quote_vectors.json", &vectors)
	for _, v := range vectors {
		extra, err := ValidateExtra(v.Requirements.Extra, v.Requirements.Network)
		require.NoError(t, err)
		wire, err := extra.ToMap()
		require.NoError(t, err)
		assert.Equal(t, v.Requirements.Extra, wire, v.Name)

		raw, err := json.Marshal(extra)
		require.NoError(t, err)
		var typed Extra
		require.NoError(t, json.Unmarshal(raw, &typed))
		assert.Equal(t, extra.Terms.AgentIdentifier, typed.Terms.AgentIdentifier)
	}
	var a AgentIdentifier
	assert.Error(t, a.UnmarshalJSON([]byte("1")))
}

func TestAgentIdentifierStatesAreDistinctSignedValues(t *testing.T) {
	q := baseQuote(t)
	digests := map[string]bool{}
	for _, agent := range []interface{}{"absent", nil, ""} {
		extra := cloneMap(t, q.Requirements.Extra)
		if agent != "absent" {
			extra["terms"].(map[string]interface{})["agentIdentifier"] = agent
		}
		req := q.Requirements
		req.Extra = extra
		digest, err := TermsDigest(req)
		require.NoError(t, err)
		digests[digest] = true
	}
	assert.Len(t, digests, 3)
	_, err := TermsDigest(types.PaymentRequirements{Network: cardano.CardanoPreprodCAIP2})
	assert.Error(t, err)
}

func TestVerifyAuthorizationRejections(t *testing.T) {
	var vectors []quoteVector
	loadVector(t, "quote_vectors.json", &vectors)
	byName := map[string]quoteVector{}
	for _, v := range vectors {
		byName[v.Name] = v
	}
	ctx := context.Background()
	verify := func(t *testing.T, v quoteVector, mutate func(e *Extra, r *types.PaymentRequirements), opts AuthorizationOptions) *Error {
		t.Helper()
		req := v.Requirements
		extra, err := ValidateExtra(cloneMap(t, req.Extra), req.Network)
		require.NoError(t, err)
		if mutate != nil {
			mutate(extra, &req)
		}
		_, err = VerifyAuthorization(ctx, extra, req, opts)
		if err == nil {
			return nil
		}
		var e *Error
		require.True(t, errors.As(err, &e))
		return e
	}
	base := byName["lovelace unregistered absent"]
	multi := byName["token custom deployment multi part"]
	registered := byName["registered with return address"]
	resource := &types.ResourceInfo{URL: "https://agent.example.com/weather"}

	t.Run("omitted content passes for a facilitator", func(t *testing.T) {
		assert.Nil(t, verify(t, multi, nil, AuthorizationOptions{ValidateCustomDeployment: deploymentOK}))
	})
	t.Run("client requires omitted content", func(t *testing.T) {
		e := verify(t, multi, nil, AuthorizationOptions{ValidateCustomDeployment: deploymentOK, RequireAllPartContent: true})
		require.NotNil(t, e)
		assert.Equal(t, cardano.ErrMasumiCommitment, e.Reason)
		assert.Equal(t, "part raw carries no content to verify its digest against", e.Detail)
	})
	t.Run("local content mismatch", func(t *testing.T) {
		e := verify(t, multi, nil, AuthorizationOptions{ValidateCustomDeployment: deploymentOK, LocalCommitmentContent: map[string]interface{}{"raw": "aGk"}})
		require.NotNil(t, e)
		assert.Equal(t, "part raw digest mismatch", e.Detail)
	})
	t.Run("echoed content contradicting the buyer's request", func(t *testing.T) {
		var parsed Extra
		raw, _ := json.Marshal(base.Requirements.Extra)
		require.NoError(t, json.Unmarshal(raw, &parsed))
		part := parsed.InputCommitment.Parts[0]
		require.True(t, part.Content.Set, "the base vector echoes its content")
		e := verify(t, base, nil, AuthorizationOptions{LocalCommitmentContent: map[string]interface{}{part.Name: "another request"}})
		require.NotNil(t, e)
		assert.Equal(t, cardano.ErrMasumiCommitment, e.Reason)
		assert.Equal(t, "part "+part.Name+" does not commit to the buyer's request", e.Detail)
		assert.Nil(t, verify(t, base, nil, AuthorizationOptions{LocalCommitmentContent: map[string]interface{}{part.Name: part.Content.Value}}))
	})
	t.Run("local raw content invalid", func(t *testing.T) {
		e := verify(t, multi, nil, AuthorizationOptions{ValidateCustomDeployment: deploymentOK, LocalCommitmentContent: map[string]interface{}{"raw": 1}})
		require.NotNil(t, e)
		assert.Equal(t, cardano.ErrMasumiCommitment, e.Reason)
	})
	t.Run("tampered part digest", func(t *testing.T) {
		e := verify(t, base, func(e *Extra, _ *types.PaymentRequirements) {
			e.InputCommitment.Parts[0].Digest = strings.Repeat("0", 64)
		}, AuthorizationOptions{})
		assert.Equal(t, cardano.ErrMasumiCommitment, e.Reason)
	})
	t.Run("tampered commitment digest", func(t *testing.T) {
		e := verify(t, base, func(e *Extra, _ *types.PaymentRequirements) {
			e.InputCommitment.Parts[0].Content = OptionalValue{}
			e.InputCommitment.Digest = strings.Repeat("0", 64)
		}, AuthorizationOptions{})
		assert.Equal(t, "commitment digest mismatch", e.Detail)
	})
	t.Run("deadline intervals", func(t *testing.T) {
		e := verify(t, base, func(e *Extra, _ *types.PaymentRequirements) { e.Terms.SubmitResultTime = e.Terms.PayByTime }, AuthorizationOptions{})
		assert.Equal(t, cardano.ErrMasumiDeadline, e.Reason)
	})
	t.Run("horizon", func(t *testing.T) {
		horizon := int64(0)
		e := verify(t, base, func(e *Extra, _ *types.PaymentRequirements) {
			e.Terms.ExternalDisputeUnlockTime = strconv.FormatInt(time.Now().UnixMilli()+int64(time.Hour/time.Millisecond), 10)
		}, AuthorizationOptions{MaxDeadlineHorizonMs: &horizon})
		assert.Equal(t, "deadlines extend beyond the accepted horizon", e.Detail)
	})
	t.Run("preview without deployment", func(t *testing.T) {
		e := verify(t, base, func(_ *Extra, r *types.PaymentRequirements) { r.Network = cardano.CardanoPreviewCAIP2 }, AuthorizationOptions{})
		assert.Equal(t, cardano.ErrMasumiDeployment, e.Reason)
	})
	t.Run("unknown network", func(t *testing.T) {
		e := verify(t, base, func(_ *Extra, r *types.PaymentRequirements) { r.Network = "cardano:unknown" }, AuthorizationOptions{})
		assert.Equal(t, cardano.ErrMasumiDeployment, e.Reason)
	})
	t.Run("custom deployment rejected", func(t *testing.T) {
		e := verify(t, multi, nil, AuthorizationOptions{ValidateCustomDeployment: func(context.Context, DeploymentClaim) (bool, error) { return false, nil }})
		assert.Equal(t, "custom deployment was not approved", e.Detail)
	})
	t.Run("custom deployment validator error", func(t *testing.T) {
		e := verify(t, multi, nil, AuthorizationOptions{ValidateCustomDeployment: func(context.Context, DeploymentClaim) (bool, error) { return false, errors.New("down") }})
		assert.Equal(t, "custom deployment validation failed: down", e.Detail)
	})
	t.Run("registry without resource", func(t *testing.T) {
		e := verify(t, registered, nil, AuthorizationOptions{ValidateRegistryClaim: registryOK})
		assert.Equal(t, "registry claims require the protected resource for endpoint validation", e.Detail)
	})
	t.Run("registry validator error", func(t *testing.T) {
		e := verify(t, registered, nil, AuthorizationOptions{Resource: resource, ValidateRegistryClaim: func(context.Context, RegistryClaim) (bool, error) {
			return false, errors.New("down")
		}})
		assert.Equal(t, "registry validation failed: down", e.Detail)
	})
	t.Run("registry claim carries signed values", func(t *testing.T) {
		var got RegistryClaim
		e := verify(t, registered, nil, AuthorizationOptions{Resource: resource, ValidateRegistryClaim: func(_ context.Context, c RegistryClaim) (bool, error) {
			got = c
			return true, nil
		}})
		assert.Nil(t, e)
		assert.Equal(t, registered.Requirements.Amount, got.Amount)
		assert.Equal(t, resource.URL, got.Resource.URL)
		assert.True(t, strings.HasPrefix(got.AgentIdentifier, RegistryPolicyID))
	})
	t.Run("foreign policy id breaks the seller signature", func(t *testing.T) {
		e := verify(t, base, func(e *Extra, _ *types.PaymentRequirements) {
			e.Terms.AgentIdentifier = AgentIdentifier{Set: true, Value: strings.Repeat("ff", 29)}
		}, AuthorizationOptions{})
		// The signature covers agentIdentifier, so it fails first.
		assert.Equal(t, cardano.ErrMasumiSellerSignature, e.Reason)
	})
	t.Run("identifier mismatch", func(t *testing.T) {
		e := verify(t, base, func(e *Extra, _ *types.PaymentRequirements) {
			e.BlockchainIdentifier = "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80"
		}, AuthorizationOptions{})
		assert.Equal(t, cardano.ErrMasumiIdentifier, e.Reason)
	})
}

func TestForeignPolicyAgentIdentifierIsRefused(t *testing.T) {
	seed := bytesOf(0x21, 32)
	key := ed25519.NewKeyFromSeed(seed)
	seller, signer, err := NewSellerSigner(key, cardano.CardanoPreprodCAIP2)
	require.NoError(t, err)
	in := testIssueInput(seller, signer)
	in.UnsafeSkipPolicyChecks = true
	in.AgentIdentifier = AgentIdentifier{Set: true, Value: strings.Repeat("ff", 28) + "01"}
	req, err := IssueRequirements(context.Background(), in)
	require.NoError(t, err)
	extra, err := ValidateExtra(req.Extra, req.Network)
	require.NoError(t, err)
	_, err = VerifyAuthorization(context.Background(), extra, req, AuthorizationOptions{ValidateRegistryClaim: registryOK})
	var e *Error
	require.True(t, errors.As(err, &e))
	assert.Equal(t, cardano.ErrMasumiAgentIdentifier, e.Reason)
	assert.Equal(t, "agentIdentifier does not carry the Masumi V2 registry policy id", e.Detail)
}

func testIssueInput(seller string, signer TermsSigner) IssueInput {
	nowMs := time.Now().UnixMilli()
	payBy := nowMs + 9*60*1000
	submit := payBy + 7*60*1000
	unlock := submit + 20*60*1000
	return IssueInput{
		Network: cardano.CardanoPreprodCAIP2, Asset: cardano.LovelaceAsset, Amount: "50000000", MaxTimeoutSeconds: 600,
		SellerAddress: seller, SignTerms: signer,
		Commitment: []CommitmentInput{{Name: "body", Canonicalization: "jcs", Content: map[string]interface{}{"days": 3, "units": "metric"}}},
		PayByTime:  strconv.FormatInt(payBy, 10), SubmitResultTime: strconv.FormatInt(submit, 10),
		UnlockTime: strconv.FormatInt(unlock, 10), ExternalDisputeUnlockTime: strconv.FormatInt(unlock+20*60*1000, 10),
	}
}

func TestIssueRequirements(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytesOf(0x31, 32))
	seller, signer, err := NewSellerSigner(key, cardano.CardanoPreprodCAIP2)
	require.NoError(t, err)
	ctx := context.Background()

	t.Run("issues a verifiable quote with a fresh nonce", func(t *testing.T) {
		first, err := IssueRequirements(ctx, testIssueInput(seller, signer))
		require.NoError(t, err)
		second, err := IssueRequirements(ctx, testIssueInput(seller, signer))
		require.NoError(t, err)
		extra, err := ValidateExtra(first.Extra, first.Network)
		require.NoError(t, err)
		auth, err := VerifyAuthorization(ctx, extra, first, AuthorizationOptions{RequireAllPartContent: true, MaxDeadlineHorizonMs: ptr(MaxDeadlineHorizonMs)})
		require.NoError(t, err)
		assert.Equal(t, first.PayTo, auth.EscrowAddress)
		assert.Equal(t, specEscrow, first.PayTo)
		assert.Regexp(t, `^[0-9a-f]{64}$`, extra.Terms.SellerNonce)
		assert.NotEqual(t, extra.Terms.SellerNonce, second.Extra["terms"].(map[string]interface{})["sellerNonce"])
	})

	t.Run("withheld content keeps the input hash", func(t *testing.T) {
		in := testIssueInput(seller, signer)
		in.SellerNonce = strings.Repeat("ab", 32)
		echoed, err := IssueRequirements(ctx, in)
		require.NoError(t, err)
		in.Commitment[0].OmitContent = true
		withheld, err := IssueRequirements(ctx, in)
		require.NoError(t, err)
		ec := echoed.Extra["inputCommitment"].(map[string]interface{})
		wc := withheld.Extra["inputCommitment"].(map[string]interface{})
		assert.Equal(t, ec["digest"], wc["digest"])
		_, has := wc["parts"].([]interface{})[0].(map[string]interface{})["content"]
		assert.False(t, has)
	})

	cases := []struct {
		name   string
		mutate func(in *IssueInput)
		err    string
	}{
		{"zero amount", func(in *IssueInput) { in.Amount = "0" }, "positive canonical integer"},
		{"leading zero amount", func(in *IssueInput) { in.Amount = "050000000" }, "positive canonical integer"},
		{"uppercase asset", func(in *IssueInput) { in.Asset = "AA" + strings.Repeat("00", 27) + "." }, "canonical lowercase form"},
		{"zero timeout", func(in *IssueInput) { in.MaxTimeoutSeconds = 0 }, "maxTimeoutSeconds must be a positive safe integer"},
		{"negative timeout skipped policy", func(in *IssueInput) { in.MaxTimeoutSeconds = -1; in.UnsafeSkipPolicyChecks = true }, "maxTimeoutSeconds must be a positive safe integer"},
		{"no signer", func(in *IssueInput) { in.SignTerms = nil }, "terms signer"},
		{"preview", func(in *IssueInput) { in.Network = cardano.CardanoPreviewCAIP2 }, "no canonical Masumi deployment"},
		{"schema", func(in *IssueInput) { in.BuyerNonce = "01" }, "issued Masumi requirements are invalid"},
		{"empty deadline", func(in *IssueInput) { in.PayByTime = "" }, "payByTime must be a positive POSIX-ms integer string"},
		{"garbage deadline", func(in *IssueInput) { in.SubmitResultTime = "12x" }, "submitResultTime must be a positive POSIX-ms integer string"},
		{"negative deadline", func(in *IssueInput) { in.UnlockTime = "-1" }, "unlockTime must be a positive POSIX-ms integer string"},
		{"long deadline", func(in *IssueInput) { in.ExternalDisputeUnlockTime = strings.Repeat("9", 21) }, "externalDisputeUnlockTime must be a positive POSIX-ms integer string"},
		{"short gap", func(in *IssueInput) { in.SubmitResultTime = addMs(in.PayByTime, 60_000) }, "deadline intervals are below the minimum"},
		{"short unlock gap", func(in *IssueInput) { in.UnlockTime = addMs(in.SubmitResultTime, 60_000) }, "deadline intervals are below the minimum"},
		{"expired", func(in *IssueInput) {
			past := time.Now().UnixMilli() - 60_000
			in.PayByTime, in.SubmitResultTime = strconv.FormatInt(past, 10), strconv.FormatInt(past+7*60_000, 10)
			in.UnlockTime, in.ExternalDisputeUnlockTime = strconv.FormatInt(past+27*60_000, 10), strconv.FormatInt(past+47*60_000, 10)
		}, "payByTime must be in the future"},
		{"submit lead", func(in *IssueInput) {
			payBy := time.Now().UnixMilli() + 60_000
			in.PayByTime, in.SubmitResultTime = strconv.FormatInt(payBy, 10), strconv.FormatInt(payBy+6*60_000, 10)
			in.UnlockTime, in.ExternalDisputeUnlockTime = strconv.FormatInt(payBy+26*60_000, 10), strconv.FormatInt(payBy+46*60_000, 10)
		}, "submitResultTime must be at least 15 minutes away"},
		{"timeout window", func(in *IssueInput) { in.MaxTimeoutSeconds = 60 }, "payByTime exceeds maxTimeoutSeconds"},
		{"horizon", func(in *IssueInput) {
			in.ExternalDisputeUnlockTime = strconv.FormatInt(time.Now().UnixMilli()+400*24*3600*1000, 10)
		}, "deadlines extend beyond the accepted horizon"},
		{"bad raw part", func(in *IssueInput) {
			in.Commitment = []CommitmentInput{{Name: "raw", Canonicalization: "raw", Content: "a+b"}}
		}, "commitment part raw"},
		{"signer fails", func(in *IssueInput) {
			in.SignTerms = func(context.Context, string, string) (SellerAuthorization, error) {
				return SellerAuthorization{}, errors.New("hw")
			}
		}, "seller signing failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := testIssueInput(seller, signer)
			c.mutate(&in)
			_, err := IssueRequirements(ctx, in)
			require.Error(t, err)
			assert.Contains(t, err.Error(), c.err)
		})
	}

	t.Run("configured horizon", func(t *testing.T) {
		in := testIssueInput(seller, signer)
		in.ExternalDisputeUnlockTime = strconv.FormatInt(time.Now().UnixMilli()+100*24*3600*1000, 10)
		in.MaxDeadlineHorizonMs = ptr(int64(200 * 24 * 3600 * 1000))
		_, err := IssueRequirements(ctx, in)
		assert.NoError(t, err)
	})

	t.Run("payByTime expires while signing", func(t *testing.T) {
		in := testIssueInput(seller, signer)
		payBy := time.Now().UnixMilli() + 60_000
		in.PayByTime, in.SubmitResultTime = strconv.FormatInt(payBy, 10), strconv.FormatInt(payBy+16*60_000, 10)
		in.UnlockTime, in.ExternalDisputeUnlockTime = strconv.FormatInt(payBy+36*60_000, 10), strconv.FormatInt(payBy+56*60_000, 10)
		in.SignTerms = func(ctx context.Context, a, d string) (SellerAuthorization, error) {
			now = func() time.Time { return time.UnixMilli(payBy + 1) }
			return signer(ctx, a, d)
		}
		defer func() { now = time.Now }()
		_, err := IssueRequirements(ctx, in)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "payByTime must be in the future")
	})
}

func addMs(s string, ms int64) string {
	n, _ := strconv.ParseInt(s, 10, 64)
	return strconv.FormatInt(n+ms, 10)
}

func ptr[T any](v T) *T { return &v }

func TestNewTermsSignerWithExternalKey(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytesOf(0x51, 32))
	public := key.Public().(ed25519.PublicKey)
	calls := 0
	signer := NewTermsSigner(public, func(message []byte) []byte {
		calls++
		return ed25519.Sign(key, message)
	})
	seller, err := cardanoEnterpriseKeyAddress(cardano.Blake2b224(public), cardano.CardanoMainnetCAIP2)
	require.NoError(t, err)
	digest := hex.EncodeToString(bytesOf(0x77, 32))
	auth, err := signer(context.Background(), seller, digest)
	require.NoError(t, err)
	assert.Equal(t, 1, calls)
	assert.True(t, VerifySellerTermsSignature(auth.Key, auth.Signature, seller, digest))

	_, err = signer(context.Background(), seller, "zz")
	assert.Error(t, err)
	bad := NewTermsSigner(public, func([]byte) []byte { return []byte{1} })
	_, err = bad(context.Background(), seller, digest)
	assert.Error(t, err)
	_, err = NewTermsSigner(public[:5], nil)(context.Background(), seller, digest)
	assert.Error(t, err)
	_, err = signer(context.Background(), specEscrow, digest)
	assert.Error(t, err, "a script address cannot be signed for")
	_, err = SignData(key[:10], seller, nil)
	assert.Error(t, err)
	_, _, err = NewSellerSigner(key[:10], cardano.CardanoMainnetCAIP2)
	assert.Error(t, err)
	_, _, err = NewSellerSigner(key, "cardano:unknown")
	assert.Error(t, err)
}

// Codec vectors shared with the other SDKs: JCS edge cases and part digests.
func TestCodecVectors(t *testing.T) {
	out, err := JCS(map[string]interface{}{"b": 1.0, "a": math.Copysign(0, -1)})
	require.NoError(t, err)
	assert.Equal(t, `{"a":0,"b":1}`, string(out))

	hello := sha256.Sum256([]byte("hello"))
	digest, err := CommitmentPartDigest("raw", "aGVsbG8")
	require.NoError(t, err)
	assert.Equal(t, hex.EncodeToString(hello[:]), digest)
	_, err = CommitmentPartDigest("raw", "aGVsbG8=")
	assert.Error(t, err)

	media := "application/json"
	commitment := InputCommitment{Version: "1", Algorithm: "sha256", Parts: []CommitmentPart{{
		Name: "body", Canonicalization: "jcs", Digest: strings.Repeat("11", 32), Content: OptionalValue{Set: true, Value: map[string]interface{}{"hello": "world"}},
	}}}
	first, err := ComputeInputHash(commitment)
	require.NoError(t, err)
	commitment.Parts[0].Content = OptionalValue{Set: true}
	second, err := ComputeInputHash(commitment)
	require.NoError(t, err)
	assert.Equal(t, first, second)
	commitment.Parts[0].MediaType = &media
	third, err := ComputeInputHash(commitment)
	require.NoError(t, err)
	assert.NotEqual(t, first, third)

	for _, c := range []struct {
		value    string
		expected string
	}{
		{"9007199254740992", "9007199254740992"},
		{"9007199254740993", "9007199254740992"},
		{"-9007199254740993", "-9007199254740992"},
		{"100000000000000000000", "100000000000000000000"},
		{"1000000000000000000000", "1e+21"},
		{"17976931348623157" + strings.Repeat("0", 292), "1.7976931348623157e+308"},
	} {
		var v interface{}
		require.NoError(t, json.Unmarshal([]byte(`{"nested":[`+c.value+`],"amount":"`+c.value+`","flag":true}`), &v))
		out, err := JCS(v)
		require.NoError(t, err)
		assert.Equal(t, `{"amount":"`+c.value+`","flag":true,"nested":[`+c.expected+`]}`, string(out))
	}

	// signed_terms_vector: seed bytes(range(32)), cbor2 COSE objects.
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i)
	}
	key := ed25519.NewKeyFromSeed(seed)
	public := key.Public().(ed25519.PublicKey)
	address, err := cardanoEnterpriseKeyAddress(cardano.Blake2b224(public), cardano.CardanoPreprodCAIP2)
	require.NoError(t, err)
	termsDigest := hex.EncodeToString(bytesOf(0x42, 32))
	auth, err := SignData(key, address, bytesOf(0x42, 32))
	require.NoError(t, err)
	assert.True(t, VerifySellerTermsSignature(auth.Key, auth.Signature, address, termsDigest))

	pub := hex.EncodeToString(public)
	for _, keyHex := range []string{
		"a401f5032720062158 20" + pub,                                      // kty = True
		"a401f93c0003272006215820" + pub,                                   // kty = 1.0
		"a4010103f9c8002006215820" + pub,                                   // alg = -8.0
		"a40101032720f94600215820" + pub,                                   // crv = 6.0
		"a5010103272006215820" + pub + "235820" + strings.Repeat("00", 32), // private material
	} {
		assert.False(t, VerifySellerTermsSignature(strings.ReplaceAll(keyHex, " ", ""), auth.Signature, address, termsDigest), keyHex)
	}
	hashedTrue := strings.Replace(auth.Signature, "a166686173686564f4", "a166686173686564f5", 1)
	assert.False(t, VerifySellerTermsSignature(auth.Key, hashedTrue, address, termsDigest))
	assert.False(t, VerifySellerTermsSignature(auth.Key, auth.Signature, address, strings.Repeat("00", 32)))
	assert.False(t, VerifySellerTermsSignature("zz", auth.Signature, address, termsDigest))
	assert.False(t, VerifySellerTermsSignature(auth.Key, "zz", address, termsDigest))
	assert.False(t, VerifySellerTermsSignature(auth.Key, auth.Signature, address, "zz"))
}

func TestCOSEKidHandling(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytesOf(0x61, 32))
	public := key.Public().(ed25519.PublicKey)
	address, err := cardanoEnterpriseKeyAddress(cardano.Blake2b224(public), cardano.CardanoPreprodCAIP2)
	require.NoError(t, err)
	raw, _, err := keyCredentialAddress(address)
	require.NoError(t, err)
	payload := bytesOf(0x42, 32)
	sign := func(kid []byte) string {
		keys := []*cborNode{intKey(headerLabelAlg), textKey("address")}
		items := []*cborNode{intKey(algEdDSA), bytesNode(raw)}
		if kid != nil {
			keys, items = append(keys, intKey(headerLabelKid)), append(items, bytesNode(kid))
		}
		protected, err := encodeCBOR(nil, &cborNode{kind: cborMap, keys: keys, items: items})
		require.NoError(t, err)
		sig := ed25519.Sign(key, encodeArray(textKey("Signature1"), bytesNode(protected), bytesNode(nil), bytesNode(payload)))
		unprotected := &cborNode{kind: cborMap, keys: []*cborNode{textKey("hashed")}, items: []*cborNode{{kind: cborBool}}}
		return hex.EncodeToString(encodeArray(bytesNode(protected), unprotected, bytesNode(payload), bytesNode(sig)))
	}
	coseKey := func(kid []byte) string {
		keys := []*cborNode{intKey(keyLabelKty), intKey(keyLabelKid), intKey(keyLabelAlg), intKey(keyLabelCrv), intKey(keyLabelX)}
		items := []*cborNode{intKey(ktyOKP), bytesNode(kid), intKey(algEdDSA), intKey(crvEd25519), bytesNode(public)}
		out, err := encodeCBOR(nil, &cborNode{kind: cborMap, keys: keys, items: items})
		require.NoError(t, err)
		return hex.EncodeToString(out)
	}
	digest := hex.EncodeToString(payload)
	assert.True(t, VerifySellerTermsSignature(coseKey([]byte{1}), sign([]byte{1}), address, digest))
	assert.False(t, VerifySellerTermsSignature(coseKey([]byte{1}), sign([]byte{2}), address, digest))
	assert.True(t, VerifySellerTermsSignature(coseKey([]byte{1}), sign(nil), address, digest))
}

func TestCBORCodecEdges(t *testing.T) {
	for _, h := range []string{
		"", "1c", "18", "19ff", "1aff", "1bff", "5f41ff", "5f4100", "5f", "62ff", "9f01", "bf0101",
		"82", "a1", "dc00", "7f41ff", "c202", "fc", "1f", "c1", "c3", "61ff",
	} {
		b, _ := hex.DecodeString(h)
		_, err := decodeCBOR(b)
		assert.Error(t, err, h)
	}
	for _, c := range []struct{ in, reencoded string }{
		{"5f41014102ff", "420102"},
		{"7f6161ff", "6161"},
		{"9f0102ff", "820102"},
		{"bf0102ff", "a10102"},
		{"c249010000000000000000", "c249010000000000000000"},
		{"c349010000000000000000", "c349010000000000000000"},
		{"c24101", "01"},
		{"3b7fffffffffffffff", "3b7fffffffffffffff"},
		{"d8184101", "d8184101"},
		{"f5", "f5"}, {"f6", "f6"}, {"f7", "f7"},
		{"a201020103", "a10103"},
	} {
		b, _ := hex.DecodeString(c.in)
		n, err := decodeCBOR(b)
		require.NoError(t, err, c.in)
		out, err := encodeCBOR(nil, n)
		require.NoError(t, err, c.in)
		assert.Equal(t, c.reencoded, hex.EncodeToString(out), c.in)
	}
	for _, h := range []string{"f93c00", "fa3f800000", "fb3ff0000000000000", "f97c00", "f97e00", "f90001", "f9bc00"} {
		b, _ := hex.DecodeString(h)
		n, err := decodeCBOR(b)
		require.NoError(t, err, h)
		assert.Equal(t, cborFloat, n.kind)
		_, err = encodeCBOR(nil, n)
		assert.Error(t, err)
	}
	nan1, _ := decodeCBOR([]byte{0xa2, 0xf9, 0x7e, 0x00, 0x01, 0xf9, 0x7e, 0x00, 0x02})
	assert.Len(t, nan1.keys, 1)
	mixed, _ := decodeCBOR([]byte{0xa4, 0xf4, 0x01, 0xf4, 0x02, 0xf6, 0x03, 0xf6, 0x04})
	assert.Len(t, mixed.keys, 2)
	assert.Equal(t, "2", mixed.items[0].num.String())
	big1 := &cborNode{kind: cborInt, num: new(big.Int).Lsh(big.NewInt(1), 70)}
	out, err := encodeCBOR(nil, big1)
	require.NoError(t, err)
	assert.Equal(t, "c249400000000000000000", hex.EncodeToString(out))
	for _, arg := range []uint64{23, 24, 255, 256, 65535, 65536, math.MaxUint32, math.MaxUint32 + 1} {
		out := appendHead(nil, 0, arg)
		n, err := decodeCBOR(out)
		require.NoError(t, err)
		assert.Equal(t, arg, n.num.Uint64())
	}
}

func TestJCSEdges(t *testing.T) {
	for _, v := range []interface{}{math.NaN(), math.Inf(1), map[int]int{1: 1}, struct{}{}, func() {}, "\xff", map[string]interface{}{"\xed\xa0\x80": 1}, json.Number("x")} {
		_, err := JCS(v)
		assert.Error(t, err, "%#v", v)
	}
	cyclic := map[string]interface{}{}
	cyclic["self"] = cyclic
	_, err := JCS(cyclic)
	assert.Error(t, err)
	list := []interface{}{nil}
	list[0] = list
	_, err = JCS(list)
	assert.Error(t, err)

	shared := map[string]interface{}{"n": 1}
	type named string
	var nilSlice []int
	var nilMap map[string]int
	var nilPtr *int
	one := 1
	cases := []struct {
		value interface{}
		out   string
	}{
		{[]interface{}{shared, shared}, `[{"n":1},{"n":1}]`},
		{[]string{"b", "a"}, `["b","a"]`},
		{[2]int{1, 2}, `[1,2]`},
		{map[named]int{"b": 1, "a": 2}, `{"a":2,"b":1}`},
		{map[string]interface{}{}, `{}`},
		{[]interface{}{}, `[]`},
		{nilSlice, `null`}, {nilMap, `null`}, {nilPtr, `null`}, {&one, `1`},
		{[]interface{}{int8(-1), int16(2), int32(3), int64(4), uint(5), uint8(6), uint16(7), uint32(8), uint64(9), float32(0.5), json.Number("1e3")}, `[-1,2,3,4,5,6,7,8,9,0.5,1000]`},
		{[]interface{}{1e-7, 1.5e-7, 123e-20, -1e21, 1e20}, `[1e-7,1.5e-7,1.23e-18,-1e+21,100000000000000000000]`},
		{" \x7f<", "\" \x7f<\""},
	}
	for _, c := range cases {
		got, err := JCS(c.value)
		require.NoError(t, err)
		assert.Equal(t, c.out, string(got))
	}
}

func TestLZBounds(t *testing.T) {
	_, ok := lzDecompressBounded([]byte{0x00}, 10)
	assert.False(t, ok)
	_, ok = lzDecompressBounded([]byte{0x00, 0x00}, 0)
	assert.False(t, ok)
	text := []uint16{'a', 'b', 'a', 'b', 0x263a, 'x', 0x263a}
	compressed := lzCompressToBytes(text)
	out, ok := lzDecompressBounded(compressed, 100)
	require.True(t, ok)
	assert.Equal(t, text, out)
	_, ok = lzDecompressBounded(compressed, 3)
	assert.False(t, ok)
	_, ok = lzDecompressBounded(compressed[:2], 100)
	assert.False(t, ok)
	empty := lzCompressToBytes(nil)
	out, ok = lzDecompressBounded(empty, 10)
	assert.True(t, ok)
	assert.Empty(t, out)

	_, err := EncodeBlockchainIdentifier(IdentifierParts{SellerNonce: strings.Repeat("a", cardano.MaxMasumiIdentifierTextChars)})
	assert.Error(t, err)
	_, err = EncodeBlockchainIdentifier(IdentifierParts{SellerNonce: randomText(cardano.MaxMasumiIdentifierTextChars - 10)})
	assert.Error(t, err)
}

func randomText(n int) string {
	var sb strings.Builder
	x := uint32(12345)
	for i := 0; i < n; i++ {
		x = x*1664525 + 1013904223
		sb.WriteRune(rune(0x4e00 + x>>20%0x5000))
	}
	return sb.String()
}

func TestBuildLockErrors(t *testing.T) {
	q := baseQuote(t)
	extra, err := ValidateExtra(q.Requirements.Extra, q.Requirements.Network)
	require.NoError(t, err)
	_, err = BuildLock(extra, "garbage", cardano.LovelaceAsset, 1, 4310, BuyerInput{})
	assert.Error(t, err)
	_, err = BuildLock(extra, vectorBuyer, cardano.LovelaceAsset, 1, 4310, BuyerInput{BuyerReturnAddress: "garbage"})
	assert.Error(t, err)
	_, err = BuildLock(extra, vectorBuyer, cardano.LovelaceAsset, math.MaxUint64-1, 1<<40, BuyerInput{})
	assert.NoError(t, err, "a huge requested amount needs no collateral")
	_, err = BuildLock(extra, vectorBuyer, "aa.bb", 1, math.MaxUint64, BuyerInput{})
	assert.NoError(t, err)
	bad := *extra
	bad.Terms.PayByTime = "x"
	_, err = BuildLock(&bad, vectorBuyer, cardano.LovelaceAsset, 1, 4310, BuyerInput{})
	assert.Error(t, err)
	bad = *extra
	bad.ReferenceKey = "zz"
	_, err = BuildLock(&bad, vectorBuyer, cardano.LovelaceAsset, 1, 4310, BuyerInput{})
	assert.Error(t, err)
	assert.Equal(t, uint64(math.MaxUint64), MinUtxoLovelace(1, 0, math.MaxUint64))
}

func TestDatumInvariants(t *testing.T) {
	q := baseQuote(t)
	view, err := ParseLockDatum(q.Locks[0].Datum)
	require.NoError(t, err)
	escrow := q.Requirements.PayTo
	require.True(t, VerifyDatumInvariants(view, escrow).OK)

	creds := func(addr string) *AddressCredentials {
		c, err := ExtractAddressCredentials(addr)
		require.NoError(t, err)
		return &c
	}
	pointer := "addr_test1gp7573my7h0fyj9cd2fwrws5v6ep0e6urpx007pz0pjnma5sszqgqqqrqyxzl6wd"
	cases := []struct {
		name   string
		mutate func(v *DatumView)
		reason string
		detail string
	}{
		{"state", func(v *DatumView) { v.State = 1 }, cardano.ErrMasumiDatumInvalid, "state"},
		{"result hash", func(v *DatumView) { v.ResultHash = "00" }, cardano.ErrMasumiDatumInvalid, "result_hash"},
		{"cooldown", func(v *DatumView) { v.BuyerCooldownTime = big.NewInt(1) }, cardano.ErrMasumiDatumInvalid, "cooldown"},
		{"script buyer return", func(v *DatumView) { v.BuyerReturnAddress = creds(escrow) }, cardano.ErrMasumiDatumInvalid, "buyer_return_address is a script payment credential"},
		{"pointer seller", func(v *DatumView) { v.Seller = *creds(pointer) }, cardano.ErrMasumiDatumInvalid, "seller is a pointer stake reference"},
		{"script stake buyer", func(v *DatumView) {
			c := *creds(vectorBuyer)
			c.Stake = &Credential{IsScript: true, Hash: strings.Repeat("00", 28)}
			v.Buyer = c
		}, cardano.ErrMasumiDatumInvalid, "buyer is a script stake credential"},
		{"short signature", func(v *DatumView) { v.ReferenceSignature = "00" }, cardano.ErrMasumiDatumInvalid, "reference_signature shorter than 16 bytes"},
		{"aggregated payout", func(v *DatumView) { v.BuyerReturnAddress = &v.Seller }, cardano.ErrMasumiDatumInvalid, "buyer and seller payout targets are equal"},
		{"deadlines", func(v *DatumView) { v.UnlockTime = v.SubmitResultTime }, cardano.ErrMasumiDeadline, "deadline intervals below the minimum"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := *view
			c.mutate(&v)
			assert.Equal(t, LockCheck{Reason: c.reason, Detail: c.detail}, VerifyDatumInvariants(&v, escrow))
		})
	}
	assert.Equal(t, cardano.ErrMasumiDatumInvalid, VerifyDatumInvariants(view, "garbage").Reason)

	seller := q.Requirements.Extra["terms"].(map[string]interface{})["sellerAddress"].(string)
	assert.Equal(t, "datum address is the escrow", VerifyDatumInvariants(view, seller).Detail)

	p := creds(pointer).Pointer
	assert.False(t, sameCredentials(AddressCredentials{Pointer: p}, AddressCredentials{}))
	assert.True(t, sameCredentials(AddressCredentials{Pointer: p}, AddressCredentials{Pointer: p}))
	assert.False(t, returnAddressMatches(ptr(vectorBuyer), nil))
	assert.False(t, returnAddressMatches(nil, creds(vectorBuyer)))
	assert.True(t, returnAddressMatches(nil, nil))
}

func TestVerifyLockContextErrors(t *testing.T) {
	q := baseQuote(t)
	req := q.Requirements
	cpb := uint64(4310)
	ttl := uint64(0)
	decoded := &cardano.DecodedTransaction{TTLSlot: &ttl, Outputs: []cardano.UtxoOutput{{Address: req.PayTo, Coin: u64(t, q.Locks[0].Locked), Datum: q.Locks[0].Datum}}}
	check := VerifyLock(context.Background(), req.Extra, req, decoded, VerifyContext{Payer: "garbage", CoinsPerUtxoByte: &cpb})
	assert.Equal(t, LockCheck{Reason: cardano.ErrMasumiDatumMismatch, Detail: "buyer does not control the nonce input"}, check)

	bad := req
	bad.Amount = "x"
	extra := cloneMap(t, req.Extra)
	check = VerifyLock(context.Background(), extra, bad, decoded, VerifyContext{Payer: vectorBuyer})
	assert.Equal(t, cardano.ErrMasumiSellerSignature, check.Reason)

	assert.Equal(t, cardano.ErrMasumiSchema, checkFromError(errors.New("x")).Reason)
	assert.Equal(t, "r: d", (&Error{Reason: "r", Detail: "d"}).Error())
	assert.Equal(t, "r", (&Error{Reason: "r"}).Error())
}

func TestEscrowScriptHashErrors(t *testing.T) {
	_, err := EscrowScriptHash(Deployment{RequiredAdmins: "x", CooldownPeriod: "1"})
	assert.Error(t, err)
	_, err = EscrowScriptHash(Deployment{RequiredAdmins: "1", CooldownPeriod: "x"})
	assert.Error(t, err)
	_, err = EscrowScriptHash(Deployment{RequiredAdmins: "1", CooldownPeriod: "1", AdminVkeys: []string{"zz"}})
	assert.Error(t, err)
	_, err = EscrowAddress("cardano:unknown", DefaultDeployment())
	assert.Error(t, err)
	_, ok := ResolveDeployment(cardano.CardanoPreviewCIP34, nil)
	assert.False(t, ok)

	for i := 0; i < maxScriptHashCacheEntries+2; i++ {
		_, err := EscrowScriptHash(Deployment{RequiredAdmins: "1", AdminVkeys: DefaultDeployment().AdminVkeys, CooldownPeriod: strconv.Itoa(i)})
		require.NoError(t, err)
	}
	scriptHashCache.Lock()
	assert.LessOrEqual(t, len(scriptHashCache.hashes), maxScriptHashCacheEntries)
	scriptHashCache.Unlock()
}

func TestApplyParamsVestedPay(t *testing.T) {
	code, _ := hex.DecodeString(VestedPayCompiledCode)
	single, err := script.ApplyParams(code, nil)
	require.NoError(t, err)
	assert.Equal(t, VestedPayCompiledCode, hex.EncodeToString(single), "no parameters leaves the program byte-identical")
	double, err := script.ApplyParams(append([]byte{0x59, 0x26, 0xa4}, code...), nil)
	require.NoError(t, err)
	assert.Equal(t, single, double)

	long := data.NewByteString(bytesOf(0xab, 300))
	applied, err := script.ApplyParams(code, []data.PlutusData{long})
	require.NoError(t, err)
	assert.Greater(t, len(applied), len(code)+300)

	_, err = script.ApplyParams([]byte{0x41, 0x01}, nil)
	assert.Error(t, err)
	_, err = script.ApplyParams([]byte{0x43, 0x01, 0x01, 0x00}, nil)
	assert.Error(t, err)
}

// Live quotes are never evicted: a full store refuses new quotes until one
// expires, so a buyer can always settle the quote it paid for.
func TestInMemoryTermsStorageKeepsLiveQuotes(t *testing.T) {
	ctx := context.Background()
	q := baseQuote(t)
	extra, err := ValidateExtra(q.Requirements.Extra, q.Requirements.Network)
	require.NoError(t, err)
	payBy, err := strconv.ParseInt(extra.Terms.PayByTime, 10, 64)
	require.NoError(t, err)
	window := time.Duration(q.Requirements.MaxTimeoutSeconds) * time.Second
	now := time.UnixMilli(payBy)
	s, err := NewInMemoryTermsStorage(1)
	require.NoError(t, err)
	s.now = func() time.Time { return now }
	put := func(digest string) error {
		_, err := s.UpdateTerms(ctx, digest, func(*StoredTerms) *StoredTerms {
			return &StoredTerms{TermsDigest: digest, Requirements: q.Requirements}
		})
		return err
	}

	require.NoError(t, put("live"))
	assert.ErrorIs(t, put("new"), ErrTermsStorageFull)
	got, _ := s.Get(ctx, "live")
	assert.NotNil(t, got, "a payable quote survives unpaid quote traffic")

	now = now.Add(window + time.Millisecond)
	require.NoError(t, put("new"), "an expired quote makes room")
	got, _ = s.Get(ctx, "live")
	assert.Nil(t, got)

	_, err = s.UpdateTerms(ctx, "new", func(current *StoredTerms) *StoredTerms {
		claimed := *current
		claimed.ClaimedTxHash = "tx"
		return &claimed
	})
	require.NoError(t, err)
	now = now.Add(window + time.Millisecond)
	assert.ErrorIs(t, put("later"), ErrTermsStorageFull, "a claimed quote outlives its payment window while settlement may resume")
	now = now.Add(ClaimedTermsRetention)
	require.NoError(t, put("later"))
}

func TestInMemoryTermsStorage(t *testing.T) {
	ctx := context.Background()
	_, err := NewInMemoryTermsStorage(0)
	assert.Error(t, err)
	s, err := NewInMemoryTermsStorage(2)
	require.NoError(t, err)

	got, err := s.Get(ctx, "a")
	require.NoError(t, err)
	assert.Nil(t, got)

	res, err := s.UpdateTerms(ctx, "a", func(current *StoredTerms) *StoredTerms { return current })
	require.NoError(t, err)
	assert.Equal(t, UpdateResult{Status: StatusUnchanged}, res)

	a := &StoredTerms{TermsDigest: "a"}
	res, err = s.UpdateTerms(ctx, "a", func(*StoredTerms) *StoredTerms { return a })
	require.NoError(t, err)
	assert.Equal(t, UpdateResult{Terms: a, Status: StatusUpdated}, res)

	claim := func(tx string) func(*StoredTerms) *StoredTerms {
		return func(current *StoredTerms) *StoredTerms {
			if current == nil || current.ClaimedTxHash != "" {
				return current
			}
			next := *current
			next.ClaimedTxHash = tx
			return &next
		}
	}
	res, err = s.UpdateTerms(ctx, "a", claim("tx1"))
	require.NoError(t, err)
	assert.Equal(t, StatusUpdated, res.Status)
	res, err = s.UpdateTerms(ctx, "a", claim("tx2"))
	require.NoError(t, err)
	assert.Equal(t, StatusUnchanged, res.Status)
	assert.Equal(t, "tx1", res.Terms.ClaimedTxHash)

	// Updating "a" does not refresh its age: it is still evicted first.
	_, _ = s.UpdateTerms(ctx, "b", func(*StoredTerms) *StoredTerms { return &StoredTerms{TermsDigest: "b"} })
	_, _ = s.UpdateTerms(ctx, "c", func(*StoredTerms) *StoredTerms { return &StoredTerms{TermsDigest: "c"} })
	got, _ = s.Get(ctx, "a")
	assert.Nil(t, got)
	got, _ = s.Get(ctx, "c")
	assert.NotNil(t, got)

	res, err = s.UpdateTerms(ctx, "b", func(*StoredTerms) *StoredTerms { return nil })
	require.NoError(t, err)
	assert.Equal(t, UpdateResult{Status: StatusDeleted}, res)
	got, _ = s.Get(ctx, "b")
	assert.Nil(t, got)

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = s.UpdateTerms(cancelled, "x", func(c *StoredTerms) *StoredTerms { return c })
	assert.Error(t, err)

	// Only the first concurrent claim wins.
	_, _ = s.UpdateTerms(ctx, "race", func(*StoredTerms) *StoredTerms { return &StoredTerms{TermsDigest: "race"} })
	var wg sync.WaitGroup
	var mu sync.Mutex
	winners := 0
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := s.UpdateTerms(ctx, "race", claim(strconv.Itoa(i)))
			if err == nil && res.Status == StatusUpdated {
				mu.Lock()
				winners++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	assert.Equal(t, 1, winners)
	var _ TermsStorage = s
}
