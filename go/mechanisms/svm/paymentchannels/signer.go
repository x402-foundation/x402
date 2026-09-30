package paymentchannels

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// PaymentChannelFacilitatorSigner is FacilitatorSvmSigner narrowed to the caps
// payment-channel facilitator work requires. Exact-only signers omit these
// methods, so they stay off the base type.
//
// History reads are optional. ChannelHistoryReads serves them from an RPC.
// A nil transaction means that open was pruned.
type PaymentChannelFacilitatorSigner interface {
	svm.FacilitatorSvmSigner

	GetAccountInfo(
		ctx context.Context,
		account solana.PublicKey,
		network string,
		opts *rpc.GetAccountInfoOpts,
	) (*rpc.GetAccountInfoResult, error)
	GetLatestBlockhash(ctx context.Context, network string) (solana.Hash, uint64, error)
	GetSlot(ctx context.Context, network string, commitment rpc.CommitmentType) (uint64, error)
}

// AssertPaymentChannelFacilitatorSigner checks that signer exposes every cap
// payment-channel facilitator work needs. It panics when a required method is missing.
func AssertPaymentChannelFacilitatorSigner(signer svm.FacilitatorSvmSigner, label string) PaymentChannelFacilitatorSigner {
	type accountInfoGetter interface {
		GetAccountInfo(context.Context, solana.PublicKey, string, *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error)
	}
	type blockhashGetter interface {
		GetLatestBlockhash(context.Context, string) (solana.Hash, uint64, error)
	}
	type slotGetter interface {
		GetSlot(context.Context, string, rpc.CommitmentType) (uint64, error)
	}

	if _, ok := signer.(accountInfoGetter); !ok {
		panic(fmt.Sprintf("%s requires GetAccountInfo on the signer", label))
	}
	if _, ok := signer.(blockhashGetter); !ok {
		panic(fmt.Sprintf("%s requires GetLatestBlockhash on the signer", label))
	}
	if _, ok := signer.(slotGetter); !ok {
		panic(fmt.Sprintf("%s requires GetSlot on the signer", label))
	}
	return signer.(PaymentChannelFacilitatorSigner)
}

// ChannelAccountSignature is one signature touching an account, newest-first
// as returned by RPC.
type ChannelAccountSignature struct {
	Signature string
	// Err is the RPC error for a failed transaction, or nil when it succeeded.
	Err interface{}
}

// ChannelHistoryReads pages account signatures and returns base64 transaction bytes.
type ChannelHistoryReads interface {
	GetSignaturesForAddress(
		ctx context.Context,
		account solana.PublicKey,
		network string,
		before *solana.Signature,
		limit *int,
	) ([]ChannelAccountSignature, error)
	// GetTransaction returns confirmed transaction wire bytes (base64), or
	// ("", nil) when the transaction is unknown.
	GetTransaction(ctx context.Context, signature solana.Signature, network string) (string, error)
}

type channelHistoryReads struct {
	rpcURLByNetwork map[string]string
}

// ChannelHistoryReadsFromRPC reads confirmed transaction history from an RPC.
// A network omitted from rpcURLByNetwork uses the public cluster default.
// That default does not promise to retain an open for the life of a channel.
func ChannelHistoryReadsFromRPC(rpcURLByNetwork map[string]string) ChannelHistoryReads {
	if rpcURLByNetwork == nil {
		rpcURLByNetwork = map[string]string{}
	}
	return channelHistoryReads{rpcURLByNetwork: rpcURLByNetwork}
}

func (r channelHistoryReads) client(network string) (*rpc.Client, error) {
	if url := r.rpcURLByNetwork[network]; url != "" {
		return rpc.New(url), nil
	}
	config, err := svm.GetNetworkConfig(network)
	if err != nil {
		return nil, err
	}
	return rpc.New(config.RPCURL), nil
}

func (r channelHistoryReads) GetSignaturesForAddress(
	ctx context.Context,
	account solana.PublicKey,
	network string,
	before *solana.Signature,
	limit *int,
) ([]ChannelAccountSignature, error) {
	client, err := r.client(network)
	if err != nil {
		return nil, err
	}
	opts := &rpc.GetSignaturesForAddressOpts{Commitment: rpc.CommitmentConfirmed}
	if before != nil {
		opts.Before = *before
	}
	if limit != nil {
		opts.Limit = limit
	}
	page, err := client.GetSignaturesForAddressWithOpts(ctx, account, opts)
	if err != nil {
		return nil, err
	}
	out := make([]ChannelAccountSignature, 0, len(page))
	for _, item := range page {
		if item == nil {
			continue
		}
		out = append(out, ChannelAccountSignature{Signature: item.Signature.String(), Err: item.Err})
	}
	return out, nil
}

func (r channelHistoryReads) GetTransaction(ctx context.Context, signature solana.Signature, network string) (string, error) {
	client, err := r.client(network)
	if err != nil {
		return "", err
	}
	version := uint64(0)
	result, err := client.GetTransaction(ctx, signature, &rpc.GetTransactionOpts{
		Encoding:                       solana.EncodingBase64,
		Commitment:                     rpc.CommitmentConfirmed,
		MaxSupportedTransactionVersion: &version,
	})
	if errors.Is(err, rpc.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if result == nil || result.Transaction == nil {
		return "", nil
	}
	raw := result.Transaction.GetBinary()
	if len(raw) == 0 {
		return "", nil
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// ChannelRPC is the account-read surface channel helpers use.
type ChannelRPC interface {
	GetAccountInfo(
		ctx context.Context,
		account solana.PublicKey,
		opts *rpc.GetAccountInfoOpts,
	) (*rpc.GetAccountInfoResult, error)
}

type signerAccountRPC struct {
	signer  PaymentChannelFacilitatorSigner
	network string
}

func (r signerAccountRPC) GetAccountInfo(
	ctx context.Context,
	account solana.PublicKey,
	opts *rpc.GetAccountInfoOpts,
) (*rpc.GetAccountInfoResult, error) {
	return r.signer.GetAccountInfo(ctx, account, r.network, opts)
}

// AccountFetchRPC adapts a payment-channel facilitator signer to ChannelRPC so
// account reads go through the signer's transport.
func AccountFetchRPC(signer PaymentChannelFacilitatorSigner, network string) ChannelRPC {
	return signerAccountRPC{signer: signer, network: network}
}
