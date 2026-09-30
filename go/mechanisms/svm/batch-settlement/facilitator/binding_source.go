package facilitator

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

// AssertDelegatedReceiverAuth requires the delegated-auth callbacks when the option is set.
func AssertDelegatedReceiverAuth(delegated *DelegatedReceiverAuth) (*DelegatedReceiverAuth, error) {
	if delegated == nil {
		return nil, nil
	}
	if !svm.ValidateSolanaAddress(delegated.ReceiverAuthorizer) || delegated.ResolveCallerIdentity == nil {
		return nil, errors.New("delegatedReceiverAuth requires a receiverAuthorizer address and resolveCallerIdentity")
	}
	return delegated, nil
}

// ChannelBinding is the receiver authorizer and caller identity read from one
// channel row, then history.
type ChannelBinding struct {
	// ReceiverAuthorizer is empty when no binding is stored or recoverable.
	ReceiverAuthorizer string
	CallerIdentity     string
}

// ReadReceiverAuthorizer returns the receiver authorizer bound to a channel:
// the channel row, then the open transaction. A stored key is not re-read. A
// history read is written back with RecordOpen when the row is absent. An
// empty stored key is a miss: discovery indexes a channel without the binding
// memo. loaded, when set, is a row already read so seal and refund do not get twice.
func ReadReceiverAuthorizer(
	ctx context.Context,
	storage paymentchannels.PaymentChannelStorage,
	history ReceiverBindingHistoryReader,
	network, channelID string,
	loaded *paymentchannels.PaymentChannelRecord,
) (ChannelBinding, error) {
	record := loaded
	if record == nil {
		stored, err := storage.Get(ctx, network, channelID)
		if err != nil {
			return ChannelBinding{}, err
		}
		record = stored
	}
	callerIdentity := ""
	if record != nil {
		callerIdentity = record.CallerIdentity
		if record.ReceiverAuthorizer != "" {
			return ChannelBinding{ReceiverAuthorizer: record.ReceiverAuthorizer, CallerIdentity: callerIdentity}, nil
		}
	}
	if history == nil {
		return ChannelBinding{CallerIdentity: callerIdentity}, nil
	}
	fromHistory, err := readBindingFromHistory(ctx, history, network, channelID)
	if err != nil || fromHistory == "" {
		return ChannelBinding{CallerIdentity: callerIdentity}, err
	}
	if record == nil {
		requested := paymentchannels.PaymentChannelRecord{
			Network:            network,
			ChannelID:          channelID,
			LastActivityAt:     time.Now(),
			ReceiverAuthorizer: fromHistory,
		}
		write, err := storage.RecordOpen(ctx, requested)
		if err != nil {
			return ChannelBinding{}, err
		}
		if err := paymentchannels.CheckOpenBindings(requested, write.Record); err != nil {
			if errors.Is(err, paymentchannels.ErrReceiverAuthorizerConflict) || errors.Is(err, paymentchannels.ErrCallerIdentityConflict) {
				return ChannelBinding{}, fmt.Errorf("%s: %s", batchsettlement.ErrReceiverAuthorizerMismatch, err.Error())
			}
			return ChannelBinding{}, err
		}
	}
	return ChannelBinding{ReceiverAuthorizer: fromHistory, CallerIdentity: callerIdentity}, nil
}

// DelegatedIdentityForOpen returns the caller identity required before a delegated open is broadcast.
func DelegatedIdentityForOpen(
	ctx context.Context,
	delegated *DelegatedReceiverAuth,
	receiverAuthorizer, channelID, payer string,
	requirements types.PaymentRequirements,
	facilitatorContext any,
) (string, error) {
	if delegated == nil || receiverAuthorizer != delegated.ReceiverAuthorizer {
		return "", nil
	}
	identity, err := ResolveDelegatedIdentity(ctx, delegated, DelegatedSettleContext{
		Step:               DelegatedStepDeposit,
		ChannelID:          channelID,
		Network:            requirements.Network,
		Payer:              payer,
		FacilitatorContext: facilitatorContext,
	})
	if err != nil {
		return "", err
	}
	if identity == "" {
		return "", fmt.Errorf("%s: caller identity is required to open a delegated channel", batchsettlement.ErrDelegatedUnauthenticated)
	}
	return identity, nil
}

// IsDelegatedAuthorizer reports whether bound is the key this facilitator advertises for delegated closes.
func IsDelegatedAuthorizer(delegated *DelegatedReceiverAuth, bound string) bool {
	return delegated != nil && delegated.ReceiverAuthorizer == bound
}

// ResolveDelegatedIdentity resolves a delegated settle's caller identity.
// An error or an empty result is unauthenticated.
func ResolveDelegatedIdentity(ctx context.Context, delegated *DelegatedReceiverAuth, settle DelegatedSettleContext) (string, error) {
	if delegated == nil || delegated.ResolveCallerIdentity == nil {
		return "", nil
	}
	identity, err := delegated.ResolveCallerIdentity(ctx, settle)
	if err != nil || identity == "" {
		return "", nil //nolint:nilerr // an identity error is unauthenticated, not a transport failure
	}
	return identity, nil
}

// RequireReceiverAuthorizer requires the stored binding to be the advertised key.
func RequireReceiverAuthorizer(bound, advertised, channelID string) (string, error) {
	if bound == "" {
		return "", fmt.Errorf("%s: no receiver authorizer is bound to %s", batchsettlement.ErrReceiverBindingUnavailable, channelID)
	}
	if bound != advertised {
		return "", fmt.Errorf("%s: advertised key is not the channel's binding", batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	return bound, nil
}

// CalculateDistributionAmount sums the still-undistributed settled amount across channels.
func CalculateDistributionAmount(channels []struct{ PayoutWatermark, Settled uint64 }) (uint64, error) {
	var total uint64
	for _, channel := range channels {
		if channel.PayoutWatermark > channel.Settled {
			return 0, fmt.Errorf("%s: payout watermark exceeds settled amount", batchsettlement.ErrChannelState)
		}
		total += channel.Settled - channel.PayoutWatermark
	}
	return total, nil
}

func readBindingFromHistory(
	ctx context.Context,
	history ReceiverBindingHistoryReader,
	network, channelID string,
) (string, error) {
	limit := BindingHistoryPageLimit
	var pages [][]ReceiverBindingHistorySignature
	var before *string
	for {
		page, err := history.GetSignaturesForAddress(ctx, network, channelID, before, &limit)
		if err != nil {
			return "", err
		}
		if len(page) == 0 {
			break
		}
		pages = append(pages, page)
		oldest := page[len(page)-1]
		if len(page) < BindingHistoryPageLimit {
			break
		}
		before = &oldest.Signature
	}
	for pageIndex := len(pages) - 1; pageIndex >= 0; pageIndex-- {
		page := pages[pageIndex]
		for index := len(page) - 1; index >= 0; index-- {
			item := page[index]
			if item.Err != nil {
				continue
			}
			wire, err := history.GetTransaction(ctx, network, item.Signature)
			if err != nil {
				return "", err
			}
			if wire == "" {
				continue
			}
			bound, ok := batchsettlement.ReadReceiverBindingFromOpen(wire, channelID)
			if ok {
				return bound, nil
			}
		}
	}
	return "", nil
}
