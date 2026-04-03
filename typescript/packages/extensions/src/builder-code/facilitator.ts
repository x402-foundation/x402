/**
 * Facilitator-side extension for the Builder Code Extension.
 *
 * At settlement time, the facilitator:
 * 1. Reads builder code data from the payment payload extensions
 * 2. Adds its own builder code to the "s" array
 * 3. Encodes the combined data as an ERC-8021 Schema 2 CBOR suffix
 * 4. The suffix is appended to the settlement transaction calldata
 */

import type { FacilitatorExtension } from "@x402/core/types";
import type { Hex } from "viem";
import { encodeBuilderCodeSuffix } from "./cbor";
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  type BuilderCodeExtensionData,
  type BuilderCodeFacilitatorConfig,
} from "./types";

/**
 * Facilitator extension that manages builder code attribution at settlement time.
 *
 * Register this with the x402Facilitator to enable builder code support.
 * The extension reads builder code data from payment payloads and provides
 * the encoded ERC-8021 suffix for the settlement mechanism to append.
 *
 * @example
 * ```typescript
 * import { BuilderCodeFacilitatorExtension } from '@x402/extensions/builder-code';
 *
 * const facilitator = new x402Facilitator();
 * facilitator.registerExtension(new BuilderCodeFacilitatorExtension({
 *   builderCode: "bc_my_facilitator",
 * }));
 * ```
 */
export class BuilderCodeFacilitatorExtension implements FacilitatorExtension {
  readonly key = BUILDER_CODE;
  private readonly config: BuilderCodeFacilitatorConfig;

  constructor(config: BuilderCodeFacilitatorConfig) {
    if (!BUILDER_CODE_PATTERN.test(config.builderCode)) {
      throw new Error(
        `Invalid builder code: "${config.builderCode}". ` +
          `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
      );
    }
    this.config = config;
  }

  /**
   * Builds the ERC-8021 Schema 2 calldata suffix from payment payload extensions.
   *
   * Reads "a" (agent code) and "s" (service codes) from the payment payload,
   * prepends the facilitator's own code to "s", and encodes as Schema 2 CBOR.
   *
   * @param payloadExtensions - The extensions from the payment payload
   * @returns Hex-encoded suffix to append to settlement calldata, or undefined if no builder codes
   */
  buildCalldataSuffix(payloadExtensions?: Record<string, unknown>): Hex | undefined {
    const extData = payloadExtensions?.[BUILDER_CODE] as
      | BuilderCodeExtensionData
      | undefined;

    // Collect service codes: facilitator's own code first, then any from the payload
    const serviceCodes: string[] = [this.config.builderCode];
    if (extData?.s) {
      for (const code of extData.s) {
        if (!serviceCodes.includes(code)) {
          serviceCodes.push(code);
        }
      }
    }

    const suffixData: BuilderCodeExtensionData = {
      a: extData?.a,
      s: serviceCodes,
    };

    // If we only have the facilitator's code and nothing else, still encode
    // (facilitator attribution alone is still valuable)
    return encodeBuilderCodeSuffix(suffixData);
  }
}
