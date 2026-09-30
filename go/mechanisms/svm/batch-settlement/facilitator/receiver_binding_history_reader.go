package facilitator

import (
	"context"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// NewReceiverBindingHistoryReader reads confirmed transaction history from an RPC.
// A network omitted from rpcURLByNetwork uses the public cluster default.
func NewReceiverBindingHistoryReader(rpcURLByNetwork map[string]string) ReceiverBindingHistoryReader {
	return historyReader{reads: paymentchannels.ChannelHistoryReadsFromRPC(rpcURLByNetwork)}
}

// ReceiverBindingHistoryReaderFromSigner adapts a signer's history reads.
// BatchSvmScheme does not call this. Pass the result as ReceiverBindingHistoryReader
// only when that signer is the history source the facilitator intends to use.
func ReceiverBindingHistoryReaderFromSigner(signer svm.FacilitatorSvmSigner) (ReceiverBindingHistoryReader, bool) {
	reads, ok := signer.(paymentchannels.ChannelHistoryReads)
	if !ok {
		return nil, false
	}
	return historyReader{reads: reads}, true
}

type historyReader struct {
	reads paymentchannels.ChannelHistoryReads
}

func (r historyReader) GetSignaturesForAddress(
	ctx context.Context,
	network, address string,
	before *string,
	limit *int,
) ([]ReceiverBindingHistorySignature, error) {
	account, err := solana.PublicKeyFromBase58(address)
	if err != nil {
		return nil, err
	}
	var beforeSig *solana.Signature
	if before != nil {
		parsed, err := solana.SignatureFromBase58(*before)
		if err != nil {
			return nil, err
		}
		beforeSig = &parsed
	}
	page, err := r.reads.GetSignaturesForAddress(ctx, account, network, beforeSig, limit)
	if err != nil {
		return nil, err
	}
	out := make([]ReceiverBindingHistorySignature, len(page))
	for i, item := range page {
		out[i] = ReceiverBindingHistorySignature{Signature: item.Signature, Err: item.Err}
	}
	return out, nil
}

func (r historyReader) GetTransaction(ctx context.Context, network, signature string) (string, error) {
	parsed, err := solana.SignatureFromBase58(signature)
	if err != nil {
		return "", err
	}
	return r.reads.GetTransaction(ctx, parsed, network)
}
