package server

// Mechanisms catalog loader for the Go e2e resource servers.
//
// SSOT is e2e/config/mechanisms_global.json + one e2e/config/mechanisms_<id>.json
// per network. Route paths, payment requirements, and declared extensions all
// come from there, so adding a mechanism does not require editing
// gin/echo/nethttp entrypoints.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const catalogSDK = "go"

type catalogNetworkMode struct {
	Name             string `json:"name"`
	Caip2            string `json:"caip2"`
	Permit2Asset     string `json:"permit2Asset"`
	Permit2AssetName string `json:"permit2AssetName"`
}

type catalogExtraEnv struct {
	Env                 string `json:"env"`
	WhenAssetOverridden bool   `json:"whenAssetOverridden"`
}

type catalogPrice struct {
	USD                        string                     `json:"usd"`
	DeclareAssetTransferMethod bool                       `json:"declareAssetTransferMethod"`
	Amount                     string                     `json:"amount"`
	AmountEnv                  string                     `json:"amountEnv"`
	Asset                      string                     `json:"asset"`
	AssetEnv                   string                     `json:"assetEnv"`
	AssetRef                   string                     `json:"assetRef"`
	Permit2Domain              bool                       `json:"permit2Domain"`
	ExtraEnv                   map[string]catalogExtraEnv `json:"extraEnv"`
}

// catalogEnvDecl is one env key's declaration in mechanisms_*.json.
type catalogEnvDecl struct {
	Required bool     `json:"required"`
	Roles    []string `json:"roles"`
}

// catalogEnvList is the flattened required/optional view of an env map.
type catalogEnvList struct {
	Required []string
	Optional []string
}

type catalogNetwork struct {
	Env      catalogEnvList                `json:"env"`
	Networks map[string]catalogNetworkMode `json:"networks"`
}

// networkFile is one mechanisms_<id>.json file's contents.
type networkFile struct {
	Env     map[string]catalogEnvDecl  `json:"env"`
	Testnet catalogNetworkMode         `json:"testnet"`
	Mainnet catalogNetworkMode         `json:"mainnet"`
	Routes  map[string]json.RawMessage `json:"routes"`
}

type globalFile struct {
	Env map[string]catalogEnvDecl `json:"env"`
}

func flattenEnvMap(env map[string]catalogEnvDecl) catalogEnvList {
	required := []string{}
	optional := []string{}
	for key, decl := range env {
		if decl.Required {
			required = append(required, key)
		} else {
			optional = append(optional, key)
		}
	}
	sort.Strings(required)
	sort.Strings(optional)
	return catalogEnvList{Required: required, Optional: optional}
}

type catalogRouteDefinition struct {
	Scheme              string            `json:"scheme"`
	Network             string            `json:"network"`
	AssetTransferMethod string            `json:"assetTransferMethod"`
	Sdks                []string          `json:"sdks"`
	RequiresEnv         string            `json:"requiresEnv"`
	Price               catalogPrice      `json:"price"`
	Extensions          []string          `json:"extensions"`
	SettlementOverride  *SettlementAmount `json:"settlementOverride"`
	PaymentFlow         string            `json:"paymentFlow"`
}

// SettlementAmount is the partial amount an upto route settles.
type SettlementAmount struct {
	Amount string `json:"amount"`
}

// ProtectedRouteMessage is the fixed success message every paid route returns.
const ProtectedRouteMessage = "Protected endpoint accessed successfully"

type mechanismsCatalog struct {
	Networks   map[string]catalogNetwork
	Routes     map[string]catalogRouteDefinition
	RouteOrder []string
}

// CatalogRoute is one paid HTTP route as declared in the catalog.
type CatalogRoute struct {
	Path                string
	Scheme              string
	Network             string
	AssetTransferMethod string
	RequiresEnv         string
	Price               catalogPrice
	Extensions          []string
	SettlementOverride  *SettlementAmount
	PaymentFlow         string
}

// ResolvedRoute is a catalog route with env-dependent requirements resolved.
type ResolvedRoute struct {
	Path                string
	NetworkID           string
	Scheme              string
	Network             string
	AssetTransferMethod string
	PayTo               string
	Price               interface{}
	Extra               map[string]interface{}
	Extensions          []string
	SettlementOverride  *SettlementAmount
}

var (
	catalogOnce sync.Once
	catalogData mechanismsCatalog
	catalogErr  error
)

var networkFileRe = regexp.MustCompile(`^mechanisms_(.+)\.json$`)

// findCatalogDir prefers the directory the harness injects and otherwise walks
// up from the working directory, so servers also run standalone from their
// own dir.
func findCatalogDir() (string, error) {
	if injected := os.Getenv("E2E_MECHANISMS_CATALOG"); injected != "" {
		if info, err := os.Stat(injected); err == nil && info.IsDir() {
			return injected, nil
		}
		return "", fmt.Errorf("E2E_MECHANISMS_CATALOG does not point at a directory: %s", injected)
	}

	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, "config", "mechanisms_global.json")
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return filepath.Join(dir, "config"), nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not locate e2e/config/mechanisms_global.json from %s", dir)
		}
		dir = parent
	}
}

func loadCatalog() (mechanismsCatalog, error) {
	catalogOnce.Do(func() {
		dir, err := findCatalogDir()
		if err != nil {
			catalogErr = err
			return
		}

		globalRaw, err := os.ReadFile(filepath.Join(dir, "mechanisms_global.json"))
		if err != nil {
			catalogErr = err
			return
		}
		var g globalFile
		if err := json.Unmarshal(globalRaw, &g); err != nil {
			catalogErr = err
			return
		}
		// Validate the new per-key env shape (global keys are harness-only).
		_ = flattenEnvMap(g.Env)

		entries, err := os.ReadDir(dir)
		if err != nil {
			catalogErr = err
			return
		}
		fileNames := []string{}
		for _, entry := range entries {
			name := entry.Name()
			if name == "mechanisms_global.json" {
				continue
			}
			if networkFileRe.MatchString(name) {
				fileNames = append(fileNames, name)
			}
		}
		sort.Strings(fileNames)

		networks := map[string]catalogNetwork{}
		routes := map[string]catalogRouteDefinition{}
		order := []string{}

		for _, fileName := range fileNames {
			id := networkFileRe.FindStringSubmatch(fileName)[1]
			raw, err := os.ReadFile(filepath.Join(dir, fileName))
			if err != nil {
				catalogErr = err
				return
			}
			var nf networkFile
			if err := json.Unmarshal(raw, &nf); err != nil {
				catalogErr = fmt.Errorf("%s: %w", fileName, err)
				return
			}

			networks[id] = catalogNetwork{
				Env:      flattenEnvMap(nf.Env),
				Networks: map[string]catalogNetworkMode{"testnet": nf.Testnet, "mainnet": nf.Mainnet},
			}

			// Re-decode from the raw file (not nf.Routes) to preserve route key order.
			fileRoutesRaw, fileOrder, err := extractOrderedRoutes(raw)
			if err != nil {
				catalogErr = fmt.Errorf("%s: %w", fileName, err)
				return
			}
			for _, path := range fileOrder {
				if _, exists := routes[path]; exists {
					catalogErr = fmt.Errorf("duplicate route path across mechanisms catalog files: %s", path)
					return
				}
				var def catalogRouteDefinition
				if err := json.Unmarshal(fileRoutesRaw[path], &def); err != nil {
					catalogErr = fmt.Errorf("%s: routes[%s]: %w", fileName, path, err)
					return
				}
				def.Network = id
				routes[path] = def
				order = append(order, path)
			}
		}

		catalogData = mechanismsCatalog{Networks: networks, Routes: routes, RouteOrder: order}
	})
	return catalogData, catalogErr
}

// extractOrderedRoutes pulls the top-level "routes" object out of a network
// catalog file, preserving key order and raw per-route JSON.
func extractOrderedRoutes(raw []byte) (map[string]json.RawMessage, []string, error) {
	var wrapper struct {
		Routes json.RawMessage `json:"routes"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return nil, nil, err
	}
	if len(wrapper.Routes) == 0 {
		return map[string]json.RawMessage{}, nil, nil
	}

	dec := json.NewDecoder(bytes.NewReader(wrapper.Routes))
	tok, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, nil, fmt.Errorf("routes: expected object")
	}

	routes := map[string]json.RawMessage{}
	order := []string{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		path, ok := keyTok.(string)
		if !ok {
			return nil, nil, fmt.Errorf("routes: expected string key")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, nil, fmt.Errorf("routes[%s]: %w", path, err)
		}
		routes[path] = raw
		order = append(order, path)
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, err
	}
	return routes, order, nil
}

// mustLoadCatalog loads the catalog or exits — servers cannot run without it.
func mustLoadCatalog() mechanismsCatalog {
	catalog, err := loadCatalog()
	if err != nil {
		fmt.Printf("❌ Failed to load mechanisms catalog: %v\n", err)
		os.Exit(1)
	}
	return catalog
}

func excludedFromEnv(name string) map[string]bool {
	excluded := map[string]bool{}
	for _, part := range strings.Split(os.Getenv(name), ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			excluded[trimmed] = true
		}
	}
	return excluded
}

func routeImplementsSDK(definition catalogRouteDefinition, sdk string) bool {
	for _, listed := range definition.Sdks {
		if listed == sdk {
			return true
		}
	}
	return false
}

// CatalogRoutes returns the routes this SDK implements, minus the exclusions the
// harness injects for surfaces that expose less than the full catalog.
func CatalogRoutes() []CatalogRoute {
	catalog := mustLoadCatalog()
	excludedSchemes := excludedFromEnv("E2E_EXCLUDE_SCHEMES")
	excludedNetworks := excludedFromEnv("E2E_EXCLUDE_NETWORKS")

	routes := make([]CatalogRoute, 0, len(catalog.RouteOrder))
	for _, path := range catalog.RouteOrder {
		definition := catalog.Routes[path]
		if !routeImplementsSDK(definition, catalogSDK) {
			continue
		}
		if excludedSchemes[definition.Scheme] || excludedNetworks[definition.Network] {
			continue
		}
		if definition.RequiresEnv != "" && os.Getenv(definition.RequiresEnv) == "" {
			continue
		}

		routes = append(routes, CatalogRoute{
			Path:                path,
			Scheme:              definition.Scheme,
			Network:             definition.Network,
			AssetTransferMethod: definition.AssetTransferMethod,
			RequiresEnv:         definition.RequiresEnv,
			Price:               definition.Price,
			Extensions:          definition.Extensions,
			SettlementOverride:  definition.SettlementOverride,
			PaymentFlow:         definition.PaymentFlow,
		})
	}
	return routes
}

// derivedNetworkKey returns the `${ID}_NETWORK` env key for a network.
func derivedNetworkKey(networkID string) string {
	return strings.ToUpper(networkID) + "_NETWORK"
}

// serverAddressEnvKey returns the `SERVER_${ID}_ADDRESS` env key for a network.
func serverAddressEnvKey(networkID string) string {
	return "SERVER_" + strings.ToUpper(networkID) + "_ADDRESS"
}

// NetworkCaip2 returns a network's CAIP-2 id: the harness env override when set,
// otherwise the catalog's testnet value.
func NetworkCaip2(networkID string) string {
	network, ok := mustLoadCatalog().Networks[networkID]
	if !ok {
		fmt.Printf("❌ Unknown network in catalog: %s\n", networkID)
		os.Exit(1)
	}
	if caip2 := os.Getenv(derivedNetworkKey(networkID)); caip2 != "" {
		return caip2
	}
	return network.Networks["testnet"].Caip2
}

// Caip2Pattern derives a CAIP-2 namespace wildcard (eip155:*) from a concrete CAIP-2 id.
func Caip2Pattern(caip2 string) string {
	ns, _, ok := strings.Cut(caip2, ":")
	if !ok || ns == "" {
		fmt.Printf("❌ invalid caip2: %s\n", caip2)
		os.Exit(1)
	}
	return ns + ":*"
}

// NetworkCaip2Pattern is the client/resource-server registration pattern for a catalog network.
func NetworkCaip2Pattern(networkID string) string {
	return Caip2Pattern(NetworkCaip2(networkID))
}

// CatalogNetworkIDs returns network ids that have at least one route for this SDK.
func CatalogNetworkIDs() []string {
	seen := map[string]bool{}
	ids := []string{}
	for _, route := range CatalogRoutes() {
		if !seen[route.Network] {
			seen[route.Network] = true
			ids = append(ids, route.Network)
		}
	}
	sort.Strings(ids)
	return ids
}

// ServerAddressEnvKey is the exported form of serverAddressEnvKey.
func ServerAddressEnvKey(networkID string) string {
	return serverAddressEnvKey(networkID)
}

func networkMode(network catalogNetwork, caip2 string) catalogNetworkMode {
	if mainnet, ok := network.Networks["mainnet"]; ok && mainnet.Caip2 == caip2 {
		return mainnet
	}
	return network.Networks["testnet"]
}

func resolvePrice(route CatalogRoute, network catalogNetwork, caip2 string) (interface{}, map[string]interface{}, error) {
	spec := route.Price

	if spec.USD != "" {
		if spec.DeclareAssetTransferMethod && route.AssetTransferMethod != "" {
			return spec.USD, map[string]interface{}{"assetTransferMethod": route.AssetTransferMethod}, nil
		}
		return spec.USD, nil, nil
	}

	mode := networkMode(network, caip2)

	amount := spec.Amount
	if spec.AmountEnv != "" {
		if fromEnv := os.Getenv(spec.AmountEnv); fromEnv != "" {
			amount = fromEnv
		}
	}
	if amount == "" {
		return nil, nil, fmt.Errorf("route %s: price has no amount", route.Path)
	}

	assetDefault := spec.Asset
	if spec.AssetRef == "permit2" {
		assetDefault = mode.Permit2Asset
	}
	asset := assetDefault
	if spec.AssetEnv != "" {
		if fromEnv := os.Getenv(spec.AssetEnv); fromEnv != "" {
			asset = fromEnv
		}
	}
	if asset == "" {
		return nil, nil, fmt.Errorf("route %s: price has no asset", route.Path)
	}
	assetOverridden := assetDefault != "" && asset != assetDefault

	extra := map[string]interface{}{}
	if route.AssetTransferMethod != "" {
		extra["assetTransferMethod"] = route.AssetTransferMethod
	}
	if spec.Permit2Domain && mode.Permit2AssetName != "" {
		extra["name"] = mode.Permit2AssetName
		extra["version"] = "2"
	}
	for key, envSpec := range spec.ExtraEnv {
		if envSpec.WhenAssetOverridden && !assetOverridden {
			continue
		}
		if value := os.Getenv(envSpec.Env); value != "" {
			extra[key] = value
		}
	}

	price := map[string]interface{}{"amount": amount, "asset": asset}
	if len(extra) > 0 {
		price["extra"] = extra
	}
	return price, nil, nil
}

// mergeRouteExtra merges price-derived extra with catalog paymentFlow.
// Authorization is omitted on the wire, matching core applyPaymentFlowWireExtra.
func mergeRouteExtra(priceExtra map[string]interface{}, paymentFlow string) map[string]interface{} {
	var wireFlow string
	if paymentFlow != "" && paymentFlow != "authorization" {
		wireFlow = paymentFlow
	}
	if wireFlow == "" && len(priceExtra) == 0 {
		return nil
	}
	extra := map[string]interface{}{}
	for key, value := range priceExtra {
		extra[key] = value
	}
	if wireFlow != "" {
		extra["paymentFlow"] = wireFlow
	}
	return extra
}

// ResolvedRoutes resolves every catalog route against this process's env.
// Routes whose network has no configured payee address are dropped, so the
// server only advertises what it can settle.
func ResolvedRoutes() []ResolvedRoute {
	catalog := mustLoadCatalog()
	resolved := make([]ResolvedRoute, 0, len(catalog.RouteOrder))

	for _, route := range CatalogRoutes() {
		network := catalog.Networks[route.Network]
		payTo := os.Getenv(serverAddressEnvKey(route.Network))
		if payTo == "" {
			continue
		}

		caip2 := NetworkCaip2(route.Network)

		price, priceExtra, err := resolvePrice(route, network, caip2)
		if err != nil {
			fmt.Printf("❌ %v\n", err)
			os.Exit(1)
		}
		extra := mergeRouteExtra(priceExtra, route.PaymentFlow)

		resolved = append(resolved, ResolvedRoute{
			Path:                route.Path,
			NetworkID:           route.Network,
			Scheme:              route.Scheme,
			Network:             caip2,
			AssetTransferMethod: route.AssetTransferMethod,
			PayTo:               payTo,
			Price:               price,
			Extra:               extra,
			Extensions:          route.Extensions,
			SettlementOverride:  route.SettlementOverride,
		})
	}

	return resolved
}

// gasSponsoringLabels are extensions that change how gas is paid, and so are
// worth naming in route descriptions. Mirrors TS GAS_SPONSORING_LABELS.
var gasSponsoringLabels = map[string]string{
	"eip2612GasSponsoring":       "EIP-2612 gas sponsoring",
	"erc20ApprovalGasSponsoring": "ERC-20 approval gas sponsoring",
}

// RouteDescription builds a human-readable route description, mirroring TS
// `routeDescription`: "Protected <scheme> <transfer>endpoint on <NETWORK> with <sponsoring>".
func RouteDescription(route ResolvedRoute) string {
	label := strings.ToUpper(route.NetworkID)
	scheme := ""
	if route.Scheme != "exact" {
		scheme = route.Scheme + " "
	}
	transfer := ""
	if route.AssetTransferMethod != "" {
		transfer = route.AssetTransferMethod + " "
	}
	sponsoring := make([]string, 0, len(route.Extensions))
	for _, id := range route.Extensions {
		if label, ok := gasSponsoringLabels[id]; ok {
			sponsoring = append(sponsoring, label)
		}
	}
	suffix := ""
	if len(sponsoring) > 0 {
		suffix = " with " + strings.Join(sponsoring, " and ")
	}
	flow := ""
	if route.Extra != nil {
		if paymentFlow, ok := route.Extra["paymentFlow"].(string); ok && paymentFlow != "" && paymentFlow != "authorization" {
			flow = " " + paymentFlow
		}
	}
	return fmt.Sprintf("Protected %s%sendpoint on %s%s%s", scheme, transfer, label, flow, suffix)
}

// McpToolName converts a catalog path to an MCP tool name: "/exact/evm/eip3009" → "exact_evm_eip3009".
func McpToolName(path string) string {
	trimmed := strings.TrimPrefix(path, "/")
	replaced := strings.ReplaceAll(trimmed, "/", "_")
	return strings.ReplaceAll(replaced, "-", "_")
}

// RouteDiscoveryOutput returns bazaar metadata matching the fixed paid-route body.
func RouteDiscoveryOutput() (map[string]interface{}, map[string]interface{}, []string) {
	example := map[string]interface{}{
		"message":   ProtectedRouteMessage,
		"timestamp": "2024-01-01T00:00:00Z",
	}
	keys := []string{"message", "timestamp"}
	properties := map[string]interface{}{}
	for _, key := range keys {
		properties[key] = map[string]interface{}{"type": "string"}
	}
	return example, properties, keys
}
