// This file tests that the batch-settlement resource server derives its charge baseline
// from on-chain totalClaimed when its local channel record is lost (e.g. after a full
// cooperative refund), so every paid request advances the voucher by at least the route price.
//
// It needs real on-chain state, so run it against a local anvil fork of Base Sepolia
// (do not point it at the live network; it spends real USDC):
//
//	anvil --fork-url https://sepolia.base.org --port 8546 --silent &
//	cd go && set -a && source .env && set +a && EVM_RPC_URL=http://127.0.0.1:8546 \
//	  go test -v -count=1 -tags=integration ./test/integration/... -run ChargeBaseline
//
// Required env: EVM_CLIENT_PRIVATE_KEY, EVM_FACILITATOR_PRIVATE_KEY,
// EVM_RESOURCE_SERVER_ADDRESS, EVM_RPC_URL (http://127.*).
package integration_test

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	baselinePrice          = int64(50_000) // route price P in USDC atoms ($0.05)
	baselineInitialDeposit = 3 * baselinePrice
)

type baselineEnv struct {
	t         *testing.T
	ctx       context.Context
	pipe      *batchedPipeline
	req       types.PaymentRequirements
	config    batchsettlement.ChannelConfig
	channelId string
}

func newBaselineEnv(t *testing.T) *baselineEnv {
	t.Helper()
	keys := loadBatchedTestKeys(t)
	if !strings.HasPrefix(keys.rpcURL, "http://127.") {
		t.Skip("needs EVM_RPC_URL pointing at a local anvil fork (http://127.*)")
	}
	pipe := buildBatchedPipeline(t, keys)
	req := pipe.requirements(fmt.Sprintf("%d", baselinePrice))
	cfg, err := pipe.clientScheme.BuildChannelConfig(req)
	if err != nil {
		t.Fatalf("build channel config: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	t.Cleanup(cancel)
	return &baselineEnv{
		t: t, ctx: ctx, pipe: pipe, req: req, config: cfg,
		channelId: pipe.channelIdForRequirements(req),
	}
}

func (e *baselineEnv) onchain() (balance, totalClaimed int64) {
	e.t.Helper()
	b, c, err := onChainChannel(e.ctx, e.pipe.facilitatorSigner, e.channelId)
	if err != nil {
		e.t.Fatalf("read channel: %v", err)
	}
	return b.Int64(), c.Int64()
}

func (e *baselineEnv) localCharged() *string {
	e.t.Helper()
	ch, err := e.pipe.serverScheme.GetStorage().Get(e.ctx, e.channelId)
	if err != nil {
		e.t.Fatalf("read local record: %v", err)
	}
	if ch == nil {
		return nil
	}
	v := ch.ChargedCumulativeAmount
	return &v
}

func (e *baselineEnv) depositPayload(deposit, maxClaimable int64) types.PaymentPayload {
	e.t.Helper()
	p, err := batchedclient.CreateBatchedEIP3009DepositPayload(
		e.ctx, e.pipe.clientSigner, e.req, e.config,
		fmt.Sprintf("%d", deposit), fmt.Sprintf("%d", maxClaimable), nil,
	)
	if err != nil {
		e.t.Fatalf("deposit payload: %v", err)
	}
	p.Accepted = e.req
	return p
}

func (e *baselineEnv) voucherPayload(maxClaimable int64) types.PaymentPayload {
	e.t.Helper()
	v, err := batchedclient.SignVoucher(e.ctx, e.pipe.clientSigner, e.channelId, fmt.Sprintf("%d", maxClaimable), e.req.Network)
	if err != nil {
		e.t.Fatalf("sign voucher: %v", err)
	}
	vp := &batchsettlement.BatchSettlementVoucherPayload{Type: "voucher", ChannelConfig: e.config, Voucher: *v}
	return types.PaymentPayload{X402Version: 2, Payload: vp.ToMap(), Accepted: e.req}
}

// pay runs verify (the gate before the protected handler) then settle, like the HTTP middleware.
// An aborted or invalid verify is reported as accepted=false.
func (e *baselineEnv) pay(p types.PaymentPayload) (accepted bool, reason string, settle *x402.SettleResponse) {
	e.t.Helper()
	v, err := e.pipe.x402Server.VerifyPayment(e.ctx, p, e.req)
	if err != nil {
		var ve *x402.VerifyError
		if errors.As(err, &ve) {
			return false, ve.InvalidReason, nil
		}
		return false, err.Error(), nil
	}
	if !v.IsValid {
		return false, v.InvalidReason, nil
	}
	s, err := e.pipe.x402Server.SettlePayment(e.ctx, p, e.req, nil)
	if err != nil {
		e.t.Fatalf("settle: %v", err)
	}
	return s.Success, s.ErrorReason, s
}

func (e *baselineEnv) fullRefund() {
	e.t.Helper()
	manager := e.pipe.serverScheme.CreateChannelManager(e.pipe.facilitatorClient, batchedTestNetwork)
	results, err := manager.Refund(e.ctx, []string{e.channelId})
	if err != nil {
		e.t.Fatalf("refund: %v", err)
	}
	if len(results) != 1 || results[0].Transaction == "" {
		e.t.Fatalf("refund failed: %+v", results)
	}
	if e.localCharged() != nil {
		e.t.Fatal("full refund must delete the local channel record")
	}
}

// establishClaimedState performs legit usage then a full refund, leaving on-chain
// totalClaimed=T>0 and no local record.
func (e *baselineEnv) establishClaimedState() int64 {
	e.t.Helper()
	ok, reason, _ := e.pay(e.depositPayload(baselineInitialDeposit, baselinePrice))
	if !ok {
		e.t.Fatalf("legit first payment failed: %s", reason)
	}
	e.fullRefund()
	balance, claimed := e.onchain()
	if claimed != baselinePrice || balance != baselinePrice {
		e.t.Fatalf("unexpected on-chain state after refund: balance=%d totalClaimed=%d", balance, claimed)
	}
	return claimed
}

func TestBatchSettlementChargeBaseline_VoucherAdvancingByPriceAfterRecordLossIsAccepted(t *testing.T) {
	e := newBaselineEnv(t)
	claimed := e.establishClaimedState()
	ok, reason, _ := e.pay(e.depositPayload(2*baselinePrice, claimed+baselinePrice))
	if !ok {
		t.Fatalf("voucher advancing by the full price was rejected: %s", reason)
	}
}

func TestBatchSettlementChargeBaseline_VoucherAdvancingByLessThanPriceAfterRecordLossIsRejected(t *testing.T) {
	e := newBaselineEnv(t)
	claimed := e.establishClaimedState()
	ok, reason, _ := e.pay(e.depositPayload(2, claimed+1))
	t.Logf("T=%d P=%d M=%d accepted=%v reason=%q", claimed, baselinePrice, claimed+1, ok, reason)
	if ok {
		t.Fatalf("voucher advancing by 1 < price %d was accepted (server charged baseline=%s, on-chain totalClaimed=%d)",
			baselinePrice, *e.localCharged(), claimed)
	}
}

func TestBatchSettlementChargeBaseline_EachRecordLossCycleAdvancesEntitlementByFullPrice(t *testing.T) {
	e := newBaselineEnv(t)
	claimed := e.establishClaimedState()
	var gains []int64
	for cycle := 1; cycle <= 3; cycle++ {
		// Try to advance by less than the price; if the server rejects it, pay the full price instead.
		max := claimed + 1
		ok, _, _ := e.pay(e.depositPayload(2, max))
		if !ok {
			max = claimed + baselinePrice
			if ok, reason, _ := e.pay(e.depositPayload(2*baselinePrice, max)); !ok {
				t.Fatalf("cycle %d: full-price voucher rejected: %s", cycle, reason)
			}
		}
		e.fullRefund()
		_, newClaimed := e.onchain()
		gains = append(gains, newClaimed-claimed)
		t.Logf("cycle %d: totalClaimed %d -> %d (+%d)", cycle, claimed, newClaimed, newClaimed-claimed)
		claimed = newClaimed
	}
	for _, g := range gains {
		if g != baselinePrice {
			t.Fatalf("entitlement gained per delivered call was %v atoms vs price %d", gains, baselinePrice)
		}
	}
}

func TestBatchSettlementChargeBaseline_ShortfallVoucherWithoutRecordLossIsRejected(t *testing.T) {
	e := newBaselineEnv(t)
	claimed := e.establishClaimedState()
	ok, _, _ := e.pay(e.depositPayload(2, claimed+1))
	if !ok {
		return // the first shortfall is already rejected, so there is nothing further to bound
	}
	chargedPtr := e.localCharged()
	if chargedPtr == nil {
		t.Fatal("expected local record after accepted payment")
	}
	charged, _ := new(big.Int).SetString(*chargedPtr, 10)
	next := new(big.Int).Add(charged, big.NewInt(1))
	ok2, _, _ := e.pay(e.voucherPayload(next.Int64()))
	if ok2 {
		t.Fatal("a second shortfall voucher was accepted without any state loss")
	}
}
