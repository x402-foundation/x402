/**
 * Resource Server utilities for the Builder Code Extension.
 *
 * Services use this to declare their builder code in the 402 response.
 * The service's code goes in the "a" (app) field since the service is
 * the application exposing the x402 endpoint. Optionally, the service
 * can include related on-chain services in the "s" array.
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
 * The service's builder code is placed in the "a" (app) field — the service
 * is the application that exposed the x402 endpoint. Related on-chain services
 * the app depends on (e.g., Morpho, Aerodrome) can be listed in the "s" array.
 *
 * @param appCode - The service's builder code (e.g., "bc_weather_svc")
 * @param serviceCodes - Optional array of related service builder codes
 * @returns A BuilderCodeExtensionData object for PaymentRequired.extensions
 *
 * @example
 * ```typescript
 * import { declareBuilderCodeExtension, BUILDER_CODE } from '@x402/extensions/builder-code';
 *
 * // Simple: just the service's own code
 * extensions: {
 *   [BUILDER_CODE]: declareBuilderCodeExtension("bc_weather_svc"),
 * }
 *
 * // With related services
 * extensions: {
 *   [BUILDER_CODE]: declareBuilderCodeExtension("bc_lending_app", ["bc_morpho", "bc_aerodrome"]),
 * }
 * ```
 */
export function declareBuilderCodeExtension(
  appCode: string,
  serviceCodes?: string[],
): BuilderCodeExtensionData {
  if (!BUILDER_CODE_PATTERN.test(appCode)) {
    throw new Error(
      `Invalid builder code: "${appCode}". ` +
        `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
    );
  }

  if (serviceCodes) {
    for (const code of serviceCodes) {
      if (!BUILDER_CODE_PATTERN.test(code)) {
        throw new Error(
          `Invalid service builder code: "${code}". ` +
            `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
        );
      }
    }
  }

  const data: BuilderCodeExtensionData = {
    a: appCode,
  };

  if (serviceCodes && serviceCodes.length > 0) {
    data.s = serviceCodes;
  }

  return data;
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
