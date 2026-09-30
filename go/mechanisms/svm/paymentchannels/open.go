package paymentchannels

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	ag_binary "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

// DecodeOpenArgs deserializes open arguments, rejecting truncated data and
// trailing bytes so a client cannot smuggle extra payload past the verifier.
func DecodeOpenArgs(data []byte) (generated.OpenArgs, error) {
	decoder := ag_binary.NewBorshDecoder(data)
	var decoded generated.OpenArgs
	if err := decoder.Decode(&decoded); err != nil {
		return generated.OpenArgs{}, fmt.Errorf("open args truncated: %d bytes", len(data))
	}
	if decoder.Remaining() != 0 {
		return generated.OpenArgs{}, fmt.Errorf(
			"open args recipient section is %d bytes, expected %d for %d recipients",
			len(data), uint64(len(decoded.Recipients))*34, len(decoded.Recipients),
		)
	}
	return decoded, nil
}

func openArgsFromSplits(salt, deposit uint64, gracePeriod uint32, openSlot uint64, recipients []Split) (generated.OpenArgs, error) {
	entries, err := distributionEntries(recipients)
	if err != nil {
		return generated.OpenArgs{}, err
	}
	return generated.OpenArgs{
		Salt:        salt,
		Deposit:     deposit,
		GracePeriod: gracePeriod,
		OpenSlot:    openSlot,
		Recipients:  entries,
	}, nil
}

func splitsFromEntries(entries []generated.DistributionEntry) []Split {
	splits := make([]Split, len(entries))
	for i, entry := range entries {
		splits[i] = Split{Recipient: entry.Recipient.String(), BPS: entry.Bps}
	}
	return splits
}

// OpenInstructionArgs are the accounts and data needed to build open.
type OpenInstructionArgs struct {
	Payer            solana.PublicKey
	RentPayer        solana.PublicKey
	Payee            solana.PublicKey
	Mint             solana.PublicKey
	AuthorizedSigner solana.PublicKey
	TokenProgram     solana.PublicKey
	Args             generated.OpenArgs
	// Program overrides the payment-channels program id. The zero key uses ProgramID.
	Program solana.PublicKey
}

// BuildOpenInstruction builds the canonical 14-account open instruction.
// The channel PDA and both token accounts are derived from the other fields,
// so the caller cannot bind a channel to accounts it did not derive.
func BuildOpenInstruction(args OpenInstructionArgs) (solana.Instruction, solana.PublicKey, error) {
	program := instructionProgram(args.Program)
	channel, err := findChannelPDA(
		program, args.Payer, args.Payee, args.Mint, args.AuthorizedSigner,
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
	eventAuthority, err := findEventAuthorityPDA(program)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	instruction, err := generated.NewOpenInstructionBuilder().
		SetOpenArgs(args.Args).
		SetPayerAccount(args.Payer).
		SetRentPayerAccount(args.RentPayer).
		SetPayeeAccount(args.Payee).
		SetMintAccount(args.Mint).
		SetAuthorizedSignerAccount(args.AuthorizedSigner).
		SetChannelAccount(channel).
		SetPayerTokenAccountAccount(payerTokenAccount).
		SetChannelTokenAccountAccount(channelTokenAccount).
		SetTokenProgramAccount(args.TokenProgram).
		SetSystemProgramAccount(solana.SystemProgramID).
		SetRentAccount(RentSysvar).
		SetAssociatedTokenProgramAccount(solana.SPLAssociatedTokenAccountProgramID).
		SetEventAuthorityAccount(eventAuthority).
		SetSelfProgramAccount(program).
		ValidateAndBuild()
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	built, err := withProgram(program, instruction)
	if err != nil {
		return nil, solana.PublicKey{}, err
	}
	return built, channel, nil
}

// MaxMemoBytes is the maximum byte length of the seller-defined memo.
const MaxMemoBytes = svm.MaxMemoBytes

// memoProgramID is the SPL Memo program. The memo makes concurrent opens with
// otherwise identical parameters unique transactions.
var memoProgramID = solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)

// BuildOpenArgs are the inputs for the client-side `open` transaction.
type BuildOpenArgs struct {
	Payer            solana.PublicKey
	Payee            solana.PublicKey
	Mint             solana.PublicKey
	AuthorizedSigner solana.PublicKey
	FeePayer         solana.PublicKey
	TokenProgram     solana.PublicKey
	Deposit          uint64
	Blockhash        solana.Hash
	OpenSlot         uint64
	GracePeriod      uint32
	Recipients       []Split
	// Salt is the channel-derivation salt; a random u64 is used when nil.
	Salt *uint64
	// Memo is the seller-defined memo (extra.memo) when set, including the
	// empty string. A random hex nonce is emitted when nil.
	Memo *string
	// BindingMemo, when set, is emitted as a second Memo instruction after the
	// seller memo.
	BindingMemo *string
	// ComputeUnitLimit overrides SetComputeUnitLimit units on the transaction.
	// Defaults to OpenDefaultComputeUnitLimit when nil; 0 omits the
	// instruction. Must not exceed OpenMaxComputeUnitLimit.
	ComputeUnitLimit *uint32
	// ComputeUnitPriceMicroLamports overrides SetComputeUnitPrice in
	// microlamports per compute unit, paid by the facilitator fee payer.
	// Defaults to svm.DefaultComputeUnitPriceMicrolamports when nil; 0 omits
	// the instruction. Must not exceed svm.MaxComputeUnitPriceMicrolamports.
	ComputeUnitPriceMicroLamports *uint64
}

// BuiltOpen is an unsigned `open` transaction plus the channel facts the
// caller must echo in its payload.
type BuiltOpen struct {
	ChannelID   solana.PublicKey
	Transaction *solana.Transaction
	Deposit     uint64
	Salt        uint64
	OpenSlot    uint64
}

// BuildOpenTransaction builds the fee-payer-sponsored `open` transaction. The
// returned transaction is unsigned: the payer signs it as the client
// authorization and the sponsor co-signs before broadcast.
func BuildOpenTransaction(args BuildOpenArgs) (*BuiltOpen, error) {
	salt, err := resolveSalt(args.Salt)
	if err != nil {
		return nil, err
	}

	openArgs, err := openArgsFromSplits(salt, args.Deposit, args.GracePeriod, args.OpenSlot, args.Recipients)
	if err != nil {
		return nil, err
	}
	openIx, channelID, err := BuildOpenInstruction(OpenInstructionArgs{
		Payer:            args.Payer,
		RentPayer:        args.FeePayer,
		Payee:            args.Payee,
		Mint:             args.Mint,
		AuthorizedSigner: args.AuthorizedSigner,
		TokenProgram:     args.TokenProgram,
		Args:             openArgs,
	})
	if err != nil {
		return nil, err
	}

	memoData, err := resolveMemoData(args.Memo)
	if err != nil {
		return nil, err
	}
	memoIxs := []solana.Instruction{
		solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{}, memoData),
	}
	if args.BindingMemo != nil {
		memoIxs = append(memoIxs, solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{}, []byte(*args.BindingMemo)))
	}

	computeBudgetIxs, err := resolveOpenComputeBudget(args.ComputeUnitLimit, args.ComputeUnitPriceMicroLamports)
	if err != nil {
		return nil, err
	}

	builder := solana.NewTransactionBuilder()
	for _, ix := range computeBudgetIxs {
		builder.AddInstruction(ix)
	}
	builder.AddInstruction(openIx)
	for _, ix := range memoIxs {
		builder.AddInstruction(ix)
	}
	tx, err := builder.
		SetRecentBlockHash(args.Blockhash).
		SetFeePayer(args.FeePayer).
		Build()
	if err != nil {
		return nil, fmt.Errorf("failed to build open transaction: %w", err)
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	raw, err := tx.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("failed to serialize open transaction: %w", err)
	}
	if len(raw) > maxTransactionBytes {
		return nil, fmt.Errorf(
			"open transaction is %d bytes, above the %d-byte packet limit",
			len(raw), maxTransactionBytes,
		)
	}

	return &BuiltOpen{
		ChannelID:   channelID,
		Transaction: tx,
		Deposit:     args.Deposit,
		Salt:        salt,
		OpenSlot:    args.OpenSlot,
	}, nil
}

func resolveSalt(salt *uint64) (uint64, error) {
	if salt != nil {
		return *salt, nil
	}
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return 0, fmt.Errorf("failed to generate channel salt: %w", err)
	}
	return binary.LittleEndian.Uint64(buf), nil
}

// resolveOpenComputeBudget builds the optional ComputeBudget prefix for a
// client open transaction: SetComputeUnitLimit (0 omits it) followed by
// SetComputeUnitPrice (0 omits it), in that order per spec.
func resolveOpenComputeBudget(computeUnitLimit *uint32, computeUnitPriceMicroLamports *uint64) ([]solana.Instruction, error) {
	limit := OpenDefaultComputeUnitLimit
	if computeUnitLimit != nil {
		limit = *computeUnitLimit
	}
	if limit > OpenMaxComputeUnitLimit {
		return nil, fmt.Errorf(
			"computeUnitLimit must be in [0, %d], received %d", OpenMaxComputeUnitLimit, limit,
		)
	}

	price := uint64(svm.DefaultComputeUnitPriceMicrolamports)
	if computeUnitPriceMicroLamports != nil {
		price = *computeUnitPriceMicroLamports
	}
	if price > svm.MaxComputeUnitPriceMicrolamports {
		return nil, fmt.Errorf(
			"computeUnitPriceMicroLamports must be in [0, %d], received %d",
			svm.MaxComputeUnitPriceMicrolamports, price,
		)
	}

	var instructions []solana.Instruction
	if limit > 0 {
		limitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
			SetUnits(limit).
			ValidateAndBuild()
		if err != nil {
			return nil, fmt.Errorf("failed to build compute limit instruction: %w", err)
		}
		instructions = append(instructions, limitIx)
	}
	if price > 0 {
		priceIx, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
			SetMicroLamports(price).
			ValidateAndBuild()
		if err != nil {
			return nil, fmt.Errorf("failed to build compute price instruction: %w", err)
		}
		instructions = append(instructions, priceIx)
	}
	return instructions, nil
}

// FindChannelPDA derives the channel program-derived address for the given
// open parameters. Seeds are "channel", payer, payee, mint, authorizedSigner,
// u64le(salt), u64le(openSlot). Results are memoized in a bounded LRU cache
// (see maxChannelPDACacheEntries).
func FindChannelPDA(
	payer, payee, mint, authorizedSigner solana.PublicKey,
	salt, openSlot uint64,
) (solana.PublicKey, error) {
	return findChannelPDA(ProgramID, payer, payee, mint, authorizedSigner, salt, openSlot)
}

func findChannelPDA(
	program, payer, payee, mint, authorizedSigner solana.PublicKey,
	salt, openSlot uint64,
) (solana.PublicKey, error) {
	seeds := channelPDASeeds(payer, payee, mint, authorizedSigner, salt, openSlot)
	key := channelPDACacheKey(program, seeds)
	if pda, ok := globalChannelPDACache.lookup(key); ok {
		return pda, nil
	}
	pda, _, err := findProgramDerivedAddress(seeds, program)
	if err != nil {
		return solana.PublicKey{}, fmt.Errorf("failed to derive channel PDA: %w", err)
	}
	globalChannelPDACache.store(key, pda)
	return pda, nil
}

func resolveMemoData(memo *string) ([]byte, error) {
	if memo != nil {
		if len(*memo) > MaxMemoBytes {
			return nil, fmt.Errorf("extra.memo exceeds maximum %d bytes", MaxMemoBytes)
		}
		return []byte(*memo), nil
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("failed to generate memo nonce: %w", err)
	}
	return []byte(hex.EncodeToString(nonce)), nil
}

// BuildTopUpArgs are the inputs for a canonical payment-channel top_up.
type BuildTopUpArgs struct {
	Payer            solana.PublicKey
	ChannelID        solana.PublicKey
	Mint             solana.PublicKey
	TokenProgram     solana.PublicKey
	FeePayer         solana.PublicKey
	Amount           uint64
	Blockhash        solana.Hash
	Memo             *string
	ComputeUnitLimit *uint32
	// ComputeUnitPriceMicroLamports overrides SetComputeUnitPrice. Nil uses the
	// package default; 0 omits the instruction.
	ComputeUnitPriceMicroLamports *uint64
	// Program overrides the payment-channels program id. The zero key uses ProgramID.
	Program solana.PublicKey
}

// BuiltTopUp is an unsigned top_up transaction.
type BuiltTopUp struct {
	ChannelID   solana.PublicKey
	Amount      uint64
	Transaction *solana.Transaction
}

// BuildTopUpPaymentChannelTransaction builds the payer-signed canonical top_up
// transaction. The fee payer is only the transaction fee payer: it is not an
// account of the six-account top_up instruction. The returned transaction is
// unsigned.
func BuildTopUpPaymentChannelTransaction(args BuildTopUpArgs) (*BuiltTopUp, error) {
	if args.Amount == 0 {
		return nil, fmt.Errorf("top-up amount must be positive")
	}
	program := instructionProgram(args.Program)
	payerTokenAccount, err := FindATA(args.Payer, args.Mint, args.TokenProgram)
	if err != nil {
		return nil, err
	}
	channelTokenAccount, err := FindATA(args.ChannelID, args.Mint, args.TokenProgram)
	if err != nil {
		return nil, err
	}
	instruction, err := generated.NewTopUpInstructionBuilder().
		SetTopUpArgs(generated.TopUpArgs{Amount: args.Amount}).
		SetPayerAccount(args.Payer).
		SetChannelAccount(args.ChannelID).
		SetPayerTokenAccountAccount(payerTokenAccount).
		SetChannelTokenAccountAccount(channelTokenAccount).
		SetMintAccount(args.Mint).
		SetTokenProgramAccount(args.TokenProgram).
		ValidateAndBuild()
	if err != nil {
		return nil, err
	}
	topUp, err := withProgram(program, instruction)
	if err != nil {
		return nil, err
	}

	memoData, err := resolveMemoData(args.Memo)
	if err != nil {
		return nil, err
	}
	computeBudgetIxs, err := resolveOpenComputeBudget(args.ComputeUnitLimit, args.ComputeUnitPriceMicroLamports)
	if err != nil {
		return nil, err
	}

	builder := solana.NewTransactionBuilder().SetRecentBlockHash(args.Blockhash).SetFeePayer(args.FeePayer)
	for _, ix := range computeBudgetIxs {
		builder.AddInstruction(ix)
	}
	tx, err := builder.
		AddInstruction(topUp).
		AddInstruction(solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{}, memoData)).
		Build()
	if err != nil {
		return nil, fmt.Errorf("failed to build top-up transaction: %w", err)
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	return &BuiltTopUp{ChannelID: args.ChannelID, Amount: args.Amount, Transaction: tx}, nil
}

// VerifyTopUpExpected pins a canonical six-account top_up transaction.
type VerifyTopUpExpected struct {
	FeePayer     solana.PublicKey
	From         solana.PublicKey
	ChannelID    solana.PublicKey
	Mint         solana.PublicKey
	TokenProgram solana.PublicKey
	Amount       uint64
	Memo         *string
	// Program overrides the payment-channels program id. The zero key uses ProgramID.
	Program                     solana.PublicKey
	MaxComputeUnits             *uint32
	MaxPriorityFeeMicroLamports *uint64
}

// VerifyTopUpTransaction decodes and validates the canonical top-up transaction
// layout and account bindings.
func VerifyTopUpTransaction(transactionBase64 string, expected VerifyTopUpExpected) error {
	tx, err := svm.DecodeTransaction(transactionBase64)
	if err != nil {
		return fmt.Errorf("verifyTopUpTransaction: %w", err)
	}
	message := &tx.Message
	if len(message.AddressTableLookups) > 0 {
		return fmt.Errorf("verifyTopUpTransaction: address-lookup tables are not permitted")
	}

	program := instructionProgram(expected.Program)
	ix, err := findCanonicalOpenInstruction(message, VerifyOpenExpected{
		FeePayer:                    expected.FeePayer,
		Memo:                        expected.Memo,
		MaxComputeUnits:             expected.MaxComputeUnits,
		MaxPriorityFeeMicroLamports: expected.MaxPriorityFeeMicroLamports,
	}, program, uint8(generated.TopUpDiscriminator), "top_up")
	if err != nil {
		return err
	}
	if len(message.AccountKeys) == 0 || !message.AccountKeys[0].Equals(expected.FeePayer) {
		return fmt.Errorf("verifyTopUpTransaction: fee payer mismatch")
	}
	wantSigners := 2
	if expected.FeePayer.Equals(expected.From) {
		wantSigners = 1
	}
	if int(message.Header.NumRequiredSignatures) != wantSigners {
		return fmt.Errorf("verifyTopUpTransaction: unexpected required signer set")
	}
	if err := verifyPayerSignature(tx, expected.From); err != nil {
		return fmt.Errorf("verifyTopUpTransaction: missing or invalid payer signature")
	}
	if len(ix.Accounts) != 6 {
		return fmt.Errorf("verifyTopUpTransaction: top_up must have exactly 6 accounts, found %d", len(ix.Accounts))
	}

	accountAt := func(slot int) (solana.PublicKey, error) {
		index := int(ix.Accounts[slot])
		if index >= len(message.AccountKeys) {
			return solana.PublicKey{}, fmt.Errorf("verifyTopUpTransaction: missing account %d", slot)
		}
		return message.AccountKeys[index], nil
	}
	payer, err := accountAt(0)
	if err != nil {
		return err
	}
	channel, err := accountAt(1)
	if err != nil {
		return err
	}
	payerATA, err := accountAt(2)
	if err != nil {
		return err
	}
	channelATA, err := accountAt(3)
	if err != nil {
		return err
	}
	mint, err := accountAt(4)
	if err != nil {
		return err
	}
	tokenProgram, err := accountAt(5)
	if err != nil {
		return err
	}
	if !payer.Equals(expected.From) || !channel.Equals(expected.ChannelID) || !mint.Equals(expected.Mint) || !tokenProgram.Equals(expected.TokenProgram) {
		return fmt.Errorf("verifyTopUpTransaction: account binding mismatch")
	}
	for _, index := range ix.Accounts {
		if index == 0 {
			return fmt.Errorf("verifyTopUpTransaction: fee payer must not be a top_up account")
		}
	}

	writableSigner := []struct {
		slot   int
		label  string
		signer bool
	}{
		{0, "payer", true},
		{1, "channel", false},
		{2, "payer token account", false},
		{3, "channel token account", false},
	}
	for _, entry := range writableSigner {
		index := int(ix.Accounts[entry.slot])
		if !isWritableIndex(message, index) || (entry.signer && !isSignerIndex(message, index)) {
			return fmt.Errorf("verifyTopUpTransaction: %s privilege mismatch", entry.label)
		}
	}

	expectedPayerATA, err := FindATA(payer, expected.Mint, expected.TokenProgram)
	if err != nil {
		return err
	}
	expectedChannelATA, err := FindATA(channel, expected.Mint, expected.TokenProgram)
	if err != nil {
		return err
	}
	if !payerATA.Equals(expectedPayerATA) || !channelATA.Equals(expectedChannelATA) {
		return fmt.Errorf("verifyTopUpTransaction: ATA binding mismatch")
	}

	var decoded generated.TopUp
	if err := ag_binary.NewBorshDecoder(ix.Data).Decode(&decoded); err != nil {
		return fmt.Errorf("verifyTopUpTransaction: %w", err)
	}
	if decoded.TopUpArgs.Amount != expected.Amount {
		return fmt.Errorf("verifyTopUpTransaction: top-up amount mismatch")
	}
	return nil
}

// lighthouseProgramID is the Phantom/Solflare assertion program allowed in the
// optional suffix of an open.
var lighthouseProgramID = solana.MustPublicKeyFromBase58(svm.LighthouseProgramAddress)

// VerifyOpenExpected pins every value a client-supplied open transaction is
// checked against before the sponsor adds its signature.
type VerifyOpenExpected struct {
	AuthorizedSigner solana.PublicKey
	FeePayer         solana.PublicKey
	From             solana.PublicKey
	Mint             solana.PublicKey
	TokenProgram     solana.PublicKey
	Payee            solana.PublicKey
	// MaxCap is the authorized ceiling. The deposit must equal it exactly:
	// `top_up` can raise an open channel's deposit, so `>=` would leave the
	// x402 ceiling advisory.
	MaxCap        uint64
	WithdrawDelay uint32
	OpenSlot      uint64
	Recipients    []Split
	// RecentSlot, when set, enforces the program's open-slot freshness window.
	RecentSlot *uint64
	// Memo, when set, must be the data of exactly one suffix Memo instruction.
	// An empty string is a requirement for an empty memo, not an absent one.
	Memo *string
	// ExpectedBindingMemo, when set, must be the data of exactly one suffix
	// Memo instruction. Memo then applies to the other memos.
	ExpectedBindingMemo *string
	// MaxComputeUnits is an operator ceiling clamped to OpenMaxComputeUnitLimit.
	MaxComputeUnits *uint32
	// MaxPriorityFeeMicroLamports is an operator ceiling clamped to
	// MaxComputeUnitPriceMicroLamports.
	MaxPriorityFeeMicroLamports *uint64
	// MaxRequiredSignatures, when set, rejects transactions requiring more
	// signatures than the operator allows.
	MaxRequiredSignatures *int
}

// VerifyOpenResult holds the channel facts extracted from a verified open.
type VerifyOpenResult struct {
	ChannelID   solana.PublicKey
	Payer       solana.PublicKey
	Deposit     uint64
	GracePeriod uint32
	OpenSlot    uint64
	Salt        uint64
	Recipients  []Split
}

// VerifyOpenTransaction decodes a client-supplied base64 open transaction and
// enforces the full acceptance policy from the SVM `upto` spec.
//
// The sponsor co-signs bytes the client constructed, so a malicious client
// could otherwise smuggle a fee-payer-authorized instruction alongside the
// open and drain the sponsor. Simulation cannot substitute for these checks:
// it runs only after the signature already authorized the transaction.
func VerifyOpenTransaction(transactionBase64 string, expected VerifyOpenExpected) (*VerifyOpenResult, error) {
	tx, err := svm.DecodeTransaction(transactionBase64)
	if err != nil {
		return nil, fmt.Errorf("verifyOpenTransaction: %w", err)
	}
	message := &tx.Message

	// Address Lookup Tables hide instruction programs and accounts from the
	// static key list, so every program must be visible before signing.
	if len(message.AddressTableLookups) > 0 {
		return nil, fmt.Errorf("verifyOpenTransaction: address lookup tables are not permitted in an open transaction")
	}

	openIx, err := findCanonicalOpenInstruction(message, expected, ProgramID, uint8(generated.OpenDiscriminator), "open")
	if err != nil {
		return nil, err
	}

	if err := verifyRequiredSigners(message, expected); err != nil {
		return nil, err
	}
	if err := verifyPayerSignature(tx, expected.From); err != nil {
		return nil, err
	}

	result, err := verifyOpenAccountsAndArgs(message, openIx, expected)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// verifyRequiredSigners asserts the required-signer set equals the distinct
// addresses in {payload.from, extra.feePayer}.
func verifyRequiredSigners(message *solana.Message, expected VerifyOpenExpected) error {
	numSigners := int(message.Header.NumRequiredSignatures)
	if expected.MaxRequiredSignatures != nil && numSigners > *expected.MaxRequiredSignatures {
		return fmt.Errorf(
			"verifyOpenTransaction: required-signer count %d exceeds maxRequiredSignatures %d",
			numSigners, *expected.MaxRequiredSignatures,
		)
	}
	if numSigners > len(message.AccountKeys) {
		return fmt.Errorf("verifyOpenTransaction: message header declares more signers than accounts")
	}

	expectedSigners := map[solana.PublicKey]struct{}{
		expected.From:     {},
		expected.FeePayer: {},
	}
	if numSigners != len(expectedSigners) {
		return fmt.Errorf(
			"verifyOpenTransaction: required-signer count %d != expected %d",
			numSigners, len(expectedSigners),
		)
	}
	for _, signer := range message.AccountKeys[:numSigners] {
		if _, ok := expectedSigners[signer]; !ok {
			return fmt.Errorf("verifyOpenTransaction: unexpected required signer %s", signer)
		}
	}
	return nil
}

// verifyPayerSignature asserts the payer signature is present and valid over
// the message bytes before the sponsor adds its own.
func verifyPayerSignature(tx *solana.Transaction, from solana.PublicKey) error {
	index := -1
	for i, key := range tx.Message.AccountKeys {
		if key.Equals(from) {
			index = i
			break
		}
	}
	if index < 0 || index >= len(tx.Signatures) {
		return fmt.Errorf("verifyOpenTransaction: missing signature for payload.from %s", from)
	}
	signature := tx.Signatures[index]
	if signature.IsZero() {
		return fmt.Errorf("verifyOpenTransaction: missing signature for payload.from %s", from)
	}
	messageBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("verifyOpenTransaction: failed to serialize message: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(from.Bytes()), messageBytes, signature[:]) {
		return fmt.Errorf("verifyOpenTransaction: invalid signature for payload.from %s", from)
	}
	return nil
}

// verifyOpenAccountsAndArgs binds the 14 canonical account slots, enforces
// account privileges, and fully decodes the open arguments.
func verifyOpenAccountsAndArgs(
	message *solana.Message,
	openIx solana.CompiledInstruction,
	expected VerifyOpenExpected,
) (*VerifyOpenResult, error) {
	if len(openIx.Accounts) != OpenAccountCount {
		return nil, fmt.Errorf(
			"verifyOpenTransaction: open instruction must have exactly %d accounts, found %d",
			OpenAccountCount, len(openIx.Accounts),
		)
	}

	accountAt := func(slot int, label string) (solana.PublicKey, error) {
		index := int(openIx.Accounts[slot])
		if index >= len(message.AccountKeys) {
			return solana.PublicKey{}, fmt.Errorf(
				"verifyOpenTransaction: missing account at slot %d (%s)", slot, label,
			)
		}
		return message.AccountKeys[index], nil
	}

	slots := []struct {
		index int
		label string
	}{
		{0, "payer"}, {1, "rentPayer"}, {2, "payee"}, {3, "mint"},
		{4, "authorizedSigner"}, {5, "channel"}, {6, "payerTokenAccount"},
		{7, "channelTokenAccount"}, {8, "tokenProgram"}, {9, "systemProgram"},
		{10, "rent"}, {11, "associatedTokenProgram"}, {12, "eventAuthority"},
		{13, "selfProgram"},
	}
	accounts := make([]solana.PublicKey, len(slots))
	for i, slot := range slots {
		account, err := accountAt(slot.index, slot.label)
		if err != nil {
			return nil, err
		}
		accounts[i] = account
	}

	payer, rentPayer, payee, mint := accounts[0], accounts[1], accounts[2], accounts[3]
	authorizedSigner, channel := accounts[4], accounts[5]
	payerTokenAccount, channelTokenAccount := accounts[6], accounts[7]
	tokenProgram := accounts[8]

	if err := verifyOpenPrivileges(message, openIx, accounts); err != nil {
		return nil, err
	}

	if !payer.Equals(expected.From) {
		return nil, fmt.Errorf("verifyOpenTransaction: payer %s != expected payload.from %s", payer, expected.From)
	}
	if len(message.AccountKeys) == 0 || !message.AccountKeys[0].Equals(expected.FeePayer) {
		return nil, fmt.Errorf("verifyOpenTransaction: transaction fee payer != expected %s", expected.FeePayer)
	}
	if !rentPayer.Equals(expected.FeePayer) {
		return nil, fmt.Errorf("verifyOpenTransaction: rentPayer %s != expected feePayer %s", rentPayer, expected.FeePayer)
	}
	if !payee.Equals(expected.Payee) {
		return nil, fmt.Errorf("verifyOpenTransaction: payee %s != expected %s", payee, expected.Payee)
	}
	if !mint.Equals(expected.Mint) {
		return nil, fmt.Errorf("verifyOpenTransaction: mint %s != expected %s", mint, expected.Mint)
	}
	if !authorizedSigner.Equals(expected.AuthorizedSigner) {
		return nil, fmt.Errorf(
			"verifyOpenTransaction: authorizedSigner %s != expected %s",
			authorizedSigner, expected.AuthorizedSigner,
		)
	}
	if !tokenProgram.Equals(expected.TokenProgram) {
		return nil, fmt.Errorf("verifyOpenTransaction: tokenProgram %s != expected %s", tokenProgram, expected.TokenProgram)
	}

	expectedPayerATA, err := FindATA(payer, expected.Mint, expected.TokenProgram)
	if err != nil {
		return nil, err
	}
	expectedChannelATA, err := FindATA(channel, expected.Mint, expected.TokenProgram)
	if err != nil {
		return nil, err
	}
	expectedEventAuthority, err := FindEventAuthorityPDA()
	if err != nil {
		return nil, err
	}
	fixed := []struct {
		label  string
		actual solana.PublicKey
		wanted solana.PublicKey
	}{
		{"payerTokenAccount", payerTokenAccount, expectedPayerATA},
		{"channelTokenAccount", channelTokenAccount, expectedChannelATA},
		{"systemProgram", accounts[9], solana.SystemProgramID},
		{"rent", accounts[10], RentSysvar},
		{"associatedTokenProgram", accounts[11], solana.SPLAssociatedTokenAccountProgramID},
		{"eventAuthority", accounts[12], expectedEventAuthority},
		{"selfProgram", accounts[13], ProgramID},
	}
	for _, entry := range fixed {
		if !entry.actual.Equals(entry.wanted) {
			return nil, fmt.Errorf("verifyOpenTransaction: %s %s != expected %s", entry.label, entry.actual, entry.wanted)
		}
	}

	args, err := DecodeOpenArgs(openIx.Data[1:])
	if err != nil {
		return nil, fmt.Errorf("verifyOpenTransaction: %w", err)
	}
	if err := verifyOpenArgs(args, expected); err != nil {
		return nil, err
	}

	derivedChannel, err := FindChannelPDA(payer, payee, mint, authorizedSigner, args.Salt, args.OpenSlot)
	if err != nil {
		return nil, err
	}
	if !derivedChannel.Equals(channel) {
		return nil, fmt.Errorf("verifyOpenTransaction: channel PDA %s != derived %s", channel, derivedChannel)
	}

	return &VerifyOpenResult{
		ChannelID:   channel,
		Payer:       payer,
		Deposit:     args.Deposit,
		GracePeriod: args.GracePeriod,
		OpenSlot:    args.OpenSlot,
		Salt:        args.Salt,
		Recipients:  splitsFromEntries(args.Recipients),
	}, nil
}

// verifyOpenPrivileges enforces the writable/signer roles of the open slots and
// rejects any writable account outside them. Solana deduplicates equal keys and
// unions their privileges, so a read-only role that equals a writable role
// (payee == rentPayer in this profile) is expected and must not be rejected.
func verifyOpenPrivileges(
	message *solana.Message,
	openIx solana.CompiledInstruction,
	accounts []solana.PublicKey,
) error {
	required := []struct {
		slot     int
		label    string
		signer   bool
		writable bool
	}{
		{0, "payer", true, true},
		{1, "rentPayer", true, true},
		{5, "channel", false, true},
		{6, "payerTokenAccount", false, true},
		{7, "channelTokenAccount", false, true},
	}
	for _, entry := range required {
		index := int(openIx.Accounts[entry.slot])
		if entry.signer && !isSignerIndex(message, index) {
			return fmt.Errorf("verifyOpenTransaction: %s at slot %d must be a signer", entry.label, entry.slot)
		}
		if entry.writable && !isWritableIndex(message, index) {
			return fmt.Errorf("verifyOpenTransaction: %s at slot %d must be writable", entry.label, entry.slot)
		}
	}

	writableRoles := map[solana.PublicKey]struct{}{
		accounts[0]: {}, accounts[1]: {}, accounts[5]: {}, accounts[6]: {}, accounts[7]: {},
	}
	for index, account := range message.AccountKeys {
		if !isWritableIndex(message, index) {
			continue
		}
		if _, ok := writableRoles[account]; !ok {
			return fmt.Errorf(
				"verifyOpenTransaction: account %s is writable but is not among the open instruction's writable roles",
				account,
			)
		}
	}
	return nil
}

// verifyOpenArgs binds the decoded open arguments to the challenge.
func verifyOpenArgs(args generated.OpenArgs, expected VerifyOpenExpected) error {
	if args.Deposit == 0 {
		return fmt.Errorf("verifyOpenTransaction: deposit must be greater than zero")
	}
	if args.Deposit != expected.MaxCap {
		return fmt.Errorf(
			"verifyOpenTransaction: deposit %d != maxCap %d — the deposit is the enforced ceiling and top_up can raise an open channel's deposit, so it must equal the authorized amount exactly",
			args.Deposit, expected.MaxCap,
		)
	}
	if args.GracePeriod != expected.WithdrawDelay {
		return fmt.Errorf(
			"verifyOpenTransaction: gracePeriod %d != expected withdrawDelay %d",
			args.GracePeriod, expected.WithdrawDelay,
		)
	}
	if args.OpenSlot != expected.OpenSlot {
		return fmt.Errorf("verifyOpenTransaction: openSlot %d != expected %d", args.OpenSlot, expected.OpenSlot)
	}
	if expected.RecentSlot != nil {
		recentSlot := *expected.RecentSlot
		if args.OpenSlot > recentSlot {
			return fmt.Errorf(
				"verifyOpenTransaction: openSlot %d is ahead of challenged recentSlot %d",
				args.OpenSlot, recentSlot,
			)
		}
		if recentSlot-args.OpenSlot > OpenSlotWindow {
			return fmt.Errorf(
				"verifyOpenTransaction: openSlot %d is outside the %d-slot freshness window of challenged recentSlot %d",
				args.OpenSlot, OpenSlotWindow, recentSlot,
			)
		}
	}
	gotRecipients := splitsFromEntries(args.Recipients)
	if len(gotRecipients) != len(expected.Recipients) {
		return fmt.Errorf(
			"verifyOpenTransaction: expected %d distribution recipients, found %d",
			len(expected.Recipients), len(gotRecipients),
		)
	}
	for i, want := range expected.Recipients {
		got := gotRecipients[i]
		if got.Recipient != want.Recipient {
			return fmt.Errorf(
				"verifyOpenTransaction: distribution recipient %s != expected %s at index %d",
				got.Recipient, want.Recipient, i,
			)
		}
		if got.BPS != want.BPS {
			return fmt.Errorf(
				"verifyOpenTransaction: distribution bps %d != expected %d at index %d",
				got.BPS, want.BPS, i,
			)
		}
	}
	return nil
}

// findCanonicalOpenInstruction enforces the top-level instruction layout:
// an optional ComputeBudget prefix, exactly one payment-channels `open`, and an
// optional Lighthouse/Memo suffix.
func findCanonicalOpenInstruction(
	message *solana.Message,
	expected VerifyOpenExpected,
	programID solana.PublicKey,
	discriminator uint8,
	instructionName string,
) (solana.CompiledInstruction, error) {
	var empty solana.CompiledInstruction
	if len(message.Instructions) == 0 {
		return empty, fmt.Errorf("verifyOpenTransaction: no payment-channels open instruction found")
	}

	maxComputeUnits := OpenMaxComputeUnitLimit
	if expected.MaxComputeUnits != nil && *expected.MaxComputeUnits < maxComputeUnits {
		maxComputeUnits = *expected.MaxComputeUnits
	}
	maxPriorityFee := MaxComputeUnitPriceMicroLamports
	if expected.MaxPriorityFeeMicroLamports != nil && *expected.MaxPriorityFeeMicroLamports < maxPriorityFee {
		maxPriorityFee = *expected.MaxPriorityFeeMicroLamports
	}

	index := 0
	seenLimit, seenPrice := false, false
	for index < len(message.Instructions) {
		ix := message.Instructions[index]
		program, err := programOf(message, ix)
		if err != nil {
			return empty, err
		}
		if !program.Equals(solana.ComputeBudget) {
			break
		}
		if err := rejectFeePayerOutsideOpen(message, ix, expected.FeePayer, "ComputeBudget"); err != nil {
			return empty, err
		}
		if err := verifyComputeBudgetInstruction(ix.Data, maxComputeUnits, maxPriorityFee, &seenLimit, &seenPrice); err != nil {
			return empty, err
		}
		index++
	}

	if index >= len(message.Instructions) {
		return empty, fmt.Errorf("verifyOpenTransaction: no payment-channels open instruction found")
	}
	openIx := message.Instructions[index]
	openProgram, err := programOf(message, openIx)
	if err != nil {
		return empty, err
	}
	if !openProgram.Equals(programID) {
		return empty, fmt.Errorf(
			"verifyOpenTransaction: unexpected instruction program %s; expected payment-channels open after the ComputeBudget prefix",
			openProgram,
		)
	}
	if len(openIx.Data) < 1 || openIx.Data[0] != discriminator {
		return empty, fmt.Errorf("verifyOpenTransaction: payment-channels instruction is not `%s`", instructionName)
	}
	index++

	if err := verifyOptionalSuffix(message, index, expected); err != nil {
		return empty, err
	}
	return openIx, nil
}

// verifyOptionalSuffix allows only Lighthouse assertions and Memo instructions
// after open, and binds the seller memo and receiver-binding memo when required.
func verifyOptionalSuffix(message *solana.Message, start int, expected VerifyOpenExpected) error {
	lighthouseCount := 0
	optionalCount := 0
	var memoDatas [][]byte
	maxOptional := MaxOptionalSuffixInstructions
	if expected.ExpectedBindingMemo != nil {
		maxOptional++
	}

	for i := start; i < len(message.Instructions); i++ {
		ix := message.Instructions[i]
		program, err := programOf(message, ix)
		if err != nil {
			return err
		}
		optionalCount++
		if optionalCount > maxOptional {
			return fmt.Errorf(
				"verifyOpenTransaction: at most %d optional instructions are allowed after open",
				maxOptional,
			)
		}
		switch {
		case program.Equals(lighthouseProgramID):
			lighthouseCount++
			if lighthouseCount > MaxLighthouseInstructions {
				return fmt.Errorf(
					"verifyOpenTransaction: at most %d Lighthouse instructions are allowed after open",
					MaxLighthouseInstructions,
				)
			}
			if err := rejectFeePayerOutsideOpen(message, ix, expected.FeePayer, "Lighthouse"); err != nil {
				return err
			}
		case program.Equals(memoProgramID):
			if err := rejectFeePayerOutsideOpen(message, ix, expected.FeePayer, "Memo"); err != nil {
				return err
			}
			memoDatas = append(memoDatas, ix.Data)
		default:
			return fmt.Errorf(
				"verifyOpenTransaction: unexpected instruction program %s; only Lighthouse or Memo are allowed after open",
				program,
			)
		}
	}

	otherMemos, err := memosBesidesBinding(memoDatas, expected.ExpectedBindingMemo)
	if err != nil {
		return err
	}
	if expected.Memo == nil {
		return nil
	}
	if len(otherMemos) != 1 {
		return fmt.Errorf(
			"verifyOpenTransaction: expected exactly one Memo instruction matching extra.memo, found %d",
			len(otherMemos),
		)
	}
	if string(otherMemos[0]) != *expected.Memo {
		return fmt.Errorf("verifyOpenTransaction: Memo instruction data does not match extra.memo")
	}
	return nil
}

// memosBesidesBinding requires exactly one memo equal to the binding text, and
// exactly one memo under that binding's prefix, then returns the rest.
func memosBesidesBinding(memoDatas [][]byte, expectedBinding *string) ([][]byte, error) {
	if expectedBinding == nil {
		return memoDatas, nil
	}
	binding := *expectedBinding
	prefix := binding
	if end := strings.LastIndex(binding, ":"); end >= 0 {
		prefix = binding[:end+1]
	}
	exact, prefixed := 0, 0
	for _, data := range memoDatas {
		text := string(data)
		if text == binding {
			exact++
		}
		if strings.HasPrefix(text, prefix) {
			prefixed++
		}
	}
	found := exact
	if exact == 1 {
		found = prefixed
	}
	if exact != 1 || prefixed != 1 {
		return nil, fmt.Errorf(
			"verifyOpenTransaction: expected exactly one Memo instruction matching the receiver binding, found %d",
			found,
		)
	}
	other := make([][]byte, 0, len(memoDatas))
	for _, data := range memoDatas {
		if !strings.HasPrefix(string(data), prefix) {
			other = append(other, data)
		}
	}
	return other, nil
}

// verifyComputeBudgetInstruction allows only SetComputeUnitLimit and
// SetComputeUnitPrice, in that order, within the spec ceilings.
func verifyComputeBudgetInstruction(
	data []byte,
	maxComputeUnits uint32,
	maxPriorityFee uint64,
	seenLimit, seenPrice *bool,
) error {
	if len(data) < 1 {
		return fmt.Errorf("verifyOpenTransaction: malformed ComputeBudget instruction")
	}
	switch data[0] {
	case ComputeBudgetSetUnitLimit:
		if *seenLimit {
			return fmt.Errorf("verifyOpenTransaction: duplicate SetComputeUnitLimit instruction")
		}
		if *seenPrice {
			return fmt.Errorf("verifyOpenTransaction: SetComputeUnitLimit must precede SetComputeUnitPrice")
		}
		if len(data) != 5 {
			return fmt.Errorf("verifyOpenTransaction: SetComputeUnitLimit must be exactly 5 bytes")
		}
		units := binary.LittleEndian.Uint32(data[1:5])
		if units > maxComputeUnits {
			return fmt.Errorf("verifyOpenTransaction: SetComputeUnitLimit %d exceeds %d", units, maxComputeUnits)
		}
		*seenLimit = true
	case ComputeBudgetSetUnitPrice:
		if *seenPrice {
			return fmt.Errorf("verifyOpenTransaction: duplicate SetComputeUnitPrice instruction")
		}
		if len(data) != 9 {
			return fmt.Errorf("verifyOpenTransaction: SetComputeUnitPrice must be exactly 9 bytes")
		}
		microLamports := binary.LittleEndian.Uint64(data[1:9])
		if microLamports > maxPriorityFee {
			return fmt.Errorf(
				"verifyOpenTransaction: SetComputeUnitPrice %d exceeds %d",
				microLamports, maxPriorityFee,
			)
		}
		*seenPrice = true
	default:
		return fmt.Errorf("verifyOpenTransaction: unsupported ComputeBudget instruction type %d", data[0])
	}
	return nil
}

// rejectFeePayerOutsideOpen keeps the sponsor key out of every instruction
// except its prescribed positions in the canonical open.
func rejectFeePayerOutsideOpen(
	message *solana.Message,
	ix solana.CompiledInstruction,
	feePayer solana.PublicKey,
	label string,
) error {
	program, err := programOf(message, ix)
	if err != nil {
		return err
	}
	if program.Equals(feePayer) {
		return fmt.Errorf("verifyOpenTransaction: feePayer must not be the invoked program of a %s instruction", label)
	}
	for _, accountIndex := range ix.Accounts {
		if int(accountIndex) >= len(message.AccountKeys) {
			return fmt.Errorf("verifyOpenTransaction: %s instruction references an out-of-range account", label)
		}
		if message.AccountKeys[accountIndex].Equals(feePayer) {
			return fmt.Errorf("verifyOpenTransaction: feePayer must not appear in %s instruction accounts", label)
		}
	}
	return nil
}

func programOf(message *solana.Message, ix solana.CompiledInstruction) (solana.PublicKey, error) {
	if int(ix.ProgramIDIndex) >= len(message.AccountKeys) {
		return solana.PublicKey{}, fmt.Errorf("verifyOpenTransaction: instruction references an out-of-range program index")
	}
	return message.AccountKeys[ix.ProgramIDIndex], nil
}

func isSignerIndex(message *solana.Message, index int) bool {
	return index < int(message.Header.NumRequiredSignatures)
}

// isWritableIndex resolves writability from the message header partitioning:
// [writable signers | readonly signers | writable nonsigners | readonly nonsigners].
func isWritableIndex(message *solana.Message, index int) bool {
	numRequired := int(message.Header.NumRequiredSignatures)
	if index < numRequired {
		return index < numRequired-int(message.Header.NumReadonlySignedAccounts)
	}
	numAccounts := len(message.AccountKeys)
	return index-numRequired < numAccounts-numRequired-int(message.Header.NumReadonlyUnsignedAccounts)
}

var unsignedDecimal = regexp.MustCompile(`^\d+$`)

// ParseU64 parses a bigint, safe integer, or digit string into a u64.
func ParseU64(value any, name string) (uint64, error) {
	const maxSafe = int64(1<<53 - 1)
	switch typed := value.(type) {
	case uint64:
		return typed, nil
	case uint32:
		return uint64(typed), nil
	case uint:
		return uint64(typed), nil
	case int:
		return parseSignedU64(int64(typed), name)
	case int32:
		return parseSignedU64(int64(typed), name)
	case int64:
		return parseSignedU64(typed, name)
	case *big.Int:
		return parseBigU64(typed, name)
	case big.Int:
		return parseBigU64(&typed, name)
	case float64:
		if math.Trunc(typed) != typed || typed > float64(maxSafe) || typed < -float64(maxSafe) {
			return 0, fmt.Errorf("%s must be a safe integer", name)
		}
		return parseSignedU64(int64(typed), name)
	case float32:
		widened := float64(typed)
		if math.Trunc(widened) != widened || widened > float64(maxSafe) || widened < -float64(maxSafe) {
			return 0, fmt.Errorf("%s must be a safe integer", name)
		}
		return parseSignedU64(int64(widened), name)
	case string:
		if !unsignedDecimal.MatchString(typed) {
			return 0, fmt.Errorf("%s must be an unsigned integer", name)
		}
		parsed, err := strconv.ParseUint(typed, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%s must fit in u64", name)
		}
		return parsed, nil
	case json.Number:
		if !unsignedDecimal.MatchString(typed.String()) {
			return 0, fmt.Errorf("%s must be an unsigned integer", name)
		}
		parsed, err := strconv.ParseUint(typed.String(), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%s must fit in u64", name)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("%s must be an unsigned integer", name)
	}
}

func parseSignedU64(value int64, name string) (uint64, error) {
	if value < 0 {
		return 0, fmt.Errorf("%s must fit in u64", name)
	}
	return uint64(value), nil
}

func parseBigU64(value *big.Int, name string) (uint64, error) {
	if value == nil || value.Sign() < 0 || !value.IsUint64() {
		return 0, fmt.Errorf("%s must fit in u64", name)
	}
	return value.Uint64(), nil
}
