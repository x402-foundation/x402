package server

import (
	"fmt"
	"os"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/server"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/server"
	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/server"
	uptosvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/server"
	svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
)

// Config holds shared env for Go e2e resource servers (gin/nethttp/echo).
type Config struct {
	Port            string
	FacilitatorURL  string
	Payees          map[string]string // network id → SERVER_${ID}_ADDRESS
	EVMPermit2Asset string
}

// Payee returns the payee address for a catalog network id, if configured.
func (c Config) Payee(networkID string) string {
	return c.Payees[networkID]
}

// LoadConfig reads and validates role-prefixed server env vars.
func LoadConfig() Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "4021"
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	payees := map[string]string{}
	for _, networkID := range CatalogNetworkIDs() {
		addr := os.Getenv(ServerAddressEnvKey(networkID))
		if addr == "" {
			continue
		}
		payees[networkID] = addr
		fmt.Printf("%s Payee address: %s\n", strings.ToUpper(networkID), addr)
	}
	if len(payees) == 0 {
		fmt.Println("❌ At least one SERVER_*_ADDRESS for a Go catalog network is required")
		os.Exit(1)
	}

	evmPermit2Asset := os.Getenv("EVM_PERMIT2_ASSET")
	if evmPermit2Asset == "" {
		evmPermit2Asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	}

	fmt.Printf("Using remote facilitator at: %s\n", facilitatorURL)

	return Config{
		Port:            port,
		FacilitatorURL:  facilitatorURL,
		Payees:          payees,
		EVMPermit2Asset: evmPermit2Asset,
	}
}

// NewFacilitatorClient builds an HTTP facilitator client from config.
func NewFacilitatorClient(cfg Config) *x402http.HTTPFacilitatorClient {
	return x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: cfg.FacilitatorURL,
	})
}

// SchemeBatched is re-exported for route builders that need the scheme name.
const SchemeBatched = batchsettlement.SchemeBatched

// networkFor converts a CAIP-2 identifier from the catalog to an SDK network.
func networkFor(caip2 string) x402.Network {
	return x402.Network(caip2)
}

// SchemeBinding pairs a network with the scheme server that handles it. Each
// framework maps these to its own middleware SchemeConfig type.
type SchemeBinding struct {
	Network x402.Network
	Server  x402.SchemeNetworkServer
}

// SchemeBindings derives the scheme registrations from the resolved route set,
// so a server exposing a narrower set of routes registers fewer schemes without
// any per-framework bookkeeping.
//
// Go's x402ResourceServer.BuildPaymentRequirements looks up schemes by exact
// CAIP-2 (not wildcard), so we register the catalog-resolved exact network id
// here. Clients still register catalog-derived wildcards via NetworkCaip2Pattern.
func SchemeBindings(cfg Config) []SchemeBinding {
	var (
		exactEVM *exactevm.ExactEvmScheme
		uptoEVM  *uptoevm.UptoEvmScheme
		batched  *batchedserver.BatchSettlementEvmScheme
		exactSVM *svm.ExactSvmScheme
		uptoSVM  *uptosvm.UptoSvmScheme
	)

	schemeFor := func(networkID, scheme string) x402.SchemeNetworkServer {
		switch networkID {
		case "evm":
			switch scheme {
			case "exact":
				if exactEVM == nil {
					exactEVM = exactevm.NewExactEvmScheme()
				}
				return exactEVM
			case "upto":
				if uptoEVM == nil {
					uptoEVM = uptoevm.NewUptoEvmScheme()
				}
				return uptoEVM
			case SchemeBatched:
				if batched == nil {
					batchedCfg := &batchedserver.BatchSettlementEvmSchemeServerConfig{}
					if authKey := os.Getenv("SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"); authKey != "" {
						auth, err := NewBatchedAuthorizerSigner(authKey)
						if err != nil {
							fmt.Printf("Failed to parse SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
							os.Exit(1)
						}
						batchedCfg.ReceiverAuthorizerSigner = auth
						fmt.Printf("Batch-settlement receiver authorizer (self-managed): %s\n", auth.Address())
					} else {
						fmt.Println("Batch-settlement receiver authorizer: facilitator-delegated")
					}
					batched = batchedserver.NewBatchSettlementEvmScheme(cfg.Payee("evm"), batchedCfg)
				}
				return batched
			}
		case "svm":
			switch scheme {
			case "exact":
				if exactSVM == nil {
					exactSVM = svm.NewExactSvmScheme()
				}
				return exactSVM
			case "upto":
				if uptoSVM == nil {
					authorizerKey := os.Getenv("SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
					if authorizerKey == "" {
						return nil
					}
					authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(authorizerKey)
					if err != nil {
						fmt.Printf("Failed to parse SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
						os.Exit(1)
					}
					fmt.Printf("SVM receiver authorizer: %s\n", authorizer.Address())
					uptoSVM = uptosvm.NewUptoSvmScheme(&uptosvm.Config{
						ReceiverAuthorizerSigner: authorizer,
						RPCURL:                   os.Getenv("SVM_RPC_URL"),
					})
				}
				return uptoSVM
			}
		}
		return nil
	}

	bindings := []SchemeBinding{}
	seen := map[string]bool{}
	for _, route := range ResolvedRoutes() {
		caip2 := NetworkCaip2(route.NetworkID)
		key := caip2 + "|" + route.Scheme
		if seen[key] {
			continue
		}
		server := schemeFor(route.NetworkID, route.Scheme)
		if server == nil {
			fmt.Printf("❌ No Go scheme server registered for %s on %s\n", route.Scheme, route.NetworkID)
			os.Exit(1)
		}
		seen[key] = true
		bindings = append(bindings, SchemeBinding{Network: x402.Network(caip2), Server: server})
	}

	return bindings
}
