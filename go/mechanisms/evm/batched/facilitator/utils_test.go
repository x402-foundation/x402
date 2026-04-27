package facilitator

import (
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// validConfig returns a ChannelConfig whose computed channel id is deterministic.
func validConfig() batched.ChannelConfig {
	return batched.ChannelConfig{
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

func TestParseRequirementsExtra_Nil(t *testing.T) {
	if got := parseRequirementsExtra(nil); got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestParseRequirementsExtra_Float64WithdrawDelay(t *testing.T) {
	got := parseRequirementsExtra(map[string]interface{}{
		"receiverAuthorizer":  "0xabc",
		"withdrawDelay":       float64(1800),
		"name":                "x402",
		"version":             "1",
		"assetTransferMethod": "eip3009",
	})
	if got.ReceiverAuthorizer != "0xabc" || got.WithdrawDelay != 1800 ||
		got.Name != "x402" || got.Version != "1" || got.AssetTransferMethod != "eip3009" {
		t.Fatalf("parsed = %+v", got)
	}
}

func TestParseRequirementsExtra_IntAndInt64WithdrawDelay(t *testing.T) {
	if got := parseRequirementsExtra(map[string]interface{}{"withdrawDelay": int(900)}); got.WithdrawDelay != 900 {
		t.Fatalf("int delay = %d", got.WithdrawDelay)
	}
	if got := parseRequirementsExtra(map[string]interface{}{"withdrawDelay": int64(2000)}); got.WithdrawDelay != 2000 {
		t.Fatalf("int64 delay = %d", got.WithdrawDelay)
	}
}

func TestParseRequirementsExtra_IgnoresWrongTypes(t *testing.T) {
	got := parseRequirementsExtra(map[string]interface{}{
		"receiverAuthorizer": 42,
		"withdrawDelay":      "not-a-number",
	})
	if got.ReceiverAuthorizer != "" || got.WithdrawDelay != 0 {
		t.Fatalf("unexpected coercion: %+v", got)
	}
}

func reqs(payTo, asset string) types.PaymentRequirements {
	return types.PaymentRequirements{PayTo: payTo, Asset: asset}
}

func TestValidateChannelConfig_OK(t *testing.T) {
	cfg := validConfig()
	id, err := batched.ComputeChannelId(cfg)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if err := ValidateChannelConfig(cfg, id, reqs(cfg.Receiver, cfg.Token)); err != nil {
		t.Fatalf("expected valid: %v", err)
	}
}

func TestValidateChannelConfig_ReceiverMismatch(t *testing.T) {
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg)
	err := ValidateChannelConfig(cfg, id, reqs("0xabc", cfg.Token))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrReceiverMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_TokenMismatch(t *testing.T) {
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg)
	err := ValidateChannelConfig(cfg, id, reqs(cfg.Receiver, "0xabc"))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrTokenMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_DelayBelowMin(t *testing.T) {
	cfg := validConfig()
	cfg.WithdrawDelay = batched.MinWithdrawDelay - 1
	id, _ := batched.ComputeChannelId(cfg)
	err := ValidateChannelConfig(cfg, id, reqs(cfg.Receiver, cfg.Token))
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrWithdrawDelayOutOfRange {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_DelayAboveMax(t *testing.T) {
	cfg := validConfig()
	cfg.WithdrawDelay = batched.MaxWithdrawDelay + 1
	id, _ := batched.ComputeChannelId(cfg)
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
	id, _ := batched.ComputeChannelId(cfg)
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
	id, _ := batched.ComputeChannelId(cfg)
	r := reqs(cfg.Receiver, cfg.Token)
	r.Extra = map[string]interface{}{"withdrawDelay": float64(2000)}
	err := ValidateChannelConfig(cfg, id, r)
	var ve *x402.VerifyError
	if !errors.As(err, &ve) || ve.InvalidReason != ErrWithdrawDelayMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChannelConfig_ExtraMatching(t *testing.T) {
	cfg := validConfig()
	id, _ := batched.ComputeChannelId(cfg)
	r := reqs(cfg.Receiver, cfg.Token)
	r.Extra = map[string]interface{}{
		"receiverAuthorizer": cfg.ReceiverAuthorizer,
		"withdrawDelay":      float64(cfg.WithdrawDelay),
	}
	if err := ValidateChannelConfig(cfg, id, r); err != nil {
		t.Fatalf("expected ok with matching extra: %v", err)
	}
}

func TestBuildChannelStateExtra_Shape(t *testing.T) {
	state := &batched.ChannelState{
		Balance:             big.NewInt(900),
		TotalClaimed:        big.NewInt(100),
		WithdrawRequestedAt: 42,
		RefundNonce:         big.NewInt(7),
	}
	out := BuildChannelStateExtra("0xabc", "1234", state)
	if out["channelId"] != "0xabc" {
		t.Fatalf("channelId")
	}
	if out["chargedCumulativeAmount"] != "1234" {
		t.Fatalf("charged")
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
