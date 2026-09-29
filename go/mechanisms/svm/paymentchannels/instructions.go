package paymentchannels

import (
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

// OpenInstructionArgs are the accounts and data needed to build `open`.
type OpenInstructionArgs struct {
	Payer            solana.PublicKey
	RentPayer        solana.PublicKey
	Payee            solana.PublicKey
	Mint             solana.PublicKey
	AuthorizedSigner solana.PublicKey
	TokenProgram     solana.PublicKey
	Args             OpenArgs
}

// BuildOpenInstruction builds the canonical 14-account `open` instruction.
// The channel PDA and both token accounts are derived from the other fields,
// so the caller cannot bind a channel to accounts it did not derive.
func BuildOpenInstruction(args OpenInstructionArgs) (solana.Instruction, solana.PublicKey, error) {
	channel, err := FindChannelPDA(
		args.Payer, args.Payee, args.Mint, args.AuthorizedSigner,
		args.Args.Salt, args.Args.OpenSlot,
	)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	payerTokenAccount, err := FindATA(args.Payer, args.Mint, args.TokenProgram)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	channelTokenAccount, err := FindATA(channel, args.Mint, args.TokenProgram)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	eventAuthority, err := FindEventAuthorityPDA()
	if err != nil {
		return nil, solana.PublicKey{}, err
	}

	encodedArgs, err := EncodeOpenArgs(args.Args)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	data := append([]byte{OpenDiscriminator}, encodedArgs...)

	accounts := solana.AccountMetaSlice{
		solana.NewAccountMeta(args.Payer, true, true),
		solana.NewAccountMeta(args.RentPayer, true, true),
		solana.NewAccountMeta(args.Payee, false, false),
		solana.NewAccountMeta(args.Mint, false, false),
		solana.NewAccountMeta(args.AuthorizedSigner, false, false),
		solana.NewAccountMeta(channel, true, false),
		solana.NewAccountMeta(payerTokenAccount, true, false),
		solana.NewAccountMeta(channelTokenAccount, true, false),
		solana.NewAccountMeta(args.TokenProgram, false, false),
		solana.NewAccountMeta(solana.SystemProgramID, false, false),
		solana.NewAccountMeta(RentSysvar, false, false),
		solana.NewAccountMeta(solana.SPLAssociatedTokenAccountProgramID, false, false),
		solana.NewAccountMeta(eventAuthority, false, false),
		solana.NewAccountMeta(ProgramID, false, false),
	}

	return solana.NewInstruction(ProgramID, accounts, data), channel, nil
}

// BuildSettleAndSealInstruction builds the payee-signed cooperative close.
// When hasVoucher is true, an Ed25519 precompile instruction carrying the
// voucher must immediately precede it in the transaction.
func BuildSettleAndSealInstruction(
	channel, payee solana.PublicKey,
	hasVoucher bool,
) solana.Instruction {
	flag := byte(0)
	if hasVoucher {
		flag = 1
	}
	accounts := solana.AccountMetaSlice{
		solana.NewAccountMeta(payee, false, true),
		solana.NewAccountMeta(channel, true, false),
		solana.NewAccountMeta(InstructionsSysvar, false, false),
	}
	return solana.NewInstruction(ProgramID, accounts, []byte{SettleAndSealDiscriminator, flag})
}

// DistributeInstructionArgs are the accounts and splits needed for `distribute`.
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
}

// BuildDistributeInstruction builds `distribute` with its dynamic tail of one
// writable recipient token account per split.
func BuildDistributeInstruction(args DistributeInstructionArgs) (solana.Instruction, error) {
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
	eventAuthority, err := FindEventAuthorityPDA()
	if err != nil {
		return nil, err
	}

	accounts := solana.AccountMetaSlice{
		solana.NewAccountMeta(args.Channel, true, false),
		solana.NewAccountMeta(args.Payer, true, false),
		solana.NewAccountMeta(args.RentPayer, true, false),
		solana.NewAccountMeta(channelTokenAccount, true, false),
		solana.NewAccountMeta(payerTokenAccount, true, false),
		solana.NewAccountMeta(payeeTokenAccount, true, false),
		solana.NewAccountMeta(treasuryTokenAccount, true, false),
		solana.NewAccountMeta(args.Mint, false, false),
		solana.NewAccountMeta(args.TokenProgram, false, false),
		solana.NewAccountMeta(eventAuthority, false, false),
		solana.NewAccountMeta(ProgramID, false, false),
	}
	for _, split := range args.Splits {
		recipient, err := solana.PublicKeyFromBase58(split.Recipient)
		if err != nil {
			return nil, fmt.Errorf("invalid distribution recipient %s: %w", split.Recipient, err)
		}
		recipientATA, err := FindATA(recipient, args.Mint, args.TokenProgram)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, solana.NewAccountMeta(recipientATA, true, false))
	}

	entries, err := encodeDistributionEntries(args.Splits)
	if err != nil {
		return nil, err
	}
	data := append([]byte{DistributeDiscriminator}, entries...)

	return solana.NewInstruction(ProgramID, accounts, data), nil
}

// BuildReclaimInstruction builds the permissionless rent reclaim for a
// Distributed channel. The program returns lamports only to the recorded
// rent payer, so reclaims are safely batchable.
func BuildReclaimInstruction(channel, rentPayer solana.PublicKey) solana.Instruction {
	accounts := solana.AccountMetaSlice{
		solana.NewAccountMeta(channel, true, false),
		solana.NewAccountMeta(rentPayer, true, false),
	}
	return solana.NewInstruction(ProgramID, accounts, []byte{ReclaimDiscriminator})
}
