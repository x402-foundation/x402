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

// broadcastRecordSeparator splits a signature, the blockhash it was signed with and
// the signed transaction. Neither base58 nor base64 has ':', so a bare signature
// and a signature:blockhash pair are also valid records.
const broadcastRecordSeparator = ":"

// encodeBroadcastRecord is the value held under an operation key while a broadcast
// is unresolved. The blockhash lets a retry tell a broadcast that can no longer
// land from one still in flight. The wire, kept only once a confirmation timed
// out, lets that retry send the same transaction again. Empty trailing parts are
// omitted.
func encodeBroadcastRecord(signature, blockhash, wire string) string {
	switch {
	case wire != "":
		return signature + broadcastRecordSeparator + blockhash + broadcastRecordSeparator + wire
	case blockhash != "":
		return signature + broadcastRecordSeparator + blockhash
	default:
		return signature
	}
}

// parseBroadcastRecord splits a broadcast record into its signature, blockhash and wire.
func parseBroadcastRecord(record string) (signature, blockhash, wire string) {
	signature, rest, _ := strings.Cut(record, broadcastRecordSeparator)
	blockhash, wire, _ = strings.Cut(rest, broadcastRecordSeparator)
	return signature, blockhash, wire
}

// blockhashOfWire returns the recent blockhash of a base64 transaction, or "" when it cannot be decoded.
func blockhashOfWire(wire string) string {
	tx, err := svm.DecodeTransaction(wire)
	if err != nil {
		return ""
	}
	return tx.Message.RecentBlockhash.String()
}

// resendKept sends a kept transaction again, so a broadcast that never reached
// a leader can still land before its blockhash expires. Errors are ignored:
// the confirmation that follows decides the outcome.
func (f *BatchSvmScheme) resendKept(ctx context.Context, signature solana.Signature, wire, network string) {
	if wire == "" {
		return
	}
	tx, err := svm.DecodeTransaction(wire)
	if err != nil || len(tx.Signatures) == 0 || tx.Signatures[0] != signature {
		return
	}
	_, _ = f.raw.SendTransaction(ctx, tx, network)
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

// PayoutAttributionAmbiguousError means a confirmed transaction's payout cannot be
// attributed: the merchant recipient is also the refund or treasury beneficiary, or
// (with Cause set) the visible transaction does not carry the balances the payout is
// read from. No retry can change either, so the outcome is terminal.
type PayoutAttributionAmbiguousError struct {
	Cause error
}

func (e *PayoutAttributionAmbiguousError) Error() string {
	if e.Cause != nil {
		return "confirmed payout cannot be attributed: " + e.Cause.Error()
	}
	return "closed-channel payout shares its recipient with refund or treasury; transfer attribution is ambiguous"
}

func (e *PayoutAttributionAmbiguousError) Unwrap() error { return e.Cause }

// unattributable marks an error read from a visible confirmed transaction as terminal.
func unattributable(err error) error {
	var ambiguous *PayoutAttributionAmbiguousError
	if errors.As(err, &ambiguous) {
		return err
	}
	return &PayoutAttributionAmbiguousError{Cause: err}
}
