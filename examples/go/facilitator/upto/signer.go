package main

import (
	"context"
	"fmt"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	svmmech "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// DefaultSvmRPC is the endpoint used when SVM_RPC_URL is unset.
const DefaultSvmRPC = "https://api.devnet.solana.com"

// facilitatorSvmSigner implements svm.FacilitatorSvmSigner over a single hot
// key. For `upto` this key is the channel fee payer, rent payer, and
// zero-share payee, so it needs SOL but no token balance.
type facilitatorSvmSigner struct {
	privateKey solana.PrivateKey
	rpcClient  *rpc.Client
}

// newFacilitatorSvmSigner creates a signer from a base58 private key.
func newFacilitatorSvmSigner(privateKeyBase58 string, rpcURL string) (*facilitatorSvmSigner, error) {
	privateKey, err := solana.PrivateKeyFromBase58(privateKeyBase58)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Solana private key: %w", err)
	}
	return &facilitatorSvmSigner{
		privateKey: privateKey,
		rpcClient:  rpc.New(rpcURL),
	}, nil
}

func (s *facilitatorSvmSigner) GetAddresses(_ context.Context, _ string) []solana.PublicKey {
	return []solana.PublicKey{s.privateKey.PublicKey()}
}

// SignTransaction adds this key's signature at its slot, leaving any client
// signature already on the transaction intact.
func (s *facilitatorSvmSigner) SignTransaction(
	_ context.Context, tx *solana.Transaction, feePayer solana.PublicKey, _ string,
) error {
	if !feePayer.Equals(s.privateKey.PublicKey()) {
		return fmt.Errorf("no signer for feePayer %s (available: %s)", feePayer, s.privateKey.PublicKey())
	}

	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}
	signature, err := s.privateKey.Sign(message)
	if err != nil {
		return fmt.Errorf("failed to sign: %w", err)
	}
	index, err := tx.GetAccountIndex(s.privateKey.PublicKey())
	if err != nil {
		return fmt.Errorf("failed to get account index: %w", err)
	}
	// solana-go leaves the signature slice short of the header's signer count,
	// so grow it before writing at this signer's index.
	if len(tx.Signatures) <= int(index) {
		signatures := make([]solana.Signature, index+1)
		copy(signatures, tx.Signatures)
		tx.Signatures = signatures
	}
	tx.Signatures[index] = signature
	return nil
}

func (s *facilitatorSvmSigner) SimulateTransaction(
	ctx context.Context, tx *solana.Transaction, _ string,
) error {
	result, err := s.rpcClient.SimulateTransactionWithOpts(ctx, tx, &rpc.SimulateTransactionOpts{
		SigVerify:  false,
		Commitment: svmmech.DefaultCommitment,
	})
	if err != nil {
		return fmt.Errorf("simulation failed: %w", err)
	}
	if result != nil && result.Value != nil && result.Value.Err != nil {
		return fmt.Errorf("simulation failed: %v", result.Value.Err)
	}
	return nil
}

func (s *facilitatorSvmSigner) SendTransaction(
	ctx context.Context, tx *solana.Transaction, _ string,
) (solana.Signature, error) {
	signature, err := s.rpcClient.SendTransactionWithOpts(ctx, tx, rpc.TransactionOpts{
		SkipPreflight:       true,
		PreflightCommitment: svmmech.DefaultCommitment,
	})
	if err != nil {
		return solana.Signature{}, fmt.Errorf("failed to send transaction: %w", err)
	}
	return signature, nil
}

// ConfirmTransaction polls until the transaction is confirmed or the attempt
// budget runs out.
func (s *facilitatorSvmSigner) ConfirmTransaction(
	ctx context.Context, signature solana.Signature, _ string,
) error {
	for attempt := 0; attempt < svmmech.MaxConfirmAttempts; attempt++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		statuses, err := s.rpcClient.GetSignatureStatuses(ctx, true, signature)
		if err == nil && statuses != nil && statuses.Value != nil && len(statuses.Value) > 0 {
			if status := statuses.Value[0]; status != nil {
				if status.Err != nil {
					return fmt.Errorf("transaction %s failed onchain", signature)
				}
				if status.ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
					status.ConfirmationStatus == rpc.ConfirmationStatusFinalized {
					return nil
				}
			}
		}
		delay := svmmech.ConfirmRetryDelay
		if attempt < svmmech.ConfirmInitialAttempts {
			delay = svmmech.ConfirmInitialRetryDelay
		}
		time.Sleep(delay)
	}
	return fmt.Errorf("transaction %s was not confirmed in time", signature)
}

func (s *facilitatorSvmSigner) GetAccountInfo(
	ctx context.Context,
	account solana.PublicKey,
	_ string,
	opts *rpc.GetAccountInfoOpts,
) (*rpc.GetAccountInfoResult, error) {
	return s.rpcClient.GetAccountInfoWithOpts(ctx, account, opts)
}

func (s *facilitatorSvmSigner) GetLatestBlockhash(ctx context.Context, _ string) (solana.Hash, uint64, error) {
	latest, err := s.rpcClient.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return solana.Hash{}, 0, err
	}
	return latest.Value.Blockhash, latest.Value.LastValidBlockHeight, nil
}

func (s *facilitatorSvmSigner) GetSlot(ctx context.Context, _ string, commitment rpc.CommitmentType) (uint64, error) {
	return s.rpcClient.GetSlot(ctx, commitment)
}

func (s *facilitatorSvmSigner) SimulateTransactionWithOpts(
	ctx context.Context,
	tx *solana.Transaction,
	_ string,
	opts *rpc.SimulateTransactionOpts,
) error {
	result, err := s.rpcClient.SimulateTransactionWithOpts(ctx, tx, opts)
	if err != nil {
		return fmt.Errorf("simulation failed: %w", err)
	}
	if result != nil && result.Value != nil && result.Value.Err != nil {
		return fmt.Errorf("simulation failed: %v", result.Value.Err)
	}
	return nil
}

func (s *facilitatorSvmSigner) GetProgramAccounts(
	ctx context.Context,
	_ string,
	programID solana.PublicKey,
	opts *rpc.GetProgramAccountsOpts,
) (rpc.GetProgramAccountsResult, error) {
	return s.rpcClient.GetProgramAccountsWithOpts(ctx, programID, opts)
}

func (s *facilitatorSvmSigner) SimulateTransactionWithInnerInstructions(ctx context.Context, tx *solana.Transaction, _ string) ([]rpc.InnerInstruction, error) {
	return svmmech.SimulateWithInnerInstructions(ctx, s.rpcClient, tx)
}

func (s *facilitatorSvmSigner) GetConfirmedTransactionInnerInstructions(ctx context.Context, signature solana.Signature, _ string) ([]rpc.InnerInstruction, solana.PublicKeySlice, error) {
	return svmmech.ConfirmedTransactionInnerInstructions(ctx, s.rpcClient, signature)
}

func (s *facilitatorSvmSigner) GetTokenAccountBalance(ctx context.Context, tokenAccount solana.PublicKey, _ string) (uint64, bool, error) {
	return svmmech.TokenAccountBalance(ctx, s.rpcClient, tokenAccount)
}

func (s *facilitatorSvmSigner) FetchAddressLookupTables(ctx context.Context, tables []solana.PublicKey, _ string) (map[solana.PublicKey]solana.PublicKeySlice, error) {
	return svmmech.AddressLookupTables(ctx, s.rpcClient, tables)
}
