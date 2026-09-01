package paymentchannels

import (
	"crypto/ed25519"
	"encoding/hex"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestVoucherMessageLayout(t *testing.T) {
	channel := testKeypair(t).PublicKey()

	message := EncodeVoucherMessage(channel, 1858, 1893456000)

	require.Len(t, message, VoucherMessageSize)
	assert.Equal(t, []byte{0x56, 0x01}, message[0:2])
	assert.Equal(t, channel.Bytes(), message[2:34])
	assert.Equal(t, u64LE(1858), message[34:42])
	assert.Equal(t, i64LE(1893456000), message[42:50])
}

// The Rust program and the TypeScript SDK sign these exact bytes, so a Go-only
// change to the layout has to fail here rather than onchain.
func TestVoucherMessageMatchesTheCrossLanguageGolden(t *testing.T) {
	channel := solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress)

	message := EncodeVoucherMessage(channel, 1_000_000, 4_102_444_800)

	assert.Equal(t,
		"5601c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6140420f0000000000005786f400000000",
		hex.EncodeToString(message),
	)
}

func TestVerifyVoucherSignature(t *testing.T) {
	authorizer := testKeypair(t)
	channel := testKeypair(t).PublicKey()
	message := EncodeVoucherMessage(channel, 1858, 1893456000)
	signature, err := authorizer.Sign(message)
	require.NoError(t, err)

	require.NoError(t, VerifyVoucherSignature(signature.String(), authorizer.PublicKey().String(), message))

	otherAuthorizer := testKeypair(t).PublicKey()
	require.ErrorContains(t,
		VerifyVoucherSignature(signature.String(), otherAuthorizer.String(), message),
		"not signed by",
	)
}

func TestVerifyVoucherSignatureRejectsMalformedInputs(t *testing.T) {
	authorizer := testKeypair(t)
	message := EncodeVoucherMessage(testKeypair(t).PublicKey(), 1858, 1893456000)
	signature, err := authorizer.Sign(message)
	require.NoError(t, err)

	tests := []struct {
		name      string
		signature string
		signer    string
		wantError string
	}{
		{
			name:      "signature is not base58",
			signature: "not-a-signature!!",
			signer:    authorizer.PublicKey().String(),
			wantError: "not valid base58",
		},
		{
			name:      "signature is the wrong length",
			signature: authorizer.PublicKey().String(),
			signer:    authorizer.PublicKey().String(),
			wantError: "not valid base58",
		},
		{
			name:      "signature is all zeros",
			signature: solana.Signature{}.String(),
			signer:    authorizer.PublicKey().String(),
			wantError: "not signed by",
		},
		{
			name:      "signer is not base58",
			signature: signature.String(),
			signer:    "not-an-address!!",
			wantError: "not a valid base58 address",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			require.ErrorContains(t,
				VerifyVoucherSignature(test.signature, test.signer, message),
				test.wantError,
			)
		})
	}
}

func TestBuildEd25519VerifyInstructionRejectsAWrongLengthSignature(t *testing.T) {
	authorizer := testKeypair(t)
	message := EncodeVoucherMessage(testKeypair(t).PublicKey(), 1, 2)

	_, err := BuildEd25519VerifyInstruction(message, make([]byte, 63), authorizer.PublicKey())

	require.ErrorContains(t, err, "voucher signature must be 64 bytes")
}

func TestBuildEd25519VerifyInstructionLayout(t *testing.T) {
	authorizer := testKeypair(t)
	channel := testKeypair(t).PublicKey()
	message := EncodeVoucherMessage(channel, 1, 2)
	signature, err := authorizer.Sign(message)
	require.NoError(t, err)

	ix, err := BuildEd25519VerifyInstruction(message, signature[:], authorizer.PublicKey())
	require.NoError(t, err)

	data, err := ix.Data()
	require.NoError(t, err)
	assert.Equal(t, Ed25519ProgramID, ix.ProgramID())
	assert.Empty(t, ix.Accounts())
	require.Len(t, data, 112+VoucherMessageSize)
	assert.Equal(t, byte(1), data[0])
	assert.Equal(t, u16LE(48), data[2:4])
	assert.Equal(t, u16LE(16), data[6:8])
	assert.Equal(t, u16LE(112), data[10:12])
	assert.Equal(t, u16LE(VoucherMessageSize), data[12:14])
	assert.Equal(t, authorizer.PublicKey().Bytes(), data[16:48])
	assert.Equal(t, signature[:], data[48:112])
	assert.Equal(t, message, data[112:])
	assert.True(t, ed25519.Verify(ed25519.PublicKey(data[16:48]), data[112:], data[48:112]))
}
