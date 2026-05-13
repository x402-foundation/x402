/**
 * One-call wiring of the `bazaar` extension into an x402Facilitator.
 *
 * Registers the `bazaar` marker (so `/supported` advertises it) and installs an
 * `onAfterVerify` hook that extracts the discovery info from each verified
 * payment and forwards it to the supplied `BazaarCatalog`.
 *
 * The hook is best-effort: any catalog error is logged but never propagated,
 * because cataloging is purely observational and must not break payment
 * verification.
 */

import type { x402Facilitator } from "@x402/core/facilitator";
import { BAZAAR } from "../types";
import { extractDiscoveryInfo } from "../facilitator";
import type { BazaarCatalog } from "./catalog";

export interface InstallBazaarFacilitatorOptions {
  /**
   * Called when the catalog upsert throws. Defaults to `console.warn`.
   * Provide your own logger to integrate with the facilitator's existing
   * observability stack.
   */
  onError?: (error: unknown) => void;
}

/**
 * Registers the bazaar extension marker and installs the cataloging hook.
 *
 * @param facilitator - The x402Facilitator instance to wire into.
 * @param catalog - The BazaarCatalog implementation that will receive discoveries.
 * @param options - Optional overrides (custom error handler).
 * @returns The same facilitator for chaining.
 *
 * @example
 * ```typescript
 * import { x402Facilitator } from "@x402/core/facilitator";
 * import { installBazaarFacilitator, InMemoryBazaarCatalog } from "@x402/extensions";
 *
 * const facilitator = new x402Facilitator();
 * // ... register schemes ...
 * installBazaarFacilitator(facilitator, new InMemoryBazaarCatalog());
 * ```
 */
export function installBazaarFacilitator(
  facilitator: x402Facilitator,
  catalog: BazaarCatalog,
  options: InstallBazaarFacilitatorOptions = {},
): x402Facilitator {
  const onError =
    options.onError ??
    ((err: unknown) => {
      console.warn(`[bazaar] catalog upsert failed: ${err instanceof Error ? err.message : err}`);
    });

  return facilitator.registerExtension(BAZAAR).onAfterVerify(async context => {
    let discovered;
    try {
      discovered = extractDiscoveryInfo(context.paymentPayload, context.requirements);
    } catch (err) {
      onError(err);
      return;
    }
    if (!discovered) return;

    try {
      await catalog.upsert({
        discovered,
        paymentRequirements: context.requirements,
        extensions: context.paymentPayload.extensions as Record<string, unknown> | undefined,
      });
    } catch (err) {
      onError(err);
    }
  });
}
