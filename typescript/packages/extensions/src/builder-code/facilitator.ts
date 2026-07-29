/**
 * Facilitator-side extension for the Builder Code Extension.
 *
 * At settlement time, the facilitator encodes its wallet code into the ERC-8021
 * suffix when configured. App code (`a`) and service code (`s`) are read from
 * the client payment payload extensions.
 */

import type { FacilitatorExtension } from "@x402/core/types";
import type { Hex } from "viem";
import { encodeBuilderCodeSuffix } from "./cbor";
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  MAX_SERVICE_CODES,
  type BuilderCodeExtensionData,
  type BuilderCodeFacilitatorConfig,
  type DataSuffixContext,
} from "./types";

/**
 * Reads the client builder-code extension object from payment-payload extensions.
 *
 * @param extensions - Extensions map from PaymentPayload
 * @returns Raw builder-code extension object, or undefined if absent
 */
function extractClientExtension(
  extensions?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const info = (extensions?.[BUILDER_CODE] as { info?: unknown } | undefined)?.info;
  if (typeof info !== "object" || info === null || Array.isArray(info)) return undefined;
  return info as Record<string, unknown>;
}

/**
 * Normalizes `s` from the client payload — accepts a string or an array, keeps
 * valid entries in order, and truncates to {@link MAX_SERVICE_CODES}.
 *
 * @param raw - Client-provided service code value (string or array of strings)
 * @returns Array of valid service codes (empty when missing or all invalid)
 */
function resolveServiceCodes(raw: unknown): string[] {
  const candidates = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return candidates
    .filter((v): v is string => typeof v === "string" && BUILDER_CODE_PATTERN.test(v))
    .slice(0, MAX_SERVICE_CODES);
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
 *   builderCode: "bc_my_facilitator", // optional
 * }));
 * ```
 */
export class BuilderCodeFacilitatorExtension implements FacilitatorExtension {
  readonly key = BUILDER_CODE;
  private readonly config: BuilderCodeFacilitatorConfig;

  /**
   * Creates a facilitator extension that encodes builder-code attribution at settlement.
   *
   * @param config - Optional facilitator builder-code configuration (wallet code `w`)
   */
  constructor(config: BuilderCodeFacilitatorConfig = {}) {
    if (config.builderCode && !BUILDER_CODE_PATTERN.test(config.builderCode)) {
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
   * - `a` and `s` are read from the client's payment payload extensions.
   * - `w` is the facilitator's own code when configured.
   *
   * @param ctx - Settlement context with payment-payload extensions
   * @returns Hex-encoded ERC-8021 builder-code calldata suffix, or undefined when no attribution is present
   */
  buildDataSuffix(ctx: DataSuffixContext): Hex | undefined {
    const clientExt = extractClientExtension(ctx.paymentPayload.extensions);

    const a =
      typeof clientExt?.a === "string" && BUILDER_CODE_PATTERN.test(clientExt.a)
        ? clientExt.a
        : undefined;
    const s = resolveServiceCodes(clientExt?.s);

    const data: BuilderCodeExtensionData = {
      ...(this.config.builderCode && { w: this.config.builderCode }),
      ...(a && { a }),
      ...(s.length > 0 && { s }),
    };

    if (!data.a && !data.w && (!data.s || (Array.isArray(data.s) && data.s.length === 0))) {
      return undefined;
    }

    return encodeBuilderCodeSuffix(data);
  }
}
