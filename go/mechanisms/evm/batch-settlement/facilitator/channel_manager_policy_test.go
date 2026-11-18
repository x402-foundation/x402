package facilitator

import (
	"context"
	"log/slog"
	"math/big"
	"strings"
	"testing"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

type recordLogHandler struct {
	messages []string
}

func (h *recordLogHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordLogHandler) Handle(_ context.Context, r slog.Record) error {
	h.messages = append(h.messages, r.Message)
	return nil
}

func (h *recordLogHandler) WithAttrs([]slog.Attr) slog.Handler { return h }

func (h *recordLogHandler) WithGroup(string) slog.Handler { return h }

func TestFacilitatorChannelManager_DerivedSettleTargetsSurviveFreshManager(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	first := newTestManager(t, nil, store, auth, false, nil)
	second, err := NewFacilitatorChannelManager(FacilitatorChannelManagerConfig{
		Storage:          store,
		Signer:           newManagedSigner(t, nil),
		AuthorizerSigner: auth,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, mgr := range []*FacilitatorChannelManager{first, second} {
		page, err := mgr.settleTargetStorage.ListSettleTargets(context.Background(), storage.SettleQuery{
			Network: ch.Network,
			Limit:   intPtr(10),
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 1 {
			t.Fatalf("targets = %d", len(page.Items))
		}
	}
}

func TestFacilitatorChannelManager_LoggerRecordsPreflightSkipAndDrained(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	skipped := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	skipped.ChannelConfig.ReceiverAuthorizer = "0x1111111111111111111111111111111111111111"
	drained := managerChannel(t, auth, "02", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, skipped)
	seedManagedChannel(t, store, drained)
	signer := newManagedSigner(t, &managedRPC{
		chainViews: map[string]managedChainView{
			strings.ToLower(drained.ChannelId): {Balance: big.NewInt(50), TotalClaimed: big.NewInt(50)},
		},
	})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	logs := &recordLogHandler{}
	mgr.logger = slog.New(logs)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	var sawSkip, sawDrained bool
	for _, msg := range logs.messages {
		if strings.Contains(msg, "different receiverAuthorizer") {
			sawSkip = true
		}
		if strings.Contains(msg, "drained channel") {
			sawDrained = true
		}
	}
	if !sawSkip || !sawDrained {
		t.Fatalf("messages = %v", logs.messages)
	}
}

func TestFacilitatorChannelManager_StartSkipsRefundWithoutIdleSecs(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, false, nil)
	interval := 60
	mgr.Start(FacilitatorAutoConfig{
		ClaimIntervalSecs:  &interval,
		RefundIntervalSecs: &interval,
	})
	if _, ok := mgr.timers[autoJobRefund]; ok {
		t.Fatal("refund timer scheduled without RefundIdleSecs")
	}
	idle := 3600
	mgr.Stop(context.Background(), false)
	mgr.Start(FacilitatorAutoConfig{
		RefundIntervalSecs: &interval,
		RefundIdleSecs:     &idle,
	})
	if _, ok := mgr.timers[autoJobRefund]; !ok {
		t.Fatal("refund timer missing")
	}
	_ = mgr.Stop(context.Background(), false)
}
