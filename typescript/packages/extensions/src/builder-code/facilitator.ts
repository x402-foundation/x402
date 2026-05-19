/**
 * Facilitator-side extension for the Builder Code Extension.
 *
 * At settlement time, the facilitator always encodes its wallet code into the
 * ERC-8021 suffix and includes server-declared app/service codes when present.
 */

import type { FacilitatorExtension } from "@x402/core/types";
import type { Hex } from "viem";
import { encodeBuilderCodeSuffix } from "./cbor";
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  type BuilderCodeExtensionData,
  type BuilderCodeFacilitatorConfig,
  type SettlementCalldataContext,
} from "./types";

/**
 * Extracts normalized builder-code fields from an extension object.
 *
 * Accepts either a top-level extension record or one nested under `info`.
 *
 * @param extension - Raw extension payload from payment headers
 * @returns Parsed app code and service codes, omitting invalid entries
 */
function readBuilderCodeExtensionFields(
  extension: Record<string, unknown>,
): BuilderCodeExtensionData {
  const rawInfo = extension.info;
  const fields =
    typeof rawInfo === "object" && rawInfo !== null && !Array.isArray(rawInfo)
      ? (rawInfo as Record<string, unknown>)
      : extension;

  const result: BuilderCodeExtensionData = {};

  if (typeof fields.a === "string" && BUILDER_CODE_PATTERN.test(fields.a)) {
    result.a = fields.a;
  }

  if (Array.isArray(fields.s)) {
    const serviceCodes = fields.s.filter(
      (code): code is string => typeof code === "string" && BUILDER_CODE_PATTERN.test(code),
    );
    if (serviceCodes.length > 0) {
      result.s = serviceCodes;
    }
  }

  return result;
}

/**
 * Facilitator extension that manages builder code attribution at settlement time.
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

  /**
   * Creates a facilitator extension with the given wallet builder code.
   *
   * @param config - Facilitator configuration including the builder code
   */
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
   * Builds the ERC-8021 Schema 2 calldata suffix for a settlement transaction.
   *
   * App and service codes come only from paymentRequiredExtensions when present.
   * The facilitator wallet code is always included.
   *
   * @param ctx - Settlement context with payment payload and required extensions
   * @returns Hex-encoded suffix bytes with at least the facilitator wallet code
   */
  buildSettlementCalldataSuffix(ctx: SettlementCalldataContext): Hex {
    const rawServerExt = ctx.paymentRequiredExtensions?.[BUILDER_CODE];
    const serverExtIsRecord =
      typeof rawServerExt === "object" && rawServerExt !== null && !Array.isArray(rawServerExt);
    const serverFields = serverExtIsRecord
      ? readBuilderCodeExtensionFields(rawServerExt as Record<string, unknown>)
      : {};

    const suffix: BuilderCodeExtensionData = {
      w: this.config.builderCode,
      ...(serverFields.a !== undefined && { a: serverFields.a }),
      ...(serverFields.s !== undefined && { s: serverFields.s }),
    };

    return encodeBuilderCodeSuffix(suffix);
  }
}
