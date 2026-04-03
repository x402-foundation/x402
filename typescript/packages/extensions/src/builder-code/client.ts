/**
 * Client-side extension for the Builder Code Extension.
 *
 * Implements the ClientExtension interface to automatically inject
 * the agent's builder code into payment payloads and echo the service's
 * builder code from the 402 response.
 */

import type { ClientExtension } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  type BuilderCodeClientConfig,
  type BuilderCodeExtensionData,
} from "./types";

/**
 * Creates a BuilderCode client extension that automatically enriches
 * payment payloads with the agent's builder code.
 *
 * The extension:
 * 1. Reads the service's builder code from the 402 response extensions
 * 2. Adds the agent's own builder code as the "a" (app) field
 * 3. Preserves the service's codes in the "s" (services) array
 *
 * @param config - Configuration with the agent's builder code
 * @returns A ClientExtension ready to register with x402Client
 *
 * @example
 * ```typescript
 * import { createBuilderCodeClientExtension } from '@x402/extensions/builder-code';
 *
 * const client = new x402Client();
 * client.registerExtension(createBuilderCodeClientExtension({
 *   builderCode: "bc_my_agent",
 * }));
 * ```
 */
export function createBuilderCodeClientExtension(
  config: BuilderCodeClientConfig,
): ClientExtension {
  if (!BUILDER_CODE_PATTERN.test(config.builderCode)) {
    throw new Error(
      `Invalid builder code: "${config.builderCode}". ` +
        `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
    );
  }

  return {
    key: BUILDER_CODE,

    async enrichPaymentPayload(
      paymentPayload: PaymentPayload,
      paymentRequired: PaymentRequired,
    ): Promise<PaymentPayload> {
      // Read existing builder-code extension data from the 402 response
      const serverExtData = paymentRequired.extensions?.[BUILDER_CODE] as
        | BuilderCodeExtensionData
        | undefined;

      // Build the merged extension data
      const builderCodeData: BuilderCodeExtensionData = {
        a: config.builderCode,
        s: serverExtData?.s ? [...serverExtData.s] : undefined,
      };

      // Merge into payload extensions
      const extensions = {
        ...paymentPayload.extensions,
        [BUILDER_CODE]: builderCodeData,
      };

      return {
        ...paymentPayload,
        extensions,
      };
    },
  };
}
