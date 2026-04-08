package svm

import (
	"encoding/binary"
	"errors"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

// ErrTransferNotRecognized indicates that an extractor does not understand the
// instruction it was asked to inspect.
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

const (
	swigInstructionSignV2             = 11
	swigInstructionSubAccountSignV1   = 9
	tokenTransferCheckedDiscriminator = 12
)

var (
	swigProgramID = solana.MustPublicKeyFromBase58(SwigProgramAddress)
	memoProgramID = solana.MustPublicKeyFromBase58(MemoProgramAddress)
)

type swigCompactInstruction struct {
	ProgramIDIndex uint8
	AccountIndexes []uint8
	Data           []byte
}

// ExtractTransferDetails returns the canonical transfer description for the
// payment instruction accepted by the exact SVM facilitator. The facilitator
// supports the stock top-level SPL TransferChecked instruction plus vetted
// wrapped transfer programs such as SWIG.
func ExtractTransferDetails(
	tx *solana.Transaction,
	inst solana.CompiledInstruction,
) (*TransferDetails, error) {
	if tx == nil || tx.Message.Instructions == nil {
		return nil, fmt.Errorf("invalid transaction: nil transaction or instructions")
	}

	details, err := extractDirectTransferDetails(tx, inst)
	if err == nil {
		return details, nil
	}
	if !errors.Is(err, ErrTransferNotRecognized) {
		return nil, err
	}

	details, err = extractSwigTransferDetails(tx, inst)
	if err == nil {
		return details, nil
	}

	return nil, err
}

// FindTransferDetails scans every instruction in the transaction until it finds
// a canonical token transfer supported by the exact SVM facilitator.
func FindTransferDetails(tx *solana.Transaction) (*TransferDetails, error) {
	if tx == nil || tx.Message.Instructions == nil {
		return nil, fmt.Errorf("invalid transaction: nil transaction or instructions")
	}

	var lastErr error
	for _, inst := range tx.Message.Instructions {
		details, err := ExtractTransferDetails(tx, inst)
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

func extractDirectTransferDetails(
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

	if len(inst.Accounts) < 4 || len(inst.Data) < 10 || inst.Data[0] != tokenTransferCheckedDiscriminator {
		return nil, ErrTransferNotRecognized
	}

	if int(inst.Accounts[3]) >= len(tx.Message.AccountKeys) {
		return nil, ErrTransferNotRecognized
	}

	return &TransferDetails{
		ProgramID:   programID,
		Source:      tx.Message.AccountKeys[inst.Accounts[0]],
		Mint:        tx.Message.AccountKeys[inst.Accounts[1]],
		Destination: tx.Message.AccountKeys[inst.Accounts[2]],
		Authority:   tx.Message.AccountKeys[inst.Accounts[3]],
		Amount:      binary.LittleEndian.Uint64(inst.Data[1:9]),
	}, nil
}

func extractSwigTransferDetails(
	tx *solana.Transaction,
	inst solana.CompiledInstruction,
) (*TransferDetails, error) {
	programID := tx.Message.AccountKeys[inst.ProgramIDIndex]
	if !programID.Equals(swigProgramID) {
		return nil, ErrTransferNotRecognized
	}

	outerAccounts, err := inst.ResolveInstructionAccounts(&tx.Message)
	if err != nil {
		return nil, ErrTransferNotRecognized
	}

	compactInstructions, err := decodeSwigCompactInstructions(inst.Data)
	if err != nil {
		return nil, ErrTransferNotRecognized
	}

	var transfer *TransferDetails
	for _, compactInstruction := range compactInstructions {
		if int(compactInstruction.ProgramIDIndex) >= len(outerAccounts) {
			return nil, ErrTransferNotRecognized
		}

		innerProgramID := outerAccounts[compactInstruction.ProgramIDIndex].PublicKey
		switch {
		case innerProgramID.Equals(solana.TokenProgramID) || innerProgramID.Equals(solana.Token2022ProgramID):
			if transfer != nil {
				return nil, ErrTransferNotRecognized
			}
			details, err := decodeTransferDetailsFromIndexes(
				outerAccounts,
				innerProgramID,
				compactInstruction.AccountIndexes,
				compactInstruction.Data,
			)
			if err != nil {
				return nil, err
			}
			transfer = details
		case innerProgramID.Equals(memoProgramID):
			continue
		default:
			return nil, ErrTransferNotRecognized
		}
	}

	if transfer == nil {
		return nil, ErrTransferNotRecognized
	}

	return transfer, nil
}

func decodeSwigCompactInstructions(data []byte) ([]swigCompactInstruction, error) {
	if len(data) < 4 {
		return nil, ErrTransferNotRecognized
	}

	discriminator := binary.LittleEndian.Uint16(data[:2])
	var compactOffset int
	switch discriminator {
	case swigInstructionSignV2:
		compactOffset = 8
	case swigInstructionSubAccountSignV1:
		compactOffset = 16
	default:
		return nil, ErrTransferNotRecognized
	}

	compactLen := int(binary.LittleEndian.Uint16(data[2:4]))
	if compactLen <= 0 || len(data) < compactOffset+compactLen {
		return nil, ErrTransferNotRecognized
	}

	compactData := data[compactOffset : compactOffset+compactLen]
	if len(compactData) == 0 {
		return nil, ErrTransferNotRecognized
	}

	instructionCount := int(compactData[0])
	offset := 1
	instructions := make([]swigCompactInstruction, 0, instructionCount)
	for i := 0; i < instructionCount; i++ {
		if len(compactData[offset:]) < 4 {
			return nil, ErrTransferNotRecognized
		}

		programIDIndex := compactData[offset]
		offset++
		accountCount := int(compactData[offset])
		offset++
		if len(compactData[offset:]) < accountCount+2 {
			return nil, ErrTransferNotRecognized
		}

		accountIndexes := append([]uint8(nil), compactData[offset:offset+accountCount]...)
		offset += accountCount
		dataLen := int(binary.LittleEndian.Uint16(compactData[offset : offset+2]))
		offset += 2
		if len(compactData[offset:]) < dataLen {
			return nil, ErrTransferNotRecognized
		}

		instructionData := append([]byte(nil), compactData[offset:offset+dataLen]...)
		offset += dataLen

		instructions = append(instructions, swigCompactInstruction{
			ProgramIDIndex: programIDIndex,
			AccountIndexes: accountIndexes,
			Data:           instructionData,
		})
	}

	if offset != len(compactData) {
		return nil, ErrTransferNotRecognized
	}

	return instructions, nil
}

func decodeTransferDetailsFromIndexes(
	accounts solana.AccountMetaSlice,
	programID solana.PublicKey,
	accountIndexes []uint8,
	data []byte,
) (*TransferDetails, error) {
	if len(accountIndexes) < 4 || len(data) < 10 || data[0] != tokenTransferCheckedDiscriminator {
		return nil, ErrTransferNotRecognized
	}

	for _, index := range accountIndexes[:4] {
		if int(index) >= len(accounts) {
			return nil, ErrTransferNotRecognized
		}
	}

	return &TransferDetails{
		ProgramID:   programID,
		Source:      accounts[accountIndexes[0]].PublicKey,
		Mint:        accounts[accountIndexes[1]].PublicKey,
		Destination: accounts[accountIndexes[2]].PublicKey,
		Authority:   accounts[accountIndexes[3]].PublicKey,
		Amount:      binary.LittleEndian.Uint64(data[1:9]),
	}, nil
}
