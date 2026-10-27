package batchsettlement

import (
	"math/big"
	"reflect"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
)

const attestationNetwork = "eip155:84532"

func mustChannelId(t *testing.T, channel ChannelConfig) string {
	t.Helper()
	channelId, err := ComputeChannelId(channel, attestationNetwork)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	return channelId
}

func mustRefundCalldata(t *testing.T) []byte {
	t.Helper()
	return mustPack(t, BatchSettlementRefundABI, "refund", toContractChannelConfig(chargeCountChannel), big.NewInt(100))
}

func TestDecodeClaimAttestation_JoinsStandaloneClaimToClaimedEvent(t *testing.T) {
	channelId := mustChannelId(t, chargeCountChannel)
	attestation := DecodeClaimAttestation(
		mustClaimCalldata(t, "claim"),
		[]ReceiptLog{mustClaimedLog(t, channelId, 500, 1)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{4}),
	)
	if attestation.FunctionName != "claim" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if !uint64sEqual(attestation.ChargeCounts, []uint64{4}) {
		t.Fatalf("chargeCounts = %v", attestation.ChargeCounts)
	}
	want := []ClaimAttestationRow{{ChannelId: channelId, Claimed: true, ClaimAmount: "500", NewTotalClaimed: "1", ChargeCount: "4"}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_UnwrapsMulticallClaimAndRefund(t *testing.T) {
	channelId := mustChannelId(t, chargeCountChannel)
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{mustClaimCalldata(t, "claim"), mustRefundCalldata(t)})

	attestation := DecodeClaimAttestation(
		outer,
		[]ReceiptLog{mustClaimedLog(t, channelId, 1, 1)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{4}),
	)
	if attestation.FunctionName != "multicall" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if !uint64sEqual(attestation.ChargeCounts, []uint64{4}) {
		t.Fatalf("chargeCounts = %v", attestation.ChargeCounts)
	}
	want := []ClaimAttestationRow{{ChannelId: channelId, Claimed: true, ClaimAmount: "1", NewTotalClaimed: "1", ChargeCount: "4"}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_CollectsRowsAcrossEveryClaimLegInCallOrder(t *testing.T) {
	channels := []ChannelConfig{channelWithSalt(0x0a), channelWithSalt(0x0b), channelWithSalt(0x0c)}
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{
		mustClaimCalldataFor(t, "claim", channels[0], channels[1]),
		mustClaimCalldataFor(t, "claimWithSignature", channels[2]),
	})
	logs := make([]ReceiptLog, len(channels))
	for i, channel := range channels {
		logs[i] = mustClaimedLog(t, mustChannelId(t, channel), 1, 1)
	}

	attestation := DecodeClaimAttestation(outer, logs, attestationNetwork, ChargeCountsMetadata([]uint64{1, 2, 3}))
	if len(attestation.Channels) != 3 {
		t.Fatalf("channels len = %d", len(attestation.Channels))
	}
	for i, channel := range channels {
		row := attestation.Channels[i]
		if !strings.EqualFold(row.ChannelId, mustChannelId(t, channel)) || !row.Claimed || row.ChargeCount != []string{"1", "2", "3"}[i] {
			t.Fatalf("row %d = %+v", i, row)
		}
	}
}

func TestDecodeClaimAttestation_NoOpRowNeverShiftsCountsOntoOtherChannels(t *testing.T) {
	channels := []ChannelConfig{channelWithSalt(0x0a), channelWithSalt(0x0b), channelWithSalt(0x0c)}
	idA, idB, idC := mustChannelId(t, channels[0]), mustChannelId(t, channels[1]), mustChannelId(t, channels[2])
	// Row B was a no-op: only A and C emitted Claimed. A position-based zip would give C the count of B.
	attestation := DecodeClaimAttestation(
		mustClaimCalldataFor(t, "claim", channels...),
		[]ReceiptLog{mustClaimedLog(t, idA, 1, 1), mustClaimedLog(t, idC, 1, 1)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{4, 2, 7}),
	)
	want := []ClaimAttestationRow{
		{ChannelId: idA, Claimed: true, ClaimAmount: "1", NewTotalClaimed: "1", ChargeCount: "4"},
		{ChannelId: idB},
		{ChannelId: idC, Claimed: true, ClaimAmount: "1", NewTotalClaimed: "1", ChargeCount: "7"},
	}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_AttributesBothRowsWhenSameChannelClaimedTwiceWithIncreasingTotals(t *testing.T) {
	channel := channelWithSalt(0x0a)
	idA := mustChannelId(t, channel)
	attestation := DecodeClaimAttestation(
		mustClaimCalldataWithTotals(t, "claim", []ChannelConfig{channel, channel}, 5, 8),
		[]ReceiptLog{mustClaimedLog(t, idA, 5, 5), mustClaimedLog(t, idA, 3, 8)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{3, 2}),
	)
	want := []ClaimAttestationRow{
		{ChannelId: idA, Claimed: true, ClaimAmount: "5", NewTotalClaimed: "5", ChargeCount: "3"},
		{ChannelId: idA, Claimed: true, ClaimAmount: "3", NewTotalClaimed: "8", ChargeCount: "2"},
	}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_AttestsOnlyAppliedRowWhenLaterDuplicateIsNoOp(t *testing.T) {
	channel := channelWithSalt(0x0a)
	idA := mustChannelId(t, channel)
	// Row 2 (total 5) is below the total row 1 already set (8), so it emits no Claimed.
	attestation := DecodeClaimAttestation(
		mustClaimCalldataWithTotals(t, "claim", []ChannelConfig{channel, channel}, 8, 5),
		[]ReceiptLog{mustClaimedLog(t, idA, 8, 8)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{3, 2}),
	)
	want := []ClaimAttestationRow{
		{ChannelId: idA, Claimed: true, ClaimAmount: "8", NewTotalClaimed: "8", ChargeCount: "3"},
		{ChannelId: idA},
	}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_ConsumesEachClaimedEventOnceWhenIdenticalRowsRepeat(t *testing.T) {
	channel := channelWithSalt(0x0a)
	idA := mustChannelId(t, channel)
	attestation := DecodeClaimAttestation(
		mustClaimCalldataWithTotals(t, "claim", []ChannelConfig{channel, channel}, 5, 5),
		[]ReceiptLog{mustClaimedLog(t, idA, 5, 5)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{3, 2}),
	)
	want := []ClaimAttestationRow{
		{ChannelId: idA, Claimed: true, ClaimAmount: "5", NewTotalClaimed: "5", ChargeCount: "3"},
		{ChannelId: idA},
	}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_WithholdsChargeCountWhenSenderNotTrusted(t *testing.T) {
	channelId := mustChannelId(t, chargeCountChannel)
	logs := []ReceiptLog{mustClaimedLog(t, channelId, 1, 1)}
	metadata := ChargeCountsMetadata([]uint64{4})
	row := ClaimAttestationRow{ChannelId: channelId, Claimed: true, ClaimAmount: "1", NewTotalClaimed: "1"}

	untrusted := DecodeClaimAttestation(mustClaimCalldata(t, "claim"), logs, attestationNetwork, metadata,
		WithTrustedSenders("0x0000000000000000000000000000000000000001"))
	if !rowsEqual(untrusted.Channels, []ClaimAttestationRow{row}) {
		t.Fatalf("untrusted channels = %+v", untrusted.Channels)
	}

	none := DecodeClaimAttestation(mustClaimCalldata(t, "claim"), logs, attestationNetwork, metadata, WithTrustedSenders())
	if !rowsEqual(none.Channels, []ClaimAttestationRow{row}) {
		t.Fatalf("no trusted senders channels = %+v", none.Channels)
	}

	trustedRow := row
	trustedRow.ChargeCount = "4"
	trusted := DecodeClaimAttestation(mustClaimCalldata(t, "claim"), logs, attestationNetwork, metadata,
		WithTrustedSenders("0x"+strings.ToUpper(claimedSender[2:])))
	if !rowsEqual(trusted.Channels, []ClaimAttestationRow{trustedRow}) {
		t.Fatalf("trusted channels = %+v", trusted.Channels)
	}
}

func TestDecodeClaimAttestation_RetriedBatchWithNoClaimedEventsAttestsNothing(t *testing.T) {
	attestation := DecodeClaimAttestation(mustClaimCalldata(t, "claim"), nil, attestationNetwork, ChargeCountsMetadata([]uint64{4}))
	want := []ClaimAttestationRow{{ChannelId: mustChannelId(t, chargeCountChannel)}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_IgnoresClaimedEventsFromOtherEmitters(t *testing.T) {
	channelId := mustChannelId(t, chargeCountChannel)
	forged := mustClaimedLog(t, channelId, 1, 1)
	forged.Address = common.HexToAddress("0x0000000000000000000000000000000000000001")
	attestation := DecodeClaimAttestation(mustClaimCalldata(t, "claim"), []ReceiptLog{forged}, attestationNetwork, ChargeCountsMetadata([]uint64{4}))
	want := []ClaimAttestationRow{{ChannelId: channelId}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_IgnoresCountsWithWrongLength(t *testing.T) {
	channelId := mustChannelId(t, chargeCountChannel)
	attestation := DecodeClaimAttestation(
		mustClaimCalldata(t, "claim"),
		[]ReceiptLog{mustClaimedLog(t, channelId, 1, 1)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{4, 9}),
	)
	if attestation.ChargeCounts != nil {
		t.Fatalf("chargeCounts = %v, want nil", attestation.ChargeCounts)
	}
	want := []ClaimAttestationRow{{ChannelId: channelId, Claimed: true, ClaimAmount: "1", NewTotalClaimed: "1"}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_DecodesClaimRowsWithoutMetadata(t *testing.T) {
	attestation := DecodeClaimAttestation(mustClaimCalldata(t, "claim"), nil, attestationNetwork, nil)
	if attestation.ChargeCounts != nil {
		t.Fatalf("chargeCounts = %v", attestation.ChargeCounts)
	}
	want := []ClaimAttestationRow{{ChannelId: mustChannelId(t, chargeCountChannel)}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_ClaimWithSignatureJoinsClaimedLogs(t *testing.T) {
	channelId := mustChannelId(t, chargeCountChannel)
	attestation := DecodeClaimAttestation(
		mustClaimCalldataFor(t, "claimWithSignature", chargeCountChannel),
		[]ReceiptLog{mustClaimedLog(t, channelId, 500, 1)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{2}),
	)
	if attestation.FunctionName != "claimWithSignature" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	want := []ClaimAttestationRow{{ChannelId: channelId, Claimed: true, ClaimAmount: "500", NewTotalClaimed: "1", ChargeCount: "2"}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_RefundOnlyMulticallHasNoChannels(t *testing.T) {
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{mustRefundCalldata(t)})
	attestation := DecodeClaimAttestation(outer, nil, attestationNetwork, ChargeCountsMetadata([]uint64{1}))
	if attestation.FunctionName != "multicall" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.Channels != nil {
		t.Fatalf("channels = %+v, want nil", attestation.Channels)
	}
}

func TestDecodeClaimAttestation_SettleHasNoChannels(t *testing.T) {
	settle := mustPack(t, BatchSettlementSettleABI, "settle",
		common.HexToAddress(chargeCountChannel.Receiver),
		common.HexToAddress(chargeCountChannel.Token),
	)
	attestation := DecodeClaimAttestation(settle, nil, attestationNetwork, ChargeCountsMetadata([]uint64{1}))
	if attestation.FunctionName != "settle" || attestation.Channels != nil {
		t.Fatalf("attestation = %+v", attestation)
	}
}

func TestDecodeClaimAttestation_UndecodableCalldata(t *testing.T) {
	attestation := DecodeClaimAttestation(common.FromHex("0xabcd"), nil, attestationNetwork, nil)
	if attestation.FunctionName != "unknown" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.Channels != nil {
		t.Fatalf("channels = %+v, want nil", attestation.Channels)
	}
}

func TestDecodeClaimAttestation_MulticallLegNotDecodable(t *testing.T) {
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{common.FromHex("0xdeadbeef")})
	attestation := DecodeClaimAttestation(outer, nil, attestationNetwork, nil)
	if attestation.FunctionName != "multicall" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.Channels != nil {
		t.Fatalf("channels = %+v, want nil", attestation.Channels)
	}
}

func TestDecodeClaimAttestation_UnparseableLogsLeaveRowsUnclaimed(t *testing.T) {
	attestation := DecodeClaimAttestation(
		mustClaimCalldata(t, "claim"),
		[]ReceiptLog{{Address: common.HexToAddress(BatchSettlementAddress), Data: []byte{0x01}}},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{1}),
	)
	want := []ClaimAttestationRow{{ChannelId: mustChannelId(t, chargeCountChannel)}}
	if !rowsEqual(attestation.Channels, want) {
		t.Fatalf("channels = %+v, want %+v", attestation.Channels, want)
	}
}

func TestDecodeClaimAttestation_ToleratesTopLevelSuffix(t *testing.T) {
	channelId := mustChannelId(t, chargeCountChannel)
	calldata := append(mustClaimCalldata(t, "claim"), common.FromHex("0x8021802180218021802180218021802180218021")...)
	attestation := DecodeClaimAttestation(
		calldata,
		[]ReceiptLog{mustClaimedLog(t, channelId, 1, 1)},
		attestationNetwork,
		ChargeCountsMetadata([]uint64{5}),
	)
	if len(attestation.Channels) != 1 || !attestation.Channels[0].Claimed || attestation.Channels[0].ChargeCount != "5" {
		t.Fatalf("channels = %+v", attestation.Channels)
	}
}

func TestClaimedRowKeys_ReturnsRowKeysFromContractOnly(t *testing.T) {
	idA := mustChannelId(t, channelWithSalt(0x0a))
	idB := mustChannelId(t, channelWithSalt(0x0b))
	forged := mustClaimedLog(t, idB, 1, 1)
	forged.Address = common.HexToAddress("0x0000000000000000000000000000000000000001")

	got := ClaimedRowKeys(goEthLogs(mustClaimedLog(t, idA, 1, 7), mustClaimedLog(t, idA, 1, 9), forged))
	want := map[string]struct{}{ClaimRowKey(idA, "7"): {}, ClaimRowKey(idA, "9"): {}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestClaimedRowKeys_EmptyForMissingOrUnparseableLogs(t *testing.T) {
	if got := ClaimedRowKeys(nil); got == nil || len(got) != 0 {
		t.Fatalf("nil logs: got %v, want empty non-nil set", got)
	}
	junk := []*goethtypes.Log{nil, {Address: common.HexToAddress(BatchSettlementAddress), Data: []byte{0x01}}}
	if got := ClaimedRowKeys(junk); got == nil || len(got) != 0 {
		t.Fatalf("junk logs: got %v, want empty non-nil set", got)
	}
}

func TestClaimRowKey_NormalizesCaseAndLeadingZeros(t *testing.T) {
	if ClaimRowKey("0xABCD", "0007") != ClaimRowKey("0xabcd", "7") {
		t.Fatal("keys differ for equal channel and total")
	}
	if ClaimRowKey("0xabcd", "7") == ClaimRowKey("0xabcd", "8") {
		t.Fatal("keys equal for different totals")
	}
}

func goEthLogs(logs ...ReceiptLog) []*goethtypes.Log {
	out := make([]*goethtypes.Log, len(logs))
	for i, log := range logs {
		out[i] = &goethtypes.Log{Address: log.Address, Topics: log.Topics, Data: log.Data}
	}
	return out
}

func rowsEqual(got, want []ClaimAttestationRow) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if !strings.EqualFold(got[i].ChannelId, want[i].ChannelId) {
			return false
		}
		g, w := got[i], want[i]
		g.ChannelId, w.ChannelId = "", ""
		if g != w {
			return false
		}
	}
	return true
}

const claimedSender = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

func mustClaimedLog(t *testing.T, channelId string, claimAmount, newTotalClaimed int64) ReceiptLog {
	t.Helper()
	return mustClaimedLogFrom(t, channelId, claimedSender, claimAmount, newTotalClaimed)
}

func mustClaimedLogFrom(t *testing.T, channelId, sender string, claimAmount, newTotalClaimed int64) ReceiptLog {
	t.Helper()
	data, err := claimedEvent.Inputs.NonIndexed().Pack(big.NewInt(claimAmount), big.NewInt(newTotalClaimed))
	if err != nil {
		t.Fatalf("pack Claimed data: %v", err)
	}
	senderTopic := common.BytesToHash(common.LeftPadBytes(common.HexToAddress(sender).Bytes(), 32))
	return ReceiptLog{
		Address: common.HexToAddress(BatchSettlementAddress),
		Topics: []common.Hash{
			claimedEvent.ID,
			common.HexToHash(channelId),
			senderTopic,
		},
		Data: data,
	}
}
