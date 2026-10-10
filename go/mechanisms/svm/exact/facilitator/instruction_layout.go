package facilitator

import (
	"bytes"
	"errors"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

var (
	memoProgramID       = solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	lighthouseProgramID = solana.MustPublicKeyFromBase58(svm.LighthouseProgramAddress)
)

// InstructionIdentity identifies an instruction by program ID and a non-empty
// discriminator matched as a byte prefix of the instruction data (an empty
// discriminator never matches, so a whole program can't be allowlisted by
// accident).
type InstructionIdentity struct {
	ProgramID     solana.PublicKey
	Discriminator []byte
}

// InstructionTuple is an ordered block of instructions (guards aside) allowed
// before or after the protocol instructions. See Config.PreflightInstructionAllowlist.
type InstructionTuple []InstructionIdentity

// protocolInstructionKind is an instruction's role. The protocol kinds are
// ordered by the relative order they must appear in.
type protocolInstructionKind int

const (
	kindGuard protocolInstructionKind = iota
	kindComputeLimit
	kindComputePrice
	kindTransfer
	kindMemo
	kindUnknown
)

// classifyProtocolInstruction identifies an instruction's role by program ID
// and discriminator, not position. kindGuard (currently only Lighthouse) may
// appear anywhere. Payload validity is checked separately by the verifiers.
func classifyProtocolInstruction(tx *solana.Transaction, inst solana.CompiledInstruction) protocolInstructionKind {
	progID, err := tx.Message.Program(inst.ProgramIDIndex)
	if err != nil {
		return kindUnknown
	}
	switch {
	case progID.Equals(solana.ComputeBudget):
		if len(inst.Data) > 0 {
			switch inst.Data[0] {
			case ixSetComputeUnitLimit:
				return kindComputeLimit
			case ixSetComputeUnitPrice:
				return kindComputePrice
			}
		}
	case isTokenProgram(progID):
		if len(inst.Data) >= 10 && inst.Data[0] == ixTokenTransferChecked {
			return kindTransfer
		}
	case progID.Equals(memoProgramID):
		return kindMemo
	case progID.Equals(lighthouseProgramID):
		return kindGuard
	}
	return kindUnknown
}

type partitionedInstructions struct {
	computeLimitIx, computePriceIx, transferIx solana.CompiledInstruction
	// memoIx is the first Memo; memoCount is the total (only enforced when
	// extra.memo is set).
	memoIx    *solana.CompiledInstruction
	memoCount int
}

// partitionProtocolInstructions finds the protocol instructions (ComputeLimit,
// ComputePrice, TransferChecked, optional Memo(s), in that relative order) by
// identity. Guards may appear anywhere since they only assert/abort. Any other
// program, a duplicate or out-of-order protocol instruction, or a missing
// transfer returns an error whose message is the invalid reason.
func partitionProtocolInstructions(tx *solana.Transaction, instructions []solana.CompiledInstruction) (*partitionedInstructions, error) {
	var found [kindMemo + 1]*solana.CompiledInstruction
	memoCount := 0
	next := kindComputeLimit
	for i := range instructions {
		inst := &instructions[i]
		kind := classifyProtocolInstruction(tx, *inst)
		switch {
		case kind == kindGuard:
			continue
		case kind == kindUnknown:
			return nil, errors.New(ErrUnknownInstruction)
		case kind == kindMemo && found[kindMemo] != nil:
			memoCount++
			continue
		case kind != next:
			return nil, errors.New(ErrProtocolInstructionOrder)
		}
		found[kind] = inst
		next++
		if kind == kindMemo {
			memoCount = 1
		}
	}
	if found[kindTransfer] == nil {
		return nil, errors.New(ErrNoTransferInstruction)
	}
	return &partitionedInstructions{
		computeLimitIx: *found[kindComputeLimit],
		computePriceIx: *found[kindComputePrice],
		transferIx:     *found[kindTransfer],
		memoIx:         found[kindMemo],
		memoCount:      memoCount,
	}, nil
}

// matchTuple matches tuple against the front (or back, if fromEnd) of
// instructions, skipping guards while scanning. It returns the matched
// instructions (guards included, original order) and the rest.
func matchTuple(
	tx *solana.Transaction, instructions []solana.CompiledInstruction, tuple InstructionTuple, fromEnd bool,
) (matched, rest []solana.CompiledInstruction, ok bool) {
	if len(tuple) == 0 {
		return nil, nil, false
	}
	consumed, matchedCount := 0, 0
	for matchedCount < len(tuple) {
		if consumed >= len(instructions) {
			return nil, nil, false
		}
		instIdx, identityIdx := consumed, matchedCount
		if fromEnd {
			instIdx, identityIdx = len(instructions)-1-consumed, len(tuple)-1-matchedCount
		}
		inst := instructions[instIdx]
		if classifyProtocolInstruction(tx, inst) != kindGuard {
			identity := tuple[identityIdx]
			progID, err := tx.Message.Program(inst.ProgramIDIndex)
			if len(identity.Discriminator) == 0 || err != nil || !progID.Equals(identity.ProgramID) ||
				!bytes.HasPrefix(inst.Data, identity.Discriminator) {
				return nil, nil, false
			}
			matchedCount++
		}
		consumed++
	}
	if fromEnd {
		return instructions[len(instructions)-consumed:], instructions[:len(instructions)-consumed], true
	}
	return instructions[:consumed], instructions[consumed:], true
}

// resolveProtocolLayout resolves the Path 1 layout: it strips a matched
// allowlisted preflight block from the front and postflight block from the
// back (each fee-payer-isolation-checked, since it is operator-configured
// arbitrary code), then partitions the rest by identity. Shared by
// verification and the settle-time path re-derivation.
func (f *ExactSvmScheme) resolveProtocolLayout(tx *solana.Transaction, feePayer solana.PublicKey) (*partitionedInstructions, error) {
	instructions := tx.Message.Instructions
	for _, block := range []struct {
		tuples  []InstructionTuple
		fromEnd bool
	}{
		{f.config.PreflightInstructionAllowlist, false},
		{f.config.PostflightInstructionAllowlist, true},
	} {
		for _, tuple := range block.tuples {
			matched, rest, ok := matchTuple(tx, instructions, tuple, block.fromEnd)
			if !ok {
				continue
			}
			if err := assertFeePayerIsolatedFromInstructions(tx, matched, feePayer); err != nil {
				return nil, errors.New(ErrPreflightPostflightFeePayerNotIsolated)
			}
			instructions = rest
			break
		}
	}
	return partitionProtocolInstructions(tx, instructions)
}
