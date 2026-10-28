package server

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	mcp402 "github.com/x402-foundation/x402/go/v2/mcp"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
	cardanoserver "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/server"
	cardanosigners "github.com/x402-foundation/x402/go/v2/signers/cardano"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Always-succeeds Plutus V3 fixture shared with the TypeScript e2e servers.
const (
	cardanoAlwaysSucceedsScript  = "4d01000033222220051200120011"
	cardanoAlwaysSucceedsDatum   = "d8799f182aff"
	cardanoAlwaysSucceedsAddress = "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682"
)

var cardanoConfirmationsRegex = regexp.MustCompile(`^-?(0|[1-9]\d?)$`)

// PaymentTimeout is the HTTP middleware's payment timeout. Cardano routes need
// room for verify plus two settle calls (core retries a pending settle once),
// each of which may wait 75s for confirmations; other networks keep 30s.
func PaymentTimeout() time.Duration {
	for _, route := range ResolvedRoutes() {
		if route.NetworkID == "cardano" {
			return 200 * time.Second
		}
	}
	return 30 * time.Second
}

// IsCardanoMasumiRoute reports routes whose quotes are issued per request.
func IsCardanoMasumiRoute(route ResolvedRoute) bool {
	return route.NetworkID == "cardano" && route.AssetTransferMethod == "masumi"
}

// cardanoConfirmationPolicy reads CARDANO_L1_CONFIRMATIONS (-1..20); nil when unset.
func cardanoConfirmationPolicy() (map[string]interface{}, error) {
	raw := strings.TrimSpace(os.Getenv("CARDANO_L1_CONFIRMATIONS"))
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(raw)
	if !cardanoConfirmationsRegex.MatchString(raw) || err != nil || n < -1 || n > 20 {
		return nil, fmt.Errorf("CARDANO_L1_CONFIRMATIONS must be an integer from -1 to 20, got %q", raw)
	}
	return map[string]interface{}{"l1Confirmations": n}, nil
}

// resolveCardanoRoute applies the per-method payTo and extra the TypeScript
// e2e servers use (e2e/src/mechanisms.ts).
func resolveCardanoRoute(route *ResolvedRoute) error {
	if route.Extra == nil {
		route.Extra = map[string]interface{}{}
	}
	policy, err := cardanoConfirmationPolicy()
	if err != nil {
		return err
	}
	if policy != nil {
		route.Extra["confirmationPolicy"] = policy
	}
	switch route.AssetTransferMethod {
	case "masumi":
		deployment, ok := masumi.ResolveDeployment(route.Network, nil)
		if !ok {
			return fmt.Errorf("network %s has no canonical Masumi deployment", route.Network)
		}
		escrow, err := masumi.EscrowAddress(route.Network, deployment)
		if err != nil {
			return err
		}
		route.PayTo = escrow
	case "script":
		route.PayTo = envOr("SERVER_CARDANO_SCRIPT_ADDRESS", cardanoAlwaysSucceedsAddress)
		route.Extra["script"] = map[string]interface{}{
			"type": "plutusV3",
			"code": envOr("SERVER_CARDANO_SCRIPT_CODE", cardanoAlwaysSucceedsScript),
		}
		route.Extra["datum"] = envOr("SERVER_CARDANO_SCRIPT_DATUM", cardanoAlwaysSucceedsDatum)
	}
	if len(route.Extra) == 0 {
		route.Extra = nil
	}
	return nil
}

var (
	cardanoSchemeOnce sync.Once
	cardanoScheme     *cardanoserver.ExactCardanoScheme
)

// CardanoScheme returns the shared Cardano server scheme. A seller mnemonic
// enables Masumi quote issuance.
func CardanoScheme() *cardanoserver.ExactCardanoScheme {
	cardanoSchemeOnce.Do(func() {
		cfg := &cardanoserver.Config{}
		if mnemonic := os.Getenv("SERVER_CARDANO_SELLER_MNEMONIC"); mnemonic != "" {
			address, signer, err := cardanosigners.NewMasumiSellerSigner(mnemonic, NetworkCaip2("cardano"), 0)
			if err != nil {
				fmt.Printf("❌ Failed to create Masumi seller signer: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("Masumi seller: %s\n", address)
			cfg.Masumi = &cardanoserver.MasumiIssuerConfig{
				Seller: func(context.Context, string) (cardanoserver.MasumiSeller, error) {
					return cardanoserver.MasumiSeller{Address: address, SignTerms: signer}, nil
				},
			}
		}
		cardanoScheme = cardanoserver.NewExactCardanoScheme(cfg)
	})
	return cardanoScheme
}

// cardanoMasumiRoute converts a resolved Masumi catalog route.
func cardanoMasumiRoute(route ResolvedRoute) (cardanoserver.MasumiRoute, error) {
	price, ok := route.Price.(map[string]interface{})
	if !ok {
		return cardanoserver.MasumiRoute{}, fmt.Errorf("route %s: Masumi routes need an amount/asset price", route.Path)
	}
	amount, _ := price["amount"].(string)
	asset, _ := price["asset"].(string)
	masumiRoute := cardanoserver.MasumiRoute{
		Network:           route.Network,
		Asset:             asset,
		Amount:            amount,
		MaxTimeoutSeconds: route.MaxTimeoutSeconds,
	}
	if raw, ok := route.Extra["confirmationPolicy"]; ok {
		policy, valid := cardano.NormalizeConfirmationPolicy(raw)
		if !valid {
			return cardanoserver.MasumiRoute{}, fmt.Errorf("route %s: invalid confirmation policy", route.Path)
		}
		masumiRoute.ConfirmationPolicy = &policy
	}
	return masumiRoute, nil
}

// cardanoMasumiOption builds the HTTP payment option for a Masumi route.
func cardanoMasumiOption(route ResolvedRoute) x402http.PaymentOption {
	masumiRoute, err := cardanoMasumiRoute(route)
	if err == nil {
		var option x402http.PaymentOption
		if option, err = CardanoScheme().MasumiPaymentOption(masumiRoute); err == nil {
			return option
		}
	}
	fmt.Printf("❌ %v\n", err)
	os.Exit(1)
	return x402http.PaymentOption{}
}

// CardanoMasumiTool wraps an MCP tool for a Masumi route with WrapMasumiTool.
func CardanoMasumiTool(server *x402.X402ResourceServer, route ResolvedRoute, resource *types.ResourceInfo, extensions map[string]interface{}, handler mcp402.ToolHandler) mcp402.ToolHandler {
	masumiRoute, err := cardanoMasumiRoute(route)
	if err == nil {
		var wrapped mcp402.ToolHandler
		wrapped, err = CardanoScheme().WrapMasumiTool(server, cardanoserver.MasumiToolConfig{
			Route:      masumiRoute,
			Resource:   resource,
			Extensions: extensions,
		}, handler)
		if err == nil {
			return wrapped
		}
	}
	fmt.Printf("❌ %v\n", err)
	os.Exit(1)
	return nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
