package facilitator

import (
	"context"
	"errors"
	"time"
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

// PayoutAttributionAmbiguousError means a confirmed sweep cannot be attributed
// because the merchant recipient is also the refund or treasury beneficiary.
type PayoutAttributionAmbiguousError struct{}

func (e *PayoutAttributionAmbiguousError) Error() string {
	return "closed-channel payout shares its recipient with refund or treasury; transfer attribution is ambiguous"
}
