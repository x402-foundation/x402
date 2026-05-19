/**
 * Client-side extension for the Builder Code Extension.
 *
 * Echoes the server's app code (`a`) and attaches the client's
 * service code (`s`) to the payment payload.
 */

import type { ClientExtension } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { BUILDER_CODE, BUILDER_CODE_PATTERN } from "./types";

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
  private readonly serviceCode: string;

  /**
   * Creates a client extension that attaches the given service code to payments.
   *
   * @param serviceCode - Client service code (`s`), 1-32 lowercase alphanumeric/underscore characters
   */
  constructor(serviceCode: string) {
    if (!BUILDER_CODE_PATTERN.test(serviceCode)) {
      throw new Error(
        `Invalid builder code: "${serviceCode}". ` +
          `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
      );
    }
    this.serviceCode = serviceCode;
  }

  /**
   * Echoes the server app code (`a`) and attaches this client's service code (`s`).
   *
   * @param payload - Payment payload to enrich
   * @param paymentRequired - Server payment requirements (source of app code `a`)
   * @returns Payment payload with builder-code extension data
   */
  async enrichPaymentPayload(
    payload: PaymentPayload,
    paymentRequired: PaymentRequired,
  ): Promise<PaymentPayload> {
    const serverExt = paymentRequired.extensions?.[BUILDER_CODE] as
      | Record<string, unknown>
      | undefined;
    const info = serverExt?.info as Record<string, unknown> | undefined;
    const a = typeof info?.a === "string" ? info.a : undefined;

    return {
      ...payload,
      extensions: {
        ...payload.extensions,
        [BUILDER_CODE]: { ...(a && { a }), s: this.serviceCode },
      },
    };
  }
}
