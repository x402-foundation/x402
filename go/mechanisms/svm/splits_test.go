package svm

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/types"
)

type splitParties struct {
	merchant, platform, referrer, feePayer solana.PublicKey
}

func newSplitParties() splitParties {
	return splitParties{
		merchant: solana.NewWallet().PublicKey(),
		platform: solana.NewWallet().PublicKey(),
		referrer: solana.NewWallet().PublicKey(),
		feePayer: solana.NewWallet().PublicKey(),
	}
}

func splitRequirements(p splitParties, extra map[string]interface{}) types.PaymentRequirements {
	base := map[string]interface{}{
		"feePayer": p.feePayer.String(),
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "40000", "memo": "platform fee"},
			map[string]interface{}{"payTo": p.referrer.String(), "amount": "10000", "memo": "referral"},
		},
	}
	for k, v := range extra {
		base[k] = v
	}
	return types.PaymentRequirements{
		Scheme:  SchemeExact,
		Network: SolanaDevnetCAIP2,
		Asset:   USDCDevnetAddress,
		Amount:  "1050000",
		PayTo:   p.merchant.String(),
		Extra:   base,
	}
}

func requireSplitsReason(t *testing.T, err error, reason string) {
	t.Helper()
	require.Error(t, err)
	var se *SplitsError
	require.True(t, errors.As(err, &se), "expected *SplitsError, got %T: %v", err, err)
	assert.Equal(t, reason, se.Reason)
}

func TestSplitErrorCodesMatchTypeScript(t *testing.T) {
	assert.Equal(t, "invalid_exact_svm_splits_invalid", ErrSplitsInvalid)
	assert.Equal(t, "split_count_exceeded", ErrSplitCountExceeded)
	assert.Equal(t, "split_ata_creation_not_authorized", ErrSplitAtaCreationNotAuthorized)
	assert.Equal(t, "split_remainder_not_positive", ErrSplitRemainderNotPositive)
	assert.Equal(t, "split_leg_unmatched", ErrSplitLegUnmatched)
	assert.Equal(t, "split_unexpected_transfer", ErrSplitUnexpectedTransfer)
	assert.Equal(t, "invalid_exact_svm_payload_split_authority_mismatch", ErrSplitAuthorityMismatch)
}

func TestParsePaymentLegs_RemainderFirstThenSplitsInOrder(t *testing.T) {
	p := newSplitParties()
	legs, err := ParsePaymentLegs(splitRequirements(p, nil))
	require.NoError(t, err)
	require.Len(t, legs, 3)
	assert.Equal(t, PaymentLeg{Owner: p.merchant, Amount: 1_000_000, IsPrimary: true}, legs[0])
	assert.Equal(t, PaymentLeg{Owner: p.platform, Amount: 40_000, Memo: "platform fee"}, legs[1])
	assert.Equal(t, PaymentLeg{Owner: p.referrer, Amount: 10_000, Memo: "referral"}, legs[2])
}

func TestParsePaymentLegs_AcceptsDecodedJSONAndTypedSlices(t *testing.T) {
	p := newSplitParties()
	raw := `{"splits":[{"payTo":"` + p.platform.String() + `","amount":"40000","ataCreationRequired":true}],"ataCreationRequired":true}`
	var extra map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(raw), &extra))
	req := splitRequirements(p, extra)
	legs, err := ParsePaymentLegs(req)
	require.NoError(t, err)
	require.Len(t, legs, 2)
	assert.True(t, legs[0].AtaCreationRequired)
	assert.True(t, legs[1].AtaCreationRequired)

	type typedSplit struct {
		PayTo  string `json:"payTo"`
		Amount string `json:"amount"`
	}
	typed := splitRequirements(p, map[string]interface{}{
		"splits": []typedSplit{{PayTo: p.platform.String(), Amount: "50000"}},
	})
	legs, err = ParsePaymentLegs(typed)
	require.NoError(t, err)
	assert.Equal(t, uint64(1_000_000), legs[0].Amount)
}

func TestParsePaymentLegs_RejectsInvalidSplit(t *testing.T) {
	cases := []struct {
		name     string
		override map[string]interface{}
	}{
		{"a non-canonical amount", map[string]interface{}{"amount": "040000"}},
		{"a zero amount", map[string]interface{}{"amount": "0"}},
		{"an amount above u64", map[string]interface{}{"amount": "18446744073709551616"}},
		{"a numeric amount", map[string]interface{}{"amount": float64(40000)}},
		{"an invalid address", map[string]interface{}{"payTo": "not-an-address"}},
		{"a memo over 566 bytes", map[string]interface{}{"memo": strings.Repeat("x", 567)}},
		{"a non-string memo", map[string]interface{}{"memo": 7}},
		{"a non-boolean ataCreationRequired", map[string]interface{}{"ataCreationRequired": "yes"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newSplitParties()
			req := splitRequirements(p, nil)
			splits := req.Extra["splits"].([]interface{})
			first := splits[0].(map[string]interface{})
			for k, v := range tc.override {
				first[k] = v
			}
			_, err := ParsePaymentLegs(req)
			requireSplitsReason(t, err, ErrSplitsInvalid)
		})
	}
}

func TestParsePaymentLegs_AcceptsMemoAtLimit(t *testing.T) {
	p := newSplitParties()
	req := splitRequirements(p, map[string]interface{}{
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "1", "memo": strings.Repeat("é", MaxSplitMemoBytes/2)},
		},
	})
	_, err := ParsePaymentLegs(req)
	require.NoError(t, err)
}

func TestParsePaymentLegs_RejectsDuplicateRecipients(t *testing.T) {
	p := newSplitParties()
	toPrimary := splitRequirements(p, map[string]interface{}{
		"splits": []interface{}{map[string]interface{}{"payTo": p.merchant.String(), "amount": "1"}},
	})
	duplicate := splitRequirements(p, map[string]interface{}{
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "1"},
			map[string]interface{}{"payTo": p.platform.String(), "amount": "2"},
		},
	})
	_, err := ParsePaymentLegs(toPrimary)
	requireSplitsReason(t, err, ErrSplitsInvalid)
	_, err = ParsePaymentLegs(duplicate)
	requireSplitsReason(t, err, ErrSplitsInvalid)
}

func TestParsePaymentLegs_RejectsSplitsConsumingTheWholeAmount(t *testing.T) {
	p := newSplitParties()
	req := splitRequirements(p, map[string]interface{}{
		"splits": []interface{}{map[string]interface{}{"payTo": p.platform.String(), "amount": "1050000"}},
	})
	_, err := ParsePaymentLegs(req)
	requireSplitsReason(t, err, ErrSplitRemainderNotPositive)

	// A sum past u64 must not wrap into a positive remainder.
	overflow := splitRequirements(p, map[string]interface{}{
		"splits": []interface{}{
			map[string]interface{}{"payTo": p.platform.String(), "amount": "18446744073709551615"},
			map[string]interface{}{"payTo": p.referrer.String(), "amount": "2"},
		},
	})
	_, err = ParsePaymentLegs(overflow)
	requireSplitsReason(t, err, ErrSplitRemainderNotPositive)
}

func TestParsePaymentLegs_RejectsMoreThanEightSplits(t *testing.T) {
	p := newSplitParties()
	splits := make([]interface{}, 9)
	for i := range splits {
		splits[i] = map[string]interface{}{"payTo": solana.NewWallet().PublicKey().String(), "amount": "1"}
	}
	_, err := ParsePaymentLegs(splitRequirements(p, map[string]interface{}{"splits": splits}))
	requireSplitsReason(t, err, ErrSplitsInvalid)
}

func TestParsePaymentLegs_RejectsMalformedTopLevelFields(t *testing.T) {
	p := newSplitParties()
	_, err := ParsePaymentLegs(splitRequirements(p, map[string]interface{}{"splits": "nope"}))
	requireSplitsReason(t, err, ErrSplitsInvalid)
	_, err = ParsePaymentLegs(splitRequirements(p, map[string]interface{}{"ataCreationRequired": "true"}))
	requireSplitsReason(t, err, ErrSplitsInvalid)
}

func TestUsesSplitTerms(t *testing.T) {
	p := newSplitParties()
	assert.True(t, UsesSplitTerms(splitRequirements(p, nil)))
	assert.False(t, UsesSplitTerms(splitRequirements(p, map[string]interface{}{"splits": []interface{}{}})))
	assert.False(t, UsesSplitTerms(splitRequirements(p, map[string]interface{}{"splits": nil})))
	assert.True(t, UsesSplitTerms(splitRequirements(p, map[string]interface{}{"splits": nil, "ataCreationRequired": true})))
	assert.False(t, UsesSplitTerms(splitRequirements(p, map[string]interface{}{"splits": nil, "ataCreationRequired": false})))
	assert.False(t, UsesSplitTerms(types.PaymentRequirements{}))
}

func TestGetSplitCapabilities_FailsClosed(t *testing.T) {
	assert.Equal(t, SplitCapabilities{}, GetSplitCapabilities(nil))
	assert.Equal(t, SplitCapabilities{}, GetSplitCapabilities(map[string]interface{}{"maxSplits": "8", "ataCreationSponsored": "true"}))
	assert.Equal(t, SplitCapabilities{}, GetSplitCapabilities(map[string]interface{}{"maxSplits": 2.5}))
	assert.Equal(t, SplitCapabilities{}, GetSplitCapabilities(map[string]interface{}{"maxSplits": -1}))
	assert.Equal(t, SplitCapabilities{MaxSplits: 3, AtaCreationSponsored: true},
		GetSplitCapabilities(map[string]interface{}{"maxSplits": 3, "ataCreationSponsored": true}))
	assert.Equal(t, SplitCapabilities{MaxSplits: 3}, GetSplitCapabilities(map[string]interface{}{"maxSplits": float64(3)}))
	assert.Equal(t, SplitCapabilities{MaxSplits: 8}, GetSplitCapabilities(map[string]interface{}{"maxSplits": json.Number("20")}))
}

func TestAssertWithinCapabilities(t *testing.T) {
	p := newSplitParties()
	legs, err := ParsePaymentLegs(splitRequirements(p, map[string]interface{}{"ataCreationRequired": true}))
	require.NoError(t, err)

	requireSplitsReason(t, AssertWithinCapabilities(legs, SplitCapabilities{}), ErrSplitCountExceeded)
	requireSplitsReason(t, AssertWithinCapabilities(legs, SplitCapabilities{MaxSplits: 1, AtaCreationSponsored: true}), ErrSplitCountExceeded)
	requireSplitsReason(t, AssertWithinCapabilities(legs, SplitCapabilities{MaxSplits: 2}), ErrSplitAtaCreationNotAuthorized)
	assert.NoError(t, AssertWithinCapabilities(legs, SplitCapabilities{MaxSplits: 2, AtaCreationSponsored: true}))
}

func TestValidateAtaCreation(t *testing.T) {
	feePayer := solana.NewWallet().PublicKey()
	owner := solana.NewWallet().PublicKey()
	mint := solana.MustPublicKeyFromBase58(USDCDevnetAddress)
	ata, err := DeriveATA(owner, mint, solana.TokenProgramID)
	require.NoError(t, err)
	valid := NewCreateIdempotentInstruction(feePayer, ata, owner, mint, solana.TokenProgramID)
	data, err := valid.Data()
	require.NoError(t, err)
	keys := func(ix solana.Instruction) []solana.PublicKey {
		var out []solana.PublicKey
		for _, a := range ix.Accounts() {
			out = append(out, a.PublicKey)
		}
		return out
	}
	newCtx := func() *AtaCreationContext {
		return &AtaCreationContext{
			Asset:         mint,
			FeePayer:      feePayer,
			MarkedOwners:  map[solana.PublicKey]struct{}{owner: {}},
			CreatedOwners: map[solana.PublicKey]struct{}{},
		}
	}

	ctx := newCtx()
	gotOwner, gotProgram, err := ValidateAtaCreation(keys(valid), data, ctx)
	require.NoError(t, err)
	assert.Equal(t, owner, gotOwner)
	assert.Equal(t, solana.TokenProgramID, gotProgram)
	_, _, err = ValidateAtaCreation(keys(valid), data, ctx)
	requireSplitsReason(t, err, ErrSplitAtaCreationNotAuthorized) // duplicate owner

	mutate := func(i int, key solana.PublicKey) []solana.PublicKey {
		k := keys(valid)
		k[i] = key
		return k
	}
	other := solana.NewWallet().PublicKey()
	ata2022, err := DeriveATA(owner, mint, solana.Token2022ProgramID)
	require.NoError(t, err)
	cases := []struct {
		name     string
		accounts []solana.PublicKey
		data     []byte
	}{
		{"non-idempotent Create", keys(valid), []byte{}},
		{"wrong discriminator", keys(valid), []byte{2}},
		{"five accounts", keys(valid)[:5], data},
		{"client-funded", mutate(0, other), data},
		{"wrong ATA", mutate(1, other), data},
		{"unmarked owner", mutate(2, other), data},
		{"other mint", mutate(3, other), data},
		{"wrong system program", mutate(4, other), data},
		{"unknown token program", mutate(5, other), data},
		{"ATA of the other token program", mutate(1, ata2022), data},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ValidateAtaCreation(tc.accounts, tc.data, newCtx())
			requireSplitsReason(t, err, ErrSplitAtaCreationNotAuthorized)
		})
	}

	token2022 := solana.Token2022ProgramID
	ctx = newCtx()
	ctx.TokenProgram = &token2022
	_, _, err = ValidateAtaCreation(keys(valid), data, ctx)
	requireSplitsReason(t, err, ErrSplitAtaCreationNotAuthorized)
}
