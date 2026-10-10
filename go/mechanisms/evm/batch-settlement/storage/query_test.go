package storage

import (
	"context"
	"reflect"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const (
	queryNetworkA  = "eip155:84532"
	queryNetworkB  = "eip155:1"
	queryReceiverA = "0x1111111111111111111111111111111111111111"
	queryReceiverB = "0x2222222222222222222222222222222222222222"
	queryTokenA    = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	queryTokenB    = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	queryNow       = int64(1_700_000_000_000)
)

func queryIdleAt() int64 { return queryNow - 60_000 }

func paddedId(n int) string {
	return "0x" + padHex(n, 64)
}

func padHex(n, width int) string {
	hex := ""
	for n > 0 {
		d := n % 16
		if d < 10 {
			hex = string(rune('0'+d)) + hex
		} else {
			hex = string(rune('a'+d-10)) + hex
		}
		n /= 16
	}
	for len(hex) < width {
		hex = "0" + hex
	}
	return hex
}

type queryingStore struct {
	*InMemoryChannelStorage[*Channel]
	queryFn func(context.Context, ChannelQuery, *ChannelStoreOptions) (*QueryPage[*Channel], error)
}

func (s queryingStore) Query(ctx context.Context, filter ChannelQuery, opts *ChannelStoreOptions) (*QueryPage[*Channel], error) {
	return s.queryFn(ctx, filter, opts)
}

func TestQueryChannels_SelectsClaimableAsBigInt(t *testing.T) {
	got := queryIds(t, ChannelQuery{Kind: QueryKindClaimable})
	want := []string{paddedId(3), paddedId(1), paddedId(2), paddedId(5)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
}

func TestQueryChannels_AppliesIdleAtOrBeforeToClaimable(t *testing.T) {
	idle := queryIdleAt()
	got := queryIds(t, ChannelQuery{Kind: QueryKindClaimable, IdleAtOrBefore: &idle})
	want := []string{paddedId(3), paddedId(2), paddedId(5)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
}

func TestQueryChannels_FiltersClaimableByNetwork(t *testing.T) {
	got := queryIds(t, ChannelQuery{Kind: QueryKindClaimable, Network: queryNetworkB})
	if len(got) != 0 {
		t.Fatalf("ids = %v, want empty", got)
	}
}

func TestQueryChannels_SelectsIdleRefundableWithEscrow(t *testing.T) {
	idle := queryIdleAt()
	got := queryIds(t, ChannelQuery{Kind: QueryKindIdleRefundable, IdleAtOrBefore: &idle})
	want := []string{paddedId(2), paddedId(3), paddedId(4), paddedId(5), paddedId(6)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
}

func TestQueryChannels_SelectsWithdrawPending(t *testing.T) {
	got := queryIds(t, ChannelQuery{Kind: QueryKindWithdrawPending})
	want := []string{paddedId(3), paddedId(8)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
}

func TestQueryChannels_PagesClaimableWithLimitAndCursor(t *testing.T) {
	store := seededQueryStore(t)
	limit1 := 1
	first, err := QueryChannels(context.Background(), store, ChannelQuery{Kind: QueryKindClaimable, Limit: &limit1}, nil)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if got := channelIds(first.Items); !reflect.DeepEqual(got, []string{paddedId(3)}) {
		t.Fatalf("first ids = %v", got)
	}
	if first.Cursor == "" {
		t.Fatal("expected cursor")
	}
	limit10 := 10
	rest, err := QueryChannels(context.Background(), store, ChannelQuery{Kind: QueryKindClaimable, Limit: &limit10, Cursor: first.Cursor}, nil)
	if err != nil {
		t.Fatalf("rest page: %v", err)
	}
	if got := channelIds(rest.Items); !reflect.DeepEqual(got, []string{paddedId(1), paddedId(2), paddedId(5)}) {
		t.Fatalf("rest ids = %v", got)
	}
	if rest.Cursor != "" {
		t.Fatalf("unexpected cursor %q", rest.Cursor)
	}
}

func TestQueryChannels_PrefersNativeQuery(t *testing.T) {
	inner := NewInMemoryChannelStorage[*Channel]()
	queried := queryChannel(paddedId(0x99), queryChannelExtra{ChargedCumulativeAmount: "1"})
	store := queryingStore{
		InMemoryChannelStorage: inner,
		queryFn: func(ctx context.Context, _ ChannelQuery, _ *ChannelStoreOptions) (*QueryPage[*Channel], error) {
			return &QueryPage[*Channel]{Items: []*Channel{queried}}, nil
		},
	}
	got, err := QueryChannels[*Channel](context.Background(), store, ChannelQuery{Kind: QueryKindClaimable}, nil)
	if err != nil {
		t.Fatalf("QueryChannels: %v", err)
	}
	if len(got.Items) != 1 || got.Items[0].ChannelId != queried.ChannelId {
		t.Fatalf("native query not used: %+v", got.Items)
	}
}

func TestQueryChannels_NativeMatchesScanShim(t *testing.T) {
	inner := seededQueryStore(t)
	store := queryingStore{
		InMemoryChannelStorage: inner,
		queryFn: func(ctx context.Context, filter ChannelQuery, _ *ChannelStoreOptions) (*QueryPage[*Channel], error) {
			return QueryByScan[*Channel](ctx, inner, filter)
		},
	}
	native, err := QueryChannels[*Channel](context.Background(), store, ChannelQuery{Kind: QueryKindClaimable}, nil)
	if err != nil {
		t.Fatalf("native: %v", err)
	}
	scan, err := QueryByScan[*Channel](context.Background(), inner, ChannelQuery{Kind: QueryKindClaimable})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !reflect.DeepEqual(channelIds(native.Items), channelIds(scan.Items)) {
		t.Fatalf("native %v scan %v", channelIds(native.Items), channelIds(scan.Items))
	}
}

func TestMatchesChannelQuery_ComparesUint256NotLexicographic(t *testing.T) {
	if !MatchesChannelQuery(queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "10", TotalClaimed: "9"}), ChannelQuery{Kind: QueryKindClaimable}) {
		t.Fatal("10 > 9 should be claimable")
	}
	if MatchesChannelQuery(queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "9", TotalClaimed: "10"}), ChannelQuery{Kind: QueryKindClaimable}) {
		t.Fatal("9 <= 10 should not be claimable")
	}
}

func TestMatchesChannelQuery_IdleBoundaryIsInclusive(t *testing.T) {
	channel := queryChannel(paddedId(1), queryChannelExtra{LastRequestTimestamp: 1000, Balance: "1"})
	idle := int64(1000)
	if !MatchesChannelQuery(channel, ChannelQuery{Kind: QueryKindIdleRefundable, IdleAtOrBefore: &idle}) {
		t.Fatal("equal timestamp should be idle")
	}
	below := int64(999)
	if MatchesChannelQuery(channel, ChannelQuery{Kind: QueryKindIdleRefundable, IdleAtOrBefore: &below}) {
		t.Fatal("later timestamp should not be idle")
	}
}

func TestMatchesChannelQuery_NetworkFilterRequiresRowNetwork(t *testing.T) {
	channel := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "10"})
	channel.Network = ""
	if MatchesChannelQuery(channel, ChannelQuery{Kind: QueryKindClaimable, Network: queryNetworkA}) {
		t.Fatal("row without network should not match a network filter")
	}
}

func TestMatchesChannelQuery_SkipsCorruptWatermarks(t *testing.T) {
	corruptCharged := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "not-a-number", TotalClaimed: "0"})
	if MatchesChannelQuery(corruptCharged, ChannelQuery{Kind: QueryKindClaimable}) {
		t.Fatal("corrupt charged amount must not match claimable")
	}
	corruptClaimed := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "10", TotalClaimed: "not-a-number"})
	if MatchesChannelQuery(corruptClaimed, ChannelQuery{Kind: QueryKindClaimable}) {
		t.Fatal("corrupt claimed amount must not match claimable")
	}
	corruptBalance := queryChannel(paddedId(1), queryChannelExtra{Balance: "not-a-number"})
	if MatchesChannelQuery(corruptBalance, ChannelQuery{Kind: QueryKindIdleRefundable}) {
		t.Fatal("corrupt balance must not match idle-refundable")
	}
	// A corrupt balance must not read as zero either: it is skipped, not selected.
	zeroBalance := queryChannel(paddedId(1), queryChannelExtra{Balance: "0"})
	if MatchesChannelQuery(zeroBalance, ChannelQuery{Kind: QueryKindIdleRefundable}) {
		t.Fatal("zero balance must not match idle-refundable")
	}
}

func TestSortChannels_ClaimablePutsWithdrawPendingFirst(t *testing.T) {
	pending := queryChannel("0x2222222222222222222222222222222222222222222222222222222222222222", queryChannelExtra{WithdrawRequestedAt: 1})
	fresh := queryChannel("0x1111111111111111111111111111111111111111111111111111111111111111", queryChannelExtra{WithdrawRequestedAt: 0})
	input := []*Channel{fresh, pending}
	got := SortChannels(append([]*Channel{}, input...), ChannelQuery{Kind: QueryKindClaimable})
	if channelIds(got)[0] != pending.ChannelId || channelIds(got)[1] != fresh.ChannelId {
		t.Fatalf("sorted = %v", channelIds(got))
	}
	if input[0] != fresh || input[1] != pending {
		t.Fatal("input mutated")
	}
}

func queryIds(t *testing.T, filter ChannelQuery) []string {
	t.Helper()
	page, err := QueryChannels(context.Background(), seededQueryStore(t), filter, nil)
	if err != nil {
		t.Fatalf("QueryChannels: %v", err)
	}
	return channelIds(page.Items)
}

func channelIds(channels []*Channel) []string {
	ids := make([]string, len(channels))
	for i, c := range channels {
		ids[i] = c.ChannelId
	}
	return ids
}

func seededQueryStore(t *testing.T) *InMemoryChannelStorage[*Channel] {
	t.Helper()
	store := NewInMemoryChannelStorage[*Channel]()
	for _, channel := range querySeed() {
		ch := channel
		if _, err := store.UpdateChannel(context.Background(), ch.ChannelId, func(*Channel) *Channel { return ch }); err != nil {
			t.Fatalf("seed %s: %v", ch.ChannelId, err)
		}
	}
	return store
}

type queryChannelExtra struct {
	ChargedCumulativeAmount string
	TotalClaimed            string
	LastRequestTimestamp    int64
	WithdrawRequestedAt     int
	Balance                 string
	Network                 string
	Receiver                string
	Token                   string
}

func querySeed() []*Channel {
	return []*Channel{
		queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "100", LastRequestTimestamp: queryNow}),
		queryChannel(paddedId(2), queryChannelExtra{ChargedCumulativeAmount: "100", LastRequestTimestamp: queryNow - 120_000}),
		queryChannel(paddedId(3), queryChannelExtra{ChargedCumulativeAmount: "100", LastRequestTimestamp: queryNow - 120_000, WithdrawRequestedAt: 1}),
		queryChannel(paddedId(4), queryChannelExtra{ChargedCumulativeAmount: "9", TotalClaimed: "10", LastRequestTimestamp: queryNow - 120_000}),
		queryChannel(paddedId(5), queryChannelExtra{ChargedCumulativeAmount: "10", TotalClaimed: "9", LastRequestTimestamp: queryNow - 120_000}),
		queryChannel(paddedId(6), queryChannelExtra{LastRequestTimestamp: queryNow - 120_000, Balance: "500"}),
		queryChannel(paddedId(7), queryChannelExtra{LastRequestTimestamp: queryNow - 120_000, Balance: "0"}),
		queryChannel(paddedId(8), queryChannelExtra{WithdrawRequestedAt: 99}),
		queryChannel(paddedId(9), queryChannelExtra{TotalClaimed: "10", ChargedCumulativeAmount: "10", Receiver: queryReceiverA, Token: queryTokenA}),
		queryChannel(paddedId(10), queryChannelExtra{TotalClaimed: "20", ChargedCumulativeAmount: "20", Receiver: queryReceiverA, Token: queryTokenA}),
		queryChannel(paddedId(11), queryChannelExtra{TotalClaimed: "5", ChargedCumulativeAmount: "5", Receiver: queryReceiverB, Token: queryTokenB, Network: queryNetworkB}),
		queryChannel(paddedId(12), queryChannelExtra{TotalClaimed: "7", ChargedCumulativeAmount: "7", Receiver: queryReceiverA, Token: queryTokenA, Network: queryNetworkB}),
	}
}

func queryChannel(channelId string, extra queryChannelExtra) *Channel {
	network := extra.Network
	if network == "" {
		network = queryNetworkA
	}
	receiver := extra.Receiver
	if receiver == "" {
		receiver = queryReceiverA
	}
	token := extra.Token
	if token == "" {
		token = queryTokenA
	}
	charged := extra.ChargedCumulativeAmount
	if charged == "" {
		charged = "0"
	}
	totalClaimed := extra.TotalClaimed
	if totalClaimed == "" {
		totalClaimed = "0"
	}
	balance := extra.Balance
	if balance == "" {
		balance = "1000"
	}
	lastReq := extra.LastRequestTimestamp
	if lastReq == 0 {
		lastReq = queryNow
	}
	return &Channel{
		ChannelId: channelId,
		ChannelConfig: batchsettlement.ChannelConfig{
			Payer:              "0x3333333333333333333333333333333333333333",
			PayerAuthorizer:    "0x0000000000000000000000000000000000000000",
			Receiver:           receiver,
			ReceiverAuthorizer: "0x0000000000000000000000000000000000000000",
			Token:              token,
			WithdrawDelay:      900,
			Salt:               channelId,
		},
		ChargedCumulativeAmount: charged,
		SignedMaxClaimable:      "0",
		Signature:               "0x",
		Balance:                 balance,
		TotalClaimed:            totalClaimed,
		WithdrawRequestedAt:     extra.WithdrawRequestedAt,
		RefundNonce:             0,
		LastRequestTimestamp:    lastReq,
		Network:                 network,
	}
}

func TestMatchesChannelQuery_MinUnclaimedThreshold(t *testing.T) {
	channel := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "100"})
	threshold := "50"
	if !MatchesChannelQuery(channel, ChannelQuery{Kind: QueryKindClaimable, MinUnclaimed: &threshold}) {
		t.Fatal("unclaimed 100 should meet threshold 50")
	}
	high := "150"
	if MatchesChannelQuery(channel, ChannelQuery{Kind: QueryKindClaimable, MinUnclaimed: &high}) {
		t.Fatal("unclaimed 100 should not meet threshold 150")
	}
	invalid := "not-a-number"
	if MatchesChannelQuery(channel, ChannelQuery{Kind: QueryKindClaimable, MinUnclaimed: &invalid}) {
		t.Fatal("unparseable threshold must fail closed")
	}
}

func TestMatchesChannelQuery_ThresholdOrIdle(t *testing.T) {
	idle := queryIdleAt()
	high := "1000"
	low := "50"
	idleLow := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "100", LastRequestTimestamp: queryNow - 120_000})
	freshLow := queryChannel(paddedId(2), queryChannelExtra{ChargedCumulativeAmount: "100", LastRequestTimestamp: queryNow})
	freshHigh := queryChannel(paddedId(3), queryChannelExtra{ChargedCumulativeAmount: "5000", LastRequestTimestamp: queryNow})

	both := ChannelQuery{Kind: QueryKindClaimable, MinUnclaimed: &high, IdleAtOrBefore: &idle}
	if !MatchesChannelQuery(idleLow, both) {
		t.Fatal("idle row below threshold should match the OR query")
	}
	if MatchesChannelQuery(freshLow, both) {
		t.Fatal("fresh row below threshold should not match the OR query")
	}
	lowBoth := ChannelQuery{Kind: QueryKindClaimable, MinUnclaimed: &low, IdleAtOrBefore: &idle}
	if !MatchesChannelQuery(freshHigh, lowBoth) {
		t.Fatal("fresh row above threshold should match the OR query")
	}
	// Either predicate alone keeps its current meaning.
	if MatchesChannelQuery(freshLow, ChannelQuery{Kind: QueryKindClaimable, MinUnclaimed: &high}) {
		t.Fatal("threshold alone should not match a row below it")
	}
	if MatchesChannelQuery(freshLow, ChannelQuery{Kind: QueryKindClaimable, IdleAtOrBefore: &idle}) {
		t.Fatal("idle alone should not match a fresh row")
	}
	pending := queryChannel(paddedId(4), queryChannelExtra{
		ChargedCumulativeAmount: "100",
		LastRequestTimestamp:    queryNow,
		WithdrawRequestedAt:     5,
	})
	if !MatchesChannelQuery(pending, both) {
		t.Fatal("fresh withdraw-pending row below threshold should match")
	}
	drained := queryChannel(paddedId(6), queryChannelExtra{
		ChargedCumulativeAmount: "100",
		TotalClaimed:            "40",
		Balance:                 "40",
		WithdrawRequestedAt:     5,
	})
	if MatchesChannelQuery(drained, both) {
		t.Fatal("drained row should not match")
	}
}

func TestQueryChannels_AppliesMinUnclaimedToClaimable(t *testing.T) {
	threshold := "50"
	got := queryIds(t, ChannelQuery{Kind: QueryKindClaimable, MinUnclaimed: &threshold})
	want := []string{paddedId(3), paddedId(1), paddedId(2)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
}

func TestSortChannels_ClaimableUnclaimedDesc(t *testing.T) {
	low := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "10"})
	high := queryChannel(paddedId(2), queryChannelExtra{ChargedCumulativeAmount: "100"})
	pending := queryChannel(paddedId(3), queryChannelExtra{ChargedCumulativeAmount: "50", WithdrawRequestedAt: 1})
	input := []*Channel{low, high, pending}
	got := SortChannels(append([]*Channel{}, input...), ChannelQuery{Kind: QueryKindClaimable, UnclaimedDesc: true})
	if want := []string{paddedId(3), paddedId(2), paddedId(1)}; !reflect.DeepEqual(channelIds(got), want) {
		t.Fatalf("sorted = %v, want %v", channelIds(got), want)
	}
	if input[0] != low || input[1] != high || input[2] != pending {
		t.Fatal("input mutated")
	}
}

func TestSortChannels_ClaimableOldestFirst(t *testing.T) {
	old := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "10", LastRequestTimestamp: queryNow})
	older := queryChannel(paddedId(2), queryChannelExtra{ChargedCumulativeAmount: "10", LastRequestTimestamp: queryNow - 120_000})
	pending := queryChannel(paddedId(3), queryChannelExtra{
		ChargedCumulativeAmount: "10",
		LastRequestTimestamp:    queryNow,
		WithdrawRequestedAt:     2,
	})
	pendingEarlier := queryChannel(paddedId(4), queryChannelExtra{
		ChargedCumulativeAmount: "10",
		LastRequestTimestamp:    queryNow - 60_000,
		WithdrawRequestedAt:     1,
	})
	input := []*Channel{old, older, pending, pendingEarlier}
	got := SortChannels(append([]*Channel{}, input...), ChannelQuery{Kind: QueryKindClaimable, OldestFirst: true})
	if want := []string{paddedId(4), paddedId(3), paddedId(2), paddedId(1)}; !reflect.DeepEqual(channelIds(got), want) {
		t.Fatalf("sorted = %v, want %v", channelIds(got), want)
	}
}

func TestSortChannels_ClaimableDefaultPreservesOrder(t *testing.T) {
	low := queryChannel(paddedId(1), queryChannelExtra{ChargedCumulativeAmount: "10"})
	high := queryChannel(paddedId(2), queryChannelExtra{ChargedCumulativeAmount: "100"})
	input := []*Channel{low, high}
	got := SortChannels(append([]*Channel{}, input...), ChannelQuery{Kind: QueryKindClaimable})
	if want := []string{paddedId(1), paddedId(2)}; !reflect.DeepEqual(channelIds(got), want) {
		t.Fatalf("sorted = %v, want %v", channelIds(got), want)
	}
}
