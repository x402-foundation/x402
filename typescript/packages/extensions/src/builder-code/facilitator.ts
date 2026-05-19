/**
 * Facilitator-side extension for the Builder Code Extension.
 *
 * At settlement time, the facilitator best-effort adds wallet attribution and
 * encodes validated builder-code fields into the ERC-8021 suffix.
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
   * Best-effort: includes validated fields only; never fails settlement.
   *
   * @param ctx - Settlement context with payment payload and required extensions
   * @returns Hex-encoded suffix bytes, or undefined when no suffix should be appended
   */
  buildSettlementCalldataSuffix(ctx: SettlementCalldataContext): Hex | undefined {
    const rawClientExt = ctx.paymentPayload.extensions?.[BUILDER_CODE];
    const clientExtIsRecord =
      typeof rawClientExt === "object" && rawClientExt !== null && !Array.isArray(rawClientExt);
    if (!clientExtIsRecord) {
      return undefined;
    }
    const clientExt = rawClientExt as Record<string, unknown>;

    const rawServerExt = ctx.paymentRequiredExtensions?.[BUILDER_CODE];
    const serverExtIsRecord =
      typeof rawServerExt === "object" && rawServerExt !== null && !Array.isArray(rawServerExt);
    const serverExt = serverExtIsRecord ? (rawServerExt as Record<string, unknown>) : undefined;

    const rawInfo = serverExt?.info;
    const infoIsRecord = typeof rawInfo === "object" && rawInfo !== null && !Array.isArray(rawInfo);
    const info = infoIsRecord ? (rawInfo as Record<string, unknown>) : undefined;

    const serverCandidate = typeof info?.a === "string" ? info.a : undefined;
    const serverAppCode =
      serverCandidate && BUILDER_CODE_PATTERN.test(serverCandidate) ? serverCandidate : undefined;

    const rawClientAppCode = clientExt.a;
    const clientAppCode =
      typeof rawClientAppCode === "string" && BUILDER_CODE_PATTERN.test(rawClientAppCode)
        ? rawClientAppCode
        : undefined;

    const clientMatchesServer =
      clientAppCode !== undefined &&
      (serverAppCode === undefined || clientAppCode === serverAppCode);
    const appCode = clientMatchesServer ? clientAppCode : serverAppCode;

    const validServiceCodes = Array.isArray(clientExt.s)
      ? clientExt.s.filter(
          (code): code is string => typeof code === "string" && BUILDER_CODE_PATTERN.test(code),
        )
      : [];
    const serviceCodes = validServiceCodes.length > 0 ? validServiceCodes : undefined;

    const suffix: BuilderCodeExtensionData = {
      w: this.config.builderCode,
      ...(appCode !== undefined && { a: appCode }),
      ...(serviceCodes !== undefined && { s: serviceCodes }),
    };

    return encodeBuilderCodeSuffix(suffix);
  }
}
