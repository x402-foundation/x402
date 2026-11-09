package paymentchannels

import (
	"encoding/binary"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

const (
	// TokenAccountLen is the base length of an SPL token account; Token-2022
	// appends its extensions after the same layout.
	TokenAccountLen = 165

	tokenAccountInitialized = 1
	tokenAccountFrozen      = 2
	// tokenAccountType is the AccountType::Account byte a Token-2022 account
	// carries at offset 165 before its extensions.
	tokenAccountType = 2
	// extensionImmutableOwner is the only account extension a settlement
	// destination may carry: it fixes the owner and nothing else, and every
	// associated token account has it.
	extensionImmutableOwner = 7
)

// TokenAccount holds the fields of an SPL token account a settlement check reads.
type TokenAccount struct {
	Mint   solana.PublicKey
	Owner  solana.PublicKey
	Amount uint64
	State  byte
	// UnsupportedExtension is the first extension outside the allowlist, or
	// -1 when every extension is allowed.
	UnsupportedExtension int
}

// DecodeTokenAccount decodes a token account, reporting false when the data is
// too short to be one (which is what an uninitialized account looks like).
func DecodeTokenAccount(data []byte) (TokenAccount, bool) {
	if len(data) < TokenAccountLen {
		return TokenAccount{}, false
	}
	return TokenAccount{
		Mint:                 solana.PublicKeyFromBytes(data[0:32]),
		Owner:                solana.PublicKeyFromBytes(data[32:64]),
		Amount:               binary.LittleEndian.Uint64(data[64:72]),
		State:                data[108],
		UnsupportedExtension: unsupportedAccountExtension(data),
	}, true
}

// unsupportedAccountExtension returns the first extension outside the
// allowlist. A malformed or truncated TLV list reports 0xffff rather than being
// skipped: the caller decides from it whether to accept an escrow.
func unsupportedAccountExtension(data []byte) int {
	if len(data) == TokenAccountLen {
		return -1
	}
	if data[TokenAccountLen] != tokenAccountType {
		return int(data[TokenAccountLen])
	}
	cursor := TokenAccountLen + 1
	for cursor < len(data) {
		padding := true
		for _, b := range data[cursor:] {
			if b != 0 {
				padding = false
				break
			}
		}
		if padding {
			return -1
		}
		if cursor+4 > len(data) {
			return 0xffff
		}
		extension := int(binary.LittleEndian.Uint16(data[cursor : cursor+2]))
		length := int(binary.LittleEndian.Uint16(data[cursor+2 : cursor+4]))
		if extension != extensionImmutableOwner {
			return extension
		}
		next := cursor + 4 + length
		if next > len(data) {
			return 0xffff
		}
		cursor = next
	}
	return -1
}

// UnusableSettlementAccount reports why a token account cannot take a
// settlement payout, or "" when it can. It must be an initialized, unfrozen
// account of the declared token program holding mint for owner, with no
// extension outside the allowlist: the program forfeits a payout to an
// unusable account, and the escrow is locked before the request is served.
func UnusableSettlementAccount(programOwner solana.PublicKey, data []byte, owner, mint, tokenProgram solana.PublicKey) string {
	if !programOwner.Equals(tokenProgram) {
		return fmt.Sprintf("is not owned by %s", tokenProgram)
	}
	account, ok := DecodeTokenAccount(data)
	if !ok {
		return "is not an initialized token account"
	}
	if !account.Mint.Equals(mint) {
		return fmt.Sprintf("holds mint %s rather than %s", account.Mint, mint)
	}
	if !account.Owner.Equals(owner) {
		return fmt.Sprintf("is owned by %s rather than %s", account.Owner, owner)
	}
	if account.State == tokenAccountFrozen {
		return "is frozen"
	}
	if account.UnsupportedExtension >= 0 {
		return fmt.Sprintf("carries token account extension %d", account.UnsupportedExtension)
	}
	if account.State != tokenAccountInitialized {
		return fmt.Sprintf("is in account state %d", account.State)
	}
	return ""
}
