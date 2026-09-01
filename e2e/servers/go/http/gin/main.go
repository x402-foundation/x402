package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	ginfw "github.com/gin-gonic/gin"
	e2eserver "github.com/x402-foundation/x402/e2e/servers/go"
	x402 "github.com/x402-foundation/x402/go/v2"
	ginmw "github.com/x402-foundation/x402/go/v2/http/gin"
)

var shutdownRequested bool

// Gin E2E Test Server with x402 v2 Payment Middleware.
//
// Paid routes come from the mechanisms catalog — see e2eserver.CatalogRoutes.

func main() {
	cfg := e2eserver.LoadConfig()
	routes := e2eserver.BuildRoutes()
	facilitatorClient := e2eserver.NewFacilitatorClient(cfg)

	schemes := make([]ginmw.SchemeConfig, 0)
	for _, binding := range e2eserver.SchemeBindings(cfg) {
		schemes = append(schemes, ginmw.SchemeConfig{Network: binding.Network, Server: binding.Server})
	}

	ginfw.SetMode(ginfw.ReleaseMode)
	r := ginfw.New()
	r.Use(ginfw.Recovery())
	r.Use(func(c *ginfw.Context) {
		if err := e2eserver.UnconfiguredErrorForPath(c.Request.URL.Path); err != nil {
			c.JSON(http.StatusNotImplemented, err)
			c.Abort()
			return
		}
		c.Next()
	})

	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:                 routes,
		Facilitator:            facilitatorClient,
		Schemes:                schemes,
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
		ErrorHandler: func(c *ginfw.Context, err error) {
			fmt.Printf("❌ [E2E SERVER ERROR] Payment error occurred\n")
			fmt.Printf("   Path: %s\n", c.Request.URL.Path)
			fmt.Printf("   Method: %s\n", c.Request.Method)
			fmt.Printf("   Error: %v\n", err)
			fmt.Printf("   Headers: %v\n", c.Request.Header)
			c.JSON(http.StatusPaymentRequired, ginfw.H{"error": err.Error()})
		},
		SettlementHandler: func(c *ginfw.Context, settleResp *x402.SettleResponse) {
			fmt.Printf("✅ [E2E SERVER SUCCESS] Payment settled\n")
			fmt.Printf("   Path: %s\n", c.Request.URL.Path)
			fmt.Printf("   Transaction: %s\n", settleResp.Transaction)
			fmt.Printf("   Network: %s\n", settleResp.Network)
			fmt.Printf("   Payer: %s\n", settleResp.Payer)
		},
	}))

	// Protected endpoints — clients must present a valid payment to access these.
	for _, route := range e2eserver.CatalogRoutes() {
		paidRoute := route
		r.GET(paidRoute.Path, func(c *ginfw.Context) {
			if shutdownRequested {
				c.JSON(http.StatusServiceUnavailable, ginfw.H{"error": "Server shutting down"})
				return
			}
			if paidRoute.SettlementOverride != nil {
				ginmw.SetSettlementOverrides(c, &x402.SettlementOverrides{
					Amount: paidRoute.SettlementOverride.Amount,
				})
			}
			c.JSON(http.StatusOK, e2eserver.RouteBody())
		})
	}

	r.GET("/health", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, e2eserver.HealthBody())
	})

	r.POST("/close", func(c *ginfw.Context) {
		shutdownRequested = true

		c.JSON(http.StatusOK, ginfw.H{"message": "Server shutting down gracefully"})
		fmt.Println("Received shutdown request")

		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	fmt.Println(e2eserver.FormatStartupBanner(
		"x402 Gin E2E Test Server",
		"http://localhost:"+cfg.Port,
	))

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: r,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
