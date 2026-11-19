package gin

// Regression test: SyncFacilitatorOnStart: false must be honoured when a facilitator is configured.
//
// THE BUG (measured against HEAD ad9a38f): the Config field was a plain bool, so "unset" and
// "explicitly false" were the same value. The defaulting logic then treated any configured
// facilitator as "the caller wants syncing" and set syncOnStart = true, silently discarding an
// explicit false. The stale `if config.Timeout != 0` guard was always true because Timeout is
// defaulted a few lines above it.
//
// WHY BEHAVIOURAL: the observable consequence of syncing at construction is a call to the
// facilitator's GetSupported (via httpServer.Initialize). Counting those calls tests the behaviour,
// not the implementation. The control test below proves the harness can see a sync at all, so the
// first test cannot pass for the wrong reason.
//
// RED BEFORE THE FIX, GREEN AFTER — that transition is the receipt.

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	core "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

type countingFacilitator struct {
	supportedCalls int64
}

func (c *countingFacilitator) Verify(ctx context.Context, payload []byte, req []byte) (*core.VerifyResponse, error) {
	return &core.VerifyResponse{IsValid: true}, nil
}

func (c *countingFacilitator) Settle(ctx context.Context, payload []byte, req []byte) (*core.SettleResponse, error) {
	return &core.SettleResponse{Success: true}, nil
}

func (c *countingFacilitator) GetSupported(ctx context.Context) (core.SupportedResponse, error) {
	atomic.AddInt64(&c.supportedCalls, 1)
	return core.SupportedResponse{
		Kinds: []core.SupportedKind{
			{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
		},
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}, nil
}

func countingRoutes() x402http.RoutesConfig {
	return x402http.RoutesConfig{
		"GET /paid": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0x0000000000000000000000000000000000000001",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}
}

func TestSyncFacilitatorOnStartFalseIsHonoured(t *testing.T) {
	gin.SetMode(gin.TestMode)

	fac := &countingFacilitator{}
	router := gin.New()
	router.Use(X402Payment(Config{
		Routes:                 countingRoutes(),
		Facilitator:            fac,
		SyncFacilitatorOnStart: spb(false), // explicitly disabled
	}))
	_ = router

	if n := atomic.LoadInt64(&fac.supportedCalls); n != 0 {
		t.Fatalf("SyncFacilitatorOnStart: false was ignored — GetSupported called %d time(s) during construction; want 0", n)
	}
}

// Control: nil (unset) with a facilitator MUST sync, which is the documented default. If this ever
// stops calling GetSupported, the test above proves nothing.
func TestSyncFacilitatorOnStartDefaultStillSyncs(t *testing.T) {
	gin.SetMode(gin.TestMode)

	fac := &countingFacilitator{}
	router := gin.New()
	router.Use(X402Payment(Config{
		Routes:      countingRoutes(),
		Facilitator: fac,
		Schemes:     []SchemeConfig{{Network: "eip155:1", Server: &mockSchemeServer{scheme: "exact"}}},
	}))
	_ = router

	if n := atomic.LoadInt64(&fac.supportedCalls); n == 0 {
		t.Fatal("default (nil) did not sync with a facilitator configured — the harness can no longer detect a sync")
	}
}
