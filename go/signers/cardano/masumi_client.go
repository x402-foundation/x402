package cardano

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
	"github.com/x402-foundation/x402/go/v2/types"
)

// MasumiClientConfig configures the client's Masumi preflight.
type MasumiClientConfig struct {
	// BuyerInput supplies buyer-chosen datum fields per quote.
	BuyerInput func(ctx context.Context, extra *masumi.Extra) (masumi.BuyerInput, error)
	// ValidateRegistryClaim is required to pay a registered agentIdentifier.
	ValidateRegistryClaim masumi.RegistryValidator
	// RequestContent is the buyer's own content for commitment parts the
	// seller did not echo, keyed by part name.
	RequestContent map[string]interface{}
	// ValidateCustomDeployment is required to pay a non-canonical deployment.
	ValidateCustomDeployment masumi.DeploymentValidator
	// MaxCollateralLovelace defaults to masumi.DefaultMaxCollateralLovelace.
	MaxCollateralLovelace *uint64
	// MaxDeadlineHorizonMs defaults to masumi.MaxDeadlineHorizonMs.
	MaxDeadlineHorizonMs *int64
}

type masumiPayment struct {
	extra   *masumi.Extra
	buyer   masumi.BuyerInput
	payByMs int64
	input   x402cardano.ClientSignInput
}

// prepareMasumi verifies the seller's authorization before anything is built:
// schema, both COSE objects, every commitment digest, deployment, registry
// claim and the deadline window.
func (s *ClientSigner) prepareMasumi(ctx context.Context, input x402cardano.ClientSignInput) (*masumiPayment, error) {
	extra, err := masumi.ValidateExtra(input.Extra, input.Network)
	if err != nil {
		return nil, fmt.Errorf("masumi payment requirements are invalid: %w", err)
	}
	horizon := s.masumi.MaxDeadlineHorizonMs
	if horizon == nil {
		defaultHorizon := int64(masumi.MaxDeadlineHorizonMs)
		horizon = &defaultHorizon
	}
	requirements := types.PaymentRequirements{
		Scheme:            x402cardano.SchemeExact,
		Network:           input.Network,
		Asset:             input.Asset,
		Amount:            input.Amount,
		PayTo:             input.PayTo,
		MaxTimeoutSeconds: input.MaxTimeoutSeconds,
		Extra:             input.Extra,
	}
	if _, err := masumi.VerifyAuthorization(ctx, extra, requirements, masumi.AuthorizationOptions{
		ValidateRegistryClaim:    s.masumi.ValidateRegistryClaim,
		Resource:                 input.Resource,
		ValidateCustomDeployment: s.masumi.ValidateCustomDeployment,
		LocalCommitmentContent:   s.masumi.RequestContent,
		RequireAllPartContent:    true,
		MaxDeadlineHorizonMs:     horizon,
	}); err != nil {
		return nil, fmt.Errorf("masumi seller authorization failed: %w", err)
	}
	payByMs, err := strconv.ParseInt(extra.Terms.PayByTime, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid Masumi payByTime: %w", err)
	}
	if input.MaxTimeoutSeconds <= 0 {
		return nil, errors.New("masumi maxTimeoutSeconds must be positive")
	}
	nowMs := s.now().UnixMilli()
	if payByMs <= nowMs {
		return nil, errors.New("masumi client preflight failed: payByTime has expired")
	}
	if payByMs > nowMs+int64(input.MaxTimeoutSeconds)*1000 {
		return nil, errors.New("masumi client preflight failed: payByTime exceeds maxTimeoutSeconds")
	}
	var buyer masumi.BuyerInput
	if s.masumi.BuyerInput != nil {
		if buyer, err = s.masumi.BuyerInput(ctx, extra); err != nil {
			return nil, err
		}
	}
	if buyer.BuyerReturnAddress != "" && !masumi.IsKeyCredentialAddressOn(buyer.BuyerReturnAddress, input.Network) {
		return nil, errors.New("masumi buyer return address must be a key-credential address on network")
	}
	return &masumiPayment{extra: extra, buyer: buyer, payByMs: payByMs, input: input}, nil
}

// applyMasumi builds the escrow lock for the buyer and sets it on the payment
// output, whose asset paymentOutput already set.
func (s *ClientSigner) applyMasumi(p *masumiPayment, amount uint64, params *ProtocolParameters, payment *PaymentOutput) error {
	lock, err := masumi.BuildLock(p.extra, s.wallet.Address(), p.input.Asset, amount, params.CoinsPerUtxoByte, p.buyer)
	if err != nil {
		return fmt.Errorf("masumi lock: %w", err)
	}
	view, err := masumi.ParseLockDatum(hex.EncodeToString(lock.Datum))
	if err != nil {
		return fmt.Errorf("masumi client preflight could not decode the lock datum: %w", err)
	}
	if check := masumi.VerifyDatumInvariants(view, p.input.PayTo); !check.OK {
		return fmt.Errorf("masumi client preflight failed: %s (%s)", check.Reason, check.Detail)
	}
	maxCollateral := masumi.DefaultMaxCollateralLovelace
	if s.masumi.MaxCollateralLovelace != nil {
		maxCollateral = *s.masumi.MaxCollateralLovelace
	}
	if lock.CollateralLovelace > maxCollateral {
		return fmt.Errorf("masumi client preflight failed: collateral %d exceeds the configured maximum %d", lock.CollateralLovelace, maxCollateral)
	}
	payment.Datum = lock.Datum
	payment.Coin = lock.LockedLovelace
	payment.RaiseToMinUtxo = false
	return nil
}
