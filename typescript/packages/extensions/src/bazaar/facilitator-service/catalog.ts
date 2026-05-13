/**
 * BazaarCatalog: storage interface for cataloging discovered x402 resources.
 *
 * Facilitators receive `bazaar` discovery extensions inside payment payloads.
 * `installBazaarFacilitator` extracts each discovery via `extractDiscoveryInfo`
 * and forwards the result here. The interface is intentionally narrow so it can
 * be implemented against an in-memory Map, Postgres, Redis, or anything else.
 *
 * The list/search response shapes match the spec's facilitator discovery API
 * (`GET /discovery/resources`, `GET /discovery/search`); see
 * `specs/extensions/bazaar.md` "Optional Discovery Endpoints".
 */

import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource } from "../facilitator";
import type {
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  SearchDiscoveryResourcesResponse,
} from "../facilitatorClient";

export type {
  ListDiscoveryResourcesParams,
  SearchDiscoveryResourcesParams,
  DiscoveryResource,
  DiscoveryResourcesResponse,
  SearchDiscoveryResourcesResponse,
};

/**
 * Input to `BazaarCatalog.upsert`. The catalog is responsible for merging this
 * single observation into any existing row for the same canonical resource.
 *
 * Note: at verify time the facilitator only sees the **one** PaymentRequirements
 * the client selected — not the full accepts[] from the original 402. Catalog
 * implementations must merge `paymentRequirements` into the row's accepts list
 * (deduped by `(scheme, network)`) so the catalog converges on the full set
 * across many payments.
 */
export interface CatalogUpsertInput {
  /** Extracted discovery resource as produced by `extractDiscoveryInfo`. */
  discovered: DiscoveredResource;
  /** The single PaymentRequirements selected for this payment. */
  paymentRequirements: PaymentRequirements;
  /** Optional extra extensions from the payment payload, stored alongside the row. */
  extensions?: Record<string, unknown>;
}

export interface BazaarCatalog {
  /**
   * Insert or update a row for the canonical resource. Must merge accepts
   * (deduped by scheme+network) and update lastSeenAt on upsert. Idempotent.
   */
  upsert(input: CatalogUpsertInput): Promise<void>;

  /** List cataloged resources with optional filters and offset pagination. */
  list(params?: ListDiscoveryResourcesParams): Promise<DiscoveryResourcesResponse>;

  /** Search cataloged resources by natural-language query. Cursor pagination is optional. */
  search(params: SearchDiscoveryResourcesParams): Promise<SearchDiscoveryResourcesResponse>;
}
