/**
 * Resource Server utilities for the Builder Code Extension.
 *
 * Services use this to declare their builder code in the 402 response,
 * which gets echoed back by the client and forwarded to the facilitator.
 */

import type { ResourceServerExtension } from "@x402/core/types";
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  type BuilderCodeExtensionData,
} from "./types";

/**
 * Declares the builder-code extension for inclusion in PaymentRequired.extensions.
 *
 * The service's builder code is placed in the "s" (services) array.
 * The client will echo this back in the payment payload, and the facilitator
 * will include it in the ERC-8021 Schema 2 suffix at settlement.
 *
 * @param builderCode - The service's builder code (e.g., "bc_weather_svc")
 * @returns A BuilderCodeExtensionData object for PaymentRequired.extensions
 *
 * @example
 * ```typescript
 * import { declareBuilderCodeExtension, BUILDER_CODE } from '@x402/extensions/builder-code';
 *
 * // In your paywall config
 * const paymentRequired = {
 *   x402Version: 2,
 *   accepts: [ ... ],
 *   extensions: {
 *     [BUILDER_CODE]: declareBuilderCodeExtension("bc_weather_svc"),
 *   },
 * };
 * ```
 */
export function declareBuilderCodeExtension(
  builderCode: string,
): BuilderCodeExtensionData {
  if (!BUILDER_CODE_PATTERN.test(builderCode)) {
    throw new Error(
      `Invalid builder code: "${builderCode}". ` +
        `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
    );
  }

  return {
    s: [builderCode],
  };
}

/**
 * ResourceServerExtension implementation for builder-code.
 *
 * Register this with the resource server to advertise builder code support.
 * The actual builder code value is set via declareBuilderCodeExtension()
 * in the paywall configuration.
 */
export const builderCodeResourceServerExtension: ResourceServerExtension = {
  key: BUILDER_CODE,
};
