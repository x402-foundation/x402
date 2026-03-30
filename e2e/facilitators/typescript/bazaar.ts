import type { DiscoveryInfo } from "@x402/extensions/bazaar";
import type { PaymentRequirements } from "@x402/core/types";

export interface DiscoveredResource {
  resource: string;
  type: "http";
  x402Version: number;
  accepts: PaymentRequirements[];
  discoveryInfo?: DiscoveryInfo;
  routeTemplate?: string;
  lastUpdated: string;
  metadata?: Record<string, unknown>;
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
      type: "http",
      x402Version,
      accepts: [paymentRequirements],
      discoveryInfo,
      routeTemplate,
      lastUpdated: new Date().toISOString(),
      metadata: {},
    });
  }

  getResources(limit: number = 100, offset: number = 0) {
    const allResources = Array.from(this.discoveredResources.values());
    const total = allResources.length;
    const items = allResources.slice(offset, offset + limit);

    return {
      x402Version: 1,
      items,
      pagination: {
        limit,
        offset,
        total,
      },
    };
  }

  getCount(): number {
    return this.discoveredResources.size;
  }
}

