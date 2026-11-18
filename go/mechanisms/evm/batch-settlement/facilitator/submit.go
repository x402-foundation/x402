package facilitator

import (
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// SubmitMode is how the facilitator submits claim / refund transactions.
type SubmitMode string

const (
	SubmitModeRelay  SubmitMode = "relay"
	SubmitModeDirect SubmitMode = "direct"
)

// OnClaimedRows receives the ClaimRowKey(channelId, newTotalClaimed) of each Claimed event once a
// claim or a bundled claim+refund confirms. Rows that did not emit Claimed were no-ops and are
// absent.
type OnClaimedRows func(claimed map[string]struct{})

func notifyClaimed(onClaimed OnClaimedRows, receipt *evm.TransactionReceipt) {
	if onClaimed == nil || receipt == nil {
		return
	}
	onClaimed(batchsettlement.ClaimedRowKeys(receipt.Logs))
}

func firstOnClaimed(callbacks []OnClaimedRows) OnClaimedRows {
	if len(callbacks) == 0 {
		return nil
	}
	return callbacks[0]
}

// SubmitContext is the signers and mode used by claim and refund dispatchers.
type SubmitContext struct {
	SubmitMode          SubmitMode
	Signer              evm.FacilitatorEvmSigner
	AuthorizerSigner    batchsettlement.AuthorizerSigner
	AuthorizerSubmitter evm.FacilitatorEvmSigner
}

// AssertDirectAuthorizerSubmitter validates a dedicated authorizer submitter
// when submitMode is "direct".
func AssertDirectAuthorizerSubmitter(
	submitMode SubmitMode,
	authorizerSigner batchsettlement.AuthorizerSigner,
	authorizerSubmitter evm.FacilitatorEvmSigner,
) error {
	if submitMode != SubmitModeDirect {
		return nil
	}
	if authorizerSigner == nil {
		return fmt.Errorf(`submitMode "direct" requires authorizerSigner`)
	}
	if authorizerSubmitter == nil {
		return fmt.Errorf(`submitMode "direct" requires authorizerSubmitter`)
	}
	addresses := authorizerSubmitter.GetAddresses()
	if len(addresses) != 1 || !sameAddress(addresses[0], authorizerSigner.Address()) {
		return fmt.Errorf("authorizerSubmitter.getAddresses() must be exactly [authorizerSigner.address]")
	}
	return nil
}

// ShouldRelaySubmit reports whether this settle should use the relay
// (*WithSignature) path. A pre-signed payload always relays. Otherwise the
// configured submitMode applies ("relay" when omitted).
func ShouldRelaySubmit(submitMode SubmitMode, hasAuthorizerSignature bool) bool {
	return hasAuthorizerSignature || submitMode != SubmitModeDirect
}

func sameAddress(a, b string) bool {
	if !common.IsHexAddress(a) || !common.IsHexAddress(b) {
		return strings.EqualFold(a, b)
	}
	return common.HexToAddress(a) == common.HexToAddress(b)
}
