package server

import (
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// UnconfiguredErrorForPath returns a 501 payload when path is a catalog route
// whose network has no payee configured (mirrors the TS e2e servers).
func UnconfiguredErrorForPath(path string) map[string]string {
	for _, route := range CatalogRoutes() {
		if route.Path != path {
			continue
		}
		envKey := ServerAddressEnvKey(route.Network)
		if os.Getenv(envKey) != "" {
			return nil
		}
		return map[string]string{
			"error":   fmt.Sprintf("%s payments not configured", strings.ToUpper(route.Network)),
			"message": fmt.Sprintf("%s environment variable is not set", envKey),
		}
	}
	return nil
}

// RouteBody builds the JSON body a paid route's handler returns.
func RouteBody() map[string]interface{} {
	return map[string]interface{}{
		"message":   ProtectedRouteMessage,
		"timestamp": time.Now().Format(time.RFC3339),
	}
}

// ServedNetwork is one network this server serves, with its payee.
type ServedNetwork struct {
	ID      string
	Network string
	PayTo   string
}

// ServedNetworks lists the networks the resolved routes cover, in catalog order.
func ServedNetworks() []ServedNetwork {
	served := []ServedNetwork{}
	seen := map[string]bool{}
	for _, route := range ResolvedRoutes() {
		if seen[route.NetworkID] {
			continue
		}
		seen[route.NetworkID] = true
		served = append(served, ServedNetwork{
			ID:      route.NetworkID,
			Network: route.Network,
			PayTo:   route.PayTo,
		})
	}
	return served
}

// HealthBody is the shared /health payload for the Go e2e servers.
func HealthBody() map[string]interface{} {
	networks := map[string]interface{}{}
	for _, served := range ServedNetworks() {
		networks[served.ID] = map[string]string{
			"network": served.Network,
			"payee":   served.PayTo,
		}
	}
	return map[string]interface{}{
		"status":   "ok",
		"version":  "2.0.0",
		"networks": networks,
	}
}

// FormatStartupBanner renders networks and endpoints from the catalog, so it
// cannot fall out of sync with what the server actually mounts.
func FormatStartupBanner(title string, address string) string {
	body := []string{fmt.Sprintf("Server: %s", address)}
	for _, served := range ServedNetworks() {
		body = append(body, fmt.Sprintf("%s: %s → %s", served.ID, served.Network, served.PayTo))
	}
	body = append(body, "", "Endpoints:")
	for _, route := range CatalogRoutes() {
		body = append(body, fmt.Sprintf("  • GET  %s  (%s %s)", route.Path, route.Network, route.Scheme))
	}
	body = append(body,
		"  • GET  /health  (no payment required)",
		"  • POST /close   (shutdown server)",
	)

	width := utf8.RuneCountInString(title)
	for _, line := range body {
		if count := utf8.RuneCountInString(line); count > width {
			width = count
		}
	}
	width += 4

	pad := func(content string) string {
		return fmt.Sprintf("║ %s ║", content+strings.Repeat(" ", width-2-utf8.RuneCountInString(content)))
	}
	rule := func(left, right string) string {
		return left + strings.Repeat("═", width) + right
	}

	lines := []string{"", rule("╔", "╗"), pad(title), rule("╠", "╣")}
	for _, line := range body {
		lines = append(lines, pad(line))
	}
	lines = append(lines,
		rule("╚", "╝"),
		// The harness waits for this line before it starts polling /health.
		fmt.Sprintf("Server listening on %s", address),
		"",
	)
	return strings.Join(lines, "\n")
}
