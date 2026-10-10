package masumi

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

// testdata/*.json is produced by the TypeScript SDK itself (jcs, digests,
// identifier, datum, escrow, COSE, issuance, lock and lock verification);
// cose_go_vectors.json holds Go signatures the TypeScript verifier accepted.
// Go must reproduce every value exactly.

func loadVector(t *testing.T, name string, v interface{}) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, v))
}

func bigOf(t *testing.T, s string) *big.Int {
	t.Helper()
	n, ok := new(big.Int).SetString(s, 10)
	require.True(t, ok, s)
	return n
}

func u64(t *testing.T, s string) uint64 {
	t.Helper()
	n, err := strconv.ParseUint(s, 10, 64)
	require.NoError(t, err)
	return n
}

func TestJCSMatchesTypeScript(t *testing.T) {
	var vectors []struct{ Input, JCS string }
	loadVector(t, "jcs_vectors.json", &vectors)
	require.NotEmpty(t, vectors)
	for _, v := range vectors {
		var value interface{}
		require.NoError(t, json.Unmarshal([]byte(v.Input), &value))
		got, err := JCS(value)
		require.NoError(t, err, v.Input)
		assert.Equal(t, v.JCS, string(got), v.Input)
	}
}

func TestIdentifierMatchesTypeScript(t *testing.T) {
	var vectors struct {
		Cases []struct {
			Parts   IdentifierParts
			Text    string
			Hex     string
			Decoded *IdentifierParts
		}
		Invalid []struct {
			Hex     string
			Decoded *IdentifierParts
		}
	}
	loadVector(t, "identifier_vectors.json", &vectors)
	for _, c := range vectors.Cases {
		assert.Equal(t, c.Text, BuildIdentifierText(c.Parts))
		encoded, err := EncodeBlockchainIdentifier(c.Parts)
		require.NoError(t, err)
		assert.Equal(t, c.Hex, encoded)
		decoded, ok := DecodeBlockchainIdentifier(c.Hex)
		if c.Decoded == nil {
			assert.False(t, ok, c.Hex)
			continue
		}
		require.True(t, ok)
		assert.Equal(t, *c.Decoded, decoded)
	}
	for _, c := range vectors.Invalid {
		decoded, ok := DecodeBlockchainIdentifier(c.Hex)
		if c.Decoded == nil {
			assert.False(t, ok, c.Hex)
		} else {
			assert.True(t, ok, c.Hex)
			assert.Equal(t, *c.Decoded, decoded)
		}
	}
}

func credentialsJSON(c AddressCredentials) map[string]interface{} {
	out := map[string]interface{}{"payment": map[string]interface{}{"isScript": c.Payment.IsScript, "hash": c.Payment.Hash}}
	if c.Stake != nil {
		out["stake"] = map[string]interface{}{"isScript": c.Stake.IsScript, "hash": c.Stake.Hash}
	}
	if c.Pointer != nil {
		out["pointer"] = map[string]interface{}{
			"slot": c.Pointer.Slot.String(), "txIndex": c.Pointer.TxIndex.String(), "certIndex": c.Pointer.CertIndex.String(),
		}
	}
	return out
}

func optionalCredentialsJSON(c *AddressCredentials) interface{} {
	if c == nil {
		return nil
	}
	return credentialsJSON(*c)
}

func viewJSON(v *DatumView) map[string]interface{} {
	return map[string]interface{}{
		"buyer":                     credentialsJSON(v.Buyer),
		"buyerReturnAddress":        optionalCredentialsJSON(v.BuyerReturnAddress),
		"seller":                    credentialsJSON(v.Seller),
		"sellerReturnAddress":       optionalCredentialsJSON(v.SellerReturnAddress),
		"referenceKey":              v.ReferenceKey,
		"referenceSignature":        v.ReferenceSignature,
		"sellerNonce":               v.SellerNonce,
		"buyerNonce":                v.BuyerNonce,
		"agentIdentifier":           v.AgentIdentifier,
		"collateralReturnLovelace":  v.CollateralReturnLovelace.String(),
		"inputHash":                 v.InputHash,
		"resultHash":                v.ResultHash,
		"payByTime":                 v.PayByTime.String(),
		"submitResultTime":          v.SubmitResultTime.String(),
		"unlockTime":                v.UnlockTime.String(),
		"externalDisputeUnlockTime": v.ExternalDisputeUnlockTime.String(),
		"sellerCooldownTime":        v.SellerCooldownTime.String(),
		"buyerCooldownTime":         v.BuyerCooldownTime.String(),
		"state":                     strconv.FormatUint(uint64(v.State), 10),
	}
}

func assertJSONEqual(t *testing.T, expected json.RawMessage, actual interface{}, msg string) {
	t.Helper()
	got, err := json.Marshal(actual)
	require.NoError(t, err)
	assert.JSONEq(t, string(expected), string(got), msg)
}

func TestAddressCredentialsMatchTypeScript(t *testing.T) {
	var vectors []struct {
		Address     string
		Credentials json.RawMessage
	}
	loadVector(t, "address_vectors.json", &vectors)
	for _, v := range vectors {
		creds, err := ExtractAddressCredentials(v.Address)
		require.NoError(t, err)
		assertJSONEqual(t, v.Credentials, credentialsJSON(creds), v.Address)
	}
	_, err := ExtractAddressCredentials("stake_test1uqfu74w3wh4gfzu8m6e7j987h4lq9r3t7ef5gaw497uu85qsqfy27")
	assert.Error(t, err)
	_, err = ExtractAddressCredentials("not an address")
	assert.Error(t, err)
}

func TestLockDatumMatchesTypeScript(t *testing.T) {
	var vectors struct {
		Build []struct {
			Input struct {
				BuyerAddress, SellerAddress, BuyerReturnAddress, SellerReturnAddress string
				ReferenceKey, ReferenceSignature, SellerNonce, BuyerNonce, InputHash string
				AgentIdentifier, CollateralReturnLovelace                            string
				PayByTime, SubmitResultTime, UnlockTime, ExternalDisputeUnlockTime   string
			}
			CBOR string
			View json.RawMessage
		}
		Spec struct {
			CBOR      string
			View      json.RawMessage
			Reencoded string
		}
		Parse []struct {
			CBOR string
			View json.RawMessage
		}
	}
	loadVector(t, "datum_vectors.json", &vectors)
	for _, v := range vectors.Build {
		in := v.Input
		cbor, err := BuildLockDatumCBOR(LockDatumInput{
			BuyerAddress: in.BuyerAddress, SellerAddress: in.SellerAddress,
			BuyerReturnAddress: in.BuyerReturnAddress, SellerReturnAddress: in.SellerReturnAddress,
			ReferenceKey: in.ReferenceKey, ReferenceSignature: in.ReferenceSignature,
			SellerNonce: in.SellerNonce, BuyerNonce: in.BuyerNonce, AgentIdentifier: in.AgentIdentifier,
			CollateralReturnLovelace: u64(t, in.CollateralReturnLovelace), InputHash: in.InputHash,
			PayByTime: bigOf(t, in.PayByTime), SubmitResultTime: bigOf(t, in.SubmitResultTime),
			UnlockTime: bigOf(t, in.UnlockTime), ExternalDisputeUnlockTime: bigOf(t, in.ExternalDisputeUnlockTime),
		})
		require.NoError(t, err)
		assert.Equal(t, v.CBOR, hex.EncodeToString(cbor))
		view, err := ParseLockDatum(v.CBOR)
		require.NoError(t, err)
		assertJSONEqual(t, v.View, viewJSON(view), v.CBOR)
	}

	view, err := ParseLockDatum(vectors.Spec.CBOR)
	require.NoError(t, err)
	assertJSONEqual(t, vectors.Spec.View, viewJSON(view), "spec vector")
	assert.Equal(t, vectors.Spec.CBOR, vectors.Spec.Reencoded)

	for _, v := range vectors.Parse {
		view, err := ParseLockDatum(v.CBOR)
		if string(v.View) == "null" {
			assert.Error(t, err, v.CBOR)
			continue
		}
		require.NoError(t, err, v.CBOR)
		assertJSONEqual(t, v.View, viewJSON(view), v.CBOR)
	}
}

func TestSpecDatumVectorRebuilds(t *testing.T) {
	enterprise := func(b byte) string {
		addr, err := cardanoEnterpriseKeyAddress(bytesOf(b, 28), cardano.CardanoPreprodCAIP2)
		require.NoError(t, err)
		return addr
	}
	cbor, err := BuildLockDatumCBOR(LockDatumInput{
		BuyerAddress: enterprise(0x11), SellerAddress: enterprise(0x22),
		ReferenceKey: "a10101", ReferenceSignature: hex.EncodeToString(bytesOf(0x55, 16)),
		SellerNonce: hex.EncodeToString(bytesOf(0x33, 32)), CollateralReturnLovelace: 1435230,
		InputHash: hex.EncodeToString(bytesOf(0x44, 32)),
		PayByTime: big.NewInt(1785756000000), SubmitResultTime: big.NewInt(1785759600000),
		UnlockTime: big.NewInt(1785763200000), ExternalDisputeUnlockTime: big.NewInt(1785766800000),
	})
	require.NoError(t, err)
	assert.Equal(t, "d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ffd87a80d8799fd8799f581c22222222222222222222222222222222222222222222222222222222ffd87a80ffd87a8043a1010150555555555555555555555555555555555820333333333333333333333333333333333333333333333333333333333333333340401a0015e65e58204444444444444444444444444444444444444444444444444444444444444444401b0000019fc75a1f001b0000019fc7910d801b0000019fc7c7fc001b0000019fc7feea800000d87980ff", hex.EncodeToString(cbor))
}

func TestEscrowMatchesTypeScript(t *testing.T) {
	var vectors []struct {
		Deployment Deployment
		ScriptHash string
		Addresses  map[string]string
	}
	loadVector(t, "escrow_vectors.json", &vectors)
	for _, v := range vectors {
		hash, err := EscrowScriptHash(v.Deployment)
		require.NoError(t, err)
		assert.Equal(t, v.ScriptHash, hash)
		for network, address := range v.Addresses {
			got, err := EscrowAddress(network, v.Deployment)
			require.NoError(t, err)
			assert.Equal(t, address, got, network)
		}
	}
}

func TestCollateralMatchesTypeScript(t *testing.T) {
	var vectors struct {
		Collateral []struct {
			DatumBytes, Tokens                               int
			CoinsPerUtxoByte, Requested, MinUtxo, Collateral string
		}
		Intervals []struct {
			Times []string
			Hold  bool
		}
	}
	loadVector(t, "collateral_vectors.json", &vectors)
	for _, v := range vectors.Collateral {
		cpb := u64(t, v.CoinsPerUtxoByte)
		assert.Equal(t, u64(t, v.MinUtxo), MinUtxoLovelace(v.DatumBytes, v.Tokens, cpb))
		assert.Equal(t, u64(t, v.Collateral), CollateralLovelace(u64(t, v.Requested), v.DatumBytes, v.Tokens, cpb))
	}
	for _, v := range vectors.Intervals {
		assert.Equal(t, v.Hold, DeadlineIntervalsHold(bigOf(t, v.Times[0]), bigOf(t, v.Times[1]), bigOf(t, v.Times[2]), bigOf(t, v.Times[3])), v.Times)
	}
}

func TestCOSEMatchesTypeScript(t *testing.T) {
	var vectors struct {
		Signed []struct{ Seed, Address, Payload, Key, Signature string }
		Verify []struct {
			Name, Key, Signature, Address, Digest string
			Valid                                 bool
		}
	}
	loadVector(t, "cose_vectors.json", &vectors)
	for _, v := range vectors.Signed {
		seed, _ := hex.DecodeString(v.Seed)
		payload, _ := hex.DecodeString(v.Payload)
		auth, err := SignData(ed25519.NewKeyFromSeed(seed), v.Address, payload)
		require.NoError(t, err)
		assert.Equal(t, v.Key, auth.Key, "Go signData must be byte-identical to TypeScript")
		assert.Equal(t, v.Signature, auth.Signature)
		assert.True(t, VerifySellerTermsSignature(v.Key, v.Signature, v.Address, v.Payload))
	}
	for _, v := range vectors.Verify {
		assert.Equal(t, v.Valid, VerifySellerTermsSignature(v.Key, v.Signature, v.Address, v.Digest), v.Name)
	}
}

// goCoseVector is a Go-produced signature that the TypeScript verifier accepted.
type goCoseVector struct {
	Seed       string `json:"seed"`
	Address    string `json:"address"`
	Payload    string `json:"payload"`
	Key        string `json:"key"`
	Signature  string `json:"signature"`
	TSVerified bool   `json:"tsVerified"`
}

func goCoseInputs() []goCoseVector {
	var out []goCoseVector
	for i, network := range []string{cardano.CardanoPreprodCAIP2, cardano.CardanoMainnetCAIP2, cardano.CardanoPreviewCAIP2} {
		seed := bytesOf(byte(0x40+i), 32)
		address, _, _ := NewSellerSigner(ed25519.NewKeyFromSeed(seed), network)
		for _, payload := range [][]byte{bytesOf(0x42, 32), bytesOf(byte(i), 32), {}} {
			out = append(out, goCoseVector{Seed: hex.EncodeToString(seed), Address: address, Payload: hex.EncodeToString(payload)})
		}
	}
	return out
}

// TestWriteGoCOSE writes Go signatures for the TypeScript round trip when
// MASUMI_WRITE_GO_COSE names an output file.
func TestWriteGoCOSE(t *testing.T) {
	target := os.Getenv("MASUMI_WRITE_GO_COSE")
	if target == "" {
		t.Skip("set MASUMI_WRITE_GO_COSE to regenerate")
	}
	vectors := goCoseInputs()
	for i := range vectors {
		seed, _ := hex.DecodeString(vectors[i].Seed)
		payload, _ := hex.DecodeString(vectors[i].Payload)
		auth, err := SignData(ed25519.NewKeyFromSeed(seed), vectors[i].Address, payload)
		require.NoError(t, err)
		vectors[i].Key, vectors[i].Signature = auth.Key, auth.Signature
	}
	raw, err := json.MarshalIndent(vectors, "", " ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(target, raw, 0o600))
}

func TestGoSignaturesMatchTSAcceptedVectors(t *testing.T) {
	var vectors []goCoseVector
	loadVector(t, "cose_go_vectors.json", &vectors)
	require.Len(t, vectors, len(goCoseInputs()))
	for _, v := range vectors {
		require.True(t, v.TSVerified, "TypeScript rejected a Go signature")
		seed, _ := hex.DecodeString(v.Seed)
		payload, _ := hex.DecodeString(v.Payload)
		auth, err := SignData(ed25519.NewKeyFromSeed(seed), v.Address, payload)
		require.NoError(t, err)
		assert.Equal(t, v.Key, auth.Key)
		assert.Equal(t, v.Signature, auth.Signature)
	}
}

type quoteVector struct {
	Name         string
	Seed         string
	Input        map[string]interface{}
	Registry     bool
	Approve      bool
	LocalContent map[string]interface{}
	Requirements types.PaymentRequirements
	SignedTerms  string `json:"signedTermsJcs"`
	TermsDigest  string
	InputHash    string
	Locks        []struct {
		CoinsPerUtxoByte   string
		BuyerReturnAddress string
		Datum              string
		Collateral         string
		Locked             string
	}
}

const vectorBuyer = "addr_test1qp7573my7h0fyj9cd2fwrws5v6ep0e6urpx007pz0pjnmakny46m3vmfawqwv3m48dv2s6eysht6tjfdk48lrzrkmj5qpmyq7l"

func registryOK(context.Context, RegistryClaim) (bool, error)     { return true, nil }
func deploymentOK(context.Context, DeploymentClaim) (bool, error) { return true, nil }

func issueInputFromVector(t *testing.T, v quoteVector) IssueInput {
	t.Helper()
	seed, _ := hex.DecodeString(v.Seed)
	_, signer, err := NewSellerSigner(ed25519.NewKeyFromSeed(seed), cardano.CardanoPreprodCAIP2)
	require.NoError(t, err)
	in := v.Input
	str := func(k string) string { s, _ := in[k].(string); return s }
	issue := IssueInput{
		Network: str("network"), Asset: str("asset"), Amount: str("amount"),
		MaxTimeoutSeconds: int(in["maxTimeoutSeconds"].(float64)), SellerAddress: str("sellerAddress"), SignTerms: signer,
		PayByTime: str("payByTime"), SubmitResultTime: str("submitResultTime"), UnlockTime: str("unlockTime"),
		ExternalDisputeUnlockTime: str("externalDisputeUnlockTime"), SellerNonce: str("sellerNonce"),
		BuyerNonce: str("buyerNonce"), UnsafeSkipPolicyChecks: true,
	}
	if raw, ok := in["agentIdentifier"]; ok {
		issue.AgentIdentifier = AgentIdentifier{Set: true, Null: raw == nil, Value: str("agentIdentifier")}
	}
	if s, ok := in["sellerReturnAddress"].(string); ok {
		issue.SellerReturnAddress = &s
	}
	if p, ok := in["confirmationPolicy"].(map[string]interface{}); ok {
		issue.ConfirmationPolicy = &cardano.ConfirmationPolicy{L1Confirmations: int(p["l1Confirmations"].(float64))}
	}
	if d, ok := in["deployment"]; ok {
		raw, _ := json.Marshal(d)
		var dep Deployment
		require.NoError(t, json.Unmarshal(raw, &dep))
		issue.Deployment = &dep
	}
	for _, rawPart := range in["commitment"].([]interface{}) {
		p := rawPart.(map[string]interface{})
		part := CommitmentInput{Name: p["name"].(string), Canonicalization: p["canonicalization"].(string), Content: p["content"]}
		if m, ok := p["mediaType"].(string); ok {
			part.MediaType = &m
		}
		if echo, ok := p["echoContent"].(bool); ok && !echo {
			part.OmitContent = true
		}
		issue.Commitment = append(issue.Commitment, part)
	}
	return issue
}

func TestIssuedQuotesMatchTypeScript(t *testing.T) {
	var vectors []quoteVector
	loadVector(t, "quote_vectors.json", &vectors)
	require.NotEmpty(t, vectors)
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			req := v.Requirements
			extra, err := ValidateExtra(req.Extra, req.Network)
			require.NoError(t, err)

			signed, err := JCS(BuildSignedTerms(extra, req))
			require.NoError(t, err)
			assert.Equal(t, v.SignedTerms, string(signed))
			digest, err := TermsDigest(req)
			require.NoError(t, err)
			assert.Equal(t, v.TermsDigest, digest)
			inputHash, err := ComputeInputHash(extra.InputCommitment)
			require.NoError(t, err)
			assert.Equal(t, v.InputHash, inputHash)

			opts := AuthorizationOptions{RequireAllPartContent: true, LocalCommitmentContent: v.LocalContent}
			if v.Registry {
				opts.ValidateRegistryClaim = registryOK
				opts.Resource = &types.ResourceInfo{URL: "https://agent.example.com/weather"}
			}
			if v.Approve {
				opts.ValidateCustomDeployment = deploymentOK
			}
			auth, err := VerifyAuthorization(context.Background(), extra, req, opts)
			require.NoError(t, err)
			assert.Equal(t, req.PayTo, auth.EscrowAddress)
			assert.Equal(t, v.TermsDigest, auth.TermsDigest)

			amount := u64(t, req.Amount)
			for _, l := range v.Locks {
				lock, err := BuildLock(extra, vectorBuyer, req.Asset, amount, u64(t, l.CoinsPerUtxoByte), BuyerInput{BuyerReturnAddress: l.BuyerReturnAddress})
				require.NoError(t, err)
				assert.Equal(t, l.Datum, hex.EncodeToString(lock.Datum))
				assert.Equal(t, u64(t, l.Collateral), lock.CollateralLovelace)
				assert.Equal(t, u64(t, l.Locked), lock.LockedLovelace)
			}

			reissued, err := IssueRequirements(context.Background(), issueInputFromVector(t, v))
			require.NoError(t, err)
			want, _ := json.Marshal(req)
			got, _ := json.Marshal(reissued)
			assert.JSONEq(t, string(want), string(got), "Go issuance must reproduce the TypeScript 402")
		})
	}
}

func TestLockVerificationMatchesTypeScript(t *testing.T) {
	var vectors []struct {
		Name         string
		Requirements types.PaymentRequirements
		Decoded      struct {
			TTLSlot    *string `json:"ttlSlot"`
			VkeyHashes []string
			Outputs    []struct {
				Address            string
				Coin               string
				Assets             map[string]string
				Datum              string
				HasReferenceScript bool
			}
		}
		Payer            string
		CoinsPerUtxoByte string
		Registry         bool
		RegistryResult   bool
		Approve          bool
		Horizon          *string
		Result           struct {
			OK     bool
			Reason string
			Detail string
		}
	}
	loadVector(t, "lock_verify_vectors.json", &vectors)
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			decoded := &cardano.DecodedTransaction{VkeyHashes: v.Decoded.VkeyHashes}
			if v.Decoded.TTLSlot != nil {
				ttl := u64(t, *v.Decoded.TTLSlot)
				decoded.TTLSlot = &ttl
			}
			for _, o := range v.Decoded.Outputs {
				out := cardano.UtxoOutput{Address: o.Address, Coin: u64(t, o.Coin), Datum: o.Datum, HasReferenceScript: o.HasReferenceScript, Assets: map[string]uint64{}}
				for unit, q := range o.Assets {
					out.Assets[unit] = u64(t, q)
				}
				decoded.Outputs = append(decoded.Outputs, out)
			}
			cpb := u64(t, v.CoinsPerUtxoByte)
			vctx := VerifyContext{Payer: v.Payer, CoinsPerUtxoByte: &cpb, Resource: &types.ResourceInfo{URL: "https://agent.example.com/weather"}}
			if v.Registry {
				result := v.RegistryResult
				vctx.ValidateRegistryClaim = func(context.Context, RegistryClaim) (bool, error) { return result, nil }
			}
			if v.Approve {
				vctx.ValidateCustomDeployment = deploymentOK
			}
			if v.Horizon != nil {
				h := int64(u64(t, *v.Horizon))
				vctx.MaxDeadlineHorizonMs = &h
			}
			got := VerifyLock(context.Background(), v.Requirements.Extra, v.Requirements, decoded, vctx)
			assert.Equal(t, LockCheck{OK: v.Result.OK, Reason: v.Result.Reason, Detail: v.Result.Detail}, got)
		})
	}
}

func bytesOf(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
