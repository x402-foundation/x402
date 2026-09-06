// Package paymentchannels provides Go bindings for the Solana payment-channels
// program (https://github.com/solana-foundation/payment-channels) used by the
// SVM `upto` scheme: PDA derivation, instruction encoding, channel account
// decoding, voucher signing, and the open-transaction acceptance policy.
package paymentchannels

import (
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

const (
	// ProgramIDBase58 is the canonical payment-channels program id.
	// It is a network/SDK constant and must never be negotiated over the wire.
	ProgramIDBase58 = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX"

	// Instruction discriminators (first data byte) of the payment-channels program.
	OpenDiscriminator          uint8 = 1
	SettleAndSealDiscriminator uint8 = 4
	DistributeDiscriminator    uint8 = 7
	ReclaimDiscriminator       uint8 = 9

	// Instruction discriminators (first data byte) of the ComputeBudget program.
	ComputeBudgetSetUnitLimit uint8 = 2
	ComputeBudgetSetUnitPrice uint8 = 3

	// OpenSlotWindow is the slot freshness / reclaim gate window for channel PDAs.
	// `open` must land within this many slots of `open_slot`, and `reclaim`
	// requires clock.slot > open_slot + OpenSlotWindow.
	OpenSlotWindow uint64 = 1500

	// DefaultGracePeriodSeconds is the default forced-close grace period.
	DefaultGracePeriodSeconds = 900

	// OpenMaxComputeUnitLimit is the spec ceiling for SetComputeUnitLimit on an
	// open transaction.
	OpenMaxComputeUnitLimit uint32 = 400_000

	// OpenDefaultComputeUnitLimit is the default SetComputeUnitLimit for a
	// built open transaction. Without one the runtime reserves 200,000 CU per
	// instruction (SIMD-0170) — 400,000 for the open + memo pair — while an
	// observed open consumes ~51,000 CU. The default keeps ~1.8x headroom over
	// that, and any SetComputeUnitPrice priority fee is charged on the
	// requested limit, so right-sizing buys the same scheduling priority at a
	// fraction of the fee. Assumes standard SPL Token (or Token-2022 without
	// execution extensions) behavior — mints whose escrow transfer runs
	// compute-heavy extensions (e.g. transfer hooks) need an explicit
	// BuildOpenArgs.ComputeUnitLimit override, up to OpenMaxComputeUnitLimit.
	OpenDefaultComputeUnitLimit uint32 = 90_000

	// MaxComputeUnitPriceMicroLamports is the spec ceiling for SetComputeUnitPrice
	// on an open transaction (5 lamports per compute unit).
	MaxComputeUnitPriceMicroLamports uint64 = svm.MaxComputeUnitPriceMicrolamports

	// MaxLighthouseInstructions is the number of Phantom/Solflare Lighthouse
	// assertions allowed in the optional suffix after `open`.
	MaxLighthouseInstructions = 3

	// MaxOptionalSuffixInstructions is the total optional suffix length after
	// `open` (3 Lighthouse + 1 Memo).
	MaxOptionalSuffixInstructions = 4

	// OpenAccountCount is the exact number of accounts in a canonical `open`.
	OpenAccountCount = 14

	// BasisPointsDenominator is the full distribution share in basis points.
	BasisPointsDenominator uint16 = 10_000
)

var (
	// ProgramID is ProgramIDBase58 in public-key form.
	ProgramID = solana.MustPublicKeyFromBase58(ProgramIDBase58)

	// Ed25519ProgramID is the Ed25519 signature-verification precompile.
	Ed25519ProgramID = solana.MustPublicKeyFromBase58("Ed25519SigVerify111111111111111111111111111")

	// InstructionsSysvar holds the current transaction's instruction list; the
	// program reads the preceding Ed25519 precompile through it.
	InstructionsSysvar = solana.MustPublicKeyFromBase58("Sysvar1nstructions1111111111111111111111111")

	// RentSysvar is the rent sysvar account required by `open`.
	RentSysvar = solana.MustPublicKeyFromBase58("SysvarRent111111111111111111111111111111111")

	// mainnetTreasuryOwner is the TREASURY_OWNER baked into the mainnet program
	// binary. `distribute` validates the treasury token account against
	// ATA(TREASURY_OWNER, mint, token_program), so it must match exactly.
	mainnetTreasuryOwner = solana.MustPublicKeyFromBase58("Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP")

	devnetTreasuryOwner = solana.MustPublicKeyFromBase58("4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap")
)

// Split is a distribution recipient share expressed in basis points.
type Split struct {
	Recipient string
	BPS       uint16
}

// ChannelStatus mirrors the onchain Channel.status values.
type ChannelStatus uint8

// Onchain channel lifecycle states.
const (
	StatusOpen        ChannelStatus = 0
	StatusClosing     ChannelStatus = 1
	StatusSealed      ChannelStatus = 2
	StatusDistributed ChannelStatus = 3
)

// String renders the channel status for logs and errors.
func (s ChannelStatus) String() string {
	switch s {
	case StatusOpen:
		return "Open"
	case StatusClosing:
		return "Closing"
	case StatusSealed:
		return "Sealed"
	case StatusDistributed:
		return "Distributed"
	default:
		return fmt.Sprintf("Unknown(%d)", uint8(s))
	}
}

// TreasuryOwner returns the payment-channels treasury owner for the program
// binary deployed on the given CAIP-2 (or legacy v1) network.
func TreasuryOwner(network string) solana.PublicKey {
	if network == svm.SolanaDevnetCAIP2 || network == svm.SolanaDevnetV1 {
		return devnetTreasuryOwner
	}
	return mainnetTreasuryOwner
}

// FindChannelPDA derives the channel program-derived address for the given
// open parameters. Seeds are "channel", payer, payee, mint, authorizedSigner,
// u64le(salt), u64le(openSlot).
func FindChannelPDA(
	payer, payee, mint, authorizedSigner solana.PublicKey,
	salt, openSlot uint64,
) (solana.PublicKey, error) {
	seeds := [][]byte{
		[]byte("channel"),
		payer.Bytes(),
		payee.Bytes(),
		mint.Bytes(),
		authorizedSigner.Bytes(),
		u64LE(salt),
		u64LE(openSlot),
	}
	pda, _, err := solana.FindProgramAddress(seeds, ProgramID)
	if err != nil {
		return solana.PublicKey{}, fmt.Errorf("failed to derive channel PDA: %w", err)
	}
	return pda, nil
}

// FindEventAuthorityPDA derives the program's event authority PDA.
func FindEventAuthorityPDA() (solana.PublicKey, error) {
	pda, _, err := solana.FindProgramAddress([][]byte{[]byte("event_authority")}, ProgramID)
	if err != nil {
		return solana.PublicKey{}, fmt.Errorf("failed to derive event authority PDA: %w", err)
	}
	return pda, nil
}

// FindATA derives an associated token account for the given token program.
// solana-go's FindAssociatedTokenAddress hardcodes the legacy token program in
// the seeds, which yields the wrong address for Token-2022 mints.
func FindATA(owner, mint, tokenProgram solana.PublicKey) (solana.PublicKey, error) {
	ata, _, err := solana.FindProgramAddress(
		[][]byte{owner.Bytes(), tokenProgram.Bytes(), mint.Bytes()},
		solana.SPLAssociatedTokenAccountProgramID,
	)
	if err != nil {
		return solana.PublicKey{}, fmt.Errorf("failed to derive associated token account: %w", err)
	}
	return ata, nil
}
