package main

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	exttypes "github.com/x402-foundation/x402/go/extensions/types"
)

type DiscoveredResource struct {
	Resource      string                     `json:"resource"`
	Type          string                     `json:"type"`
	X402Version   int                        `json:"x402Version"`
	Accepts       []x402.PaymentRequirements `json:"accepts"`
	DiscoveryInfo *exttypes.DiscoveryInfo    `json:"discoveryInfo,omitempty"`
	RouteTemplate string                     `json:"routeTemplate,omitempty"`
	LastUpdated   string                     `json:"lastUpdated"`
	Extensions    map[string]interface{}     `json:"extensions,omitempty"`
}

type BazaarCatalog struct {
	discoveredResources map[string]DiscoveredResource
	mutex               *sync.RWMutex
}

func NewBazaarCatalog() *BazaarCatalog {
	return &BazaarCatalog{
		discoveredResources: make(map[string]DiscoveredResource),
		mutex:               &sync.RWMutex{},
	}
}

func (c *BazaarCatalog) CatalogResource(
	resourceURL string,
	method string,
	x402Version int,
	discoveryInfo *exttypes.DiscoveryInfo,
	paymentRequirements x402.PaymentRequirements,
	routeTemplate string,
) {
	log.Printf("📝 Discovered resource: %s", resourceURL)
	log.Printf("   Method: %s", method)
	log.Printf("   x402 Version: %d", x402Version)
	if routeTemplate != "" {
		log.Printf("   Route template: %s", routeTemplate)
	}

	// Derive type from discovery info input type
	resourceType := "http"
	if discoveryInfo != nil {
		if _, ok := discoveryInfo.Input.(exttypes.McpInput); ok {
			resourceType = "mcp"
		}
	}

	c.mutex.Lock()
	defer c.mutex.Unlock()

	c.discoveredResources[resourceURL] = DiscoveredResource{
		Resource:      resourceURL,
		Type:          resourceType,
		X402Version:   x402Version,
		Accepts:       []x402.PaymentRequirements{paymentRequirements},
		DiscoveryInfo: discoveryInfo,
		RouteTemplate: routeTemplate,
		LastUpdated:   time.Now().Format(time.RFC3339),
		Extensions:    make(map[string]interface{}),
	}
}

func (c *BazaarCatalog) GetResources(limit, offset int) ([]DiscoveredResource, int) {
	c.mutex.RLock()
	defer c.mutex.RUnlock()

	all := make([]DiscoveredResource, 0, len(c.discoveredResources))
	for _, r := range c.discoveredResources {
		all = append(all, r)
	}

	total := len(all)
	if offset >= total {
		return []DiscoveredResource{}, total
	}

	end := offset + limit
	if end > total {
		end = total
	}

	return all[offset:end], total
}

// SearchResources performs case-insensitive keyword search across resource URL,
// type, and extension values.
func (c *BazaarCatalog) SearchResources(query, resourceType string, limit int) ([]DiscoveredResource, string) {
	c.mutex.RLock()
	defer c.mutex.RUnlock()

	needle := strings.ToLower(query)
	var results []DiscoveredResource

	for _, r := range c.discoveredResources {
		haystack := strings.ToLower(r.Resource + " " + r.Type)
		for _, v := range r.Extensions {
			haystack += " " + strings.ToLower(fmt.Sprintf("%v", v))
		}
		if !strings.Contains(haystack, needle) {
			continue
		}
		if resourceType != "" && r.Type != resourceType {
			continue
		}
		results = append(results, r)
	}

	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}

	return results, query
}

func (c *BazaarCatalog) GetCount() int {
	c.mutex.RLock()
	defer c.mutex.RUnlock()

	return len(c.discoveredResources)
}
