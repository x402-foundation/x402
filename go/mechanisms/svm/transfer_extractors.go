package svm

import (
	"errors"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
)

// ErrTransferNotRecognized indicates that an extractor does not understand the
// instruction it was asked to inspect. Callers can try the next registered
// extractor when they receive this error.
var ErrTransferNotRecognized = errors.New("svm transfer not recognized")

// TransferDetails is the canonical token transfer shape expected by the exact
// SVM facilitator, regardless of how a transaction encodes that transfer.
type TransferDetails struct {
	ProgramID   solana.PublicKey
	Source      solana.PublicKey
	Mint        solana.PublicKey
	Destination solana.PublicKey
	Authority   solana.PublicKey
	Amount      uint64
}

// TransferExtractor decodes a canonical transfer description from a compiled
// instruction. Custom extractors can be registered to support wrapped payment
// instructions while keeping the exact scheme verification logic unchanged.
type TransferExtractor func(tx *solana.Transaction, inst solana.CompiledInstruction) (*TransferDetails, error)

// DefaultTransferExtractors returns the stock extractors supported by x402.
func DefaultTransferExtractors() []TransferExtractor {
	return []TransferExtractor{DirectTransferCheckedExtractor}
}

// ExtractTransferDetails tries the provided extractors in order until one
// successfully returns a canonical transfer description.
func ExtractTransferDetails(
	tx *solana.Transaction,
	inst solana.CompiledInstruction,
	extractors ...TransferExtractor,
) (*TransferDetails, error) {
	if tx == nil || tx.Message.Instructions == nil {
		return nil, fmt.Errorf("invalid transaction: nil transaction or instructions")
	}

	if len(extractors) == 0 {
		extractors = DefaultTransferExtractors()
	}

	var lastErr error
	for _, extractor := range extractors {
		if extractor == nil {
			continue
		}

		details, err := extractor(tx, inst)
		if err == nil {
			return details, nil
		}

		if errors.Is(err, ErrTransferNotRecognized) {
			lastErr = err
			continue
		}

		lastErr = err
	}

	if lastErr == nil {
		lastErr = ErrTransferNotRecognized
	}

	return nil, lastErr
}

// FindTransferDetails scans every instruction in the transaction until it finds
// a canonical token transfer using the provided extractor set.
func FindTransferDetails(tx *solana.Transaction, extractors ...TransferExtractor) (*TransferDetails, error) {
	if tx == nil || tx.Message.Instructions == nil {
		return nil, fmt.Errorf("invalid transaction: nil transaction or instructions")
	}

	var lastErr error
	for _, inst := range tx.Message.Instructions {
		details, err := ExtractTransferDetails(tx, inst, extractors...)
		if err == nil {
			return details, nil
		}

		lastErr = err
	}

	if lastErr == nil {
		lastErr = ErrTransferNotRecognized
	}

	return nil, lastErr
}

// DirectTransferCheckedExtractor recognizes the stock top-level SPL
// Token/Token-2022 TransferChecked instruction shape used by x402 exact today.
func DirectTransferCheckedExtractor(
	tx *solana.Transaction,
	inst solana.CompiledInstruction,
) (*TransferDetails, error) {
	if tx == nil || tx.Message.Instructions == nil {
		return nil, fmt.Errorf("invalid transaction: nil transaction or instructions")
	}

	programID := tx.Message.AccountKeys[inst.ProgramIDIndex]
	if programID != solana.TokenProgramID && programID != solana.Token2022ProgramID {
		return nil, ErrTransferNotRecognized
	}

	accounts, err := inst.ResolveInstructionAccounts(&tx.Message)
	if err != nil {
		return nil, ErrTransferNotRecognized
	}

	if len(accounts) < 4 {
		return nil, ErrTransferNotRecognized
	}

	decoded, err := token.DecodeInstruction(accounts, inst.Data)
	if err != nil {
		return nil, ErrTransferNotRecognized
	}

	transferChecked, ok := decoded.Impl.(*token.TransferChecked)
	if !ok {
		return nil, ErrTransferNotRecognized
	}

	amount := uint64(0)
	if transferChecked.Amount != nil {
		amount = *transferChecked.Amount
	}

	return &TransferDetails{
		ProgramID:   programID,
		Source:      accounts[0].PublicKey,
		Mint:        accounts[1].PublicKey,
		Destination: accounts[2].PublicKey,
		Authority:   accounts[3].PublicKey,
		Amount:      amount,
	}, nil
}
