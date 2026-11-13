package cardano

import (
	"bufio"
	"context"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNetworks(t *testing.T) {
	assert.Equal(t, CardanoMainnetCAIP2, NormalizeNetwork(CardanoMainnetCIP34))
	assert.Equal(t, CardanoPreprodCAIP2, NormalizeNetwork(CardanoPreprodCIP34))
	assert.Equal(t, CardanoPreviewCAIP2, NormalizeNetwork(CardanoPreviewCIP34))
	assert.Equal(t, "eip155:1", NormalizeNetwork("eip155:1"))
	assert.True(t, IsCardanoNetwork(CardanoPreprodCIP34))
	assert.False(t, IsCardanoNetwork("cardano:sanchonet"))
	id, err := NetworkID(CardanoMainnetCAIP2)
	require.NoError(t, err)
	assert.Equal(t, NetworkIDMainnet, id)
	id, err = NetworkID(CardanoPreviewCIP34)
	require.NoError(t, err)
	assert.Equal(t, NetworkIDTestnet, id)
	_, err = NetworkID("solana:mainnet")
	assert.Error(t, err)
}

func TestParseAssetUnit(t *testing.T) {
	policy, name, err := ParseAssetUnit(LovelaceAsset)
	require.NoError(t, err)
	assert.Empty(t, policy)
	assert.Empty(t, name)
	policy, name, err = ParseAssetUnit("C48CBB3D5E57ED56E276BC45F99AB39ABE94E6CD7AC39FB402DA47AD.0014DF105553444D")
	require.NoError(t, err)
	assert.Equal(t, USDMMainnetPolicyID, policy)
	assert.Equal(t, USDMAssetNameHex, name)
	_, _, err = ParseAssetUnit("usdm")
	assert.Error(t, err)
	assert.True(t, IsCanonicalAsset(USDMPreprodAsset))
	assert.False(t, IsCanonicalAsset("C48CBB3D5E57ED56E276BC45F99AB39ABE94E6CD7AC39FB402DA47AD.00"))
}

func TestParseUtxoRef(t *testing.T) {
	hash, index, err := ParseUtxoRef("662CBF645FCD8914EB89115B83970A950493DD2FBAF39DEA3B96E8CBDC132939#7")
	require.NoError(t, err)
	assert.Equal(t, "662cbf645fcd8914eb89115b83970a950493dd2fbaf39dea3b96e8cbdc132939", hash)
	assert.EqualValues(t, 7, index)
	for _, bad := range []string{"", "abc#0", "662cbf645fcd8914eb89115b83970a950493dd2fbaf39dea3b96e8cbdc132939", "662cbf645fcd8914eb89115b83970a950493dd2fbaf39dea3b96e8cbdc132939#99999999999"} {
		_, _, err := ParseUtxoRef(bad)
		assert.Error(t, err, bad)
	}
}

func TestIsPositiveCanonicalAmount(t *testing.T) {
	assert.True(t, IsPositiveCanonicalAmount("1"))
	for _, bad := range []string{"0", "01", "-1", "1.5", ""} {
		assert.False(t, IsPositiveCanonicalAmount(bad), bad)
	}
}

func TestSlotConversions(t *testing.T) {
	ms, err := SlotToPosixMs(CardanoPreprodCAIP2, 86400)
	require.NoError(t, err)
	assert.EqualValues(t, 1655769600000, ms)
	slot, err := PosixMsToSlot(CardanoPreprodCAIP2, ms+20_999)
	require.NoError(t, err)
	assert.EqualValues(t, 86420, slot)
	ms, err = SlotToPosixMs(CardanoMainnetCIP34, 4492800+10)
	require.NoError(t, err)
	assert.EqualValues(t, 1596059101000, ms)
	_, err = SlotToPosixMs("cardano:unknown", 1)
	assert.Error(t, err)
	_, err = SlotToPosixMs(CardanoPreprodCAIP2, 1<<61+86400+5)
	assert.Error(t, err, "slots whose time overflows int64 are rejected, not wrapped")
	_, err = SlotToPosixMs(CardanoMainnetCAIP2, ^uint64(0))
	assert.Error(t, err)
}

func TestMinUtxoLovelace(t *testing.T) {
	assert.EqualValues(t, (160+82)*4310, MinUtxoLovelace(82, 4310))
}

func TestConfirmationPolicy(t *testing.T) {
	policy, ok := ResolveConfirmationPolicy(nil)
	require.True(t, ok)
	assert.Equal(t, DefaultL1Confirmations, policy.L1Confirmations)
	policy, ok = ResolveConfirmationPolicy(map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": float64(-1)}})
	require.True(t, ok)
	assert.Equal(t, -1, policy.L1Confirmations)
	for _, bad := range []interface{}{
		map[string]interface{}{"l1Confirmations": float64(21)},
		map[string]interface{}{"l1Confirmations": 1.5},
		map[string]interface{}{"l1Confirmations": "1"},
		map[string]interface{}{"l1Confirmations": float64(1), "extra": true},
		map[string]interface{}{},
		[]interface{}{1},
		nil,
	} {
		_, ok := ResolveConfirmationPolicy(map[string]interface{}{"confirmationPolicy": bad})
		assert.False(t, ok, "%v", bad)
	}
	assert.True(t, ConfirmationsSatisfy(1, 1))
	assert.False(t, ConfirmationsSatisfy(-1, 0))
}

func TestDefaultAssets(t *testing.T) {
	asset, err := GetDefaultAsset(CardanoPreprodCIP34, "")
	require.NoError(t, err)
	assert.Equal(t, USDMPreprodAsset, asset.Asset)
	asset, err = GetDefaultAsset(CardanoMainnetCAIP2, "usdm")
	require.NoError(t, err)
	assert.Equal(t, USDMMainnetAsset, asset.Asset)
	_, err = GetDefaultAsset(CardanoPreviewCAIP2, "")
	assert.Error(t, err)
	_, err = GetDefaultAsset(CardanoMainnetCAIP2, "USDC")
	assert.Error(t, err)
	assert.NotNil(t, FindDefaultAsset(USDMMainnetAsset, CardanoMainnetCAIP2))
	assert.Nil(t, FindDefaultAsset(LovelaceAsset, CardanoMainnetCAIP2))
}

func TestAddressHelpers(t *testing.T) {
	cred, err := PaymentCredential("addr1vy3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs44r503")
	require.NoError(t, err)
	assert.False(t, cred.IsScript)
	assert.Equal(t, "22222222222222222222222222222222222222222222222222222222", cred.HashHex())
	id, err := AddressNetworkID("addr1vy3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs44r503")
	require.NoError(t, err)
	assert.Equal(t, NetworkIDMainnet, id)
	_, err = PaymentCredential("not-an-address")
	assert.Error(t, err)
}

// TestErrorReasonsMatchTypeScript reads the TypeScript constants and asserts
// every wire-visible error reason exists here with the identical value.
func TestErrorReasonsMatchTypeScript(t *testing.T) {
	f, err := os.Open("../../../typescript/packages/mechanisms/cardano/src/constants.ts")
	if os.IsNotExist(err) {
		t.Skip("TypeScript sources not available")
	}
	require.NoError(t, err)
	defer f.Close()
	goReasons := map[string]bool{}
	for _, v := range []string{
		ErrUnsupportedScheme, ErrInvalidPayload, ErrRequirementsInvalid, ErrNetworkMismatch,
		ErrTransactionDecodeFailed, ErrNetworkIDMismatch, ErrRecipientMismatch, ErrAssetMismatch,
		ErrAmountInsufficient, ErrNonceInvalid, ErrNonceNotInInputs, ErrNonceNotOnChain,
		ErrInputNotAvailable, ErrTTLExpired, ErrValidityNotYetValid, ErrChainLookupFailed,
		ErrSettlementFailed, ErrSettlementDefinitivelyRejected, ErrSettlementNotConfirmed,
		ErrDuplicateSettlement, ErrMasumiTermsUnknown, ErrMasumiTermsMismatch, ErrSettlementPending,
		ErrScriptAddressMismatch, ErrTransactionUnsigned, ErrInvalidSignature,
		ErrTransactionPhase2Invalid, ErrTransactionPhase1Invalid, ErrValueNotConserved,
		ErrFeeBelowMinimum, ErrInputValueUnavailable, ErrMinUtxoInsufficient,
		ErrMasumiContractMismatch, ErrMasumiDatumMissing, ErrMasumiDatumMismatch,
		ErrMasumiDatumInvalid, ErrMasumiDeadline, ErrMasumiCollateral, ErrMasumiMinUtxo,
		ErrMasumiReferenceScript, ErrMasumiAsset, ErrPolicyInvalid, ErrTTLTooFar,
		ErrEvidenceUnavailable, ErrMasumiSchema, ErrMasumiCommitment, ErrMasumiSellerSignature,
		ErrMasumiIdentifier, ErrMasumiAgentIdentifier, ErrMasumiDeployment, ErrMasumiEscrowOutputCount,
	} {
		goReasons[v] = true
	}
	decl := regexp.MustCompile(`^export const ERR_[A-Z0-9_]+ =\s*$|^export const ERR_[A-Z0-9_]+ = "([^"]+)";`)
	cont := regexp.MustCompile(`^\s+"([^"]+)";`)
	scanner := bufio.NewScanner(f)
	var pending bool
	count := 0
	for scanner.Scan() {
		line := scanner.Text()
		if pending {
			if m := cont.FindStringSubmatch(line); m != nil {
				assert.True(t, goReasons[m[1]], "missing Go reason %q", m[1])
				count++
			}
			pending = false
			continue
		}
		if m := decl.FindStringSubmatch(line); m != nil {
			if m[1] == "" {
				pending = true
				continue
			}
			assert.True(t, goReasons[m[1]], "missing Go reason %q", m[1])
			count++
		}
	}
	require.NoError(t, scanner.Err())
	assert.Equal(t, len(goReasons), count, "TypeScript and Go reason sets differ in size")
}

func TestInMemorySettlementStore(t *testing.T) {
	ctx := context.Background()
	store := NewInMemorySettlementStore(0)
	claim := SettlementClaim{TxHash: "a", OwnerToken: "o1", TermsDigest: "d"}
	res, _ := store.ClaimSettlement(ctx, claim)
	assert.Equal(t, ClaimFresh, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o2", TermsDigest: "d"})
	assert.Equal(t, ClaimInFlight, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "b", OwnerToken: "o3", TermsDigest: "d"})
	assert.Equal(t, ClaimTermsConflict, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o2"})
	assert.Equal(t, ClaimTermsConflict, res)

	require.NoError(t, store.MarkSubmitted(ctx, "a", "wrong-owner"))
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o2", TermsDigest: "d"})
	assert.Equal(t, ClaimInFlight, res)
	require.NoError(t, store.MarkSubmitted(ctx, "a", "o1"))
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o2", TermsDigest: "d"})
	assert.Equal(t, ClaimSubmitted, res)
	require.NoError(t, store.ReleaseClaim(ctx, "a", "o1"))
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o2", TermsDigest: "d"})
	assert.Equal(t, ClaimSubmitted, res, "a submitted claim is never released")

	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "c", OwnerToken: "o4"})
	assert.Equal(t, ClaimFresh, res)
	require.NoError(t, store.MarkRejected(ctx, "c", "o4"))
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "c", OwnerToken: "o5"})
	assert.Equal(t, ClaimRejected, res)

	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "e", OwnerToken: "o6", TermsDigest: "e-d"})
	assert.Equal(t, ClaimFresh, res)
	require.NoError(t, store.ReleaseClaim(ctx, "e", "o6"))
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "f", OwnerToken: "o7", TermsDigest: "e-d"})
	assert.Equal(t, ClaimFresh, res, "a released claim frees its terms digest")
}

func TestInMemorySettlementStoreCapacity(t *testing.T) {
	ctx := context.Background()
	store := NewInMemorySettlementStore(2)
	res, _ := store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "b", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "c", OwnerToken: "o"})
	assert.Equal(t, ClaimCapacityExceeded, res, "in-flight claims are never evicted")
	require.NoError(t, store.MarkSubmitted(ctx, "a", "o"))
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "c", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o"})
	assert.Equal(t, ClaimCapacityExceeded, res, "the oldest settled record was evicted")
}

func TestInMemorySettlementStoreLease(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_000, 0)
	store := NewInMemorySettlementStore(2).WithClaimLease(time.Minute)
	store.now = func() time.Time { return now }
	res, _ := store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o2"})
	assert.Equal(t, ClaimInFlight, res, "a live in-flight claim blocks retries")
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "b", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "c", OwnerToken: "o"})
	assert.Equal(t, ClaimCapacityExceeded, res)

	now = now.Add(2 * time.Minute)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "a", OwnerToken: "o2"})
	assert.Equal(t, ClaimSubmitted, res, "an abandoned claim resumes from chain evidence")
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "c", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res, "abandoned claims no longer pin capacity")
}

// A settled record that binds still-payable Masumi terms is never evicted:
// dropping it would let the same quote pay a second transaction.
func TestInMemorySettlementStoreKeepsLiveTermsBindings(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_000, 0)
	store := NewInMemorySettlementStore(2)
	store.now = func() time.Time { return now }
	expires := now.Add(time.Minute).UnixMilli()
	res, _ := store.ClaimSettlement(ctx, SettlementClaim{TxHash: "tx1", OwnerToken: "o", TermsDigest: "terms", TermsExpireAtMs: expires})
	require.Equal(t, ClaimFresh, res)
	require.NoError(t, store.MarkSubmitted(ctx, "tx1", "o"))

	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "other", OwnerToken: "o"})
	assert.Equal(t, ClaimCapacityExceeded, res, "the live binding is not evicted to make room")
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "tx2", OwnerToken: "o", TermsDigest: "terms", TermsExpireAtMs: expires})
	assert.Equal(t, ClaimTermsConflict, res)

	now = now.Add(2 * time.Minute)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "other", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res, "expired terms free their binding")
}

func TestInMemorySettlementStoreRetainsUntilTransactionExpires(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_000, 0)
	store := NewInMemorySettlementStore(1)
	store.now = func() time.Time { return now }
	res, _ := store.ClaimSettlement(ctx, SettlementClaim{TxHash: "tx", OwnerToken: "o", RetainUntilMs: now.Add(time.Hour).UnixMilli()})
	require.Equal(t, ClaimFresh, res)
	require.NoError(t, store.MarkSubmitted(ctx, "tx", "o"))

	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "other", OwnerToken: "o"})
	assert.Equal(t, ClaimCapacityExceeded, res)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "tx", OwnerToken: "o2"})
	assert.Equal(t, ClaimSubmitted, res)

	now = now.Add(2 * time.Hour)
	res, _ = store.ClaimSettlement(ctx, SettlementClaim{TxHash: "other", OwnerToken: "o"})
	assert.Equal(t, ClaimFresh, res, "an expired transaction frees its record")
}

func TestInMemorySettlementStoreConcurrentClaims(t *testing.T) {
	ctx := context.Background()
	store := NewInMemorySettlementStore(0)
	results := make(chan SettlementClaimResult, 32)
	for i := 0; i < 32; i++ {
		go func() {
			res, _ := store.ClaimSettlement(ctx, SettlementClaim{TxHash: "same", OwnerToken: "o"})
			results <- res
		}()
	}
	fresh := 0
	for i := 0; i < 32; i++ {
		if <-results == ClaimFresh {
			fresh++
		}
	}
	assert.Equal(t, 1, fresh)
}
