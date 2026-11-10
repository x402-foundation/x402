package paymentchannels

import (
	"encoding/binary"
	"errors"
	"sync/atomic"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func resetChannelPDACacheTestState(t *testing.T) {
	globalChannelPDACache.reset()
	origDeriver := findProgramDerivedAddress
	findProgramDerivedAddress = solana.FindProgramAddress
	t.Cleanup(func() {
		findProgramDerivedAddress = origDeriver
		globalChannelPDACache.reset()
	})
}

func uncachedChannelPDA(
	program, payer, payee, mint, authorizedSigner solana.PublicKey,
	salt, openSlot uint64,
) (solana.PublicKey, error) {
	seeds := channelPDASeeds(payer, payee, mint, authorizedSigner, salt, openSlot)
	pda, _, err := solana.FindProgramAddress(seeds, program)
	return pda, err
}

func freshChannelPDAInputs(t *testing.T) (
	payer, payee, mint, authorizedSigner solana.PublicKey,
	salt, openSlot uint64,
) {
	return testKeypair(t).PublicKey(),
		testKeypair(t).PublicKey(),
		testKeypair(t).PublicKey(),
		testKeypair(t).PublicKey(),
		7,
		341_000_000
}

func TestFindChannelPDACacheMatchesUncachedAndDerivesOnce(t *testing.T) {
	resetChannelPDACacheTestState(t)

	var deriveCalls atomic.Int32
	findProgramDerivedAddress = func(seeds [][]byte, programID solana.PublicKey) (solana.PublicKey, uint8, error) {
		deriveCalls.Add(1)
		return solana.FindProgramAddress(seeds, programID)
	}

	payer, payee, mint, authorizedSigner, salt, openSlot := freshChannelPDAInputs(t)
	expected, err := uncachedChannelPDA(ProgramID, payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)

	got, err := FindChannelPDA(payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)
	assert.Equal(t, expected, got)

	gotAgain, err := FindChannelPDA(payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)
	assert.Equal(t, expected, gotAgain)
	assert.Equal(t, int32(1), deriveCalls.Load())
}

func TestFindChannelPDACacheNeverConfusesSeedSets(t *testing.T) {
	resetChannelPDACacheTestState(t)

	var deriveCalls atomic.Int32
	findProgramDerivedAddress = func(seeds [][]byte, programID solana.PublicKey) (solana.PublicKey, uint8, error) {
		deriveCalls.Add(1)
		return solana.FindProgramAddress(seeds, programID)
	}

	pool := make([]solana.PublicKey, 3)
	for i := range pool {
		pool[i] = testKeypair(t).PublicKey()
	}

	type seedSet struct {
		payer, payee, mint, authorizedSigner solana.PublicKey
		salt, openSlot                       uint64
	}
	var seedSets []seedSet
	for _, payer := range pool {
		for _, payee := range pool {
			for _, mint := range pool {
				for _, authorizedSigner := range pool {
					for _, salt := range []uint64{1, 12} {
						for _, openSlot := range []uint64{3, 23} {
							seedSets = append(seedSets, seedSet{payer, payee, mint, authorizedSigner, salt, openSlot})
						}
					}
				}
			}
		}
	}
	require.Len(t, seedSets, 324)

	expected := make([]solana.PublicKey, len(seedSets))
	for i, seeds := range seedSets {
		pda, err := uncachedChannelPDA(
			ProgramID, seeds.payer, seeds.payee, seeds.mint, seeds.authorizedSigner, seeds.salt, seeds.openSlot,
		)
		require.NoError(t, err)
		expected[i] = pda
	}
	assert.Len(t, dedupePublicKeys(expected), len(expected))

	for i, seeds := range seedSets {
		got, err := FindChannelPDA(
			seeds.payer, seeds.payee, seeds.mint, seeds.authorizedSigner, seeds.salt, seeds.openSlot,
		)
		require.NoError(t, err)
		assert.Equal(t, expected[i], got)
	}
	for i := len(seedSets) - 1; i >= 0; i-- {
		seeds := seedSets[i]
		got, err := FindChannelPDA(
			seeds.payer, seeds.payee, seeds.mint, seeds.authorizedSigner, seeds.salt, seeds.openSlot,
		)
		require.NoError(t, err)
		assert.Equal(t, expected[i], got)
	}
	assert.Equal(t, int32(len(seedSets)), deriveCalls.Load())
}

func dedupePublicKeys(keys []solana.PublicKey) []solana.PublicKey {
	seen := make(map[solana.PublicKey]struct{}, len(keys))
	out := make([]solana.PublicKey, 0, len(keys))
	for _, key := range keys {
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

func TestFindChannelPDACacheSharesDefaultProgramOnly(t *testing.T) {
	resetChannelPDACacheTestState(t)

	var deriveCalls atomic.Int32
	findProgramDerivedAddress = func(seeds [][]byte, programID solana.PublicKey) (solana.PublicKey, uint8, error) {
		deriveCalls.Add(1)
		return solana.FindProgramAddress(seeds, programID)
	}

	payer, payee, mint, authorizedSigner, salt, openSlot := freshChannelPDAInputs(t)
	otherProgram := testKeypair(t).PublicKey()

	byDefault, err := FindChannelPDA(payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)

	byExplicit, err := findChannelPDA(ProgramID, payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)
	assert.Equal(t, byDefault, byExplicit)
	assert.Equal(t, int32(1), deriveCalls.Load())

	underOther, err := findChannelPDA(otherProgram, payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)
	expectedOther, err := uncachedChannelPDA(otherProgram, payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)
	assert.Equal(t, expectedOther, underOther)
	assert.NotEqual(t, byDefault, underOther)
	assert.Equal(t, int32(2), deriveCalls.Load())
}

func TestFindChannelPDACacheDoesNotCacheFailedDerivation(t *testing.T) {
	resetChannelPDACacheTestState(t)

	payer, payee, mint, authorizedSigner, salt, openSlot := freshChannelPDAInputs(t)
	fail := errors.New("derivation failed")

	var calls atomic.Int32
	findProgramDerivedAddress = func(seeds [][]byte, programID solana.PublicKey) (solana.PublicKey, uint8, error) {
		if calls.Add(1) == 1 {
			return solana.PublicKey{}, 0, fail
		}
		return solana.FindProgramAddress(seeds, programID)
	}

	_, err := FindChannelPDA(payer, payee, mint, authorizedSigner, salt, openSlot)
	require.ErrorIs(t, err, fail)

	expected, err := uncachedChannelPDA(ProgramID, payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)

	got, err := FindChannelPDA(payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)
	assert.Equal(t, expected, got)
	assert.Equal(t, int32(2), calls.Load())
}

func TestChannelPDACacheLRUDirect(t *testing.T) {
	cache := newChannelPDACache(3)
	key := func(s string) string { return s }
	pda := func(b byte) solana.PublicKey { return solana.PublicKey{b} }

	cache.store(key("a"), pda(1))
	cache.store(key("b"), pda(2))
	cache.store(key("c"), pda(3))

	_, ok := cache.lookup(key("a"))
	require.True(t, ok)
	cache.store(key("d"), pda(4))

	_, ok = cache.lookup(key("b"))
	assert.False(t, ok, "least recently used entry b should be evicted")
	got, ok := cache.lookup(key("a"))
	require.True(t, ok)
	assert.Equal(t, pda(1), got)
}

func TestFindChannelPDACacheLRUEviction(t *testing.T) {
	resetChannelPDACacheTestState(t)

	var calls atomic.Int32
	findProgramDerivedAddress = func(seeds [][]byte, programID solana.PublicKey) (solana.PublicKey, uint8, error) {
		n := calls.Add(1)
		var pda solana.PublicKey
		binary.LittleEndian.PutUint64(pda[:8], uint64(n))
		return pda, 255, nil
	}

	payer, payee, mint, authorizedSigner, _, openSlot := freshChannelPDAInputs(t)
	at := func(salt uint64) (solana.PublicKey, error) {
		return findChannelPDA(ProgramID, payer, payee, mint, authorizedSigner, salt, openSlot)
	}

	for i := 0; i < maxChannelPDACacheEntries; i++ {
		_, err := at(uint64(i))
		require.NoError(t, err)
	}

	first, err := at(0)
	require.NoError(t, err)
	assert.Equal(t, int32(maxChannelPDACacheEntries), calls.Load())

	stillFirst, err := at(0)
	require.NoError(t, err)
	assert.Equal(t, first, stillFirst)
	assert.Equal(t, int32(maxChannelPDACacheEntries), calls.Load())

	_, err = at(uint64(maxChannelPDACacheEntries))
	require.NoError(t, err)
	assert.Equal(t, int32(maxChannelPDACacheEntries+1), calls.Load())

	stillFirst, err = at(0)
	require.NoError(t, err)
	assert.Equal(t, first, stillFirst)

	evictedAtOne, err := at(1)
	require.NoError(t, err)
	var expectedReDerived solana.PublicKey
	binary.LittleEndian.PutUint64(expectedReDerived[:8], uint64(maxChannelPDACacheEntries+2))
	assert.Equal(t, expectedReDerived, evictedAtOne)
	assert.Equal(t, int32(maxChannelPDACacheEntries+2), calls.Load())
}

func TestChannelPDACacheKeySeparatesSaltAndOpenSlot(t *testing.T) {
	resetChannelPDACacheTestState(t)

	pool := make([]solana.PublicKey, 3)
	for i := range pool {
		pool[i] = testKeypair(t).PublicKey()
	}
	payer, payee, mint, authorizedSigner := pool[0], pool[1], pool[2], pool[0]

	a, err := FindChannelPDA(payer, payee, mint, authorizedSigner, 1, 23)
	require.NoError(t, err)
	b, err := FindChannelPDA(payer, payee, mint, authorizedSigner, 12, 3)
	require.NoError(t, err)
	assert.NotEqual(t, a, b)
}
