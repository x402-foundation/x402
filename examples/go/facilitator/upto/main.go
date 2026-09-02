// Command upto-facilitator serves the SVM `upto` scheme on Solana Devnet and
// runs the rent cleanup manager against the scheme's channel storage, so
// abandoned payment channels are sealed and their rent reclaimed.
//
// For the EVM side of `upto`, see ../basic, which registers the EVM upto
// facilitator scheme alongside `exact`.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	uptosvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/facilitator"
)

const DefaultPort = "4022"

func main() {
	godotenv.Load()

	privateKey := os.Getenv("SVM_PRIVATE_KEY")
	if privateKey == "" {
		fmt.Println("❌ SVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	rpcURL := os.Getenv("SVM_RPC_URL")
	if rpcURL == "" {
		rpcURL = DefaultSvmRPC
	}
	network := x402.Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")

	signer, err := newFacilitatorSvmSigner(privateKey, rpcURL)
	if err != nil {
		fmt.Printf("❌ Failed to create SVM signer: %v\n", err)
		os.Exit(1)
	}

	// The scheme owns an in-memory channel store by default. Inject a durable
	// one in production so cleanup survives restarts and works across replicas.
	maxChannelLifetimeSecs := envInt("MAX_CHANNEL_LIFETIME_SECS", uptosvm.DefaultMaxChannelLifetimeSecs)
	scheme := uptosvm.NewUptoSvmScheme(signer, &uptosvm.Config{
		MaxChannelLifetimeSecs: &maxChannelLifetimeSecs,
	})

	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{network}, scheme)

	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
		if ctx.Result.Success {
			fmt.Printf("🎉 Settled %s: %s\n", ctx.Result.Amount, ctx.Result.Transaction)
		}
		return nil
	})

	cleanup := scheme.NewRentCleanupManager(string(network))
	cleanupCtx, stopCleanup := context.WithCancel(context.Background())
	defer stopCleanup()
	cleanup.Start(cleanupCtx, uptosvm.StartConfig{
		Interval: time.Duration(envInt("RENT_CLEANUP_INTERVAL_SECS", 300)) * time.Second,
		CleanupOptions: uptosvm.CleanupOptions{
			AbandonGraceSecs: int64(envInt("RENT_CLEANUP_ABANDON_GRACE_SECS", uptosvm.DefaultAbandonGraceSecs)),
			OnClose: func(result uptosvm.CloseResult) {
				fmt.Printf("[rent-cleanup] %s channel=%s tx=%s\n",
					result.Action, result.ChannelID, result.Transaction)
			},
			OnReclaim: func(result uptosvm.ReclaimResult) {
				fmt.Printf("[rent-cleanup] reclaimed %d channels tx=%s\n",
					len(result.ChannelIDs), result.Transaction)
			},
			OnError: func(err error, channelID string) {
				fmt.Printf("[rent-cleanup] error channel=%s: %v\n", channelID, err)
			},
		},
	})
	defer cleanup.Stop()

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/supported", func(c *gin.Context) {
		c.JSON(http.StatusOK, facilitator.GetSupported())
	})

	r.POST("/verify", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()

		payload, requirements, ok := readSettleRequest(c)
		if !ok {
			return
		}
		result, err := facilitator.Verify(ctx, payload, requirements)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, result)
	})

	r.POST("/settle", func(c *gin.Context) {
		// Channel opens wait for confirmation, so settle needs a longer budget.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
		defer cancel()

		payload, requirements, ok := readSettleRequest(c)
		if !ok {
			return
		}
		result, err := facilitator.Settle(ctx, payload, requirements)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, result)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = DefaultPort
	}

	fmt.Printf("🚀 Upto facilitator listening on http://localhost:%s\n", port)
	fmt.Printf("   SVM: %s on %s\n", signer.GetAddresses(context.Background(), string(network))[0], network)
	fmt.Println()

	server := &http.Server{Addr: ":" + port, Handler: r, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
		<-signals
		stopCleanup()
		cleanup.Stop()
		_ = server.Shutdown(context.Background())
	}()

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}

func readSettleRequest(c *gin.Context) (payload, requirements []byte, ok bool) {
	var body struct {
		PaymentPayload      json.RawMessage `json:"paymentPayload"`
		PaymentRequirements json.RawMessage `json:"paymentRequirements"`
	}
	if err := c.BindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return nil, nil, false
	}
	return body.PaymentPayload, body.PaymentRequirements, true
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
