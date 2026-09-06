package paymentchannels

import (
	"crypto/ed25519"
	"encoding/binary"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

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

	openIx, err := findCanonicalOpenInstruction(message, expected)
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
		Recipients:  args.Recipients,
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
func verifyOpenArgs(args OpenArgs, expected VerifyOpenExpected) error {
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
	if len(args.Recipients) != len(expected.Recipients) {
		return fmt.Errorf(
			"verifyOpenTransaction: expected %d distribution recipients, found %d",
			len(expected.Recipients), len(args.Recipients),
		)
	}
	for i, want := range expected.Recipients {
		got := args.Recipients[i]
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
	if !openProgram.Equals(ProgramID) {
		return empty, fmt.Errorf(
			"verifyOpenTransaction: unexpected instruction program %s; expected payment-channels open after the ComputeBudget prefix",
			openProgram,
		)
	}
	if len(openIx.Data) < 1 || openIx.Data[0] != OpenDiscriminator {
		return empty, fmt.Errorf("verifyOpenTransaction: payment-channels instruction is not `open`")
	}
	index++

	if err := verifyOptionalSuffix(message, index, expected); err != nil {
		return empty, err
	}
	return openIx, nil
}

// verifyOptionalSuffix allows only Lighthouse assertions and Memo instructions
// after `open`, and binds the seller memo when one is required.
func verifyOptionalSuffix(message *solana.Message, start int, expected VerifyOpenExpected) error {
	lighthouseCount := 0
	optionalCount := 0
	var memoDatas [][]byte

	for i := start; i < len(message.Instructions); i++ {
		ix := message.Instructions[i]
		program, err := programOf(message, ix)
		if err != nil {
			return err
		}
		optionalCount++
		if optionalCount > MaxOptionalSuffixInstructions {
			return fmt.Errorf(
				"verifyOpenTransaction: at most %d optional instructions are allowed after open",
				MaxOptionalSuffixInstructions,
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

	if expected.Memo == nil {
		return nil
	}
	if len(memoDatas) != 1 {
		return fmt.Errorf(
			"verifyOpenTransaction: expected exactly one Memo instruction matching extra.memo, found %d",
			len(memoDatas),
		)
	}
	if string(memoDatas[0]) != *expected.Memo {
		return fmt.Errorf("verifyOpenTransaction: Memo instruction data does not match extra.memo")
	}
	return nil
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
