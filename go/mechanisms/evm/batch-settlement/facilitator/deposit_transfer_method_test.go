package facilitator

import (
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

func depositPayloadWith(permit2, erc3009 bool) *batchsettlement.BatchSettlementDepositPayload {
	auth := batchsettlement.BatchSettlementDepositAuthorization{}
	if permit2 {
		auth.Permit2Authorization = &batchsettlement.BatchSettlementPermit2Authorization{}
	}
	if erc3009 {
		auth.Erc3009Authorization = &batchsettlement.BatchSettlementErc3009Authorization{}
	}
	return &batchsettlement.BatchSettlementDepositPayload{
		Deposit: batchsettlement.BatchSettlementDepositData{Authorization: auth},
	}
}

// The requirements `assetTransferMethod` hint is authoritative over the payload shape, matching
// the TypeScript and Python SDKs. Routing the same request differently per SDK would let a
// payment verify on one and revert on another.
func TestResolveDepositTransferMethodPrecedence(t *testing.T) {
	hint := func(v string) types.PaymentRequirements {
		return types.PaymentRequirements{Extra: map[string]interface{}{"assetTransferMethod": v}}
	}
	noHint := types.PaymentRequirements{}

	if got := resolveDepositTransferMethod(depositPayloadWith(true, false), hint("eip3009")); got != batchsettlement.AssetTransferMethodEip3009 {
		t.Fatalf("hint=eip3009 should win over a permit2 payload, got %s", got)
	}
	if got := resolveDepositTransferMethod(depositPayloadWith(false, true), hint("permit2")); got != batchsettlement.AssetTransferMethodPermit2 {
		t.Fatalf("hint=permit2 should win over an erc3009 payload, got %s", got)
	}
	if got := resolveDepositTransferMethod(depositPayloadWith(true, false), noHint); got != batchsettlement.AssetTransferMethodPermit2 {
		t.Fatalf("permit2 payload without hint should resolve to permit2, got %s", got)
	}
	if got := resolveDepositTransferMethod(depositPayloadWith(false, true), noHint); got != batchsettlement.AssetTransferMethodEip3009 {
		t.Fatalf("erc3009 payload without hint should resolve to eip3009, got %s", got)
	}
}
