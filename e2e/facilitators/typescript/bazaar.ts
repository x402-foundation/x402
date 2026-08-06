import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";

export class BazaarCatalog {
  private discoveredResources = new Map<string, DiscoveryResource>();

  add(resource: DiscoveryResource): void {
    console.log(`📝 Discovered resource: ${resource.resource}`);
    console.log(`   x402 Version: ${resource.x402Version}`);
    if (resource.serviceName) {
      console.log(`   Service: ${resource.serviceName}`);
    }
    if (resource.tags?.length) {
      console.log(`   Tags: ${resource.tags.join(", ")}`);
    }

    this.discoveredResources.set(resource.resource, resource);
  }

  getResources(limit: number = 100, offset: number = 0) {
    const allResources = Array.from(this.discoveredResources.values());
    const total = allResources.length;
    const items = allResources.slice(offset, offset + limit);

    return {
      x402Version: 2,
      items,
      pagination: {
        limit,
        offset,
        total,
      },
    };
  }

  /**
   * Search resources using case-insensitive keyword matching against resource URL,
   * type, description, service metadata, and extension values.
   */
  searchResources(query: string, type?: string, limit?: number) {
    const needle = query.toLowerCase();
    let results = Array.from(this.discoveredResources.values()).filter((r) => {
      const haystack = [
        r.resource,
        r.type,
        r.description ?? "",
        r.serviceName ?? "",
        ...(r.tags ?? []),
        ...Object.values(r.extensions ?? {}),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });

    if (type) {
      results = results.filter((r) => r.type === type);
    }

    const items = limit !== undefined ? results.slice(0, limit) : results;

    return {
      x402Version: 2,
      resources: items,
      partialResults: false,
      pagination: null,
    };
  }

  getCount(): number {
    return this.discoveredResources.size;
  }
}
