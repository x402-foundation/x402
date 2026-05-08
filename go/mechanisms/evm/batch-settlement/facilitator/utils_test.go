package facilitator

import (
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// validConfig returns a ChannelConfig whose computed channel id is deterministic.
func validConfig() batchsettlement.ChannelConfig {
	return batchsettlement.ChannelConfig{
		Payer:              "0x1111111111111111111111111111111111111111",
		PayerAuthorizer:    "0x2222222222222222222222222222222222222222",
		Receiver:           "0x3333333333333333333333333333333333333333",
		ReceiverAuthorizer: "0x4444444444444444444444444444444444444444",
		Token:              "0x5555555555555555555555555555555555555555",
		WithdrawDelay:      900,
		Salt:               "0x0000000000000000000000000000000000000000000000000000000000000001",
	}
}

func TestToContractChannelConfig_Roundtrips(t *testing.T) {
	cfg := validConfig()
	v := ToContractChannelConfig(cfg)
	if !strings.EqualFold(v.Payer.Hex(), cfg.Payer) {
		t.Fatalf("payer = %s", v.Payer.Hex())
	}
	if !strings.EqualFold(v.Receiver.Hex(), cfg.Receiver) {
		t.Fatalf("receiver = %s", v.Receiver.Hex())
	}
	if v.WithdrawDelay.Int64() != int64(cfg.WithdrawDelay) {
		t.Fatalf("withdrawDelay = %s", v.WithdrawDelay)
	}
	if v.Salt[31] != 0x01 {
		t.Fatalf("salt last byte = %x", v.Salt[31])
	}
}

func TestToContractChannelConfig_ShortSaltLeftPads(t *testing.T) {
	cfg := validConfig()
	cfg.Salt = "0xff"
	v := ToContractChannelConfig(cfg)
	if v.Salt[0] != 0xff {
		t.Fatalf("expected leading 0xff, got %x", v.Salt[0])
	}
	for i := 1; i < 32; i++ {
		if v.Salt[i] != 0x00 {
			t.Fatalf("byte %d should be zero, got %x", i, v.Salt[i])
		}
	}
}

func reqs(payTo, asset string) types.PaymentRequirements {
	return types.PaymentRequirements{
		PayTo:   payTo,
		Asset:   asset,
		Network: "eip155:8453",
		Extra: map[string]interface{}{
			"receiverAuthorizer": "0x4444444444444444444444444444444444444444",
		},
	}
}

func TestValidateChannelConfig_OK(t *testing.T) {
	cfg := validConfig()
	id, err := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if err := ValidateChannelConfig(cfg, id, reqs(cfg.Receiver, cfg.Token)); err != nil {
		t.Fatalf("expected valid: %v", err)
	}
}

func TestValidateChannelConfig_ReceiverMismatch(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	err := ValidateChannelConfig(cfg, id, reqs("0xabc", cfg.Token))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrReceiverMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_TokenMismatch(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	err := ValidateChannelConfig(cfg, id, reqs(cfg.Receiver, "0xabc"))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrTokenMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_DelayBelowMin(t *testing.T) {
	cfg := validConfig()
	cfg.WithdrawDelay = batchsettlement.MinWithdrawDelay - 1
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	err := ValidateChannelConfig(cfg, id, reqs(cfg.Receiver, cfg.Token))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrWithdrawDelayOutOfRange {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_DelayAboveMax(t *testing.T) {
	cfg := validConfig()
	cfg.WithdrawDelay = batchsettlement.MaxWithdrawDelay + 1
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	err := ValidateChannelConfig(cfg, id, reqs(cfg.Receiver, cfg.Token))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrWithdrawDelayOutOfRange {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_ChannelIdMismatch(t *testing.T) {
	cfg := validConfig()
	err := ValidateChannelConfig(cfg, "0xdeadbeef", reqs(cfg.Receiver, cfg.Token))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrChannelIdMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_ExtraReceiverAuthorizerMismatch(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	r := reqs(cfg.Receiver, cfg.Token)
	r.Extra = map[string]interface{}{
		"receiverAuthorizer": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	}
	err := ValidateChannelConfig(cfg, id, r)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_ExtraWithdrawDelayMismatch(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	r := reqs(cfg.Receiver, cfg.Token)
	r.Extra = map[string]interface{}{
		"receiverAuthorizer": cfg.ReceiverAuthorizer,
		"withdrawDelay":      float64(2000),
	}
	err := ValidateChannelConfig(cfg, id, r)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrWithdrawDelayMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_ExtraMatching(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	r := reqs(cfg.Receiver, cfg.Token)
	r.Extra = map[string]interface{}{
		"receiverAuthorizer": cfg.ReceiverAuthorizer,
		"withdrawDelay":      float64(cfg.WithdrawDelay),
	}
	if err := ValidateChannelConfig(cfg, id, r); err != nil {
		t.Fatalf("expected ok with matching extra: %v", err)
	}
}

// TestValidateChannelConfig_ExtraWithdrawDelayNumberShapes covers the inlined
// numeric coercion for `withdrawDelay`: JSON decoders surface int/int64/float64
// depending on source, and the validator must accept all three so callers
// don't fail on benign type drift.
func TestValidateChannelConfig_ExtraWithdrawDelayNumberShapes(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")
	for label, value := range map[string]interface{}{
		"int":     int(cfg.WithdrawDelay),
		"int64":   int64(cfg.WithdrawDelay),
		"float64": float64(cfg.WithdrawDelay),
	} {
		t.Run(label, func(t *testing.T) {
			r := reqs(cfg.Receiver, cfg.Token)
			r.Extra = map[string]interface{}{
				"receiverAuthorizer": cfg.ReceiverAuthorizer,
				"withdrawDelay":      value,
			}
			if err := ValidateChannelConfig(cfg, id, r); err != nil {
				t.Fatalf("delay=%v (%s): expected ok, got %v", value, label, err)
			}
		})
	}
}

// TestValidateChannelConfig_ExtraTypeTolerance pins parser behavior for the
// two participating Extra fields. `withdrawDelay` is silently ignored when
// non-numeric (benign type drift in JSON decoders). `receiverAuthorizer` is
// strictly required: a non-string value is treated as missing and rejected.
func TestValidateChannelConfig_ExtraTypeTolerance(t *testing.T) {
	cfg := validConfig()
	id, _ := batchsettlement.ComputeChannelId(cfg, "eip155:8453")

	// Non-numeric withdrawDelay is ignored; receiverAuthorizer is valid.
	r := reqs(cfg.Receiver, cfg.Token)
	r.Extra = map[string]interface{}{
		"receiverAuthorizer": cfg.ReceiverAuthorizer,
		"withdrawDelay":      "not-a-number",
	}
	if err := ValidateChannelConfig(cfg, id, r); err != nil {
		t.Fatalf("expected non-numeric withdrawDelay to be ignored, got %v", err)
	}

	// Non-string receiverAuthorizer is rejected (the field is mandatory).
	r.Extra = map[string]interface{}{"receiverAuthorizer": 42}
	err := ValidateChannelConfig(cfg, id, r)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("expected ErrReceiverAuthorizerMismatch, got %v", err)
	}
}

// TestBuildVerifyExtra_FlatShape pins the wire shape of the verify response.
// Verify responses return a flat extra (channelId, balance, totalClaimed,
// withdrawRequestedAt, refundNonce). If the facilitator wraps these under
// `channelState`, the server falls back to "0" for balance/totalClaimed and
// silently corrupts its tracked channel record.
// The downstream symptom is `invalid_batch_settlement_evm_refund_no_balance` at refund
// time because `channel.balance == 0 < chargedCumulativeAmount`.
func TestBuildVerifyExtra_FlatShape(t *testing.T) {
	state := &batchsettlement.ChannelState{
		Balance:             big.NewInt(900),
		TotalClaimed:        big.NewInt(100),
		WithdrawRequestedAt: 42,
		RefundNonce:         big.NewInt(7),
	}
	out := BuildVerifyExtra("0xabc", state)

	if _, hasNested := out["channelState"]; hasNested {
		t.Fatalf("verify extra must NOT wrap fields under `channelState`, got %+v", out)
	}
	if _, hasCharged := out["chargedCumulativeAmount"]; hasCharged {
		t.Fatalf("verify extra must NOT include chargedCumulativeAmount (server-only field), got %+v", out)
	}
	if out["channelId"] != "0xabc" {
		t.Fatalf("channelId = %v", out["channelId"])
	}
	if out["balance"] != "900" {
		t.Fatalf("balance = %v", out["balance"])
	}
	if out["totalClaimed"] != "100" {
		t.Fatalf("totalClaimed = %v", out["totalClaimed"])
	}
	if out["withdrawRequestedAt"] != 42 {
		t.Fatalf("withdrawRequestedAt = %v", out["withdrawRequestedAt"])
	}
	if out["refundNonce"] != "7" {
		t.Fatalf("refundNonce = %v", out["refundNonce"])
	}
}

// TestBuildSettleExtra_NestedShapeNoChargedCumulative pins the wire shape of
// the settle response. It returns a nested `channelState` containing
// channelId/balance/totalClaimed/withdrawRequestedAt/refundNonce, but NOT
// chargedCumulativeAmount, which the resource server's
// `enrichSettlementResponse` hook adds via additive merge afterwards. Emitting
// `chargedCumulativeAmount` from the facilitator triggers the enrichment policy
// to reject the duplicate field, which suppresses the merge and breaks
// downstream state.
func TestBuildSettleExtra_NestedShapeNoChargedCumulative(t *testing.T) {
	state := &batchsettlement.ChannelState{
		Balance:             big.NewInt(900),
		TotalClaimed:        big.NewInt(100),
		WithdrawRequestedAt: 42,
		RefundNonce:         big.NewInt(7),
	}
	out := BuildSettleExtra("0xabc", state)

	cs, ok := out["channelState"].(map[string]interface{})
	if !ok {
		t.Fatalf("settle extra must wrap fields under `channelState`, got %+v", out)
	}
	if _, hasCharged := cs["chargedCumulativeAmount"]; hasCharged {
		t.Fatalf("settle extra MUST NOT include chargedCumulativeAmount (server enrichSettlementResponse adds it), got %+v", cs)
	}
	if cs["channelId"] != "0xabc" {
		t.Fatalf("channelId = %v", cs["channelId"])
	}
	if cs["balance"] != "900" {
		t.Fatalf("balance = %v", cs["balance"])
	}
	if cs["totalClaimed"] != "100" {
		t.Fatalf("totalClaimed = %v", cs["totalClaimed"])
	}
	if cs["withdrawRequestedAt"] != 42 {
		t.Fatalf("withdrawRequestedAt = %v", cs["withdrawRequestedAt"])
	}
	if cs["refundNonce"] != "7" {
		t.Fatalf("refundNonce = %v", cs["refundNonce"])
	}
}

func TestErc3009AuthorizationTimeInvalidReason_Valid(t *testing.T) {
	now := time.Now().Unix()
	r := Erc3009AuthorizationTimeInvalidReason(big.NewInt(now-60), big.NewInt(now+3600))
	if r != "" {
		t.Fatalf("expected valid, got %q", r)
	}
}

func TestErc3009AuthorizationTimeInvalidReason_Expired(t *testing.T) {
	now := time.Now().Unix()
	r := Erc3009AuthorizationTimeInvalidReason(big.NewInt(now-3600), big.NewInt(now-60))
	if r != ErrValidBeforeExpired {
		t.Fatalf("expected expired, got %q", r)
	}
}

func TestErc3009AuthorizationTimeInvalidReason_FutureValidAfter(t *testing.T) {
	now := time.Now().Unix()
	r := Erc3009AuthorizationTimeInvalidReason(big.NewInt(now+3600), big.NewInt(now+7200))
	if r != ErrValidAfterInFuture {
		t.Fatalf("expected future, got %q", r)
	}
}
