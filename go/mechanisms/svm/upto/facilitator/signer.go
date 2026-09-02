package facilitator

import (
	"context"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// UptoFacilitatorSigner is FacilitatorSvmSigner narrowed to the read and
// simulate RPC the `upto` facilitator requires at runtime. Exact-only signers
// omit the extra methods. GetProgramAccounts is optional and only needed for
// RentCleanupManager.Discover(); assertProgramAccountsSigner checks it.
type UptoFacilitatorSigner interface {
	svm.FacilitatorSvmSigner

	GetAccountInfo(
		ctx context.Context,
		account solana.PublicKey,
		network string,
		opts *rpc.GetAccountInfoOpts,
	) (*rpc.GetAccountInfoResult, error)
	GetLatestBlockhash(ctx context.Context, network string) (solana.Hash, uint64, error)
	GetSlot(ctx context.Context, network string, commitment rpc.CommitmentType) (uint64, error)
	SimulateTransactionWithOpts(
		ctx context.Context,
		tx *solana.Transaction,
		network string,
		opts *rpc.SimulateTransactionOpts,
	) error
}

// assertUptoFacilitatorSigner validates that signer exposes every RPC cap the
// `upto` facilitator needs at construction. Panics with a clear message when a
// required method is missing.
func assertUptoFacilitatorSigner(signer svm.FacilitatorSvmSigner, label string) UptoFacilitatorSigner {
	type accountInfoGetter interface {
		GetAccountInfo(context.Context, solana.PublicKey, string, *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error)
	}
	type blockhashGetter interface {
		GetLatestBlockhash(context.Context, string) (solana.Hash, uint64, error)
	}
	type slotGetter interface {
		GetSlot(context.Context, string, rpc.CommitmentType) (uint64, error)
	}
	type simWithOpts interface {
		SimulateTransactionWithOpts(context.Context, *solana.Transaction, string, *rpc.SimulateTransactionOpts) error
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
	if _, ok := signer.(simWithOpts); !ok {
		panic(fmt.Sprintf("%s requires SimulateTransactionWithOpts on the signer", label))
	}
	return signer.(UptoFacilitatorSigner)
}

// programAccountsGetter is the optional discovery sweep cap. It is not part of
// UptoFacilitatorSigner so NewUptoSvmScheme can construct without it.
type programAccountsGetter interface {
	GetProgramAccounts(
		context.Context,
		string,
		solana.PublicKey,
		*rpc.GetProgramAccountsOpts,
	) (rpc.GetProgramAccountsResult, error)
}

// assertProgramAccountsSigner validates GetProgramAccounts for discovery sweeps.
func assertProgramAccountsSigner(signer svm.FacilitatorSvmSigner, label string) programAccountsGetter {
	gpa, ok := signer.(programAccountsGetter)
	if !ok {
		panic(fmt.Sprintf("%s requires GetProgramAccounts on the signer", label))
	}
	return gpa
}

type programAccountsQuerier struct {
	signer  programAccountsGetter
	network string
}

func (q programAccountsQuerier) GetProgramAccounts(
	ctx context.Context,
	opts *rpc.GetProgramAccountsOpts,
) (rpc.GetProgramAccountsResult, error) {
	return q.signer.GetProgramAccounts(ctx, q.network, paymentchannels.ProgramID, opts)
}
