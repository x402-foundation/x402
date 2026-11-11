package facilitator

import (
	"context"
	"errors"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// errReservationHeld means another broadcast already holds the operation's reservation.
var errReservationHeld = errors.New("broadcast reservation held by another worker")

// recoveryGrace is how long pending-store access may run past the request deadline.
const recoveryGrace = 250 * time.Millisecond

// recoveryFallbackTimeout bounds recovery access when the request context has no deadline.
const recoveryFallbackTimeout = 5 * time.Second

// recoveryContext detaches pending-store access from request cancellation, bounded to
// the request deadline plus recoveryGrace (from now if already expired).
func recoveryContext(ctx context.Context) (context.Context, context.CancelFunc) {
	detached := context.WithoutCancel(ctx)
	deadline, ok := ctx.Deadline()
	if !ok {
		return context.WithTimeout(detached, recoveryFallbackTimeout)
	}
	if now := time.Now(); deadline.Before(now) {
		deadline = now
	}
	return context.WithDeadline(detached, deadline.Add(recoveryGrace))
}

// broadcastRecordSeparator splits a signature from the blockhash it was signed with.
// Base58 has no ':', so a bare signature is also a valid record.
const broadcastRecordSeparator = ":"

// encodeBroadcastRecord is the value held under an operation key while a broadcast
// is unresolved. The blockhash lets a retry tell a broadcast that can no longer
// land from one still in flight. An empty blockhash yields the bare signature.
func encodeBroadcastRecord(signature, blockhash string) string {
	if blockhash == "" {
		return signature
	}
	return signature + broadcastRecordSeparator + blockhash
}

// parseBroadcastRecord splits a broadcast record into its signature and blockhash.
func parseBroadcastRecord(record string) (signature, blockhash string) {
	signature, blockhash, _ = strings.Cut(record, broadcastRecordSeparator)
	return signature, blockhash
}

// blockhashOfWire returns the recent blockhash of a base64 transaction, or "" when it cannot be decoded.
func blockhashOfWire(wire string) string {
	tx, err := svm.DecodeTransaction(wire)
	if err != nil {
		return ""
	}
	return tx.Message.RecentBlockhash.String()
}

// expiredWithoutLanding reports whether a broadcast whose confirmation was never
// observed can no longer land: its blockhash is invalid and the network has no
// record of the signature. Anything uncertain answers false.
func (f *BatchSvmScheme) expiredWithoutLanding(ctx context.Context, signature solana.Signature, blockhash, network string) bool {
	if blockhash == "" {
		return false
	}
	validity, ok := f.raw.(svm.FacilitatorBlockhashCapabilities)
	history, historyOK := f.raw.(svm.FacilitatorConfirmedTransactionReader)
	if !ok || !historyOK {
		return false
	}
	hash, err := solana.HashFromBase58(blockhash)
	if err != nil {
		return false
	}
	valid, err := validity.IsBlockhashValid(ctx, hash, network)
	if err != nil || valid {
		return false
	}
	confirmed, err := history.GetConfirmedTransaction(ctx, signature, network)
	return err == nil && confirmed == nil
}

// PayoutAttributionAmbiguousError means a confirmed sweep cannot be attributed
// because the merchant recipient is also the refund or treasury beneficiary.
type PayoutAttributionAmbiguousError struct{}

func (e *PayoutAttributionAmbiguousError) Error() string {
	return "closed-channel payout shares its recipient with refund or treasury; transfer attribution is ambiguous"
}
