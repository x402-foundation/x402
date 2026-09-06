package facilitator

import (
	"crypto/ed25519"
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

// VerifyRequiredSignatures asserts account 0 is the advertised fee payer, then
// verifies Ed25519 signatures for signer indices 1..NumRequiredSignatures-1
// over the marshaled message. Index 0 is skipped: the facilitator fills that
// slot at settle time.
func VerifyRequiredSignatures(tx *solana.Transaction, expectedFeePayer string) error {
	if len(tx.Message.AccountKeys) == 0 || tx.Message.AccountKeys[0].String() != expectedFeePayer {
		return errors.New(ErrFeePayerMismatch)
	}

	messageBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return errors.New(ErrSignatureInvalid)
	}

	numSigners := int(tx.Message.Header.NumRequiredSignatures)
	for i := 1; i < numSigners; i++ {
		if i >= len(tx.Message.AccountKeys) {
			return errors.New(ErrSignatureInvalid)
		}
		if i >= len(tx.Signatures) || tx.Signatures[i].IsZero() {
			return errors.New(ErrSignatureInvalid)
		}
		key := tx.Message.AccountKeys[i]
		if !ed25519.Verify(ed25519.PublicKey(key.Bytes()), messageBytes, tx.Signatures[i][:]) {
			return errors.New(ErrSignatureInvalid)
		}
	}
	return nil
}
