package paymentchannels

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVerifyOpenTransactionAcceptsWalletInstructionLayouts(t *testing.T) {
	tests := []struct {
		name   string
		prefix func(t *testing.T) []solana.Instruction
		suffix func(t *testing.T) []solana.Instruction
	}{
		{
			name: "compute budget prefix and lighthouse suffix",
			prefix: func(t *testing.T) []solana.Instruction {
				return []solana.Instruction{
					computeUnitLimitInstruction(t, OpenMaxComputeUnitLimit),
					computeUnitPriceInstruction(t, MaxComputeUnitPriceMicroLamports),
				}
			},
			suffix: func(*testing.T) []solana.Instruction {
				return []solana.Instruction{lighthouseInstruction()}
			},
		},
		{
			name:   "three lighthouse assertions and a memo",
			prefix: func(*testing.T) []solana.Instruction { return nil },
			suffix: func(*testing.T) []solana.Instruction {
				return []solana.Instruction{
					lighthouseInstruction(), lighthouseInstruction(), lighthouseInstruction(),
					memoInstruction("nonce"),
				}
			},
		},
		{
			name:   "no optional instructions at all",
			prefix: func(*testing.T) []solana.Instruction { return nil },
			suffix: func(*testing.T) []solana.Instruction { return nil },
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newOpenFixture(t)

			result, err := VerifyOpenTransaction(
				fixture.buildSignedOpen(t, test.prefix(t), test.suffix(t)),
				fixture.expected(),
			)

			require.NoError(t, err)
			assert.Equal(t, fixture.deposit, result.Deposit)
			assert.Equal(t, fixture.salt, result.Salt)
		})
	}
}

func TestVerifyOpenTransactionRejectsDisallowedInstructions(t *testing.T) {
	tests := []struct {
		name      string
		prefix    func(t *testing.T, f *openFixture) []solana.Instruction
		suffix    func(t *testing.T, f *openFixture) []solana.Instruction
		wantError string
	}{
		{
			name: "unknown program after open",
			suffix: func(_ *testing.T, f *openFixture) []solana.Instruction {
				return []solana.Instruction{
					solana.NewInstruction(solana.SystemProgramID, solana.AccountMetaSlice{}, []byte{0x00}),
				}
			},
			wantError: "only Lighthouse or Memo are allowed after open",
		},
		{
			// A second open would escrow a second deposit and bill the
			// facilitator for a second channel's rent on one authorization.
			name: "a second payment-channels open",
			suffix: func(t *testing.T, f *openFixture) []solana.Instruction {
				return []solana.Instruction{f.openInstruction(t)}
			},
			wantError: "only Lighthouse or Memo are allowed after open",
		},
		{
			name: "fourth lighthouse assertion",
			suffix: func(_ *testing.T, f *openFixture) []solana.Instruction {
				return []solana.Instruction{
					lighthouseInstruction(), lighthouseInstruction(),
					lighthouseInstruction(), lighthouseInstruction(),
				}
			},
			wantError: "at most 3 Lighthouse instructions",
		},
		{
			name: "five optional suffix instructions",
			suffix: func(_ *testing.T, f *openFixture) []solana.Instruction {
				return []solana.Instruction{
					lighthouseInstruction(), lighthouseInstruction(), lighthouseInstruction(),
					memoInstruction("a"), memoInstruction("b"),
				}
			},
			wantError: "at most 4 optional instructions",
		},
		{
			name: "lighthouse referencing the fee payer",
			suffix: func(_ *testing.T, f *openFixture) []solana.Instruction {
				return []solana.Instruction{
					solana.NewInstruction(lighthouseProgramID, solana.AccountMetaSlice{
						solana.NewAccountMeta(f.feePayer, false, false),
					}, []byte{0x01}),
				}
			},
			wantError: "feePayer must not appear in Lighthouse instruction accounts",
		},
		{
			name: "memo referencing the fee payer",
			suffix: func(_ *testing.T, f *openFixture) []solana.Instruction {
				return []solana.Instruction{
					solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{
						solana.NewAccountMeta(f.feePayer, false, false),
					}, []byte("nonce")),
				}
			},
			wantError: "feePayer must not appear in Memo instruction accounts",
		},
		{
			name: "compute unit price above the spec ceiling",
			prefix: func(t *testing.T, _ *openFixture) []solana.Instruction {
				return []solana.Instruction{
					computeUnitPriceInstruction(t, MaxComputeUnitPriceMicroLamports+1),
				}
			},
			wantError: "SetComputeUnitPrice 5000001 exceeds 5000000",
		},
		{
			name: "compute unit limit above the spec ceiling",
			prefix: func(t *testing.T, _ *openFixture) []solana.Instruction {
				return []solana.Instruction{
					computeUnitLimitInstruction(t, OpenMaxComputeUnitLimit+1),
				}
			},
			wantError: "SetComputeUnitLimit 400001 exceeds 400000",
		},
		{
			name: "compute unit price before compute unit limit",
			prefix: func(t *testing.T, _ *openFixture) []solana.Instruction {
				return []solana.Instruction{
					computeUnitPriceInstruction(t, 1),
					computeUnitLimitInstruction(t, 1000),
				}
			},
			wantError: "SetComputeUnitLimit must precede SetComputeUnitPrice",
		},
		{
			name: "duplicate compute unit limit",
			prefix: func(t *testing.T, _ *openFixture) []solana.Instruction {
				return []solana.Instruction{
					computeUnitLimitInstruction(t, 1000),
					computeUnitLimitInstruction(t, 2000),
				}
			},
			wantError: "duplicate SetComputeUnitLimit",
		},
		{
			name: "unsupported compute budget instruction",
			prefix: func(_ *testing.T, _ *openFixture) []solana.Instruction {
				return []solana.Instruction{
					solana.NewInstruction(solana.ComputeBudget, solana.AccountMetaSlice{}, []byte{0x01, 0x00}),
				}
			},
			wantError: "unsupported ComputeBudget instruction type 1",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newOpenFixture(t)
			var prefix, suffix []solana.Instruction
			if test.prefix != nil {
				prefix = test.prefix(t, fixture)
			}
			if test.suffix != nil {
				suffix = test.suffix(t, fixture)
			}

			_, err := VerifyOpenTransaction(fixture.buildSignedOpen(t, prefix, suffix), fixture.expected())

			require.ErrorContains(t, err, test.wantError)
		})
	}
}

func TestVerifyOpenTransactionEnforcesOperatorCaps(t *testing.T) {
	fixture := newOpenFixture(t)
	transaction := fixture.buildSignedOpen(t, []solana.Instruction{
		computeUnitLimitInstruction(t, 300_000),
		computeUnitPriceInstruction(t, 2_000_000),
	}, nil)

	loweredUnits := uint32(200_000)
	expected := fixture.expected()
	expected.MaxComputeUnits = &loweredUnits
	_, err := VerifyOpenTransaction(transaction, expected)
	require.ErrorContains(t, err, "SetComputeUnitLimit 300000 exceeds 200000")

	loweredFee := uint64(1_000_000)
	expected = fixture.expected()
	expected.MaxPriorityFeeMicroLamports = &loweredFee
	_, err = VerifyOpenTransaction(transaction, expected)
	require.ErrorContains(t, err, "SetComputeUnitPrice 2000000 exceeds 1000000")

	maxSignatures := 1
	expected = fixture.expected()
	expected.MaxRequiredSignatures = &maxSignatures
	_, err = VerifyOpenTransaction(transaction, expected)
	require.ErrorContains(t, err, "required-signer count 2 exceeds maxRequiredSignatures 1")
}

func TestVerifyOpenTransactionEnforcesMemoBinding(t *testing.T) {
	fixture := newOpenFixture(t)
	memo := "order-42"
	expected := fixture.expected()
	expected.Memo = &memo

	_, err := VerifyOpenTransaction(
		fixture.buildSignedOpen(t, nil, []solana.Instruction{memoInstruction("order-42")}),
		expected,
	)
	require.NoError(t, err)

	_, err = VerifyOpenTransaction(
		fixture.buildSignedOpen(t, nil, []solana.Instruction{memoInstruction("order-43")}),
		expected,
	)
	require.ErrorContains(t, err, "Memo instruction data does not match extra.memo")

	_, err = VerifyOpenTransaction(
		fixture.buildSignedOpen(t, nil, []solana.Instruction{memoInstruction("order-42"), memoInstruction("order-42")}),
		expected,
	)
	require.ErrorContains(t, err, "expected exactly one Memo instruction")

	_, err = VerifyOpenTransaction(fixture.buildSignedOpen(t, nil, nil), expected)
	require.ErrorContains(t, err, "expected exactly one Memo instruction")
}

// At this layer an explicit empty Memo is still a demand for an empty memo,
// not an absent requirement. Callers no longer reach it through extra.memo:
// upto.ParseExtraMemo resolves "" to unset before it gets here.
func TestVerifyOpenTransactionBindsAnEmptyMemo(t *testing.T) {
	fixture := newOpenFixture(t)
	empty := ""
	expected := fixture.expected()
	expected.Memo = &empty

	_, err := VerifyOpenTransaction(
		fixture.buildSignedOpen(t, nil, []solana.Instruction{memoInstruction("")}),
		expected,
	)
	require.NoError(t, err)

	_, err = VerifyOpenTransaction(
		fixture.buildSignedOpen(t, nil, []solana.Instruction{memoInstruction("deadbeef")}),
		expected,
	)
	require.ErrorContains(t, err, "Memo instruction data does not match extra.memo")

	// No memo requirement at all still accepts the client's uniqueness nonce.
	expected.Memo = nil
	_, err = VerifyOpenTransaction(
		fixture.buildSignedOpen(t, nil, []solana.Instruction{memoInstruction("deadbeef")}),
		expected,
	)
	require.NoError(t, err)
}

func TestVerifyOpenTransactionEnforcesSlotFreshness(t *testing.T) {
	fixture := newOpenFixture(t)
	transaction := fixture.buildSignedOpen(t, nil, nil)

	fresh := fixture.openSlot + OpenSlotWindow
	expected := fixture.expected()
	expected.RecentSlot = &fresh
	_, err := VerifyOpenTransaction(transaction, expected)
	require.NoError(t, err)

	stale := fixture.openSlot + OpenSlotWindow + 1
	expected = fixture.expected()
	expected.RecentSlot = &stale
	_, err = VerifyOpenTransaction(transaction, expected)
	require.ErrorContains(t, err, "outside the 1500-slot freshness window")

	behind := fixture.openSlot - 1
	expected = fixture.expected()
	expected.RecentSlot = &behind
	_, err = VerifyOpenTransaction(transaction, expected)
	require.ErrorContains(t, err, "is ahead of challenged recentSlot")
}

func TestVerifyOpenTransactionRejectsChallengeMismatches(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(t *testing.T, expected *VerifyOpenExpected)
		wantError string
	}{
		{
			name: "deposit below the ceiling",
			mutate: func(_ *testing.T, expected *VerifyOpenExpected) {
				expected.MaxCap = 10_001
			},
			wantError: "deposit 10000 != maxCap 10001",
		},
		{
			name: "deposit above the ceiling",
			mutate: func(_ *testing.T, expected *VerifyOpenExpected) {
				expected.MaxCap = 9_999
			},
			wantError: "deposit 10000 != maxCap 9999",
		},
		{
			name: "grace period mismatch",
			mutate: func(_ *testing.T, expected *VerifyOpenExpected) {
				expected.WithdrawDelay = 900
			},
			wantError: "gracePeriod 3600 != expected withdrawDelay 900",
		},
		{
			name: "open slot mismatch",
			mutate: func(_ *testing.T, expected *VerifyOpenExpected) {
				expected.OpenSlot = 1
			},
			wantError: "openSlot 341000000 != expected 1",
		},
		{
			name: "payee mismatch",
			mutate: func(t *testing.T, expected *VerifyOpenExpected) {
				expected.Payee = testKeypair(t).PublicKey()
			},
			wantError: "payee",
		},
		{
			name: "mint mismatch",
			mutate: func(t *testing.T, expected *VerifyOpenExpected) {
				expected.Mint = testKeypair(t).PublicKey()
			},
			wantError: "mint",
		},
		{
			name: "authorized signer mismatch",
			mutate: func(t *testing.T, expected *VerifyOpenExpected) {
				expected.AuthorizedSigner = testKeypair(t).PublicKey()
			},
			wantError: "authorizedSigner",
		},
		{
			name: "token program mismatch",
			mutate: func(_ *testing.T, expected *VerifyOpenExpected) {
				expected.TokenProgram = solana.Token2022ProgramID
			},
			wantError: "tokenProgram",
		},
		{
			name: "distribution recipient mismatch",
			mutate: func(t *testing.T, expected *VerifyOpenExpected) {
				expected.Recipients = []Split{
					{Recipient: testKeypair(t).PublicKey().String(), BPS: BasisPointsDenominator},
				}
			},
			wantError: "distribution recipient",
		},
		{
			name: "distribution share mismatch",
			mutate: func(_ *testing.T, expected *VerifyOpenExpected) {
				expected.Recipients[0].BPS = 5_000
			},
			wantError: "distribution bps 10000 != expected 5000",
		},
		{
			name: "extra distribution recipient",
			mutate: func(t *testing.T, expected *VerifyOpenExpected) {
				expected.Recipients = append(expected.Recipients,
					Split{Recipient: testKeypair(t).PublicKey().String(), BPS: 1})
			},
			wantError: "expected 2 distribution recipients, found 1",
		},
		{
			name: "payer mismatch",
			mutate: func(t *testing.T, expected *VerifyOpenExpected) {
				expected.From = testKeypair(t).PublicKey()
			},
			wantError: "unexpected required signer",
		},
		{
			name: "fee payer mismatch",
			mutate: func(t *testing.T, expected *VerifyOpenExpected) {
				expected.FeePayer = testKeypair(t).PublicKey()
			},
			wantError: "unexpected required signer",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newOpenFixture(t)
			expected := fixture.expected()
			test.mutate(t, &expected)

			_, err := VerifyOpenTransaction(fixture.buildSignedOpen(t, nil, nil), expected)

			require.ErrorContains(t, err, test.wantError)
		})
	}
}

func TestVerifyOpenTransactionRejectsUnexpectedWritableAccount(t *testing.T) {
	fixture := newOpenFixture(t)
	intruder := testKeypair(t).PublicKey()

	transaction := fixture.buildSignedOpen(t, nil, []solana.Instruction{
		solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{
			solana.NewAccountMeta(intruder, true, false),
		}, []byte("nonce")),
	})

	_, err := VerifyOpenTransaction(transaction, fixture.expected())
	require.ErrorContains(t, err, "is writable but is not among the open instruction's writable roles")
}

// The open instruction's account list is pinned to the canonical slots, so a
// client cannot append an account the program would treat as a remaining account.
// When the payer sponsors its own open, {from, feePayer} collapses to a single
// required signer and the transaction carries one signature.
func TestVerifyOpenTransactionAcceptsASelfSponsoredOpen(t *testing.T) {
	fixture := newOpenFixture(t)
	payer := fixture.payerKey.PublicKey()

	built, err := BuildOpenTransaction(BuildOpenArgs{
		Payer:            payer,
		Payee:            payer,
		Mint:             fixture.mint,
		AuthorizedSigner: fixture.authorizer,
		FeePayer:         payer,
		TokenProgram:     fixture.tokenProgram,
		Deposit:          fixture.deposit,
		Blockhash:        solana.Hash(testKeypair(t).PublicKey()),
		OpenSlot:         fixture.openSlot,
		GracePeriod:      fixture.graceSeconds,
		Recipients:       []Split{{Recipient: fixture.payTo.String(), BPS: BasisPointsDenominator}},
		Salt:             &fixture.salt,
	})
	require.NoError(t, err)
	signTransaction(t, built.Transaction, fixture.payerKey)
	require.Len(t, built.Transaction.Signatures, 1)

	expected := fixture.expected()
	expected.FeePayer = payer
	expected.Payee = payer

	result, err := VerifyOpenTransaction(encodeTransaction(t, built.Transaction), expected)

	require.NoError(t, err)
	assert.Equal(t, built.ChannelID, result.ChannelID)
}

func TestVerifyOpenTransactionRejectsExtraOpenAccounts(t *testing.T) {
	fixture := newOpenFixture(t)
	open := fixture.openInstruction(t)
	data, err := open.Data()
	require.NoError(t, err)

	padded := append(open.Accounts(), solana.NewAccountMeta(testKeypair(t).PublicKey(), false, false))
	transaction := fixture.buildSignedOpenWith(t, solana.NewInstruction(ProgramID, padded, data))

	_, err = VerifyOpenTransaction(transaction, fixture.expected())

	require.ErrorContains(t, err, "open instruction must have exactly 14 accounts, found 15")
}

// Privileges come from the message header, not the instruction metas, so a
// client that widens the writable partition must still be rejected.
func TestVerifyOpenTransactionRejectsWritableHeaderElevation(t *testing.T) {
	fixture := newOpenFixture(t)

	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(fixture.feePayer).
		AddInstruction(fixture.openInstruction(t)).
		Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)

	// Promote the first read-only account to writable, then sign the tampered
	// message so only the account policy can catch it.
	require.Positive(t, tx.Message.Header.NumReadonlyUnsignedAccounts)
	tx.Message.Header.NumReadonlyUnsignedAccounts--
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	signTransaction(t, tx, fixture.payerKey)

	_, err = VerifyOpenTransaction(encodeTransaction(t, tx), fixture.expected())

	require.ErrorContains(t, err, "is writable but is not among the open instruction's writable roles")
}

func TestVerifyOpenTransactionRejectsMalformedTransactions(t *testing.T) {
	fixture := newOpenFixture(t)

	_, err := VerifyOpenTransaction("not base64!", fixture.expected())
	require.ErrorContains(t, err, "failed to decode base64 transaction")

	_, err = VerifyOpenTransaction("AAAA", fixture.expected())
	require.ErrorContains(t, err, "failed to deserialize transaction")
}

func TestVerifyOpenTransactionRejectsMissingOpenInstruction(t *testing.T) {
	fixture := newOpenFixture(t)

	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(fixture.feePayer).
		AddInstruction(computeUnitLimitInstruction(t, 1000)).
		Build()
	require.NoError(t, err)

	_, err = VerifyOpenTransaction(encodeTransaction(t, tx), fixture.expected())
	require.ErrorContains(t, err, "no payment-channels open instruction found")
}

func TestVerifyOpenTransactionRejectsAddressLookupTables(t *testing.T) {
	fixture := newOpenFixture(t)

	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(fixture.feePayer).
		AddInstruction(fixture.openInstruction(t)).
		Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Message.AddressTableLookups = solana.MessageAddressTableLookupSlice{{
		AccountKey:      testKeypair(t).PublicKey(),
		WritableIndexes: []uint8{0},
	}}

	_, err = VerifyOpenTransaction(encodeTransaction(t, tx), fixture.expected())
	require.ErrorContains(t, err, "address lookup tables are not permitted")
}

func TestVerifyOpenTransactionRejectsForgedPayerSignature(t *testing.T) {
	fixture := newOpenFixture(t)
	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(fixture.feePayer).
		AddInstruction(fixture.openInstruction(t)).
		Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	// Sign with a key that is not the payer, then park it in the payer's slot.
	signTransaction(t, tx, fixture.payerKey)
	index, err := tx.GetAccountIndex(fixture.payerKey.PublicKey())
	require.NoError(t, err)
	tx.Signatures[index][0] ^= 0xff

	_, err = VerifyOpenTransaction(encodeTransaction(t, tx), fixture.expected())
	require.ErrorContains(t, err, "invalid signature for payload.from")
}
