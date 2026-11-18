package paymentchannels

import (
	"encoding/base64"
	"strings"
	"sync"

	solana "github.com/gagliardetto/solana-go"
)

// maxChannelPDACacheEntries is the maximum channel PDAs kept by findChannelPDA
// (~1.5 MiB when full).
const maxChannelPDACacheEntries = 4096

type programAddressDeriver func(seeds [][]byte, programID solana.PublicKey) (solana.PublicKey, uint8, error)

// findProgramDerivedAddress derives a program address. Tests may replace it to
// count derivations or simulate failures.
var findProgramDerivedAddress programAddressDeriver = solana.FindProgramAddress

var globalChannelPDACache = newChannelPDACache(maxChannelPDACacheEntries)

type channelPDACache struct {
	mu      sync.Mutex
	max     int
	entries map[string]solana.PublicKey
	order   []string
}

func newChannelPDACache(max int) *channelPDACache {
	return &channelPDACache{
		max:     max,
		entries: make(map[string]solana.PublicKey),
	}
}

func (c *channelPDACache) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]solana.PublicKey)
	c.order = nil
}

func channelPDASeeds(
	payer, payee, mint, authorizedSigner solana.PublicKey,
	salt, openSlot uint64,
) [][]byte {
	return [][]byte{
		[]byte("channel"),
		payer.Bytes(),
		payee.Bytes(),
		mint.Bytes(),
		authorizedSigner.Bytes(),
		u64LE(salt),
		u64LE(openSlot),
	}
}

// channelPDACacheKey is keyed on exactly what the derivation hashes: the base58
// program address and the base64 of each seed, none of which can contain ":".
func channelPDACacheKey(program solana.PublicKey, seeds [][]byte) string {
	parts := make([]string, 1+len(seeds))
	parts[0] = program.String()
	for i, seed := range seeds {
		parts[i+1] = base64.StdEncoding.EncodeToString(seed)
	}
	return strings.Join(parts, ":")
}

func (c *channelPDACache) lookup(key string) (solana.PublicKey, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	pda, ok := c.entries[key]
	if !ok {
		return solana.PublicKey{}, false
	}
	c.touch(key)
	return pda, true
}

func (c *channelPDACache) store(key string, pda solana.PublicKey) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, ok := c.entries[key]; ok {
		c.entries[key] = pda
		c.touch(key)
		return
	}
	c.entries[key] = pda
	c.order = append(c.order, key)
	if len(c.order) > c.max {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.entries, oldest)
	}
}

func (c *channelPDACache) touch(key string) {
	for i, existing := range c.order {
		if existing == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	c.order = append(c.order, key)
}
