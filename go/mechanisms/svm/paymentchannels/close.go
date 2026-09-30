package paymentchannels

import (
	"encoding/binary"
	"fmt"
	"regexp"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

var requestCloseNonce = regexp.MustCompile(`^[0-9a-fA-F]{32,}$`)

// BuildRequestCloseArgs are the inputs for a payer-signed request_close.
type BuildRequestCloseArgs struct {
	Payer     solana.PublicKey
	FeePayer  solana.PublicKey
	ChannelID solana.PublicKey
	Blockhash solana.Hash
	// Memo, when set, is the Memo instruction data. Nil emits a random hex nonce.
	Memo *string
	// Program overrides the payment-channels program id. The zero key uses ProgramID.
	Program solana.PublicKey
}

// BuildRequestCloseTransaction builds an unsigned request_close transaction.
// The payer signs it and the sponsor co-signs the fee-payer slot before broadcast.
func BuildRequestCloseTransaction(args BuildRequestCloseArgs) (*solana.Transaction, error) {
	program := instructionProgram(args.Program)
	instruction, err := generated.NewRequestCloseInstructionBuilder().
		SetPayerAccount(args.Payer).
		SetChannelAccount(args.ChannelID).
		ValidateAndBuild()
	if err != nil {
		return nil, err
	}
	requestClose, err := withProgram(program, instruction)
	if err != nil {
		return nil, err
	}
	memoData, err := resolveMemoData(args.Memo)
	if err != nil {
		return nil, err
	}
	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(args.Blockhash).
		SetFeePayer(args.FeePayer).
		AddInstruction(requestClose).
		AddInstruction(solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{}, memoData)).
		Build()
	if err != nil {
		return nil, fmt.Errorf("failed to build request_close transaction: %w", err)
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	return tx, nil
}

// VerifyRequestCloseExpected pins a sponsor-bound request_close transaction.
type VerifyRequestCloseExpected struct {
	Payer                       solana.PublicKey
	FeePayer                    solana.PublicKey
	ChannelID                   solana.PublicKey
	Memo                        *string
	Program                     solana.PublicKey
	MaxComputeUnits             *uint32
	MaxPriorityFeeMicroLamports *uint64
}

// VerifyRequestCloseTransaction checks that the sponsor may authorize only the
// fee for one canonical close instruction.
func VerifyRequestCloseTransaction(transactionBase64 string, expected VerifyRequestCloseExpected) error {
	if expected.Payer.Equals(expected.FeePayer) {
		return fmt.Errorf("verifyRequestCloseTransaction: payer must differ from feePayer")
	}
	tx, err := svm.DecodeTransaction(transactionBase64)
	if err != nil {
		return fmt.Errorf("verifyRequestCloseTransaction: %w", err)
	}
	message := &tx.Message
	if len(message.AddressTableLookups) > 0 {
		return fmt.Errorf("verifyRequestCloseTransaction: address lookup tables are not permitted")
	}
	numSigners := int(message.Header.NumRequiredSignatures)
	if numSigners > len(message.AccountKeys) {
		return fmt.Errorf("verifyRequestCloseTransaction: required signers must be payer and feePayer")
	}
	signers := map[solana.PublicKey]struct{}{expected.FeePayer: {}, expected.Payer: {}}
	if numSigners != len(signers) {
		return fmt.Errorf("verifyRequestCloseTransaction: required signers must be payer and feePayer")
	}
	for _, signer := range message.AccountKeys[:numSigners] {
		if _, ok := signers[signer]; !ok {
			return fmt.Errorf("verifyRequestCloseTransaction: required signers must be payer and feePayer")
		}
	}
	if len(message.AccountKeys) == 0 || !message.AccountKeys[0].Equals(expected.FeePayer) {
		return fmt.Errorf("verifyRequestCloseTransaction: transaction fee payer mismatch")
	}
	if err := verifyPayerSignature(tx, expected.Payer); err != nil {
		return fmt.Errorf("verifyRequestCloseTransaction: missing or invalid payer signature")
	}

	program := instructionProgram(expected.Program)
	maxComputeUnits := OpenMaxComputeUnitLimit
	if expected.MaxComputeUnits != nil && *expected.MaxComputeUnits < maxComputeUnits {
		maxComputeUnits = *expected.MaxComputeUnits
	}
	maxPriorityFee := MaxComputeUnitPriceMicroLamports
	if expected.MaxPriorityFeeMicroLamports != nil && *expected.MaxPriorityFeeMicroLamports < maxPriorityFee {
		maxPriorityFee = *expected.MaxPriorityFeeMicroLamports
	}

	seenLimit, seenPrice := false, false
	closeSeen, memoSeen := false, false
	lighthouseCount := 0
	phase := "prefix"
	for _, ix := range message.Instructions {
		invoked, err := programOf(message, ix)
		if err != nil {
			return err
		}
		if phase == "prefix" && invoked.Equals(solana.ComputeBudget) {
			if err := verifyRequestCloseComputeBudget(ix.Data, maxComputeUnits, maxPriorityFee, &seenLimit, &seenPrice); err != nil {
				return err
			}
			if len(ix.Accounts) != 0 {
				return fmt.Errorf("invalid Compute Budget instruction")
			}
			continue
		}
		if !closeSeen && invoked.Equals(program) {
			phase = "close"
			if err := verifyRequestCloseInstruction(message, ix, expected); err != nil {
				return err
			}
			closeSeen = true
			continue
		}
		if !closeSeen {
			return fmt.Errorf("verifyRequestCloseTransaction: unexpected instruction before request_close")
		}
		phase = "suffix"
		switch {
		case invoked.Equals(memoProgramID):
			if memoSeen || len(ix.Accounts) != 0 {
				return fmt.Errorf("verifyRequestCloseTransaction: invalid Memo suffix")
			}
			memoSeen = true
			if len(ix.Data) > svm.MaxMemoBytes {
				return fmt.Errorf("verifyRequestCloseTransaction: memo exceeds the byte limit")
			}
			actual := string(ix.Data)
			if expected.Memo != nil {
				if actual != *expected.Memo {
					return fmt.Errorf("verifyRequestCloseTransaction: memo mismatch")
				}
				continue
			}
			if !requestCloseNonce.MatchString(actual) {
				return fmt.Errorf("verifyRequestCloseTransaction: nonce memo must be hexadecimal")
			}
		case invoked.Equals(lighthouseProgramID):
			lighthouseCount++
			if lighthouseCount > MaxLighthouseInstructions {
				return fmt.Errorf("verifyRequestCloseTransaction: too many Lighthouse instructions")
			}
			if err := rejectRequestCloseFeePayer(message, ix, expected.FeePayer); err != nil {
				return err
			}
		default:
			return fmt.Errorf("verifyRequestCloseTransaction: unsupported suffix instruction")
		}
	}
	if !closeSeen {
		return fmt.Errorf("verifyRequestCloseTransaction: missing request_close")
	}
	return nil
}

func verifyRequestCloseInstruction(message *solana.Message, ix solana.CompiledInstruction, expected VerifyRequestCloseExpected) error {
	if len(ix.Data) != 1 || ix.Data[0] != uint8(generated.RequestCloseDiscriminator) {
		return fmt.Errorf("verifyRequestCloseTransaction: expected request_close discriminator")
	}
	if len(ix.Accounts) != 2 {
		return fmt.Errorf("verifyRequestCloseTransaction: request_close must have two accounts")
	}
	payerIndex := int(ix.Accounts[0])
	channelIndex := int(ix.Accounts[1])
	if payerIndex >= len(message.AccountKeys) || channelIndex >= len(message.AccountKeys) ||
		!message.AccountKeys[payerIndex].Equals(expected.Payer) ||
		!message.AccountKeys[channelIndex].Equals(expected.ChannelID) {
		return fmt.Errorf("verifyRequestCloseTransaction: request_close account binding mismatch")
	}
	if !isSignerIndex(message, payerIndex) || isWritableIndex(message, payerIndex) ||
		!isWritableIndex(message, channelIndex) || isSignerIndex(message, channelIndex) {
		return fmt.Errorf("verifyRequestCloseTransaction: request_close account privileges mismatch")
	}
	return nil
}

func verifyRequestCloseComputeBudget(data []byte, maxComputeUnits uint32, maxPriorityFee uint64, seenLimit, seenPrice *bool) error {
	if len(data) < 1 {
		return fmt.Errorf("invalid Compute Budget instruction")
	}
	switch data[0] {
	case ComputeBudgetSetUnitLimit:
		if *seenLimit || *seenPrice || len(data) != 5 {
			return fmt.Errorf("invalid SetComputeUnitLimit instruction")
		}
		units := binary.LittleEndian.Uint32(data[1:5])
		if units > maxComputeUnits {
			return fmt.Errorf("compute unit limit exceeds sponsor cap")
		}
		*seenLimit = true
	case ComputeBudgetSetUnitPrice:
		if *seenPrice || len(data) != 9 {
			return fmt.Errorf("invalid SetComputeUnitPrice instruction")
		}
		price := binary.LittleEndian.Uint64(data[1:9])
		if price > maxPriorityFee {
			return fmt.Errorf("compute unit price exceeds sponsor cap")
		}
		*seenPrice = true
	default:
		return fmt.Errorf("unsupported Compute Budget instruction")
	}
	return nil
}

func rejectRequestCloseFeePayer(message *solana.Message, ix solana.CompiledInstruction, feePayer solana.PublicKey) error {
	program, err := programOf(message, ix)
	if err != nil {
		return err
	}
	if program.Equals(feePayer) {
		return fmt.Errorf("verifyRequestCloseTransaction: feePayer must not be an invoked program")
	}
	for _, accountIndex := range ix.Accounts {
		if int(accountIndex) >= len(message.AccountKeys) {
			return fmt.Errorf("verifyRequestCloseTransaction: feePayer must not be a suffix account")
		}
		if message.AccountKeys[accountIndex].Equals(feePayer) {
			return fmt.Errorf("verifyRequestCloseTransaction: feePayer must not be a suffix account")
		}
	}
	return nil
}
