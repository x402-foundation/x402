package svm

import (
	"context"
	"errors"
	"fmt"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// ConfirmPolicy bounds one confirmation wait. The zero value uses the
// package defaults (MaxConfirmAttempts and the fast-then-slow poll).
// Tests set MaxAttempts and Sleep so a local status double does not wait.
type ConfirmPolicy struct {
	MaxAttempts     int
	InitialAttempts int
	InitialDelay    time.Duration
	RetryDelay      time.Duration
	// Sleep replaces time.Sleep when non-nil. A no-op keeps tests instant.
	Sleep func(time.Duration)
}

// DefaultConfirmPolicy is the wait used by facilitator signers.
func DefaultConfirmPolicy() ConfirmPolicy {
	return ConfirmPolicy{
		MaxAttempts:     MaxConfirmAttempts,
		InitialAttempts: ConfirmInitialAttempts,
		InitialDelay:    ConfirmInitialRetryDelay,
		RetryDelay:      ConfirmRetryDelay,
	}
}

func (p ConfirmPolicy) normalized() ConfirmPolicy {
	if p.MaxAttempts <= 0 {
		p = DefaultConfirmPolicy()
	}
	if p.Sleep == nil {
		p.Sleep = time.Sleep
	}
	return p
}

// ConfirmSignature polls getSignatureStatuses until the signature is
// confirmed or finalized, the context ends, or the attempt budget runs out.
//
// A confirmed or finalized status whose Err is set is a terminal chain
// failure (*TransactionOnchainFailureError). The signature is already
// consumed; callers must not report settlement_pending or send it again.
//
// A timeout, an RPC or transport error, a null or malformed status, and a
// status that has not reached confirmed or finalized are uncertain. Those
// errors are not terminal: the broadcast may still land. getTransaction is
// consulted only when getSignatureStatuses itself fails, matching the
// facilitator signers this helper replaces. A chain error on that fetched
// transaction is terminal; a transport failure from either call is not.
func ConfirmSignature(ctx context.Context, client *rpc.Client, signature solana.Signature, policy ConfirmPolicy) error {
	if client == nil {
		return errors.New("transaction confirmation unavailable: nil rpc client")
	}
	policy = policy.normalized()
	var lastTransport error
	for attempt := 0; attempt < policy.MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}

		// History search on every poll matches the Go facilitator signers
		// this helper replaces. A decisive status still wins on the first hit.
		statuses, err := client.GetSignatureStatuses(ctx, true, signature)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			lastTransport = err
			if decided, decErr := confirmFromTransaction(ctx, client, signature); decided {
				return decErr
			}
		} else {
			decided, decErr := decideSignatureStatuses(statuses)
			if decided {
				return decErr
			}
			lastTransport = nil
		}

		if attempt+1 == policy.MaxAttempts {
			break
		}
		delay := policy.RetryDelay
		if attempt < policy.InitialAttempts {
			delay = policy.InitialDelay
		}
		policy.Sleep(delay)
	}
	if lastTransport != nil {
		return fmt.Errorf("transaction confirmation unavailable: %w", lastTransport)
	}
	return fmt.Errorf("transaction confirmation timed out after %d attempts", policy.MaxAttempts)
}

// decideSignatureStatuses reports whether one getSignatureStatuses result is
// decisive. Only confirmed and finalized entries are chain facts. A processed
// entry, a null entry, or an execution error that has not reached those
// levels stays uncertain so a reorg or a lagging node is not called terminal.
func decideSignatureStatuses(statuses *rpc.GetSignatureStatusesResult) (bool, error) {
	if statuses == nil || len(statuses.Value) == 0 || statuses.Value[0] == nil {
		return false, nil
	}
	return decideSignatureStatus(statuses.Value[0])
}

func decideSignatureStatus(status *rpc.SignatureStatusesResult) (bool, error) {
	if status == nil {
		return false, nil
	}
	switch status.ConfirmationStatus {
	case rpc.ConfirmationStatusConfirmed, rpc.ConfirmationStatusFinalized:
		if status.Err != nil {
			return true, &TransactionOnchainFailureError{
				Message: fmt.Sprintf("transaction failed on-chain: %v", status.Err),
			}
		}
		return true, nil
	default:
		return false, nil
	}
}

func confirmFromTransaction(ctx context.Context, client *rpc.Client, signature solana.Signature) (bool, error) {
	txResult, txErr := client.GetTransaction(ctx, signature, &rpc.GetTransactionOpts{
		Encoding:   solana.EncodingBase58,
		Commitment: DefaultCommitment,
	})
	if txErr != nil || txResult == nil || txResult.Meta == nil {
		return false, nil
	}
	if txResult.Meta.Err != nil {
		return true, &TransactionOnchainFailureError{
			Message: fmt.Sprintf("transaction failed on-chain: %v", txResult.Meta.Err),
		}
	}
	return true, nil
}
