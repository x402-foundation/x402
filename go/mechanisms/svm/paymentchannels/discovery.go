package paymentchannels

import (
	"context"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// DiscoveredChannel is a channel account found onchain via getProgramAccounts
// and validated against the canonical PDA derivation, independent of any
// offchain metadata store.
type DiscoveredChannel struct {
	ChannelID solana.PublicKey
	Channel   Channel
}

// DiscoverChannelsByRentPayer finds every payment-channels account this
// facilitator key fronted rent for, per spec §6. It filters onchain by
// rent_payer and account size, then rejects any match that fails full
// validation rather than trusting the RPC provider's filter.
//
// This is the recovery path for channels missing from offchain storage
// (deleted, never written, or lost); it is not a substitute for the settle-
// time ChannelStorage record, which also carries the distribution recipient.
func DiscoverChannelsByRentPayer(
	ctx context.Context,
	rpcClient *rpc.Client,
	rentPayer solana.PublicKey,
) ([]DiscoveredChannel, error) {
	accountSize := uint64(ChannelAccountSize)
	results, err := rpcClient.GetProgramAccountsWithOpts(ctx, ProgramID, &rpc.GetProgramAccountsOpts{
		Encoding:   solana.EncodingBase64,
		Commitment: rpc.CommitmentConfirmed,
		DataSlice:  nil,
		Filters: []rpc.RPCFilter{
			{DataSize: accountSize},
			{Memcmp: &rpc.RPCFilterMemcmp{
				Offset: ChannelRentPayerOffset,
				Bytes:  solana.Base58(rentPayer.Bytes()),
			}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list program accounts for rent payer %s: %w", rentPayer, err)
	}

	discovered := make([]DiscoveredChannel, 0, len(results))
	for _, result := range results {
		if result == nil || result.Account == nil {
			continue
		}
		channel, err := validateDiscoveredAccount(result.Pubkey, result.Account.Owner, result.Account.Data.GetBinary())
		if err != nil {
			continue
		}
		discovered = append(discovered, DiscoveredChannel{ChannelID: result.Pubkey, Channel: *channel})
	}
	return discovered, nil
}

// validateDiscoveredAccount rejects anything getProgramAccounts's filters
// could theoretically be tricked into returning: the wrong owner, an
// undersized or malformed account, or a PDA that does not rederive to the
// address the account was found at.
func validateDiscoveredAccount(pubkey, owner solana.PublicKey, data []byte) (*Channel, error) {
	if !owner.Equals(ProgramID) {
		return nil, fmt.Errorf("account %s is owned by %s, not the payment-channels program", pubkey, owner)
	}
	channel, err := DecodeChannel(data)
	if err != nil {
		return nil, err
	}
	derived, err := FindChannelPDA(
		channel.Payer, channel.Payee, channel.Mint, channel.AuthorizedSigner,
		channel.Salt, channel.OpenSlot,
	)
	if err != nil {
		return nil, err
	}
	if !derived.Equals(pubkey) {
		return nil, fmt.Errorf("account %s does not match its derived channel PDA %s", pubkey, derived)
	}
	return channel, nil
}
