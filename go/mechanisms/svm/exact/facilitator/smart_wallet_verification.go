package facilitator

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	defaultSmartWalletMaxComputeUnits             uint32 = 400_000
	defaultSmartWalletMaxPriorityFeeMicroLamports uint64 = 50_000

	ixSetComputeUnitLimit  = 2
	ixSetComputeUnitPrice  = 3
	ixTokenTransferChecked = 12

	postSettlementInnerRetries = 3
)

var defaultSmartWalletAllowedPrograms = []string{
	"SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",  // Squads Multisig v4
	"SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG",  // Squads Smart Account
	"SWiGmQedKzMz1tiTqoJCWeGDnGXfNBp2PkXLkpCAtQo",  // Swig (legacy)
	"swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",  // Swig v2
	"GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", // SPL Governance
	"CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", // Metaplex Core
	svm.LighthouseProgramAddress,                   // Phantom wallet-protection assertions
}

type transferCheckedInfo struct {
	programID   solana.PublicKey
	amount      uint64
	mint        solana.PublicKey
	destination solana.PublicKey
	authority   solana.PublicKey
}

func isTokenProgram(programID solana.PublicKey) bool {
	return programID.Equals(solana.TokenProgramID) || programID.Equals(solana.Token2022ProgramID)
}

func findATA(owner, mint, tokenProgram solana.PublicKey) (solana.PublicKey, error) {
	ata, _, err := solana.FindProgramAddress(
		[][]byte{owner.Bytes(), tokenProgram.Bytes(), mint.Bytes()},
		solana.SPLAssociatedTokenAccountProgramID,
	)
	return ata, err
}

func expectedDestinationATAs(payTo, mint solana.PublicKey) (map[solana.PublicKey]struct{}, error) {
	atas := make(map[solana.PublicKey]struct{}, 2)
	for _, program := range []solana.PublicKey{solana.TokenProgramID, solana.Token2022ProgramID} {
		ata, err := findATA(payTo, mint, program)
		if err != nil {
			continue
		}
		atas[ata] = struct{}{}
	}
	if len(atas) == 0 {
		return nil, errors.New(ErrSmartWalletCannotDeriveATA)
	}
	return atas, nil
}

func assertFeePayerIsolated(tx *solana.Transaction, feePayer solana.PublicKey) error {
	for _, ix := range tx.Message.Instructions {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		if err != nil {
			return fmt.Errorf("%s: %w", ErrSmartWalletFeePayerNotIsolated, err)
		}
		if programID.Equals(feePayer) {
			return fmt.Errorf("%s: fee payer %s invoked as program", ErrSmartWalletFeePayerNotIsolated, feePayer)
		}
		for _, idx := range ix.Accounts {
			account, err := tx.Message.Account(idx)
			if err != nil {
				return fmt.Errorf("%s: %w", ErrSmartWalletFeePayerNotIsolated, err)
			}
			if account.Equals(feePayer) {
				return fmt.Errorf("%s: fee payer %s appears in instruction accounts (program: %s)",
					ErrSmartWalletFeePayerNotIsolated, feePayer, programID)
			}
		}
	}
	return nil
}

func validateComputeBudgetLimits(tx *solana.Transaction, maxCU uint32, maxPriorityFee uint64) error {
	for _, ix := range tx.Message.Instructions {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		if err != nil || !programID.Equals(solana.ComputeBudget) {
			continue
		}
		if len(ix.Data) == 0 {
			return errors.New(ErrSmartWalletMalformedComputeBudget)
		}
		switch ix.Data[0] {
		case ixSetComputeUnitLimit:
			if len(ix.Data) < 5 {
				return errors.New(ErrSmartWalletMalformedComputeLimit)
			}
			units := binary.LittleEndian.Uint32(ix.Data[1:5])
			if units > maxCU {
				return fmt.Errorf("%s: %d exceeds max %d", ErrSmartWalletComputeUnitsTooHigh, units, maxCU)
			}
		case ixSetComputeUnitPrice:
			if len(ix.Data) < 9 {
				return errors.New(ErrSmartWalletMalformedComputePrice)
			}
			microLamports := binary.LittleEndian.Uint64(ix.Data[1:9])
			if microLamports > maxPriorityFee {
				return fmt.Errorf("%s: %d exceeds max %d", ErrSmartWalletPriorityFeeTooHigh, microLamports, maxPriorityFee)
			}
		default:
			return fmt.Errorf("%s: type %d", ErrSmartWalletUnsupportedComputeBudget, ix.Data[0])
		}
	}
	return nil
}

func extractTransfersFromInnerInstructions(inner []rpc.InnerInstruction, accountKeys solana.PublicKeySlice) []transferCheckedInfo {
	if inner == nil {
		return nil
	}
	var transfers []transferCheckedInfo
	for _, group := range inner {
		for _, ix := range group.Instructions {
			if int(ix.ProgramIDIndex) >= len(accountKeys) {
				continue
			}
			programID := accountKeys[ix.ProgramIDIndex]
			if !isTokenProgram(programID) {
				continue
			}
			if len(ix.Data) < 9 || ix.Data[0] != ixTokenTransferChecked || len(ix.Accounts) < 4 {
				continue
			}
			mintIdx, destIdx, authIdx := ix.Accounts[1], ix.Accounts[2], ix.Accounts[3]
			if int(mintIdx) >= len(accountKeys) || int(destIdx) >= len(accountKeys) || int(authIdx) >= len(accountKeys) {
				continue
			}
			transfers = append(transfers, transferCheckedInfo{
				programID:   programID,
				amount:      binary.LittleEndian.Uint64(ix.Data[1:9]),
				mint:        accountKeys[mintIdx],
				destination: accountKeys[destIdx],
				authority:   accountKeys[authIdx],
			})
		}
	}
	return transfers
}

func extractTopLevelTransfers(tx *solana.Transaction) []transferCheckedInfo {
	var transfers []transferCheckedInfo
	for _, ix := range tx.Message.Instructions {
		programID, err := tx.Message.Program(ix.ProgramIDIndex)
		if err != nil || !isTokenProgram(programID) {
			continue
		}
		if len(ix.Data) < 9 || ix.Data[0] != ixTokenTransferChecked || len(ix.Accounts) < 4 {
			continue
		}
		mint, err := tx.Message.Account(ix.Accounts[1])
		if err != nil {
			continue
		}
		destination, err := tx.Message.Account(ix.Accounts[2])
		if err != nil {
			continue
		}
		authority, err := tx.Message.Account(ix.Accounts[3])
		if err != nil {
			continue
		}
		transfers = append(transfers, transferCheckedInfo{
			programID:   programID,
			amount:      binary.LittleEndian.Uint64(ix.Data[1:9]),
			mint:        mint,
			destination: destination,
			authority:   authority,
		})
	}
	return transfers
}

func verifySmartWalletMemo(tx *solana.Transaction, expectedMemo string) error {
	if expectedMemo == "" {
		return nil
	}
	memoPubkey := solana.MustPublicKeyFromBase58(svm.MemoProgramAddress)
	var memoCount int
	var actual []byte
	for _, ix := range tx.Message.Instructions {
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
		return errors.New(ErrMemoCount)
	}
	if string(actual) != expectedMemo {
		return errors.New(ErrMemoMismatch)
	}
	return nil
}

func verifySmartWalletTransaction(
	ctx context.Context,
	tx *solana.Transaction,
	requirements types.PaymentRequirements,
	caps svm.SmartWalletRPCCapabilities,
	feePayer solana.PublicKey,
	signerAddresses []string,
	maxCU uint32,
	maxPriorityFee uint64,
) (*transferCheckedInfo, error) {
	if err := assertFeePayerIsolated(tx, feePayer); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}
	if err := validateComputeBudgetLimits(tx, maxCU, maxPriorityFee); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	inner, err := caps.SimulateTransactionWithInnerInstructions(ctx, tx, requirements.Network)
	if err != nil {
		return nil, x402.NewVerifyError(
			fmt.Sprintf("%s: %s", ErrSmartWalletSimulationFailed, err.Error()),
			"",
			err.Error(),
		)
	}

	expectedMemo, _ := requirements.Extra["memo"].(string)
	if err := verifySmartWalletMemo(tx, expectedMemo); err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	transfers := extractTopLevelTransfers(tx)
	transfers = append(transfers, extractTransfersFromInnerInstructions(inner, tx.Message.AccountKeys)...)

	signerSet := make(map[string]struct{}, len(signerAddresses))
	for _, addr := range signerAddresses {
		signerSet[addr] = struct{}{}
	}
	for _, t := range transfers {
		if _, ok := signerSet[t.authority.String()]; ok {
			return nil, x402.NewVerifyError(ErrFeePayerTransferringFunds, t.authority.String(), ErrFeePayerTransferringFunds)
		}
	}

	payTo, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return nil, x402.NewVerifyError(ErrSmartWalletCannotDeriveATA, "", err.Error())
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return nil, x402.NewVerifyError(ErrSmartWalletCannotDeriveATA, "", err.Error())
	}
	expectedATAs, err := expectedDestinationATAs(payTo, mint)
	if err != nil {
		return nil, x402.NewVerifyError(err.Error(), "", err.Error())
	}

	requiredAmount, err := parseUintAmount(requirements.Amount)
	if err != nil {
		return nil, x402.NewVerifyError(ErrSmartWalletTransferMismatch, "", err.Error())
	}

	var matching []transferCheckedInfo
	for _, t := range transfers {
		if t.mint.String() != requirements.Asset {
			continue
		}
		if _, ok := expectedATAs[t.destination]; !ok {
			continue
		}
		if t.amount >= requiredAmount {
			matching = append(matching, t)
		}
	}

	if len(matching) == 0 {
		if len(transfers) == 0 {
			return nil, x402.NewVerifyError(ErrSmartWalletNoTransferInSimulation, "", ErrSmartWalletNoTransferInSimulation)
		}
		return nil, x402.NewVerifyError(ErrSmartWalletTransferMismatch, transfers[0].authority.String(), ErrSmartWalletTransferMismatch)
	}
	if len(matching) > 1 {
		return nil, x402.NewVerifyError(ErrSmartWalletMultipleMatchingTransfers, matching[0].authority.String(), ErrSmartWalletMultipleMatchingTransfers)
	}
	return &matching[0], nil
}

func parseUintAmount(amount string) (uint64, error) {
	return strconv.ParseUint(amount, 10, 64)
}

func balanceDeltaMeetsAmount(after, before, required uint64) bool {
	return after >= before && after-before >= required
}

func verifyPostSettlement(
	ctx context.Context,
	caps svm.SmartWalletRPCCapabilities,
	signature solana.Signature,
	network string,
	requirements types.PaymentRequirements,
	signerAddresses []string,
	balanceBefore *uint64,
	knownDestinationATA *solana.PublicKey,
) bool {
	requiredAmount, err := parseUintAmount(requirements.Amount)
	if err != nil {
		return false
	}

	signerSet := make(map[string]struct{}, len(signerAddresses))
	for _, addr := range signerAddresses {
		signerSet[addr] = struct{}{}
	}

	var lastInner []rpc.InnerInstruction
	var lastKeys solana.PublicKeySlice
	for attempt := 0; attempt < postSettlementInnerRetries; attempt++ {
		inner, keys, fetchErr := caps.GetConfirmedTransactionInnerInstructions(ctx, signature, network)
		if fetchErr == nil && inner != nil {
			lastInner, lastKeys = inner, keys
			break
		}
		if attempt < postSettlementInnerRetries-1 {
			time.Sleep(time.Duration(100*(attempt+1)) * time.Millisecond)
		}
	}

	if lastInner != nil {
		expectedATAs := map[solana.PublicKey]struct{}{}
		if knownDestinationATA != nil {
			expectedATAs[*knownDestinationATA] = struct{}{}
		} else if payTo, payToErr := solana.PublicKeyFromBase58(requirements.PayTo); payToErr == nil {
			if mint, mintErr := solana.PublicKeyFromBase58(requirements.Asset); mintErr == nil {
				if atas, ataErr := expectedDestinationATAs(payTo, mint); ataErr == nil {
					expectedATAs = atas
				}
			}
		}
		for _, t := range extractTransfersFromInnerInstructions(lastInner, lastKeys) {
			if t.mint.String() != requirements.Asset {
				continue
			}
			if _, ok := expectedATAs[t.destination]; !ok {
				continue
			}
			if t.amount < requiredAmount {
				continue
			}
			if _, self := signerSet[t.authority.String()]; self {
				continue
			}
			return true
		}
		return false
	}

	if balanceBefore == nil {
		return false
	}
	if knownDestinationATA != nil {
		after, exists, balErr := caps.GetTokenAccountBalance(ctx, *knownDestinationATA, network)
		if balErr != nil || !exists {
			return false
		}
		return balanceDeltaMeetsAmount(after, *balanceBefore, requiredAmount)
	}

	payTo, err := solana.PublicKeyFromBase58(requirements.PayTo)
	if err != nil {
		return false
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return false
	}
	for _, program := range []solana.PublicKey{solana.TokenProgramID, solana.Token2022ProgramID} {
		ata, ataErr := findATA(payTo, mint, program)
		if ataErr != nil {
			continue
		}
		after, exists, balErr := caps.GetTokenAccountBalance(ctx, ata, network)
		if balErr != nil || !exists {
			continue
		}
		if balanceDeltaMeetsAmount(after, *balanceBefore, requiredAmount) {
			return true
		}
	}
	return false
}
