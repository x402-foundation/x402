package masumi

import (
	"errors"
	"math"
	"strings"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// BuyerInput are the buyer-chosen datum fields.
type BuyerInput struct {
	// BuyerReturnAddress is the optional datum buyer_return_address; empty is
	// None. It must differ from the effective seller payout target.
	BuyerReturnAddress string
}

// Lock is a built escrow lock: the inline datum and the escrow output value.
type Lock struct {
	// Datum is the inline datum CBOR for the payTo output.
	Datum []byte
	// CollateralLovelace is the datum collateral_return_lovelace.
	CollateralLovelace uint64
	// LockedLovelace is requestedLovelace + CollateralLovelace.
	LockedLovelace uint64
}

// BuildLock builds the 19-field lock datum and the lovelace the escrow output
// must carry. The collateral is client-computed so the escrow still clears its
// post-SubmitResult min-UTxO; because it is itself a datum field it is
// re-derived until it reaches a fixed point.
func BuildLock(extra *Extra, buyerAddress, asset string, amount, coinsPerUtxoByte uint64, buyer BuyerInput) (*Lock, error) {
	terms := extra.Terms
	isLovelace := strings.ToLower(asset) == cardano.LovelaceAsset
	requested, tokenCount := uint64(0), 1
	if isLovelace {
		requested, tokenCount = amount, 0
	}
	sellerReturn := ""
	if terms.SellerReturnAddress != nil {
		sellerReturn = *terms.SellerReturnAddress
	}
	build := func(collateral uint64) ([]byte, error) {
		return BuildLockDatumCBOR(LockDatumInput{
			BuyerAddress:              buyerAddress,
			SellerAddress:             terms.SellerAddress,
			BuyerReturnAddress:        buyer.BuyerReturnAddress,
			SellerReturnAddress:       sellerReturn,
			ReferenceKey:              extra.ReferenceKey,
			ReferenceSignature:        extra.ReferenceSignature,
			SellerNonce:               terms.SellerNonce,
			BuyerNonce:                terms.BuyerNonce,
			AgentIdentifier:           terms.AgentIdentifier.Hex(),
			CollateralReturnLovelace:  collateral,
			InputHash:                 terms.InputHash,
			PayByTime:                 parseBig(terms.PayByTime),
			SubmitResultTime:          parseBig(terms.SubmitResultTime),
			UnlockTime:                parseBig(terms.UnlockTime),
			ExternalDisputeUnlockTime: parseBig(terms.ExternalDisputeUnlockTime),
		})
	}

	collateral := uint64(0)
	datum, err := build(collateral)
	if err != nil {
		return nil, err
	}
	converged := false
	for round := 0; round < maxCollateralRounds; round++ {
		needed := CollateralLovelace(requested, len(datum), tokenCount, coinsPerUtxoByte)
		if needed <= collateral {
			converged = true
			break
		}
		collateral = needed
		if datum, err = build(collateral); err != nil {
			return nil, err
		}
	}
	if !converged {
		return nil, errors.New("masumi collateral did not converge; refusing to build an unspendable lock")
	}
	if requested > math.MaxUint64-collateral {
		return nil, errors.New("masumi locked lovelace overflows")
	}
	return &Lock{Datum: datum, CollateralLovelace: collateral, LockedLovelace: requested + collateral}, nil
}
