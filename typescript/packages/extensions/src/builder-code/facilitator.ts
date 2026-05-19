/**
 * Facilitator-side extension for the Builder Code Extension.
 *
 * At settlement time, the facilitator:
 * 1. Validates declared and payload builder codes; omits invalid or tampered fields
 * 2. Adds its own builder code as the "w" (wallet) field
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
  type SettlementCalldataContext,
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
   * Builds the ERC-8021 Schema 2 calldata suffix for a settlement transaction.
   * Invalid or tampered fields are omitted; settlement is never blocked.
   */
  buildSettlementCalldataSuffix(ctx: SettlementCalldataContext): Hex | undefined {
    const rawExt = ctx.paymentPayload.extensions?.[BUILDER_CODE];
    if (rawExt === undefined) {
      return undefined;
    }

    // Declared app code: PaymentRequired `info.a`, merged onto the payload at payment creation.
    let declaredA: string | undefined;
    if (rawExt && typeof rawExt === "object") {
      const record = rawExt as Record<string, unknown>;
      const info =
        "info" in record && record.info && typeof record.info === "object"
          ? (record.info as Record<string, unknown>)
          : undefined;
      const candidate = info && typeof info.a === "string" ? info.a : undefined;
      if (candidate && BUILDER_CODE_PATTERN.test(candidate)) {
        declaredA = candidate;
      }
    }

    // Client fields: top-level `a` and `s` on the payload extension.
    let clientA: string | undefined;
    let s: string[] | undefined;
    if (rawExt && typeof rawExt === "object") {
      const record = rawExt as Record<string, unknown>;
      if (typeof record.a === "string") {
        clientA = record.a;
      }
      if (Array.isArray(record.s)) {
        const valid = record.s.filter(
          (code): code is string => typeof code === "string" && BUILDER_CODE_PATTERN.test(code),
        );
        if (valid.length > 0) {
          s = valid;
        }
      }
    }

    let a: string | undefined;
    if (declaredA) {
      if (clientA !== undefined) {
        if (BUILDER_CODE_PATTERN.test(clientA) && clientA === declaredA) {
          a = clientA;
        }
      } else {
        a = declaredA;
      }
    }

    return encodeBuilderCodeSuffix({
      a,
      w: this.config.builderCode,
      s,
    } satisfies BuilderCodeExtensionData);
  }
}
