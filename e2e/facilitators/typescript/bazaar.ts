import type { DiscoveryInfo } from "@x402/extensions/bazaar";
import type { PaymentRequirements } from "@x402/core/types";

export interface DiscoveredResource {
  resource: string;
  type: "http" | "mcp";
  x402Version: number;
  accepts: PaymentRequirements[];
  discoveryInfo?: DiscoveryInfo;
  routeTemplate?: string;
  lastUpdated: string;
  extensions?: Record<string, unknown>;
}

export class BazaarCatalog {
  private discoveredResources = new Map<string, DiscoveredResource>();

  catalogResource(
    resourceUrl: string,
    method: string,
    x402Version: number,
    discoveryInfo: DiscoveryInfo,
    paymentRequirements: PaymentRequirements,
    routeTemplate?: string,
  ): void {
    console.log(`📝 Discovered resource: ${resourceUrl}`);
    console.log(`   Method: ${method}`);
    console.log(`   x402 Version: ${x402Version}`);
    if (routeTemplate) {
      console.log(`   Route template: ${routeTemplate}`);
    }

    this.discoveredResources.set(resourceUrl, {
      resource: resourceUrl,
      type: discoveryInfo.input.type,
      x402Version,
      accepts: [paymentRequirements],
      discoveryInfo,
      routeTemplate,
      lastUpdated: new Date().toISOString(),
      extensions: {},
    });
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
   * type, and extension values.
   */
  searchResources(query: string, type?: string, limit?: number) {
    const needle = query.toLowerCase();
    let results = Array.from(this.discoveredResources.values()).filter((r) => {
      const haystack = [
        r.resource,
        r.type,
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
