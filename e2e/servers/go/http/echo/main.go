package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/labstack/echo/v4"
	e2eserver "github.com/x402-foundation/x402/e2e/servers/go"
	x402 "github.com/x402-foundation/x402/go/v2"
	echomw "github.com/x402-foundation/x402/go/v2/http/echo"
)

var shutdownRequested bool

// Echo E2E Test Server with x402 v2 Payment Middleware.
//
// Paid routes come from the mechanisms catalog — see e2eserver.CatalogRoutes.

func main() {
	cfg := e2eserver.LoadConfig()
	routes := e2eserver.BuildRoutes()
	facilitatorClient := e2eserver.NewFacilitatorClient(cfg)

	schemes := make([]echomw.SchemeConfig, 0)
	for _, binding := range e2eserver.SchemeBindings(cfg) {
		schemes = append(schemes, echomw.SchemeConfig{Network: binding.Network, Server: binding.Server})
	}

	e := echo.New()
	e.HideBanner = true
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if err := e2eserver.UnconfiguredErrorForPath(c.Request().URL.Path); err != nil {
				return c.JSON(http.StatusNotImplemented, err)
			}
			return next(c)
		}
	})

	e.Use(echomw.X402Payment(echomw.Config{
		Routes:                 routes,
		Facilitator:            facilitatorClient,
		Schemes:                schemes,
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
		ErrorHandler: func(c echo.Context, err error) {
			fmt.Printf("❌ [E2E SERVER ERROR] Payment error occurred\n")
			fmt.Printf("   Path: %s\n", c.Request().URL.Path)
			fmt.Printf("   Method: %s\n", c.Request().Method)
			fmt.Printf("   Error: %v\n", err)
			fmt.Printf("   Headers: %v\n", c.Request().Header)
			c.JSON(http.StatusPaymentRequired, map[string]interface{}{"error": err.Error()})
		},
		SettlementHandler: func(c echo.Context, settleResp *x402.SettleResponse) {
			fmt.Printf("✅ [E2E SERVER SUCCESS] Payment settled\n")
			fmt.Printf("   Path: %s\n", c.Request().URL.Path)
			fmt.Printf("   Transaction: %s\n", settleResp.Transaction)
			fmt.Printf("   Network: %s\n", settleResp.Network)
			fmt.Printf("   Payer: %s\n", settleResp.Payer)
		},
	}))

	// Protected endpoints — clients must present a valid payment to access these.
	for _, route := range e2eserver.CatalogRoutes() {
		paidRoute := route
		e.GET(paidRoute.Path, func(c echo.Context) error {
			if shutdownRequested {
				return c.JSON(http.StatusServiceUnavailable, map[string]interface{}{
					"error": "Server shutting down",
				})
			}
			if paidRoute.SettlementOverride != nil {
				echomw.SetSettlementOverrides(c, &x402.SettlementOverrides{
					Amount: paidRoute.SettlementOverride.Amount,
				})
			}
			return c.JSON(http.StatusOK, e2eserver.RouteBody())
		})
	}

	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, e2eserver.HealthBody())
	})

	e.POST("/close", func(c echo.Context) error {
		shutdownRequested = true

		fmt.Println("Received shutdown request")

		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message": "Server shutting down gracefully",
		})
	})

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	fmt.Println(e2eserver.FormatStartupBanner(
		"x402 Echo E2E Test Server",
		"http://localhost:"+cfg.Port,
	))

	if err := e.Start(":" + cfg.Port); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
