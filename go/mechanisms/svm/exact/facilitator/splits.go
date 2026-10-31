package facilitator

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Multi-payee split verification (scheme_exact_svm.md §5): Path 1 static
// layout, fee payer isolation with the bounded CreateIdempotent exception,
// Path 2 leg matching and post-settlement per-leg confirmation.

// splitVerifyError converts a split rule violation into a VerifyError
// carrying its reason code. Other errors keep their full text as the reason,
// as the smart-wallet checks do.
func splitVerifyError(err error, payer string) error {
	var se *svm.SplitsError
	if errors.As(err, &se) {
		return x402.NewVerifyError(se.Reason, payer, se.Error())
	}
	return x402.NewVerifyError(err.Error(), payer, err.Error())
}

func markedOwners(legs []svm.PaymentLeg) map[solana.PublicKey]struct{} {
	owners := make(map[solana.PublicKey]struct{})
	for _, leg := range legs {
		if leg.AtaCreationRequired {
			owners[leg.Owner] = struct{}{}
		}
	}
	return owners
}

func instructionAccounts(tx *solana.Transaction, ix solana.CompiledInstruction) ([]solana.PublicKey, error) {
	accounts := make([]solana.PublicKey, len(ix.Accounts))
	for i, idx := range ix.Accounts {
		account, err := tx.Message.Account(idx)
		if err != nil {
			return nil, err
		}
		accounts[i] = account
	}
	return accounts, nil
}

// assertFeePayerIsolatedWithAtaCreation is fee payer isolation with the
// bounded §2.1.1 exception: inside a validated CreateIdempotent, the fee payer
// may be the funding payer (account 0) and, when it is itself a recipient, the
// wallet owner (account 2). It must not appear anywhere else or be invoked as
// a program. Every ATA-program instruction is validated against §5.4.
func assertFeePayerIsolatedWithAtaCreation(
	tx *solana.Transaction,
	feePayer solana.PublicKey,
	asset solana.PublicKey,
	marked map[solana.PublicKey]struct{},
	tokenProgram *solana.PublicKey,
) error {
	ataCtx := &svm.AtaCreationContext{
		Asset:         asset,
		FeePayer:      feePayer,
		MarkedOwners:  marked,
		CreatedOwners: map[solana.PublicKey]struct{}{},
		TokenProgram:  tokenProgram,
	}
	for _, ix := range tx.Message.Instructions {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		if err != nil {
			return fmt.Errorf("%s: %w", ErrSmartWalletFeePayerNotIsolated, err)
		}
		if programID.Equals(feePayer) {
			return fmt.Errorf("%s: fee payer %s invoked as program", ErrSmartWalletFeePayerNotIsolated, feePayer)
		}
		accounts, err := instructionAccounts(tx, ix)
		if err != nil {
			return fmt.Errorf("%s: %w", ErrSmartWalletFeePayerNotIsolated, err)
		}
		if programID.Equals(solana.SPLAssociatedTokenAccountProgramID) {
			// Account 0 is the fee payer by construction; account 2 may be the
			// fee payer only as a recipient's owner. Accounts 1, 3, 4, 5 are the
			// ATA, mint and programs, none of which can be the fee payer here.
			if _, _, err := svm.ValidateAtaCreation(accounts, ix.Data, ataCtx); err != nil {
				return err
			}
			continue
		}
		for _, account := range accounts {
			if account.Equals(feePayer) {
				return fmt.Errorf("%s: fee payer %s appears in instruction accounts (program: %s)",
					ErrSmartWalletFeePayerNotIsolated, feePayer, programID)
			}
		}
	}
	return nil
}

// legDestination is a leg with the ATAs it may be paid to (one per token program).
type legDestination struct {
	svm.PaymentLeg
	atas map[solana.PublicKey]struct{}
}

func deriveLegDestinations(legs []svm.PaymentLeg, asset solana.PublicKey) ([]legDestination, error) {
	out := make([]legDestination, len(legs))
	for i, leg := range legs {
		atas, err := expectedDestinationATAs(leg.Owner, asset)
		if err != nil {
			return nil, err
		}
		out[i] = legDestination{PaymentLeg: leg, atas: atas}
	}
	return out, nil
}

// transferPaysLeg reports whether a transfer pays a leg: right destination,
// and the primary's amount at least the remainder or a split's amount exactly
// its carve-out.
func transferPaysLeg(t transferCheckedInfo, leg legDestination) bool {
	if _, ok := leg.atas[t.destination]; !ok {
		return false
	}
	if leg.IsPrimary {
		return t.amount >= leg.Amount
	}
	return t.amount == leg.Amount
}

// matchTransfersToLegs matches every asset transfer to exactly one leg and
// every leg to exactly one transfer (§5.3, §5.5). Transfers of other mints are
// ignored. Returns the transfer matched to each leg, in leg order.
func matchTransfersToLegs(transfers []transferCheckedInfo, legs []legDestination, asset solana.PublicKey) ([]transferCheckedInfo, error) {
	matched := make([]*transferCheckedInfo, len(legs))
	for i := range transfers {
		t := transfers[i]
		if !t.mint.Equals(asset) {
			continue
		}
		legIndex := -1
		for j, leg := range legs {
			if transferPaysLeg(t, leg) {
				legIndex = j
				break
			}
		}
		if legIndex == -1 {
			return nil, &svm.SplitsError{
				Reason:  ErrSplitUnexpectedTransfer,
				Message: fmt.Sprintf("transfer of %d to %s matches no leg", t.amount, t.destination),
			}
		}
		if matched[legIndex] != nil {
			return nil, errors.New(ErrSmartWalletMultipleMatchingTransfers)
		}
		matched[legIndex] = &t
	}
	out := make([]transferCheckedInfo, len(legs))
	for i, m := range matched {
		if m == nil {
			return nil, &svm.SplitsError{
				Reason:  ErrSplitLegUnmatched,
				Message: fmt.Sprintf("no transfer pays %s", legs[i].Owner),
			}
		}
		out[i] = *m
	}
	return out, nil
}

// verifyExpectedMemo checks that exactly one Memo instruction carries
// extra.memo when the requirements set one.
func verifyExpectedMemo(tx *solana.Transaction, optional []solana.CompiledInstruction, requirements types.PaymentRequirements) string {
	expectedMemo, ok := requirements.Extra["memo"].(string)
	if !ok || expectedMemo == "" {
		return ""
	}
	memoPubkey := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	var memoCount int
	var actual []byte
	for _, ix := range optional {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		if err != nil {
			continue
		}
		if programID.Equals(memoPubkey) {
			memoCount++
			actual = ix.Data
		}
	}
	if memoCount != 1 {
		return ErrMemoCount
	}
	if string(actual) != expectedMemo {
		return ErrMemoMismatch
	}
	return ""
}

// verifyStaticSplitPath is Path 1 for split charges (§5.7): on legacy and
// version 0 a compute limit + compute price prefix (version 1 carries its
// budget in the message config instead), K fee-payer-funded CreateIdempotent
// for marked recipients, one TransferChecked for the primary remainder, one
// per split in extra.splits order, then up to four Lighthouse / Memo
// instructions.
func (f *ExactSvmScheme) verifyStaticSplitPath(
	ctx context.Context,
	tx *solana.Transaction,
	requirements types.PaymentRequirements,
	signerAddressStrs []string,
	legs []svm.PaymentLeg,
) (string, error) {
	instructions := tx.Message.Instructions
	isAtaProgram := func(ix solana.CompiledInstruction) bool {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		return err == nil && programID.Equals(solana.SPLAssociatedTokenAccountProgramID)
	}

	prefixLength := staticTransferIndex(tx)
	createCount := 0
	for prefixLength+createCount < len(instructions) && isAtaProgram(instructions[prefixLength+createCount]) {
		createCount++
	}
	firstTransfer := prefixLength + createCount
	firstOptional := firstTransfer + len(legs)
	if len(instructions) < firstOptional || len(instructions) > firstOptional+4 {
		return "", x402.NewVerifyError(ErrTransactionInstructionsLength, "",
			fmt.Sprintf("transaction instructions length mismatch: %d not in [%d, %d]", len(instructions), firstOptional, firstOptional+4))
	}

	if prefixLength == 0 {
		if err := f.verifyTransactionV1Config(tx); err != nil {
			return "", x402.NewVerifyError(err.Error(), "", err.Error())
		}
	} else {
		if err := f.verifyComputeLimitInstruction(tx, instructions[0]); err != nil {
			return "", x402.NewVerifyError(err.Error(), "", err.Error())
		}
		if err := f.verifyComputePriceInstruction(tx, instructions[1]); err != nil {
			return "", x402.NewVerifyError(err.Error(), "", err.Error())
		}
	}

	asset, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return "", x402.NewVerifyError(ErrMintMismatch, "", err.Error())
	}
	signerSet := make(map[string]struct{}, len(signerAddressStrs))
	for _, addr := range signerAddressStrs {
		signerSet[addr] = struct{}{}
	}

	// Positional transfers: the primary remainder, then each split in order.
	payer := ""
	var tokenProgram *solana.PublicKey
	for i, leg := range legs {
		ix := instructions[firstTransfer+i]
		programID, progErr := tx.Message.Program(ix.ProgramIDIndex)
		// Exactly 10 data bytes and 4 accounts: trailing multisig signer
		// accounts would let the transfer's authority be something other than
		// the account the payer signed with.
		if progErr != nil || !isTokenProgram(programID) ||
			len(ix.Data) != 10 || ix.Data[0] != ixTokenTransferChecked || len(ix.Accounts) != 4 {
			return "", x402.NewVerifyError(ErrNoTransferInstruction, payer, ErrNoTransferInstruction)
		}
		if tokenProgram != nil && !programID.Equals(*tokenProgram) {
			return "", x402.NewVerifyError(ErrSplitLegUnmatched, payer, "legs use different token programs")
		}
		program := programID
		tokenProgram = &program

		accounts, accErr := instructionAccounts(tx, ix)
		if accErr != nil {
			return "", x402.NewVerifyError(ErrNoTransferInstruction, payer, accErr.Error())
		}
		mint, destination, authority := accounts[1], accounts[2], accounts[3]
		if _, self := signerSet[authority.String()]; self {
			return "", x402.NewVerifyError(ErrFeePayerTransferringFunds, authority.String(), ErrFeePayerTransferringFunds)
		}
		if payer != "" && authority.String() != payer {
			return "", x402.NewVerifyError(ErrSplitAuthorityMismatch, payer, ErrSplitAuthorityMismatch)
		}
		payer = authority.String()

		if !mint.Equals(asset) {
			return "", x402.NewVerifyError(ErrMintMismatch, payer, ErrMintMismatch)
		}
		expectedATA, ataErr := svm.DeriveATA(leg.Owner, asset, programID)
		if ataErr != nil || !destination.Equals(expectedATA) {
			return "", x402.NewVerifyError(ErrRecipientMismatch, payer, ErrRecipientMismatch)
		}
		if binary.LittleEndian.Uint64(ix.Data[1:9]) != leg.Amount {
			return "", x402.NewVerifyError(ErrAmountMismatch, payer, ErrAmountMismatch)
		}
	}

	optional := instructions[firstOptional:]
	lighthousePubkey := solana.MustPublicKeyFromBase58(svm.LighthouseProgramAddress)
	memoPubkey := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	for _, ix := range optional {
		programID, progErr := tx.Message.Program(ix.ProgramIDIndex)
		if progErr != nil || (!programID.Equals(lighthousePubkey) && !programID.Equals(memoPubkey)) {
			return "", x402.NewVerifyError(ErrUnknownOptionalInstruction, payer, ErrUnknownOptionalInstruction)
		}
	}

	// Fee payer isolation with the bounded CreateIdempotent exception
	// (§2.1.1); this also validates every creation against §5.4.
	feePayer, err := solana.PublicKeyFromBase58(requirements.Extra["feePayer"].(string))
	if err != nil {
		return "", x402.NewVerifyError(ErrInvalidFeePayer, payer, err.Error())
	}
	if err := assertFeePayerIsolatedWithAtaCreation(tx, feePayer, asset, markedOwners(legs), tokenProgram); err != nil {
		return "", splitVerifyError(err, payer)
	}

	if reason := verifyExpectedMemo(tx, optional, requirements); reason != "" {
		return "", x402.NewVerifyError(reason, payer, reason)
	}

	if err := f.signer.SimulateTransaction(ctx, tx, string(requirements.Network), nil); err != nil {
		return "", x402.NewVerifyError(ErrTransactionSimulationFailed, payer, err.Error())
	}
	return payer, nil
}

// legBalance is a leg ATA and its pre-broadcast balance (nil when the
// account did not exist or could not be read).
type legBalance struct {
	ata    solana.PublicKey
	before *uint64
}

// Post-settlement verification methods, reported for diagnostics and tests.
const (
	postSettlementTopLevel          = "topLevel"
	postSettlementInnerInstructions = "innerInstructions"
	postSettlementBalanceDelta      = "balanceDelta"
	postSettlementUnverified        = "unverified"
)

// verifyPostSettlementLegs is post-settlement verification for split charges
// (§3.4 with N + 1 legs).
//
// A confirmed transaction executed every top-level instruction, so legs paid
// by a top-level transfer need no further check. Every other leg must appear
// in the confirmed CPI trace, or, when the trace is unavailable, show the
// expected balance delta on its ATA: at least the remainder for the primary
// leg, exactly the carve-out for a split.
func verifyPostSettlementLegs(
	ctx context.Context,
	caps svm.SmartWalletRPCCapabilities,
	signature solana.Signature,
	network string,
	legs []legDestination,
	asset solana.PublicKey,
	signerAddresses []string,
	topLevel []transferCheckedInfo,
	balances []legBalance,
) (bool, string) {
	signerSet := make(map[string]struct{}, len(signerAddresses))
	for _, addr := range signerAddresses {
		signerSet[addr] = struct{}{}
	}
	pays := func(t transferCheckedInfo, leg legDestination) bool {
		if !t.mint.Equals(asset) {
			return false
		}
		if _, self := signerSet[t.authority.String()]; self {
			return false
		}
		return transferPaysLeg(t, leg)
	}
	paidBy := func(transfers []transferCheckedInfo, leg legDestination) bool {
		for _, t := range transfers {
			if pays(t, leg) {
				return true
			}
		}
		return false
	}

	var pending []int
	for i, leg := range legs {
		if !paidBy(topLevel, leg) {
			pending = append(pending, i)
		}
	}
	if len(pending) == 0 {
		return true, postSettlementTopLevel
	}

	var confirmedInner []rpc.InnerInstruction
	var confirmedKeys solana.PublicKeySlice
	for attempt := 0; attempt < postSettlementInnerRetries; attempt++ {
		inner, keys, err := caps.GetConfirmedTransactionInnerInstructions(ctx, signature, network)
		if err == nil && inner != nil {
			confirmedInner, confirmedKeys = inner, keys
			break
		}
		if attempt < postSettlementInnerRetries-1 {
			time.Sleep(time.Duration(100*(attempt+1)) * time.Millisecond)
		}
	}
	if confirmedInner != nil {
		inner := extractTransfersFromInnerInstructions(confirmedInner, confirmedKeys)
		for _, i := range pending {
			if !paidBy(inner, legs[i]) {
				return false, postSettlementInnerInstructions
			}
		}
		return true, postSettlementInnerInstructions
	}

	if balances == nil {
		return false, postSettlementUnverified
	}
	for _, i := range pending {
		leg := legs[i]
		if i >= len(balances) {
			return false, postSettlementUnverified
		}
		entry := balances[i]
		// A missing ATA has no balance; it starts from zero only when this
		// transaction may have created it.
		var before uint64
		switch {
		case entry.before != nil:
			before = *entry.before
		case leg.AtaCreationRequired:
			before = 0
		default:
			return false, postSettlementUnverified
		}
		after, exists, err := caps.GetTokenAccountBalance(ctx, entry.ata, network)
		if err != nil || !exists {
			return false, postSettlementUnverified
		}
		if after < before {
			return false, postSettlementBalanceDelta
		}
		delta := after - before
		if leg.IsPrimary && delta < leg.Amount || !leg.IsPrimary && delta != leg.Amount {
			return false, postSettlementBalanceDelta
		}
	}
	return true, postSettlementBalanceDelta
}
