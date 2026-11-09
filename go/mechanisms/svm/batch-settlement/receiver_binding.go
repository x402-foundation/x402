package batchsettlement

import (
	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

// ReceiverBindingMemoPrefix marks the Memo that names a channel's receiver authorizer.
const ReceiverBindingMemoPrefix = "x402:batch-settlement:svm:rcvauth:v1:"

// openChannelAccountIndex is the channel account of the canonical payment-channels open.
const openChannelAccountIndex = 5

// EncodeReceiverBindingMemo returns the Memo text for a receiver authorizer.
func EncodeReceiverBindingMemo(authorizer string) string {
	return ReceiverBindingMemoPrefix + authorizer
}

// ParseReceiverBindingMemo returns the authorizer key when memo is a well-formed binding.
func ParseReceiverBindingMemo(memo string) (string, bool) {
	if len(memo) < len(ReceiverBindingMemoPrefix) || memo[:len(ReceiverBindingMemoPrefix)] != ReceiverBindingMemoPrefix {
		return "", false
	}
	authorizer := memo[len(ReceiverBindingMemoPrefix):]
	if !svm.ValidateSolanaAddress(authorizer) {
		return "", false
	}
	return authorizer, true
}

// ReadReceiverBindingFromOpen returns the authorizer a canonical open bound into channelID.
// Zero binding memos, or more than one, is not a binding. The payer signature covers the memo.
func ReadReceiverBindingFromOpen(wireTx, channelID string) (string, bool) {
	tx, err := svm.DecodeTransaction(wireTx)
	if err != nil {
		return "", false
	}
	message := &tx.Message
	if len(message.AddressTableLookups) > 0 {
		return "", false
	}

	var open *solana.CompiledInstruction
	opens := 0
	for i := range message.Instructions {
		ix := &message.Instructions[i]
		program, err := programKey(message, ix.ProgramIDIndex)
		if err != nil || !program.Equals(paymentchannels.ProgramID) {
			continue
		}
		if len(ix.Data) == 0 || ix.Data[0] != uint8(generated.OpenDiscriminator) {
			continue
		}
		opens++
		open = ix
	}
	if opens != 1 || open == nil {
		return "", false
	}
	if len(open.Accounts) <= openChannelAccountIndex {
		return "", false
	}
	channel, err := accountKey(message, open.Accounts[openChannelAccountIndex])
	if err != nil || channel.String() != channelID {
		return "", false
	}

	var bindings []string
	memoProgram := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	for i := range message.Instructions {
		ix := &message.Instructions[i]
		program, err := programKey(message, ix.ProgramIDIndex)
		if err != nil || !program.Equals(memoProgram) || len(ix.Data) == 0 {
			continue
		}
		if authorizer, ok := ParseReceiverBindingMemo(string(ix.Data)); ok {
			bindings = append(bindings, authorizer)
		}
	}
	if len(bindings) != 1 {
		return "", false
	}
	return bindings[0], true
}

func programKey(message *solana.Message, index uint16) (solana.PublicKey, error) {
	return accountKey(message, index)
}

func accountKey(message *solana.Message, index uint16) (solana.PublicKey, error) {
	if int(index) >= len(message.AccountKeys) {
		return solana.PublicKey{}, errOutOfRange
	}
	return message.AccountKeys[index], nil
}
