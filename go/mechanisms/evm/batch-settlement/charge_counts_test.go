package batchsettlement

import (
	"encoding/hex"
	"math/big"
	"reflect"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/extensions/buildercode"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

var zeroAddr = "0x0000000000000000000000000000000000000000"

var chargeCountChannel = ChannelConfig{
	Payer:              "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
	PayerAuthorizer:    zeroAddr,
	Receiver:           "0x9876543210987654321098765432109876543210",
	ReceiverAuthorizer: "0x1111111111111111111111111111111111111111",
	Token:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	WithdrawDelay:      900,
	Salt:               "0x" + strings.Repeat("00", 32),
}

func TestChargeCountsMetadataKey(t *testing.T) {
	if ChargeCountsMetadataKey != "x402ChargeCounts" {
		t.Fatalf("ChargeCountsMetadataKey = %q", ChargeCountsMetadataKey)
	}
}

func TestChargeCountsMetadata_WrapsCountsUnderKey(t *testing.T) {
	got := ChargeCountsMetadata([]uint64{3, 0, 41})
	want := map[string]any{"x402ChargeCounts": []uint64{3, 0, 41}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("metadata = %#v, want %#v", got, want)
	}
}

func TestChargeCountsMetadata_NilWhenNoClaimRows(t *testing.T) {
	if ChargeCountsMetadata(nil) != nil || ChargeCountsMetadata([]uint64{}) != nil {
		t.Fatal("expected nil metadata for zero claim rows")
	}
}

func TestChargeCountsMetadata_CopiesInput(t *testing.T) {
	counts := []uint64{1, 2}
	metadata := ChargeCountsMetadata(counts)
	counts[0] = 99
	if !uint64sEqual(ParseChargeCountsMetadata(metadata), []uint64{1, 2}) {
		t.Fatalf("metadata aliases the input slice: %v", metadata)
	}
}

func TestParseChargeCountsMetadata_RoundTripsBuiltMetadata(t *testing.T) {
	got := ParseChargeCountsMetadata(ChargeCountsMetadata([]uint64{3, 0, 41}))
	if !uint64sEqual(got, []uint64{3, 0, 41}) {
		t.Fatalf("got %v", got)
	}
}

func TestParseChargeCountsMetadata_AcceptsParsedCborValues(t *testing.T) {
	got := ParseChargeCountsMetadata(map[string]any{"x402ChargeCounts": []any{uint64(1), 2, uint(3)}})
	if !uint64sEqual(got, []uint64{1, 2, 3}) {
		t.Fatalf("got %v", got)
	}
}

func TestParseChargeCountsMetadata_AbsentKey(t *testing.T) {
	if ParseChargeCountsMetadata(nil) != nil || ParseChargeCountsMetadata(map[string]any{}) != nil {
		t.Fatal("expected nil when the key is absent")
	}
}

func TestParseChargeCountsMetadata_MalformedValues(t *testing.T) {
	for name, value := range map[string]any{
		"string":        "3",
		"map":           map[string]any{"0": uint64(3)},
		"negative":      []any{uint64(1), -1},
		"text entry":    []any{"1"},
		"float entry":   []any{1.5},
		"nested array":  []any{[]any{uint64(1)}},
		"oversized big": []any{new(big.Int).Lsh(big.NewInt(1), 70)},
	} {
		if got := ParseChargeCountsMetadata(map[string]any{"x402ChargeCounts": value}); got != nil {
			t.Fatalf("%s: got %v, want nil", name, got)
		}
	}
}

func TestParseChargeCountsMetadata_EmptyArrayStaysEmpty(t *testing.T) {
	got := ParseChargeCountsMetadata(map[string]any{"x402ChargeCounts": []any{}})
	if got == nil || len(got) != 0 {
		t.Fatalf("got %v, want empty non-nil list", got)
	}
}

// metadataSuffixHex encodes metadata into an ERC-8021 suffix through the builder-code package
// and returns it as hex.
func metadataSuffixHex(t *testing.T, data buildercode.BuilderCodeSuffixData) string {
	t.Helper()
	suffix, err := buildercode.EncodeBuilderCodeSuffix(data)
	if err != nil {
		t.Fatalf("encode suffix: %v", err)
	}
	return hex.EncodeToString(suffix)
}

func TestChargeCountsMetadata_ExampleVector(t *testing.T) {
	// The m entry of the spec example: 616d a1 70<"x402ChargeCounts"> 83 03 00 1829 (25 bytes).
	wantEntry := "616d" + "a1" + "70" + hex.EncodeToString([]byte("x402ChargeCounts")) + "83" + "03" + "00" + "1829"
	if len(wantEntry) != 25*2 {
		t.Fatalf("example m entry is %d bytes, want 25", len(wantEntry)/2)
	}

	metadataOnly := metadataSuffixHex(t, buildercode.BuilderCodeSuffixData{M: ChargeCountsMetadata([]uint64{3, 0, 41})})
	if !strings.HasPrefix(metadataOnly, "a1"+wantEntry) {
		t.Fatalf("metadata-only map = %s, want prefix a1%s", metadataOnly, wantEntry)
	}

	withCode := buildercode.BuilderCodeSuffixData{M: ChargeCountsMetadata([]uint64{3, 0, 41})}
	withCode.W = "bc_myfacilitator"
	hexSuffix := metadataSuffixHex(t, withCode)
	if !strings.Contains(hexSuffix, wantEntry) {
		t.Fatalf("suffix %s does not contain m entry %s", hexSuffix, wantEntry)
	}
	parsed, ok := buildercode.ParseBuilderCodeSuffixFromCalldata("0xdeadbeef" + hexSuffix)
	if !ok {
		t.Fatal("expected a valid suffix")
	}
	if parsed.W != "bc_myfacilitator" || !uint64sEqual(ParseChargeCountsMetadata(parsed.M), []uint64{3, 0, 41}) {
		t.Fatalf("parsed = %+v", parsed)
	}
}

func TestChargeCountsMetadata_SizeAt100Rows(t *testing.T) {
	counts := make([]uint64, 100)
	for i := range counts {
		counts[i] = uint64(i % 24)
	}
	smallest := len(metadataSuffixHex(t, buildercode.BuilderCodeSuffixData{M: ChargeCountsMetadata(counts)})) / 2
	if smallest >= 350 {
		t.Fatalf("100 one-byte counts take %d bytes, want < 350", smallest)
	}

	for i := range counts {
		counts[i] = 65535
	}
	largest := len(metadataSuffixHex(t, buildercode.BuilderCodeSuffixData{M: ChargeCountsMetadata(counts)})) / 2
	if largest >= 350 {
		t.Fatalf("100 three-byte counts take %d bytes, want < 350", largest)
	}
}

func TestChargeCountsMetadata_SurvivesTopLevelSuffixOnClaimCalldata(t *testing.T) {
	suffix, err := buildercode.EncodeBuilderCodeSuffix(buildercode.BuilderCodeSuffixData{M: ChargeCountsMetadata([]uint64{2, 9})})
	if err != nil {
		t.Fatalf("encode suffix: %v", err)
	}
	for _, fn := range []string{"claim", "claimWithSignature"} {
		calldata := evm.AppendDataSuffix(mustClaimCalldata(t, fn), suffix)
		parsed, ok := buildercode.ParseBuilderCodeSuffixFromCalldata("0x" + hex.EncodeToString(calldata))
		if !ok {
			t.Fatalf("%s: expected a valid suffix", fn)
		}
		if !uint64sEqual(ParseChargeCountsMetadata(parsed.M), []uint64{2, 9}) {
			t.Fatalf("%s: counts = %v", fn, ParseChargeCountsMetadata(parsed.M))
		}
	}
}

func uint64sEqual(got, want []uint64) bool {
	if got == nil || len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

type contractChannelConfig struct {
	Payer              common.Address
	PayerAuthorizer    common.Address
	Receiver           common.Address
	ReceiverAuthorizer common.Address
	Token              common.Address
	WithdrawDelay      *big.Int
	Salt               [32]byte
}

type voucherClaimArg struct {
	Voucher struct {
		Channel            contractChannelConfig
		MaxClaimableAmount *big.Int
	}
	Signature    []byte
	TotalClaimed *big.Int
}

func toContractChannelConfig(c ChannelConfig) contractChannelConfig {
	var salt [32]byte
	copy(salt[:], common.FromHex(c.Salt))
	return contractChannelConfig{
		Payer:              common.HexToAddress(c.Payer),
		PayerAuthorizer:    common.HexToAddress(c.PayerAuthorizer),
		Receiver:           common.HexToAddress(c.Receiver),
		ReceiverAuthorizer: common.HexToAddress(c.ReceiverAuthorizer),
		Token:              common.HexToAddress(c.Token),
		WithdrawDelay:      big.NewInt(int64(c.WithdrawDelay)),
		Salt:               salt,
	}
}

// channelWithSalt returns chargeCountChannel with the last salt byte set to suffix.
func channelWithSalt(suffix byte) ChannelConfig {
	channel := chargeCountChannel
	channel.Salt = "0x" + strings.Repeat("00", 31) + hex.EncodeToString([]byte{suffix})
	return channel
}

// claimRows builds claim rows for channels. totals[i] is row i's totalClaimed, default 1.
func claimRows(channels []ChannelConfig, totals ...int64) []voucherClaimArg {
	claims := make([]voucherClaimArg, len(channels))
	for i, channel := range channels {
		total := int64(1)
		if i < len(totals) {
			total = totals[i]
		}
		claims[i] = voucherClaimArg{
			Signature:    common.FromHex("0xcafe"),
			TotalClaimed: big.NewInt(total),
		}
		claims[i].Voucher.Channel = toContractChannelConfig(channel)
		claims[i].Voucher.MaxClaimableAmount = big.NewInt(1000)
	}
	return claims
}

func mustClaimCalldataFor(t *testing.T, functionName string, channels ...ChannelConfig) []byte {
	t.Helper()
	return mustClaimCalldataWithTotals(t, functionName, channels)
}

func mustClaimCalldataWithTotals(t *testing.T, functionName string, channels []ChannelConfig, totals ...int64) []byte {
	t.Helper()
	claims := claimRows(channels, totals...)
	switch functionName {
	case "claim":
		return mustPack(t, BatchSettlementClaimABI, "claim", claims)
	case "claimWithSignature":
		return mustPack(t, BatchSettlementClaimWithSignatureABI, "claimWithSignature", claims, common.FromHex("0xdead"))
	default:
		t.Fatalf("unknown function %s", functionName)
		return nil
	}
}

func mustClaimCalldata(t *testing.T, functionName string) []byte {
	t.Helper()
	return mustClaimCalldataFor(t, functionName, chargeCountChannel)
}

func mustPack(t *testing.T, abiJSON []byte, name string, args ...interface{}) []byte {
	t.Helper()
	parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		t.Fatalf("abi: %v", err)
	}
	data, err := parsed.Pack(name, args...)
	if err != nil {
		t.Fatalf("pack %s: %v", name, err)
	}
	return data
}
