/**
 * Facilitator-side extension for the Builder Code Extension.
 *
 * At settlement time, the facilitator always encodes its wallet code into the
 * ERC-8021 suffix. App code (`a`) comes from the server declaration (with soft
 * echo validation against the client payload). Service code (`s`) is
 * client-provided via the payment payload.
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

function extractServerAppCode(
  extensions?: Record<string, unknown>,
): string | undefined {
  const raw = extensions?.[BUILDER_CODE];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const ext = raw as Record<string, unknown>;
  const info =
    typeof ext.info === "object" && ext.info !== null && !Array.isArray(ext.info)
      ? (ext.info as Record<string, unknown>)
      : ext;

  return typeof info.a === "string" && BUILDER_CODE_PATTERN.test(info.a)
    ? info.a
    : undefined;
}

function extractClientExtension(
  extensions?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = extensions?.[BUILDER_CODE];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** Normalizes `s` from the client payload — accepts a string or first-valid-entry from an array. */
function resolveServiceCode(raw: unknown): string | undefined {
  if (typeof raw === "string" && BUILDER_CODE_PATTERN.test(raw)) return raw;
  if (Array.isArray(raw)) {
    const first = raw.find(
      (v): v is string => typeof v === "string" && BUILDER_CODE_PATTERN.test(v),
    );
    return first;
  }
  return undefined;
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
   * - `a` comes from the server declaration; the client echo is validated softly.
   * - `s` is read from the client's payment payload.
   * - `w` is always the facilitator's own code.
   */
  buildSettlementCalldataSuffix(ctx: SettlementCalldataContext): Hex {
    const serverA = extractServerAppCode(ctx.paymentRequiredExtensions);
    const clientExt = extractClientExtension(ctx.paymentPayload.extensions);

    let a = serverA;
    if (clientExt?.a && typeof clientExt.a === "string") {
      if (serverA && clientExt.a !== serverA) {
        console.warn(
          `[builder-code] client "a" mismatch: "${clientExt.a}" vs server "${serverA}". Using server value.`,
        );
      } else {
        a = clientExt.a as string;
      }
    }

    const s = resolveServiceCode(clientExt?.s);

    const data: BuilderCodeExtensionData = {
      w: this.config.builderCode,
      ...(a && { a }),
      ...(s && { s }),
    };

    return encodeBuilderCodeSuffix(data);
  }
}
