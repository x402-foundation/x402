// Package paymentchannels provides Go bindings for the Solana payment-channels
// program used by the SVM upto scheme: PDA derivation, instruction encoding,
// channel account decoding, voucher signing, and the open-transaction
// acceptance policy.
package paymentchannels

import (
	"crypto/ed25519"
	"fmt"

	ag_binary "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

const (
	// ProgramIDBase58 is the canonical payment-channels program id.
	// It is a network/SDK constant and must never be negotiated over the wire.
	ProgramIDBase58 = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX"

	// Instruction discriminators (first data byte) of the ComputeBudget program.
	ComputeBudgetSetUnitLimit uint8 = 2
	ComputeBudgetSetUnitPrice uint8 = 3

	// OpenSlotWindow is the slot freshness / reclaim gate window for channel PDAs.
	// open must land within this many slots of open_slot, and reclaim requires
	// clock.slot > open_slot + OpenSlotWindow.
	OpenSlotWindow uint64 = 1500

	// DefaultGracePeriodSeconds is the default forced-close grace period.
	DefaultGracePeriodSeconds = 900

	// OpenMaxComputeUnitLimit is the spec ceiling for SetComputeUnitLimit on an
	// open transaction.
	OpenMaxComputeUnitLimit uint32 = 400_000

	// OpenDefaultComputeUnitLimit is the default SetComputeUnitLimit for a
	// built open or top-up. Bump-seed search (1,500 CU per rejected candidate)
	// plus the nonce and binding memos can exceed 110,000 CU; 200,000 leaves
	// room for a longer streak. Priority fee is charged on the requested limit.
	// Mints with compute-heavy transfer extensions need an explicit
	// BuildOpenArgs.ComputeUnitLimit override, up to OpenMaxComputeUnitLimit.
	OpenDefaultComputeUnitLimit uint32 = 200_000

	// MaxComputeUnitPriceMicroLamports is the spec ceiling for SetComputeUnitPrice
	// on an open transaction (5 lamports per compute unit).
	MaxComputeUnitPriceMicroLamports uint64 = svm.MaxComputeUnitPriceMicrolamports

	// MaxLighthouseInstructions is the number of Phantom/Solflare Lighthouse
	// assertions allowed in the optional suffix after open.
	MaxLighthouseInstructions = 3

	// MaxOptionalSuffixInstructions is the total optional suffix length after
	// open (3 Lighthouse + 1 Memo). A binding memo adds one more slot.
	MaxOptionalSuffixInstructions = 4

	// OpenAccountCount is the exact number of accounts in a canonical open.
	OpenAccountCount = 14

	// maxTransactionBytes is the Solana packet limit for a serialized transaction.
	maxTransactionBytes = 1232

	// maxTransactionComputeUnits is the Solana per-transaction compute-unit maximum.
	maxTransactionComputeUnits uint32 = 1_400_000
)

var (
	// ProgramID is ProgramIDBase58 in public-key form.
	ProgramID = solana.MustPublicKeyFromBase58(ProgramIDBase58)

	// Ed25519ProgramID is the Ed25519 signature-verification precompile.
	Ed25519ProgramID = solana.MustPublicKeyFromBase58("Ed25519SigVerify111111111111111111111111111")

	// InstructionsSysvar holds the current transaction's instruction list; the
	// program reads the preceding Ed25519 precompile through it.
	InstructionsSysvar = solana.MustPublicKeyFromBase58("Sysvar1nstructions1111111111111111111111111")

	// RentSysvar is the rent sysvar account required by open.
	RentSysvar = solana.MustPublicKeyFromBase58("SysvarRent111111111111111111111111111111111")

	// mainnetTreasuryOwner is the TREASURY_OWNER baked into the mainnet program
	// binary. distribute validates the treasury token account against
	// ATA(TREASURY_OWNER, mint, token_program), so it must match exactly.
	mainnetTreasuryOwner = solana.MustPublicKeyFromBase58("Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP")

	devnetTreasuryOwner = solana.MustPublicKeyFromBase58("4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap")
)

// Split is a distribution recipient share expressed in basis points.
type Split struct {
	Recipient string
	BPS       uint16
}

// ChannelStatusString renders a channel status for logs and errors.
func ChannelStatusString(status generated.ChannelStatus) string {
	switch status {
	case generated.ChannelStatus_Open:
		return "Open"
	case generated.ChannelStatus_Sealed:
		return "Sealed"
	case generated.ChannelStatus_Closing:
		return "Closing"
	case generated.ChannelStatus_Distributed:
		return "Distributed"
	default:
		return fmt.Sprintf("Unknown(%d)", uint8(status))
	}
}

// DecodeChannel decodes a channel account through the generated layout.
// Accounts shorter than the supported layout are rejected rather than
// zero-filled; the byte offsets are only valid for this channel-account version.
func DecodeChannel(data []byte) (*generated.Channel, error) {
	if len(data) < ChannelAccountSize {
		return nil, fmt.Errorf("channel account is %d bytes, expected at least %d", len(data), ChannelAccountSize)
	}
	var decoded generated.Channel
	if err := ag_binary.NewBorshDecoder(data).Decode(&decoded); err != nil {
		return nil, fmt.Errorf("failed to decode channel account: %w", err)
	}
	if decoded.Discriminator != uint8(generated.AccountDiscriminator_Channel) {
		return nil, fmt.Errorf("account discriminator %d is not a payment channel", decoded.Discriminator)
	}
	return &decoded, nil
}

// TreasuryOwner returns the payment-channels treasury owner for the program
// binary deployed on the given CAIP-2 (or legacy v1) network.
func TreasuryOwner(network string) solana.PublicKey {
	if network == svm.SolanaDevnetCAIP2 || network == svm.SolanaDevnetV1 {
		return devnetTreasuryOwner
	}
	return mainnetTreasuryOwner
}

// FindEventAuthorityPDA derives the program's event authority PDA.
func FindEventAuthorityPDA() (solana.PublicKey, error) {
	return findEventAuthorityPDA(ProgramID)
}

func findEventAuthorityPDA(program solana.PublicKey) (solana.PublicKey, error) {
	pda, _, err := solana.FindProgramAddress([][]byte{[]byte("event_authority")}, program)
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

// SettleVoucher is a receiver-authorizer-signed cumulative amount for a channel.
type SettleVoucher struct {
	AuthorizedSigner solana.PublicKey
	SignatureBase58  string
	CumulativeAmount uint64
	ExpiresAt        int64
}

// SettleAndSealBuildArgs are the inputs for an onchain settle_and_seal.
type SettleAndSealBuildArgs struct {
	ChannelID solana.PublicKey
	Payee     solana.PublicKey
	// Program overrides the payment-channels program id. The zero key uses ProgramID.
	Program solana.PublicKey
	// Voucher, when set, prepends an Ed25519 precompile instruction.
	Voucher *SettleVoucher
}

// BuildSettleAndSealInstructions builds settle_and_seal. A voucher prepends
// the Ed25519 precompile at index 0; the settle_and_seal instruction reads it
// through the instructions sysvar. With no voucher the channel is sealed with
// a zero settlement (full refund).
func BuildSettleAndSealInstructions(args SettleAndSealBuildArgs) ([]solana.Instruction, error) {
	program := instructionProgram(args.Program)
	instructions := make([]solana.Instruction, 0, 2)
	hasVoucher := uint8(0)
	if args.Voucher != nil {
		hasVoucher = 1
		signature, err := solana.SignatureFromBase58(args.Voucher.SignatureBase58)
		if err != nil {
			return nil, fmt.Errorf("voucher signature is not valid base58: %w", err)
		}
		message := EncodeVoucherMessage(args.ChannelID, args.Voucher.CumulativeAmount, args.Voucher.ExpiresAt)
		precompile, err := BuildEd25519VerifyInstruction(message, signature[:], args.Voucher.AuthorizedSigner)
		if err != nil {
			return nil, err
		}
		instructions = append(instructions, precompile)
	}
	settle, err := generated.NewSettleAndSealInstructionBuilder().
		SetPayeeAccount(args.Payee).
		SetChannelAccount(args.ChannelID).
		SetInstructionsSysvarAccount(InstructionsSysvar).
		SetSettleAndSealArgs(generated.SettleAndSealArgs{HasVoucher: hasVoucher}).
		ValidateAndBuild()
	if err != nil {
		return nil, err
	}
	instruction, err := withProgram(program, settle)
	if err != nil {
		return nil, err
	}
	return append(instructions, instruction), nil
}

// BuildSealInstruction builds the permissionless seal for a Closing channel
// whose grace period has elapsed.
func BuildSealInstruction(channel solana.PublicKey) solana.Instruction {
	instruction, err := generated.NewSealInstructionBuilder().
		SetChannelAccount(channel).
		ValidateAndBuild()
	if err != nil {
		panic(err)
	}
	return instruction
}

// SettleBuildArgs are the inputs for a watermark-only settle.
type SettleBuildArgs struct {
	ChannelID solana.PublicKey
	Voucher   SettleVoucher
	// Program overrides the payment-channels program id. The zero key uses ProgramID.
	Program solana.PublicKey
}

// BuildSettleInstructions builds the Ed25519 precompile followed by settle.
// settle advances the channel's settled watermark and neither seals the
// channel nor moves tokens. settle is permissionless; the precompile
// signature is the authority.
func BuildSettleInstructions(args SettleBuildArgs) ([]solana.Instruction, error) {
	program := instructionProgram(args.Program)
	signature, err := solana.SignatureFromBase58(args.Voucher.SignatureBase58)
	if err != nil {
		return nil, fmt.Errorf("voucher signature is not valid base58: %w", err)
	}
	message := EncodeVoucherMessage(args.ChannelID, args.Voucher.CumulativeAmount, args.Voucher.ExpiresAt)
	verify, err := BuildEd25519VerifyInstruction(message, signature[:], args.Voucher.AuthorizedSigner)
	if err != nil {
		return nil, err
	}
	settle, err := generated.NewSettleInstructionBuilder().
		SetChannelAccount(args.ChannelID).
		SetInstructionsSysvarAccount(InstructionsSysvar).
		ValidateAndBuild()
	if err != nil {
		return nil, err
	}
	instruction, err := withProgram(program, settle)
	if err != nil {
		return nil, err
	}
	return []solana.Instruction{verify, instruction}, nil
}

// DistributeInstructionArgs are the accounts and splits needed for distribute.
type DistributeInstructionArgs struct {
	Channel      solana.PublicKey
	Payer        solana.PublicKey
	Payee        solana.PublicKey
	RentPayer    solana.PublicKey
	Mint         solana.PublicKey
	TokenProgram solana.PublicKey
	Splits       []Split
	// Network selects the treasury owner baked into the deployed program.
	Network string
	// Program overrides the payment-channels program id. The zero key uses ProgramID.
	Program solana.PublicKey
}

// BuildDistributeInstruction builds distribute with its dynamic tail of one
// writable recipient token account per split.
func BuildDistributeInstruction(args DistributeInstructionArgs) (solana.Instruction, error) {
	program := instructionProgram(args.Program)
	channelTokenAccount, err := FindATA(args.Channel, args.Mint, args.TokenProgram)
	if err != nil {
		return nil, err
	}
	payerTokenAccount, err := FindATA(args.Payer, args.Mint, args.TokenProgram)
	if err != nil {
		return nil, err
	}
	payeeTokenAccount, err := FindATA(args.Payee, args.Mint, args.TokenProgram)
	if err != nil {
		return nil, err
	}
	treasuryTokenAccount, err := FindATA(TreasuryOwner(args.Network), args.Mint, args.TokenProgram)
	if err != nil {
		return nil, err
	}
	eventAuthority, err := findEventAuthorityPDA(program)
	if err != nil {
		return nil, err
	}
	entries, err := distributionEntries(args.Splits)
	if err != nil {
		return nil, err
	}

	builder := generated.NewDistributeInstructionBuilder().
		SetChannelAccount(args.Channel).
		SetPayerAccount(args.Payer).
		SetRentPayerAccount(args.RentPayer).
		SetChannelTokenAccountAccount(channelTokenAccount).
		SetPayerTokenAccountAccount(payerTokenAccount).
		SetPayeeTokenAccountAccount(payeeTokenAccount).
		SetTreasuryTokenAccountAccount(treasuryTokenAccount).
		SetMintAccount(args.Mint).
		SetTokenProgramAccount(args.TokenProgram).
		SetEventAuthorityAccount(eventAuthority).
		SetSelfProgramAccount(program).
		SetDistributeArgs(generated.DistributeArgs{Recipients: entries})
	for _, split := range entries {
		recipientATA, ataErr := FindATA(split.Recipient, args.Mint, args.TokenProgram)
		if ataErr != nil {
			return nil, ataErr
		}
		builder.AccountMetaSlice = append(builder.AccountMetaSlice, solana.Meta(recipientATA).WRITE())
	}
	instruction, err := builder.ValidateAndBuild()
	if err != nil {
		return nil, err
	}
	return withProgram(program, instruction)
}

// BuildReclaimInstruction builds the permissionless rent reclaim for a
// Distributed channel. The program returns lamports only to the recorded
// rent payer, so reclaims are safely batchable.
func BuildReclaimInstruction(channel, rentPayer solana.PublicKey) solana.Instruction {
	instruction, err := generated.NewReclaimInstructionBuilder().
		SetChannelAccount(channel).
		SetRentPayerAccount(rentPayer).
		ValidateAndBuild()
	if err != nil {
		panic(err)
	}
	return instruction
}

// BuildEd25519VerifyInstruction builds the Ed25519 precompile instruction that
// carries a voucher to the program. Layout matches the payment-channels Rust
// helper: a 16-byte offset header, then signer, signature, and message.
func BuildEd25519VerifyInstruction(message, signature []byte, signer solana.PublicKey) (solana.Instruction, error) {
	if len(signer) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("signer must be %d bytes, got %d", ed25519.PublicKeySize, len(signer))
	}
	if len(signature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("voucher signature must be %d bytes, got %d", ed25519.SignatureSize, len(signature))
	}
	if len(message) > 0xffff {
		return nil, fmt.Errorf("voucher message too long: %d bytes", len(message))
	}

	const (
		publicKeyOffset    = 16
		signatureOffset    = publicKeyOffset + ed25519.PublicKeySize
		messageDataOffset  = signatureOffset + ed25519.SignatureSize
		currentInstruction = 0xffff
	)

	data := make([]byte, messageDataOffset+len(message))
	data[0] = 1
	data[1] = 0
	copy(data[2:4], u16LE(signatureOffset))
	copy(data[4:6], u16LE(currentInstruction))
	copy(data[6:8], u16LE(publicKeyOffset))
	copy(data[8:10], u16LE(currentInstruction))
	copy(data[10:12], u16LE(messageDataOffset))
	copy(data[12:14], u16LE(uint16(len(message))))
	copy(data[14:16], u16LE(currentInstruction))
	copy(data[publicKeyOffset:], signer.Bytes())
	copy(data[signatureOffset:], signature)
	copy(data[messageDataOffset:], message)

	return solana.NewInstruction(Ed25519ProgramID, solana.AccountMetaSlice{}, data), nil
}

func instructionProgram(program solana.PublicKey) solana.PublicKey {
	if program.IsZero() {
		return ProgramID
	}
	return program
}

func withProgram(program solana.PublicKey, instruction *generated.Instruction) (solana.Instruction, error) {
	if program.Equals(ProgramID) {
		return instruction, nil
	}
	data, err := instruction.Data()
	if err != nil {
		return nil, err
	}
	return solana.NewInstruction(program, instruction.Accounts(), data), nil
}

func distributionEntries(splits []Split) ([]generated.DistributionEntry, error) {
	entries := make([]generated.DistributionEntry, 0, len(splits))
	for _, split := range splits {
		recipient, err := solana.PublicKeyFromBase58(split.Recipient)
		if err != nil {
			return nil, fmt.Errorf("invalid distribution recipient %s: %w", split.Recipient, err)
		}
		entries = append(entries, generated.DistributionEntry{Recipient: recipient, Bps: split.BPS})
	}
	return entries, nil
}
