package facilitator

import (
	"context"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// durableResult is a broadcast that landed, or a terminal settle response.
type durableResult struct {
	OK        bool
	Replayed  bool
	Signature string
	Response  *x402.SettleResponse
}

// ProofAmountBound selects how a proof is compared with the advertised amount.
// Verify requires an exact match. Settle allows a lower metered charge.
type ProofAmountBound string

const (
	ProofAmountExact   ProofAmountBound = "exact"
	ProofAmountCeiling ProofAmountBound = "ceiling"
)

// VoucherModeBinding selects where voucher mode is read from.
// Client payments match the requirements. Redemption reads the payload, because
// one worker requirements object covers both modes.
type VoucherModeBinding string

const (
	VoucherModeRequirements VoucherModeBinding = "requirements"
	VoucherModePayload      VoucherModeBinding = "payload"
)

// DelegatedSettleStep is the settle phase passed to ResolveCallerIdentity.
type DelegatedSettleStep string

const (
	DelegatedStepDeposit DelegatedSettleStep = "deposit"
	DelegatedStepSeal    DelegatedSettleStep = "seal"
	DelegatedStepRefund  DelegatedSettleStep = "refund"
)

// DelegatedSettleContext is passed to DelegatedReceiverAuth.ResolveCallerIdentity.
type DelegatedSettleContext struct {
	Step               DelegatedSettleStep
	ChannelID          string
	Network            string
	Payer              string
	FacilitatorContext any
}

// DelegatedReceiverAuth opts the facilitator into signing closes for a caller identity.
// Advertised as /supported extra.receiverAuthorizer. The facilitator records the
// caller's identity on the channel row at open and requires the same identity to
// seal or cooperatively refund, so those closes carry no CloseAuthorization.
// Offering this mode requires ResolveCallerIdentity. The identity is written on
// the channel row and is not onchain. A lost row fails closed.
type DelegatedReceiverAuth struct {
	// ReceiverAuthorizer is advertised as /supported extra.receiverAuthorizer and bound into delegated channels.
	ReceiverAuthorizer    string
	ResolveCallerIdentity func(context.Context, DelegatedSettleContext) (string, error)
}

// BatchTerms are the terms resolved from a channel config and the facilitator's fee payer.
type BatchTerms struct {
	FeePayer           string
	ReceiverAuthorizer string
	TokenProgram       string
	WithdrawDelay      int
	Memo               *string
	VoucherSigner      string
}

// ValidatedDeposit is a deposit payload whose terms, channel, and amounts have been checked.
type ValidatedDeposit struct {
	Payload         batchsettlement.BatchDepositPayload
	Terms           BatchTerms
	ChannelID       string
	Deposit         uint64
	ExpectedDeposit uint64
	IsTopUp         bool
	Proof           batchsettlement.BatchProof
	// ProofAmount is the signed cumulative for a client voucher, or the metered charge for server mode.
	ProofAmount uint64
}

// PreparedClaim is one claim whose channel, voucher, and fee payer are ready to redeem.
type PreparedClaim struct {
	Claim        batchsettlement.BatchVoucherClaim
	ChannelID    string
	FeePayer     string
	Cumulative   uint64
	ExpiresAt    int64
	PayTo        string
	TokenProgram string
	Terms        BatchTerms
}

// PreparedDistribution is one channel whose settled amount is ready to distribute.
type PreparedDistribution struct {
	ChannelConfig batchsettlement.BatchChannelConfig
	ChannelID     string
	FeePayer      string
	Terms         BatchTerms
}

// ReceiverBindingHistorySignature is one signature touching a channel account, newest-first.
type ReceiverBindingHistorySignature struct {
	Signature string
	// Err is the RPC error for a failed transaction, or nil when it succeeded.
	Err interface{}
}

// ReceiverBindingHistoryReader reconstructs a channel's receiver-authorizer
// binding from its open transaction. A pruned history fails closed: GetTransaction
// returns an empty string.
type ReceiverBindingHistoryReader interface {
	GetSignaturesForAddress(
		ctx context.Context,
		network string,
		address string,
		before *string,
		limit *int,
	) ([]ReceiverBindingHistorySignature, error)
	// GetTransaction returns confirmed transaction bytes, or "" when the signature is unknown.
	GetTransaction(ctx context.Context, network, signature string) (string, error)
}

// OnDistributionConfirmed runs before a payout is marked complete. Implementations must deduplicate by transaction.
type OnDistributionConfirmed func(ctx context.Context, response *x402.SettleResponse, requirements types.PaymentRequirements) error
