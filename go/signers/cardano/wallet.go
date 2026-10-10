package cardano

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	_ "embed"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"filippo.io/edwards25519"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"golang.org/x/crypto/pbkdf2"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// bip39English is the BIP-0039 English wordlist,
// https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt
// (sha256 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda).
//
//go:embed bip39_english.txt
var bip39English string

var bip39Index = func() map[string]int {
	words := strings.Fields(bip39English)
	index := make(map[string]int, len(words))
	for i, w := range words {
		index[w] = i
	}
	return index
}()

const hardened = 0x80000000

// extendedKey is a BIP32-Ed25519 extended private key with its chain code.
type extendedKey struct {
	kL, kR    [32]byte
	chainCode [32]byte
}

// Wallet holds the CIP-1852 payment key and base address of one account.
type Wallet struct {
	payment *extendedKey
	address string
}

// NewWalletFromMnemonic derives the account's base address (payment key
// 1852'/1815'/account'/0/0, stake key .../2/0) from a BIP-39 mnemonic using
// Icarus master-key generation, as Cardano wallets do.
func NewWalletFromMnemonic(mnemonic string, network string, accountIndex uint32) (*Wallet, error) {
	if accountIndex >= hardened {
		return nil, errors.New("account index out of range")
	}
	networkID, err := x402cardano.NetworkID(network)
	if err != nil {
		return nil, err
	}
	entropy, err := mnemonicEntropy(mnemonic)
	if err != nil {
		return nil, err
	}
	root := icarusMasterKey(entropy)
	account := root.derive(1852 | hardened).derive(1815 | hardened).derive(accountIndex | hardened)
	payment := account.derive(0).derive(0)
	stake := account.derive(2).derive(0)
	addr, err := common.NewAddressFromParts(
		common.AddressTypeKeyKey,
		uint8(networkID),
		x402cardano.Blake2b224(payment.publicKey()),
		x402cardano.Blake2b224(stake.publicKey()),
	)
	if err != nil {
		return nil, err
	}
	return &Wallet{payment: payment, address: addr.String()}, nil
}

// Address returns the bech32 base address.
func (w *Wallet) Address() string { return w.address }

// PaymentPublicKey returns the 32-byte payment verification key.
func (w *Wallet) PaymentPublicKey() []byte { return w.payment.publicKey() }

// SignTxBody signs a transaction body hash with the payment key.
func (w *Wallet) SignTxBody(bodyHash []byte) []byte { return w.payment.sign(bodyHash) }

func mnemonicEntropy(mnemonic string) ([]byte, error) {
	words := strings.Fields(strings.ToLower(mnemonic))
	if n := len(words); n < 12 || n > 24 || n%3 != 0 {
		return nil, fmt.Errorf("mnemonic must have 12 to 24 words in multiples of 3, got %d", n)
	}
	bits := new(big.Int)
	for _, w := range words {
		i, ok := bip39Index[w]
		if !ok {
			return nil, errors.New("mnemonic contains a word outside the BIP-39 English list")
		}
		bits.Lsh(bits, 11).Or(bits, big.NewInt(int64(i)))
	}
	totalBits := len(words) * 11
	checksumBits := totalBits / 33
	entropyBytes := (totalBits - checksumBits) / 8
	checksum := new(big.Int).And(bits, big.NewInt(int64(1<<checksumBits-1)))
	entropy := new(big.Int).Rsh(bits, uint(checksumBits)).FillBytes(make([]byte, entropyBytes))
	sum := sha256.Sum256(entropy)
	if uint64(sum[0]>>(8-checksumBits)) != checksum.Uint64() {
		return nil, errors.New("mnemonic checksum is invalid")
	}
	return entropy, nil
}

func icarusMasterKey(entropy []byte) *extendedKey {
	seed := pbkdf2.Key(nil, entropy, 4096, 96, sha512.New)
	key := &extendedKey{}
	copy(key.kL[:], seed[:32])
	copy(key.kR[:], seed[32:64])
	copy(key.chainCode[:], seed[64:])
	key.kL[0] &= 0xf8
	key.kL[31] &= 0x1f
	key.kL[31] |= 0x40
	return key
}

// derive returns the child key at index (hardened when index >= 2^31).
func (k *extendedKey) derive(index uint32) *extendedKey {
	var idx [4]byte
	binary.LittleEndian.PutUint32(idx[:], index)
	zMac := hmac.New(sha512.New, k.chainCode[:])
	cMac := hmac.New(sha512.New, k.chainCode[:])
	if index >= hardened {
		zMac.Write([]byte{0x00})
		zMac.Write(k.kL[:])
		zMac.Write(k.kR[:])
		cMac.Write([]byte{0x01})
		cMac.Write(k.kL[:])
		cMac.Write(k.kR[:])
	} else {
		pub := k.publicKey()
		zMac.Write([]byte{0x02})
		zMac.Write(pub)
		cMac.Write([]byte{0x03})
		cMac.Write(pub)
	}
	zMac.Write(idx[:])
	cMac.Write(idx[:])
	z := zMac.Sum(nil)
	child := &extendedKey{}
	// kL' = 8*zL + kL and kR' = zR + kR (mod 2^256), little-endian.
	var carry uint16
	for i := 0; i < 32; i++ {
		var zl uint16
		if i < 28 {
			zl = uint16(z[i])
		}
		sum := uint16(k.kL[i]) + zl<<3 + carry
		child.kL[i] = byte(sum)
		carry = sum >> 8
	}
	carry = 0
	for i := 0; i < 32; i++ {
		sum := uint16(k.kR[i]) + uint16(z[32+i]) + carry
		child.kR[i] = byte(sum)
		carry = sum >> 8
	}
	copy(child.chainCode[:], cMac.Sum(nil)[32:])
	return child
}

func (k *extendedKey) scalar() *edwards25519.Scalar {
	var wide [64]byte
	copy(wide[:], k.kL[:])
	s, _ := edwards25519.NewScalar().SetUniformBytes(wide[:])
	return s
}

// publicKey returns the 32-byte Ed25519 verification key.
func (k *extendedKey) publicKey() []byte {
	return new(edwards25519.Point).ScalarBaseMult(k.scalar()).Bytes()
}

// sign produces an Ed25519 signature with the extended key; it verifies with
// crypto/ed25519 against PublicKey.
func (k *extendedKey) sign(message []byte) []byte {
	pub := k.publicKey()
	h := sha512.New()
	h.Write(k.kR[:])
	h.Write(message)
	r, _ := edwards25519.NewScalar().SetUniformBytes(h.Sum(nil))
	rPoint := new(edwards25519.Point).ScalarBaseMult(r).Bytes()
	h.Reset()
	h.Write(rPoint)
	h.Write(pub)
	h.Write(message)
	challenge, _ := edwards25519.NewScalar().SetUniformBytes(h.Sum(nil))
	s := edwards25519.NewScalar().MultiplyAdd(challenge, k.scalar(), r)
	return append(rPoint, s.Bytes()...)
}
