/**
 * Client-side extension for the Builder Code Extension.
 *
 * Attaches the client's service code (`s`) to the payment payload.
 */

import type { ClientExtension } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { BUILDER_CODE, BUILDER_CODE_PATTERN, MAX_CLIENT_SERVICE_CODES } from "./types";

/**
 * Client extension that adds builder-code attribution to payment payloads.
 *
 * @example
 * ```typescript
 * import { BuilderCodeClientExtension } from '@x402/extensions/builder-code';
 *
 * const client = new x402Client();
 * client.registerExtension(new BuilderCodeClientExtension("bc_my_client"));
 * ```
 */
export class BuilderCodeClientExtension implements ClientExtension {
  readonly key = BUILDER_CODE;
  private readonly serviceCodes: string[];

  /**
   * Creates a client extension that attaches the given service code(s) to payments.
   *
   * Accepts a single code or an array of codes so layered clients (e.g. an MCP
   * middleware) can attribute multiple participants. Codes are normalized to an
   * array and sent as the `s` field.
   *
   * @param serviceCodes - Client service code(s) (`s`), each 1-32 lowercase alphanumeric/underscore characters
   */
  constructor(serviceCodes: string | string[]) {
    const codes = Array.isArray(serviceCodes) ? serviceCodes : [serviceCodes];
    if (codes.length > MAX_CLIENT_SERVICE_CODES) {
      throw new Error(
        `Too many service codes: ${codes.length} exceeds the maximum of ${MAX_CLIENT_SERVICE_CODES}.`,
      );
    }
    for (const code of codes) {
      if (!BUILDER_CODE_PATTERN.test(code)) {
        throw new Error(
          `Invalid builder code: "${code}". ` +
            `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
        );
      }
    }
    this.serviceCodes = codes;
  }

  /**
   * Attaches this client's service code(s) (`s`).
   *
   * @param payload - Payment payload to enrich
   * @param _ - Server payment requirements; core merges server extension data
   * @returns Payment payload with builder-code extension data
   */
  async enrichPaymentPayload(payload: PaymentPayload, _: PaymentRequired): Promise<PaymentPayload> {
    return {
      ...payload,
      extensions: {
        ...payload.extensions,
        [BUILDER_CODE]: { info: { s: this.serviceCodes } },
      },
    };
  }
}
