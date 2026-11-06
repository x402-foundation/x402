package batchsettlement

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

func sampleConfig() ChannelConfig {
	return ChannelConfig{
		Payer:              "0x1111111111111111111111111111111111111111",
		PayerAuthorizer:    "0x2222222222222222222222222222222222222222",
		Receiver:           "0x3333333333333333333333333333333333333333",
		ReceiverAuthorizer: "0x4444444444444444444444444444444444444444",
		Token:              "0x5555555555555555555555555555555555555555",
		WithdrawDelay:      900,
		Salt:               "0x0000000000000000000000000000000000000000000000000000000000000001",
	}
}

const testNetwork = "eip155:8453"

func TestComputeChannelId_Deterministic(t *testing.T) {
	cfg := sampleConfig()
	a, err := ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	b, err := ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a != b {
		t.Fatalf("non-deterministic: %s vs %s", a, b)
	}
	if !strings.HasPrefix(a, "0x") || len(a) != 66 {
		t.Fatalf("expected 0x-prefixed 32-byte hex; got %q", a)
	}
}

func TestComputeChannelId_DistinctConfigsDiffer(t *testing.T) {
	a, _ := ComputeChannelId(sampleConfig(), testNetwork)
	cfg2 := sampleConfig()
	cfg2.Salt = "0x0000000000000000000000000000000000000000000000000000000000000002"
	b, _ := ComputeChannelId(cfg2, testNetwork)
	if a == b {
		t.Fatal("different salts produced same channelId")
	}

	cfg3 := sampleConfig()
	cfg3.WithdrawDelay = 901
	c, _ := ComputeChannelId(cfg3, testNetwork)
	if a == c {
		t.Fatal("different withdrawDelay produced same channelId")
	}
}

func TestComputeChannelId_AcceptsShortSalt(t *testing.T) {
	cfg := sampleConfig()
	cfg.Salt = "0x01"
	if _, err := ComputeChannelId(cfg, testNetwork); err != nil {
		t.Fatalf("short salt rejected: %v", err)
	}
}

func TestComputeChannelId_RejectsTooLongSalt(t *testing.T) {
	cfg := sampleConfig()
	cfg.Salt = "0x" + strings.Repeat("ab", 33)
	if _, err := ComputeChannelId(cfg, testNetwork); err == nil {
		t.Fatal("expected error")
	}
}

func TestNormalizeChannelId(t *testing.T) {
	cases := map[string]string{
		"0xABCDEF0000000000000000000000000000000000000000000000000000000000": "0xabcdef0000000000000000000000000000000000000000000000000000000000",
		"0x00000000000000000000000000000000000000000000000000000000000000ab": "0x00000000000000000000000000000000000000000000000000000000000000ab",
		"0xAbCdEf1234567890AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
	}
	for in, want := range cases {
		got, err := NormalizeChannelId(in)
		if err != nil {
			t.Fatalf("NormalizeChannelId(%q): unexpected err %v", in, err)
		}
		if got != want {
			t.Fatalf("NormalizeChannelId(%q) = %q, want %q", in, got, want)
		}
	}

	invalid := []string{"0xABCDEF", "0xabc", "0x", "not-a-channel-id", "", "../../../etc/passwd", "/etc/passwd"}
	for _, in := range invalid {
		if _, err := NormalizeChannelId(in); err == nil {
			t.Fatalf("NormalizeChannelId(%q): expected error", in)
		}
	}
}

func TestIsCanonicalChannelId(t *testing.T) {
	if !IsCanonicalChannelId("0xAbCdEf1234567890AbCdEf1234567890AbCdEf1234567890AbCdEf1234567890") {
		t.Fatal("expected mixed-case 64-hex to be canonical")
	}
	for _, in := range []string{"0x1234", "", "0x" + strings.Repeat("g", 64), "../../../etc/passwd"} {
		if IsCanonicalChannelId(in) {
			t.Fatalf("IsCanonicalChannelId(%q) = true", in)
		}
	}
}

func TestChannelIdBindingError(t *testing.T) {
	cfg := sampleConfig()
	id, err := ComputeChannelId(cfg, testNetwork)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	if got := ChannelIdBindingError(cfg, id, testNetwork); got != "" {
		t.Fatalf("expected empty binding error, got %q", got)
	}
	if got := ChannelIdBindingError(cfg, "0x"+strings.ToUpper(id[2:]), testNetwork); got != "" {
		t.Fatalf("mixed-case id should bind, got %q", got)
	}
	if got := ChannelIdBindingError(cfg, "0xabcd", testNetwork); got != ErrInvalidChannelId {
		t.Fatalf("malformed = %q, want %q", got, ErrInvalidChannelId)
	}
	wrong := "0x" + strings.Repeat("11", 32)
	if got := ChannelIdBindingError(cfg, wrong, testNetwork); got != ErrChannelIdMismatch {
		t.Fatalf("mismatch = %q, want %q", got, ErrChannelIdMismatch)
	}
}

func TestGetBatchSettlementEip712Domain(t *testing.T) {
	chainId := big.NewInt(8453)
	d := GetBatchSettlementEip712Domain(chainId)
	if d.Name != BatchSettlementDomain.Name {
		t.Fatalf("Name = %q", d.Name)
	}
	if d.Version != BatchSettlementDomain.Version {
		t.Fatalf("Version = %q", d.Version)
	}
	if d.ChainID == nil || d.ChainID.Cmp(chainId) != 0 {
		t.Fatalf("ChainID = %v", d.ChainID)
	}
	if d.VerifyingContract != BatchSettlementAddress {
		t.Fatalf("VerifyingContract = %q", d.VerifyingContract)
	}
}

func TestHexToBytes32_LeftPads(t *testing.T) {
	out, err := hexToBytes32("0x01")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	for i := range 31 {
		if out[i] != 0 {
			t.Fatalf("byte %d should be zero, got %x", i, out[i])
		}
	}
	if out[31] != 1 {
		t.Fatalf("byte 31 = %x, want 0x01", out[31])
	}
}

func TestHexToBytes32_NoPrefix(t *testing.T) {
	out, err := hexToBytes32("01")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out[31] != 1 {
		t.Fatalf("byte 31 = %x", out[31])
	}
}

func TestHexToBytes32_TooLong(t *testing.T) {
	if _, err := hexToBytes32("0x" + strings.Repeat("a", 65)); err == nil {
		t.Fatal("expected error")
	}
}

func TestNormalizeChannelSalt_LeftPadsNumberBigintAndHex(t *testing.T) {
	const bytes32One = "0x0000000000000000000000000000000000000000000000000000000000000001"
	for _, in := range []interface{}{1, int64(1), uint64(1), big.NewInt(1), "0x1", bytes32One} {
		got, err := NormalizeChannelSalt(in)
		if err != nil {
			t.Fatalf("NormalizeChannelSalt(%v): %v", in, err)
		}
		if got != bytes32One {
			t.Fatalf("NormalizeChannelSalt(%v) = %q, want %q", in, got, bytes32One)
		}
	}
}

func TestNormalizeChannelSalt_RejectsNegativeNonIntegerAndOversized(t *testing.T) {
	if _, err := NormalizeChannelSalt(-1); err == nil {
		t.Fatal("expected error for negative int")
	}
	if _, err := NormalizeChannelSalt(1.5); err == nil {
		t.Fatal("expected error for non-integer")
	}
	if _, err := NormalizeChannelSalt(new(big.Int).Neg(big.NewInt(1))); err == nil {
		t.Fatal("expected error for negative bigint")
	}
	tooBig := new(big.Int).Lsh(big.NewInt(1), 256)
	if _, err := NormalizeChannelSalt(tooBig); err == nil {
		t.Fatal("expected error for 2^256")
	}
	if _, err := NormalizeChannelSalt("0xzz"); err == nil {
		t.Fatal("expected error for non-hex")
	}
}

func TestParseChannelSalt_AcceptsEmptyDecimalAndHex(t *testing.T) {
	const zero = "0x0000000000000000000000000000000000000000000000000000000000000000"
	const one = "0x0000000000000000000000000000000000000000000000000000000000000001"
	cases := map[string]string{
		"":       zero,
		"   ":    zero,
		"0":      zero,
		"1":      one,
		"42":     "0x000000000000000000000000000000000000000000000000000000000000002a",
		" 1 ":    one,
		"0x1":    one,
		"0X1":    one,
		"0xfeed": "0x000000000000000000000000000000000000000000000000000000000000feed",
		zero:     zero,
		one:      one,
	}
	for in, want := range cases {
		got, err := ParseChannelSalt(in)
		if err != nil {
			t.Fatalf("ParseChannelSalt(%q): %v", in, err)
		}
		if got != want {
			t.Fatalf("ParseChannelSalt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseChannelSalt_RejectsInvalid(t *testing.T) {
	for _, in := range []string{"0xzz", "abc", "-1", "1.5", "0x" + strings.Repeat("ff", 33)} {
		if _, err := ParseChannelSalt(in); err == nil {
			t.Fatalf("ParseChannelSalt(%q): expected error", in)
		}
	}
}

func TestPackRefundAuthorizerSalt_IncrementStyleUsesLow96(t *testing.T) {
	refundAuthorizer := "0xaaaabbbbccccddddeeeeffffaaaabbbbccccdddd"
	a, err := PackRefundAuthorizerSalt(
		"0x0000000000000000000000000000000000000000000000000000000000000011",
		refundAuthorizer,
	)
	if err != nil {
		t.Fatalf("pack a: %v", err)
	}
	b, err := PackRefundAuthorizerSalt(
		"0x0000000000000000000000000000000000000000000000000000000000000012",
		refundAuthorizer,
	)
	if err != nil {
		t.Fatalf("pack b: %v", err)
	}
	if a == b {
		t.Fatal("increment-style salts should differ")
	}
	fromShort, err := PackRefundAuthorizerSalt("0x11", refundAuthorizer)
	if err != nil {
		t.Fatalf("pack short: %v", err)
	}
	if a != fromShort {
		t.Fatalf("short salt = %q, want %q", fromShort, a)
	}
	if !strings.EqualFold(UnpackRefundAuthorizer(a), refundAuthorizer) {
		t.Fatalf("unpack a = %q", UnpackRefundAuthorizer(a))
	}
	if !strings.EqualFold(UnpackRefundAuthorizer(b), refundAuthorizer) {
		t.Fatalf("unpack b = %q", UnpackRefundAuthorizer(b))
	}
}

func TestPackRefundAuthorizerSalt_KeepsHigh12WhenNonzero(t *testing.T) {
	refundAuthorizer := "0xaaaabbbbccccddddeeeeffffaaaabbbbccccdddd"
	salt := "0xabc1230000000000000000000000000000000000000000000000000000000099"
	got, err := PackRefundAuthorizerSalt(salt, refundAuthorizer)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	padded, err := hexToBytes32(salt)
	if err != nil {
		t.Fatalf("pad: %v", err)
	}
	want := "0x" + hex.EncodeToString(padded[:12]) + strings.TrimPrefix(commonHexAddress(refundAuthorizer), "0x")
	if !strings.EqualFold(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestIsOnchainStateFresh(t *testing.T) {
	const now int64 = 1_000_000
	if IsOnchainStateFresh(CachedChannelOnchain{OnchainSyncedAt: now}, 0, now) {
		t.Fatal("ttl 0 should be stale even if just synced")
	}
	if !IsOnchainStateFresh(CachedChannelOnchain{OnchainSyncedAt: now - 1_000}, 5_000, now) {
		t.Fatal("sync inside positive ttl should be fresh")
	}
}

func TestValidateChannelConfig_MatchesRequirements(t *testing.T) {
	cfg := validateTestConfig()
	reqs := validateTestRequirements()
	id, err := ComputeChannelId(cfg, reqs.Network)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	if got := ValidateChannelConfig(cfg, id, reqs); got != "" {
		t.Fatalf("expected ok, got %q", got)
	}
}

func TestValidateChannelConfig_ChannelIdMismatch(t *testing.T) {
	cfg := validateTestConfig()
	fake := "0x0000000000000000000000000000000000000000000000000000000000000001"
	if got := ValidateChannelConfig(cfg, fake, validateTestRequirements()); got != ErrChannelIdMismatch {
		t.Fatalf("got %q, want %q", got, ErrChannelIdMismatch)
	}
}

func TestValidateChannelConfig_ReceiverMismatch(t *testing.T) {
	cfg := validateTestConfig()
	cfg.Receiver = "0x1111111111111111111111111111111111111111"
	id, _ := ComputeChannelId(cfg, validateTestRequirements().Network)
	if got := ValidateChannelConfig(cfg, id, validateTestRequirements()); got != ErrReceiverMismatch {
		t.Fatalf("got %q, want %q", got, ErrReceiverMismatch)
	}
}

func TestValidateChannelConfig_ReceiverAuthorizerMismatch(t *testing.T) {
	cfg := validateTestConfig()
	cfg.ReceiverAuthorizer = "0x2222222222222222222222222222222222222222"
	reqs := validateTestRequirements()
	reqs.Extra = map[string]interface{}{
		"receiverAuthorizer": "0x3333333333333333333333333333333333333333",
		"withdrawDelay":      900,
	}
	id, _ := ComputeChannelId(cfg, reqs.Network)
	if got := ValidateChannelConfig(cfg, id, reqs); got != ErrReceiverAuthorizerMismatch {
		t.Fatalf("got %q, want %q", got, ErrReceiverAuthorizerMismatch)
	}
}

func TestValidateChannelConfig_TokenMismatch(t *testing.T) {
	cfg := validateTestConfig()
	cfg.Token = "0xaaaa000000000000000000000000000000000000"
	id, _ := ComputeChannelId(cfg, validateTestRequirements().Network)
	if got := ValidateChannelConfig(cfg, id, validateTestRequirements()); got != ErrTokenMismatch {
		t.Fatalf("got %q, want %q", got, ErrTokenMismatch)
	}
}

func TestValidateChannelConfig_WithdrawDelayMismatch(t *testing.T) {
	cfg := validateTestConfig()
	cfg.WithdrawDelay = 1800
	id, _ := ComputeChannelId(cfg, validateTestRequirements().Network)
	if got := ValidateChannelConfig(cfg, id, validateTestRequirements()); got != ErrWithdrawDelayMismatch {
		t.Fatalf("got %q, want %q", got, ErrWithdrawDelayMismatch)
	}
}

func TestValidateChannelConfig_WithdrawDelayBelowMin(t *testing.T) {
	cfg := validateTestConfig()
	cfg.WithdrawDelay = MinWithdrawDelay - 1
	reqs := validateTestRequirements()
	reqs.Extra = map[string]interface{}{"receiverAuthorizer": cfg.ReceiverAuthorizer}
	id, _ := ComputeChannelId(cfg, reqs.Network)
	if got := ValidateChannelConfig(cfg, id, reqs); got != ErrWithdrawDelayOutOfRange {
		t.Fatalf("got %q, want %q", got, ErrWithdrawDelayOutOfRange)
	}
}

func TestValidateChannelConfig_WithdrawDelayAboveMax(t *testing.T) {
	cfg := validateTestConfig()
	cfg.WithdrawDelay = MaxWithdrawDelay + 1
	reqs := validateTestRequirements()
	reqs.Extra = map[string]interface{}{"receiverAuthorizer": cfg.ReceiverAuthorizer}
	id, _ := ComputeChannelId(cfg, reqs.Network)
	if got := ValidateChannelConfig(cfg, id, reqs); got != ErrWithdrawDelayOutOfRange {
		t.Fatalf("got %q, want %q", got, ErrWithdrawDelayOutOfRange)
	}
}

func TestValidateChannelConfig_MissingReceiverAuthorizer(t *testing.T) {
	cfg := validateTestConfig()
	cfg.ReceiverAuthorizer = "0x2222222222222222222222222222222222222222"
	reqs := validateTestRequirements()
	reqs.Extra = map[string]interface{}{"withdrawDelay": 900}
	id, _ := ComputeChannelId(cfg, reqs.Network)
	if got := ValidateChannelConfig(cfg, id, reqs); got != ErrReceiverAuthorizerMismatch {
		t.Fatalf("got %q, want %q", got, ErrReceiverAuthorizerMismatch)
	}
}

func TestValidateChannelConfig_ZeroReceiverAuthorizer(t *testing.T) {
	cfg := validateTestConfig()
	cfg.ReceiverAuthorizer = zeroAddr
	reqs := validateTestRequirements()
	reqs.Extra = map[string]interface{}{
		"receiverAuthorizer": zeroAddr,
		"withdrawDelay":      900,
	}
	id, _ := ComputeChannelId(cfg, reqs.Network)
	if got := ValidateChannelConfig(cfg, id, reqs); got != ErrReceiverAuthorizerMismatch {
		t.Fatalf("got %q, want %q", got, ErrReceiverAuthorizerMismatch)
	}
}

func TestVerifyEoaVoucherSignature_MatchAndMismatch(t *testing.T) {
	key, err := crypto.HexToECDSA("5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a")
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	authorizer := crypto.PubkeyToAddress(key.PublicKey).Hex()
	channelID := "0x" + strings.Repeat("11", 32)
	payload := &BatchSettlementVoucherPayload{
		Type: "voucher",
		ChannelConfig: ChannelConfig{
			Payer:           authorizer,
			PayerAuthorizer: authorizer,
		},
		Voucher: BatchSettlementVoucherFields{
			ChannelId:          channelID,
			MaxClaimableAmount: "1000",
		},
	}
	maxClaimable := big.NewInt(1000)
	hash, err := evm.HashTypedData(
		GetBatchSettlementEip712Domain(big.NewInt(84532)),
		VoucherTypes,
		"Voucher",
		map[string]interface{}{
			"channelId":          channelID,
			"maxClaimableAmount": maxClaimable,
		},
	)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	sig, err := crypto.Sign(hash, key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sig[64] += 27
	payload.Voucher.Signature = "0x" + hex.EncodeToString(sig)

	if !VerifyEoaVoucherSignature(payload, "eip155:84532") {
		t.Fatal("expected matching signature to verify")
	}

	payload.Voucher.Signature = "0x00"
	if VerifyEoaVoucherSignature(payload, "eip155:84532") {
		t.Fatal("malformed signature should fail")
	}

	payload.Voucher.Signature = "0x" + hex.EncodeToString(sig)
	payload.ChannelConfig.PayerAuthorizer = "0x0000000000000000000000000000000000000001"
	if VerifyEoaVoucherSignature(payload, "eip155:84532") {
		t.Fatal("mismatched authorizer should fail")
	}
}

func TestEvaluateVoucherAgainstCachedState(t *testing.T) {
	cfg := validateTestConfig()
	reqs := validateTestRequirements()
	id, err := ComputeChannelId(cfg, reqs.Network)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	raw := &BatchSettlementVoucherPayload{
		Type:          "voucher",
		ChannelConfig: cfg,
		Voucher: BatchSettlementVoucherFields{
			ChannelId:          id,
			MaxClaimableAmount: "500",
		},
	}
	fresh := &CachedChannelOnchain{
		ChannelId:           id,
		Balance:             "1000",
		TotalClaimed:        "100",
		WithdrawRequestedAt: 0,
		RefundNonce:         1,
		OnchainSyncedAt:     1_000_000,
	}
	got := EvaluateVoucherAgainstCachedState(raw, reqs, fresh, 1_000_000, 5_000)
	if got == nil || !got.IsValid {
		t.Fatalf("expected valid cached accept, got %+v", got)
	}
	if got.Payer != cfg.Payer {
		t.Fatalf("payer = %q", got.Payer)
	}

	if EvaluateVoucherAgainstCachedState(raw, reqs, nil, 1_000_000, 5_000) != nil {
		t.Fatal("missing channel should fall back")
	}
	if EvaluateVoucherAgainstCachedState(raw, reqs, fresh, 1_000_000, 0) != nil {
		t.Fatal("ttl 0 should fall back")
	}

	zeroAuth := *raw
	zeroAuth.ChannelConfig.PayerAuthorizer = zeroAddr
	if EvaluateVoucherAgainstCachedState(&zeroAuth, reqs, fresh, 1_000_000, 5_000) != nil {
		t.Fatal("zero authorizer should fall back")
	}

	over := *raw
	over.Voucher.MaxClaimableAmount = "2000"
	if got := EvaluateVoucherAgainstCachedState(&over, reqs, fresh, 1_000_000, 5_000); got == nil || got.IsValid || got.InvalidReason != ErrCumulativeExceedsBalance {
		t.Fatalf("exceeds balance = %+v", got)
	}
	below := *raw
	below.Voucher.MaxClaimableAmount = "100"
	if got := EvaluateVoucherAgainstCachedState(&below, reqs, fresh, 1_000_000, 5_000); got == nil || got.IsValid || got.InvalidReason != ErrCumulativeBelowClaimed {
		t.Fatalf("below claimed = %+v", got)
	}
}

func validateTestConfig() ChannelConfig {
	return ChannelConfig{
		Payer:              "0x1234567890123456789012345678901234567890",
		PayerAuthorizer:    "0x1234567890123456789012345678901234567890",
		Receiver:           "0x9876543210987654321098765432109876543210",
		ReceiverAuthorizer: "0x1111111111111111111111111111111111111111",
		Token:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		WithdrawDelay:      900,
		Salt:               "0x0000000000000000000000000000000000000000000000000000000000000000",
	}
}

func validateTestRequirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            "batch-settlement",
		Network:           "eip155:84532",
		Amount:            "1000",
		Asset:             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		PayTo:             "0x9876543210987654321098765432109876543210",
		MaxTimeoutSeconds: 3600,
		Extra: map[string]interface{}{
			"receiverAuthorizer": "0x1111111111111111111111111111111111111111",
			"withdrawDelay":      900,
		},
	}
}

func commonHexAddress(addr string) string {
	return common.HexToAddress(addr).Hex()
}
