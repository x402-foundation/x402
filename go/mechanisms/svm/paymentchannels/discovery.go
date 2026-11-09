package paymentchannels

import (
	"context"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

const (
	// ChannelAccountSize is the fixed byte length of the channel account layout
	// this scheme targets. Discovery filters on it via getProgramAccounts.
	// Byte 0 is the account discriminator; 0 is reserved for uninitialized accounts.
	ChannelAccountSize = 256

	// Field offsets into the account layout, past the fixed-width scalar
	// prefix. Also usable as getProgramAccounts memcmp offsets.
	ChannelPayerOffset            = 88
	ChannelPayeeOffset            = 120
	ChannelAuthorizedSignerOffset = 152
	ChannelMintOffset             = 184
	ChannelRentPayerOffset        = 216
	ChannelOpenSlotOffset         = 248
)

// DiscoveredChannel is a channel account found onchain and validated
// independent of any offchain metadata store.
type DiscoveredChannel struct {
	ChannelID solana.PublicKey
	Channel   generated.Channel
}

// ProgramAccountsQuerier lists onchain program accounts. Facilitator signers
// implement this via a thin adapter at the call site.
type ProgramAccountsQuerier interface {
	GetProgramAccounts(ctx context.Context, opts *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error)
}

// ProgramAccountScan lists program accounts, however the caller reaches the network.
type ProgramAccountScan func(ctx context.Context, program solana.PublicKey, filters []rpc.RPCFilter) (rpc.GetProgramAccountsResult, error)

// ChannelAddressFilters selects channels by one 32-byte address field.
func ChannelAddressFilters(value solana.PublicKey, offset uint64) []rpc.RPCFilter {
	return []rpc.RPCFilter{
		{DataSize: uint64(ChannelAccountSize)},
		{Memcmp: &rpc.RPCFilterMemcmp{
			Offset: offset,
			Bytes:  solana.Base58(value.Bytes()),
		}},
	}
}

// DiscoverChannels runs a channel scan and keeps only the rows whose PDA
// rederives from their own fields. A getProgramAccounts filter result is never
// trusted on its own.
func DiscoverChannels(
	ctx context.Context,
	scan ProgramAccountScan,
	filters []rpc.RPCFilter,
	program solana.PublicKey,
) ([]DiscoveredChannel, error) {
	if program.IsZero() {
		program = ProgramID
	}
	results, err := scan(ctx, program, filters)
	if err != nil {
		return nil, err
	}
	discovered := make([]DiscoveredChannel, 0, len(results))
	for _, result := range results {
		if result == nil || result.Account == nil {
			continue
		}
		channel, valid := validateDiscoveredAccount(result.Pubkey, result.Account.Owner, result.Account.Data.GetBinary(), program)
		if !valid {
			continue
		}
		discovered = append(discovered, DiscoveredChannel{ChannelID: result.Pubkey, Channel: *channel})
	}
	return discovered, nil
}

// DiscoverChannelsByPayer finds channels a wallet opened and funded.
func DiscoverChannelsByPayer(
	ctx context.Context,
	scan ProgramAccountScan,
	payer solana.PublicKey,
	program solana.PublicKey,
) ([]DiscoveredChannel, error) {
	return DiscoverChannels(ctx, scan, ChannelAddressFilters(payer, ChannelPayerOffset), program)
}

// DiscoverChannelsByRentPayer finds every payment-channels account this
// facilitator key fronted rent for. It filters onchain by rent_payer and
// account size, then rejects any match that fails full validation rather than
// trusting the RPC provider's filter.
//
// This is the recovery path for channels missing from offchain storage. It is
// not a substitute for the settle-time record, which also carries the
// distribution recipient.
func DiscoverChannelsByRentPayer(
	ctx context.Context,
	querier ProgramAccountsQuerier,
	rentPayer solana.PublicKey,
) ([]DiscoveredChannel, error) {
	scan := func(ctx context.Context, program solana.PublicKey, filters []rpc.RPCFilter) (rpc.GetProgramAccountsResult, error) {
		return querier.GetProgramAccounts(ctx, &rpc.GetProgramAccountsOpts{
			Encoding:   solana.EncodingBase64,
			Commitment: rpc.CommitmentConfirmed,
			Filters:    filters,
		})
	}
	found, err := DiscoverChannels(ctx, scan, ChannelAddressFilters(rentPayer, ChannelRentPayerOffset), ProgramID)
	if err != nil {
		return nil, fmt.Errorf("failed to list program accounts for rent payer %s: %w", rentPayer, err)
	}
	return found, nil
}

// validateDiscoveredAccount rejects anything getProgramAccounts's filters
// could theoretically be tricked into returning: the wrong owner, an
// undersized or malformed account, or a PDA that does not rederive to the
// address the account was found at.
func validateDiscoveredAccount(pubkey, owner solana.PublicKey, data []byte, program solana.PublicKey) (*generated.Channel, bool) {
	if !owner.Equals(program) {
		return nil, false
	}
	channel, err := DecodeChannel(data)
	if err != nil {
		return nil, false
	}
	derived, err := findChannelPDA(
		program, channel.Payer, channel.Payee, channel.Mint, channel.AuthorizedSigner,
		channel.Salt, channel.OpenSlot,
	)
	if err != nil || !derived.Equals(pubkey) {
		return nil, false
	}
	return channel, true
}
