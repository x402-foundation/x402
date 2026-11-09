package main

import (
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/x402-foundation/x402/go/v2/extensions/bazaar"
)

type BazaarCatalog struct {
	discoveredResources map[string]bazaar.DiscoveryResource
	mutex               *sync.RWMutex
}

func NewBazaarCatalog() *BazaarCatalog {
	return &BazaarCatalog{
		discoveredResources: make(map[string]bazaar.DiscoveryResource),
		mutex:               &sync.RWMutex{},
	}
}

func (c *BazaarCatalog) Add(resource bazaar.DiscoveryResource) {
	log.Printf("📝 Discovered resource: %s", resource.Resource)
	log.Printf("   x402 Version: %d", resource.X402Version)
	if resource.ServiceName != "" {
		log.Printf("   Service: %s", resource.ServiceName)
	}
	if len(resource.Tags) > 0 {
		log.Printf("   Tags: %s", strings.Join(resource.Tags, ", "))
	}

	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.discoveredResources[resource.Resource] = resource
}

func (c *BazaarCatalog) GetResources(limit, offset int) ([]bazaar.DiscoveryResource, int) {
	c.mutex.RLock()
	defer c.mutex.RUnlock()

	all := make([]bazaar.DiscoveryResource, 0, len(c.discoveredResources))
	for _, r := range c.discoveredResources {
		all = append(all, r)
	}

	total := len(all)
	if offset >= total {
		return []bazaar.DiscoveryResource{}, total
	}

	end := offset + limit
	if end > total {
		end = total
	}

	return all[offset:end], total
}

// SearchResources performs case-insensitive keyword search across resource URL,
// type, description, service metadata, and extension values.
func (c *BazaarCatalog) SearchResources(query, resourceType string, limit int) ([]bazaar.DiscoveryResource, string) {
	c.mutex.RLock()
	defer c.mutex.RUnlock()

	needle := strings.ToLower(query)
	var results []bazaar.DiscoveryResource

	for _, r := range c.discoveredResources {
		haystack := strings.ToLower(strings.Join([]string{
			r.Resource,
			r.Type,
			r.Description,
			r.ServiceName,
			strings.Join(r.Tags, " "),
		}, " "))
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
