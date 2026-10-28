package masumi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/blinklabs-io/gouroboros/ledger/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// COSE_Key labels (RFC 8152) and the only accepted algorithm parameters.
const (
	keyLabelKty = 1
	keyLabelKid = 2
	keyLabelAlg = 3
	keyLabelOps = 4
	keyLabelCrv = -1
	keyLabelX   = -2
	keyLabelD   = -4

	headerLabelAlg = 1
	headerLabelKid = 4

	ktyOKP       = 1
	algEdDSA     = -8
	crvEd25519   = 6
	ed25519Bytes = 32
)

// SellerAuthorization is a CIP-30 signData result as the wire carries it.
type SellerAuthorization struct {
	// Key is the complete CBOR COSE_Key as lowercase hex.
	Key string
	// Signature is the complete CBOR COSE_Sign1 as lowercase hex.
	Signature string
}

// TermsSigner produces the seller's CIP-8 authorization over termsDigest, as
// CIP-30 signData(sellerAddress, termsDigestHex) does.
type TermsSigner func(ctx context.Context, sellerAddress, termsDigestHex string) (SellerAuthorization, error)

// keyCredentialAddress parses a bech32 address whose payment credential is a
// key hash, returning its raw bytes and that credential.
func keyCredentialAddress(bech32 string) (raw []byte, keyHash []byte, err error) {
	addr, err := parseShelleyAddress(bech32)
	if err != nil {
		return nil, nil, err
	}
	payment, ok := addr.PayloadPayload().(common.AddressPayloadKeyHash)
	if !ok {
		return nil, nil, errors.New("address has no key payment credential")
	}
	raw, err = addr.Bytes()
	return raw, payment.Hash.Bytes(), err
}

// coseKey is a structurally valid Ed25519 COSE_Key.
type coseKey struct {
	publicKey []byte
	kid       []byte
}

// parseCoseKey requires kty OKP, alg EdDSA, crv Ed25519, a 32-byte public key
// and no private material.
func parseCoseKey(keyBytes []byte) (*coseKey, bool) {
	m, err := decodeCBOR(keyBytes)
	if err != nil || m.kind != cborMap {
		return nil, false
	}
	for i, k := range m.keys {
		if k.kind != cborInt && k.kind != cborText {
			return nil, false
		}
		if k.isInt(keyLabelOps) && m.items[i].kind != cborArray {
			return nil, false
		}
	}
	if !m.get(intKey(keyLabelKty)).isInt(ktyOKP) || !m.get(intKey(keyLabelAlg)).isInt(algEdDSA) ||
		!m.get(intKey(keyLabelCrv)).isInt(crvEd25519) || m.get(intKey(keyLabelD)) != nil {
		return nil, false
	}
	x := m.get(intKey(keyLabelX))
	if x == nil || x.kind != cborBytes || len(x.bytes) != ed25519Bytes {
		return nil, false
	}
	key := &coseKey{publicKey: x.bytes}
	if kid := m.get(intKey(keyLabelKid)); kid != nil && kid.kind == cborBytes {
		key.kid = kid.bytes
	}
	return key, true
}

func headerMap(n *cborNode) bool {
	if n.kind != cborMap {
		return false
	}
	for _, k := range n.keys {
		if k.kind != cborInt && k.kind != cborText {
			return false
		}
	}
	return true
}

// coseSign1 is a decoded COSE_Sign1 with its Sig_structure protected bytes
// re-encoded as the TypeScript SDK does before verifying.
type coseSign1 struct {
	protected   *cborNode
	unprotected *cborNode
	payload     []byte
	hasPayload  bool
	signature   []byte
}

func parseCoseSign1(b []byte) (*coseSign1, bool) {
	root, err := decodeCBOR(b)
	if err != nil || root.kind != cborArray || len(root.items) != 4 {
		return nil, false
	}
	protectedBytes, unprotected, payload, signature := root.items[0], root.items[1], root.items[2], root.items[3]
	if protectedBytes.kind != cborBytes {
		return nil, false
	}
	protected, err := decodeCBOR(protectedBytes.bytes)
	if err != nil || !headerMap(protected) || !headerMap(unprotected) {
		return nil, false
	}
	out := &coseSign1{protected: protected, unprotected: unprotected}
	switch payload.kind {
	case cborNull, cborUndefined:
	case cborBytes:
		out.payload, out.hasPayload = payload.bytes, true
	default:
		return nil, false
	}
	if signature.kind != cborBytes || len(signature.bytes) != ed25519.SignatureSize {
		return nil, false
	}
	out.signature = signature.bytes
	return out, true
}

// VerifySellerTermsSignature verifies the seller's CIP-8 authorization over
// termsDigest: a valid Ed25519 COSE_Key without private material; a COSE_Sign1
// with protected alg EdDSA and the raw seller address, unprotected hashed=false,
// an attached payload equal to termsDigest and a valid Sig_structure under an
// empty external AAD; equal kid values when both are present; and
// Blake2b-224(publicKey) equal to the seller's key payment credential. Any
// failure returns false.
func VerifySellerTermsSignature(referenceKeyHex, referenceSignatureHex, sellerAddress, termsDigestHex string) bool {
	keyBytes, err := hex.DecodeString(referenceKeyHex)
	if err != nil {
		return false
	}
	signatureBytes, err := hex.DecodeString(referenceSignatureHex)
	if err != nil {
		return false
	}
	digest, err := hex.DecodeString(termsDigestHex)
	if err != nil {
		return false
	}
	key, ok := parseCoseKey(keyBytes)
	if !ok {
		return false
	}
	sign1, ok := parseCoseSign1(signatureBytes)
	if !ok {
		return false
	}
	hashed := sign1.unprotected.get(textKey("hashed"))
	if hashed == nil || hashed.kind != cborBool || hashed.flag {
		return false
	}
	if kid := sign1.protected.get(intKey(headerLabelKid)); kid != nil && kid.kind == cborBytes && key.kid != nil &&
		!bytes.Equal(kid.bytes, key.kid) {
		return false
	}
	addressBytes, keyHash, err := keyCredentialAddress(sellerAddress)
	if err != nil {
		return false
	}

	if !sign1.hasPayload || !bytes.Equal(sign1.payload, digest) {
		return false
	}
	address := sign1.protected.get(textKey("address"))
	if address == nil || address.kind != cborBytes || !bytes.Equal(address.bytes, addressBytes) {
		return false
	}
	if !sign1.protected.get(intKey(headerLabelAlg)).isInt(algEdDSA) {
		return false
	}
	if !bytes.Equal(cardano.Blake2b224(key.publicKey), keyHash) {
		return false
	}
	protected, err := encodeCBOR(nil, sign1.protected)
	if err != nil {
		return false
	}
	sigStructure := encodeArray(textKey("Signature1"), bytesNode(protected), bytesNode([]byte{}), bytesNode(sign1.payload))
	return ed25519.Verify(key.publicKey, sigStructure, sign1.signature)
}

// NewTermsSigner builds a TermsSigner from an external Ed25519 key: sign must
// return the 64-byte Ed25519 signature of message under publicKey. The
// COSE_Sign1 and COSE_Key are built exactly as CIP-30 signData does.
func NewTermsSigner(publicKey []byte, sign func(message []byte) []byte) TermsSigner {
	return func(_ context.Context, address, termsDigestHex string) (SellerAuthorization, error) {
		digest, err := hex.DecodeString(termsDigestHex)
		if err != nil {
			return SellerAuthorization{}, fmt.Errorf("invalid terms digest: %w", err)
		}
		return signData(publicKey, sign, address, digest)
	}
}

func signData(publicKey []byte, sign func([]byte) []byte, sellerAddress string, payload []byte) (SellerAuthorization, error) {
	if len(publicKey) != ed25519Bytes || sign == nil {
		return SellerAuthorization{}, errors.New("invalid ed25519 signing key")
	}
	addressBytes, _, err := keyCredentialAddress(sellerAddress)
	if err != nil {
		return SellerAuthorization{}, fmt.Errorf("invalid seller address: %w", err)
	}
	protected, _ := encodeCBOR(nil, &cborNode{
		kind:  cborMap,
		keys:  []*cborNode{intKey(headerLabelAlg), textKey("address")},
		items: []*cborNode{intKey(algEdDSA), bytesNode(addressBytes)},
	})
	sigStructure := encodeArray(textKey("Signature1"), bytesNode(protected), bytesNode([]byte{}), bytesNode(payload))
	signature := sign(sigStructure)
	if len(signature) != ed25519.SignatureSize {
		return SellerAuthorization{}, errors.New("signer returned an invalid ed25519 signature")
	}
	unprotected := &cborNode{kind: cborMap, keys: []*cborNode{textKey("hashed")}, items: []*cborNode{{kind: cborBool}}}
	sign1 := encodeArray(bytesNode(protected), unprotected, bytesNode(payload), bytesNode(signature))
	key, _ := encodeCBOR(nil, &cborNode{
		kind:  cborMap,
		keys:  []*cborNode{intKey(keyLabelKty), intKey(keyLabelAlg), intKey(keyLabelCrv), intKey(keyLabelX)},
		items: []*cborNode{intKey(ktyOKP), intKey(algEdDSA), intKey(crvEd25519), bytesNode(publicKey)},
	})
	return SellerAuthorization{Key: hex.EncodeToString(key), Signature: hex.EncodeToString(sign1)}, nil
}
