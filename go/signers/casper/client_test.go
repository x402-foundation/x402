package casper

import (
	"os"
	"regexp"
	"testing"

	"github.com/make-software/casper-go-sdk/v2/types/keypair"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var addressRegex = regexp.MustCompile(`^(00|01)[0-9a-fA-F]{64}$`)

func newTestSignerKey(t *testing.T) *ClientSigner {
	t.Helper()
	key, err := keypair.GeneratePrivateKey(keypair.ED25519)
	require.NoError(t, err)
	return &ClientSigner{key: key}
}

func TestClientSigner_AccountAddress(t *testing.T) {
	signer := newTestSignerKey(t)
	addr := signer.AccountAddress()
	assert.Regexp(t, addressRegex, addr, "AccountAddress must be (00|01)+64 hex chars")
	assert.Equal(t, "00", addr[:2], "AccountAddress must start with '00'")
}

func TestClientSigner_PublicKey(t *testing.T) {
	signer := newTestSignerKey(t)
	pk := signer.PublicKey()
	// ed25519 public key: "01" + 32 bytes = 66 hex chars
	assert.Len(t, pk, 66, "ed25519 public key hex must be 66 chars")
	assert.Equal(t, "01", pk[:2], "ed25519 key must start with '01'")
}

func TestClientSigner_SignEIP712(t *testing.T) {
	signer := newTestSignerKey(t)

	var digest [32]byte
	copy(digest[:], "test-eip712-digest-for-signing!!")

	sig, err := signer.SignEIP712(digest)
	require.NoError(t, err)
	assert.NotEqual(t, [65]byte{}, sig, "signature must not be zero")

	// Verify the signature with the public key
	pk, err := keypair.NewPublicKey(signer.PublicKey())
	require.NoError(t, err)
	err = pk.VerifySignature(digest[:], sig[:])
	assert.NoError(t, err, "signature must verify against the public key")
}

func TestClientSigner_SignEIP712_DifferentDigestsDifferentSigs(t *testing.T) {
	signer := newTestSignerKey(t)

	var d1, d2 [32]byte
	copy(d1[:], "first-digest-for-signing-test!!!")
	copy(d2[:], "second-digest-for-signing-test!!")

	sig1, err := signer.SignEIP712(d1)
	require.NoError(t, err)
	sig2, err := signer.SignEIP712(d2)
	require.NoError(t, err)

	assert.NotEqual(t, sig1, sig2, "different digests must produce different signatures")
}

func TestNewClientSignerFromKeyFile_ED25519(t *testing.T) {
	key, err := keypair.GeneratePrivateKey(keypair.ED25519)
	require.NoError(t, err)

	pemData, err := key.ToPem()
	require.NoError(t, err)

	tmpFile, err := os.CreateTemp("", "test-key-*.pem")
	require.NoError(t, err)
	defer os.Remove(tmpFile.Name())

	_, err = tmpFile.Write(pemData)
	require.NoError(t, err)
	tmpFile.Close()

	signer, err := NewClientSignerFromKeyFile(tmpFile.Name(), "ed25519")
	require.NoError(t, err)
	require.NotNil(t, signer)

	assert.Regexp(t, addressRegex, signer.AccountAddress())
	assert.NotEmpty(t, signer.PublicKey())
}

func TestNewClientSignerFromKeyFile_UnsupportedAlgo(t *testing.T) {
	_, err := NewClientSignerFromKeyFile("/nonexistent", "rsa")
	assert.ErrorContains(t, err, "unsupported key algorithm")
}

func TestNewClientSignerFromKeyFile_MissingFile(t *testing.T) {
	_, err := NewClientSignerFromKeyFile("/nonexistent/path.pem", "ed25519")
	assert.Error(t, err)
}
