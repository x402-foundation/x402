package facilitator

import (
	"context"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// blockInstruction stands in for an arbitrary operator-configured
// preflight/postflight instruction; feePayer, if set, is attached as a readonly
// account (to test isolation).
func blockInstruction(program solana.PublicKey, discriminator []byte, feePayer ...solana.PublicKey) solana.Instruction {
	metas := solana.AccountMetaSlice{}
	for _, acc := range feePayer {
		metas = append(metas, solana.NewAccountMeta(acc, false, false))
	}
	return solana.NewInstruction(program, metas, discriminator)
}

func memoInstruction(data string) solana.Instruction {
	return solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{}, []byte(data))
}

func verifyReason(t *testing.T, scheme *ExactSvmScheme, f exactFixture) string {
	t.Helper()
	_, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	if err == nil {
		return ""
	}
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve))
	return ve.InvalidReason
}

func TestExactSvmScheme_Path1InstructionLayout(t *testing.T) {
	setup, finish := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	long := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	tuple := func(program solana.PublicKey, discriminator ...byte) InstructionTuple {
		return InstructionTuple{{ProgramID: program, Discriminator: discriminator}}
	}
	allowlists := &Config{
		PreflightInstructionAllowlist:  []InstructionTuple{tuple(setup, 0xaa)},
		PostflightInstructionAllowlist: []InstructionTuple{tuple(finish, 0xbb)},
	}
	fixed := func(ixs ...solana.Instruction) func(solana.PublicKey) []solana.Instruction {
		return func(solana.PublicKey) []solana.Instruction { return ixs }
	}
	guards := func(n int) []solana.Instruction {
		out := make([]solana.Instruction, n)
		for i := range out {
			out[i] = lighthouseInstruction()
		}
		return out
	}

	tests := []struct {
		name          string
		before, after func(feePayer solana.PublicKey) []solana.Instruction
		config        *Config
		memo          string
		wantReason    string // empty means valid
	}{
		{name: "guards before transfer (Phantom)", before: fixed(guards(1)...)},
		{name: "guards before and after", before: fixed(guards(2)...), after: fixed(guards(1)...)},
		{name: "many guards, no cap", before: fixed(guards(3)...), after: fixed(guards(5)...)},
		{name: "several memos without extra.memo", after: fixed(memoInstruction("one"), memoInstruction("two"))},
		{
			name: "several memos with extra.memo", memo: "one", wantReason: ErrMemoCount,
			after: fixed(memoInstruction("one"), memoInstruction("two")),
		},
		{name: "memo before transfer", before: fixed(memoInstruction("early")), wantReason: ErrProtocolInstructionOrder},
		{
			name: "preflight and postflight blocks", config: allowlists,
			before: fixed(blockInstruction(setup, []byte{0xaa})), after: fixed(blockInstruction(finish, []byte{0xbb})),
		},
		{
			name: "blocks without an allowlist", wantReason: ErrUnknownInstruction,
			before: fixed(blockInstruction(setup, []byte{0xaa})),
		},
		{
			name: "preflight with wrong discriminator", config: allowlists, wantReason: ErrUnknownInstruction,
			before: fixed(blockInstruction(setup, []byte{0xff})),
		},
		{
			name: "postflight with wrong discriminator", config: allowlists, wantReason: ErrUnknownInstruction,
			after: fixed(blockInstruction(finish, []byte{0xff})),
		},
		{
			name:   "multi-instruction tuple with guard interspersed, long discriminator",
			config: &Config{PreflightInstructionAllowlist: []InstructionTuple{append(tuple(setup, long...), tuple(finish, 0xbb)...)}},
			before: fixed(blockInstruction(setup, long), lighthouseInstruction(), blockInstruction(finish, []byte{0xbb})),
		},
		{
			name: "fee payer in preflight block", config: allowlists, wantReason: ErrPreflightPostflightFeePayerNotIsolated,
			before: func(fp solana.PublicKey) []solana.Instruction {
				return []solana.Instruction{blockInstruction(setup, []byte{0xaa}, fp)}
			},
		},
		{
			name: "fee payer in postflight block", config: allowlists, wantReason: ErrPreflightPostflightFeePayerNotIsolated,
			after: func(fp solana.PublicKey) []solana.Instruction {
				return []solana.Instruction{blockInstruction(finish, []byte{0xbb}, fp)}
			},
		},
		{
			name: "empty tuple fails closed", wantReason: ErrUnknownInstruction,
			config: &Config{PreflightInstructionAllowlist: []InstructionTuple{{}}},
			before: fixed(blockInstruction(setup, []byte{0xaa})),
		},
		{
			name: "empty discriminator fails closed", wantReason: ErrUnknownInstruction,
			config: &Config{PreflightInstructionAllowlist: []InstructionTuple{tuple(setup)}},
			before: fixed(blockInstruction(setup, []byte{0xaa})),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			none := fixed()
			before, after := tt.before, tt.after
			if before == nil {
				before = none
			}
			if after == nil {
				after = none
			}
			f := buildExactFixtureWithInstructionsFn(t, before, after)
			if tt.memo != "" {
				f.requirements.Extra["memo"] = tt.memo
			}
			signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
			scheme := NewExactSvmScheme(signer, tt.config)
			assert.Equal(t, tt.wantReason, verifyReason(t, scheme, f))
		})
	}
}

func TestExactSvmScheme_HasStaticTransferLayoutHonorsAllowlists(t *testing.T) {
	setup := solana.NewWallet().PublicKey()
	f := buildExactFixtureWithInstructions(t, []solana.Instruction{blockInstruction(setup, []byte{0xaa})}, nil)
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}

	configured := NewExactSvmScheme(signer, &Config{
		PreflightInstructionAllowlist: []InstructionTuple{{{ProgramID: setup, Discriminator: []byte{0xaa}}}},
	})
	assert.True(t, configured.hasStaticTransferLayout(f.tx, f.facilitatorAddr))
	assert.False(t, NewExactSvmScheme(signer).hasStaticTransferLayout(f.tx, f.facilitatorAddr))
}
