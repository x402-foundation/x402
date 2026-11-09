package client

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// catalogTestnetCaip2 reads testnet.caip2 from e2e/config/mechanisms_<id>.json.
func catalogTestnetCaip2(networkID string) (string, error) {
	candidates := []string{}
	if injected := os.Getenv("E2E_MECHANISMS_CATALOG"); injected != "" {
		candidates = append(candidates, injected)
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidates = append(candidates, filepath.Join(dir, "config"))
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	for _, catalogDir := range candidates {
		path := filepath.Join(catalogDir, fmt.Sprintf("mechanisms_%s.json", networkID))
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		var file struct {
			Testnet struct {
				Caip2 string `json:"caip2"`
			} `json:"testnet"`
		}
		if err := json.Unmarshal(raw, &file); err != nil {
			return "", fmt.Errorf("%s: %w", path, err)
		}
		if file.Testnet.Caip2 == "" {
			return "", fmt.Errorf("%s: missing testnet.caip2", path)
		}
		return file.Testnet.Caip2, nil
	}
	return "", fmt.Errorf("could not locate mechanisms_%s.json", networkID)
}

// resolveNetworkCaip2 prefers `${ID}_NETWORK`, else catalog testnet CAIP-2.
func resolveNetworkCaip2(networkID string) string {
	if fromEnv := os.Getenv(strings.ToUpper(networkID) + "_NETWORK"); fromEnv != "" {
		return fromEnv
	}
	caip2, err := catalogTestnetCaip2(networkID)
	if err != nil {
		log.Fatalf("❌ %v", err)
	}
	return caip2
}

// caip2Pattern derives a CAIP-2 namespace wildcard (eip155:*) from a concrete CAIP-2 id.
func caip2Pattern(caip2 string) string {
	ns, _, ok := strings.Cut(caip2, ":")
	if !ok || ns == "" {
		log.Fatalf("❌ invalid caip2: %s", caip2)
	}
	return ns + ":*"
}

// networkCaip2Pattern is the client registration pattern for a catalog network.
func networkCaip2Pattern(networkID string) string {
	return caip2Pattern(resolveNetworkCaip2(networkID))
}
