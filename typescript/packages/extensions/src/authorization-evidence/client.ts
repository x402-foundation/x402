/**
 * Authorization Evidence Client Extension
 *
 * Client-side extension that echoes the server's challenge info and attaches
 * the agent's evidence presentation to the payment payload.
 */

import { AUTHORIZATION_EVIDENCE } from "./types";
import type { AuthorizationEvidenceInfo } from "./types";

/** The subset of PaymentRequired the client extension reads. */
interface PaymentRequiredLike {
  extensions?: Record<string, { info?: AuthorizationEvidenceInfo } | undefined>;
}

/** The subset of PaymentPayload the client extension writes. */
interface PaymentPayloadLike {
  extensions?: Record<string, unknown>;
}

/** A provider producing the evidence presentation for one payment attempt. */
export type EvidenceProvider = (info: AuthorizationEvidenceInfo) => string | Promise<string>;

/**
 * Client extension attaching authorization evidence. On each payment attempt
 * against a route that declared the extension, the provider is called with
 * the server's challenge info and its presentation is added to the echoed
 * extension payload.
 */
export class AuthorizationEvidenceClientExtension {
  readonly key = AUTHORIZATION_EVIDENCE;
  private readonly provider: EvidenceProvider;

  /**
   * Create the client extension.
   *
   * @param provider - Produces the evidence presentation for a challenge
   */
  constructor(provider: EvidenceProvider) {
    if (typeof provider !== "function") {
      throw new Error(`Invalid authorization-evidence provider: expected a function`);
    }
    this.provider = provider;
  }

  /**
   * Echo the server's extension info and attach the evidence presentation.
   * Routes that did not advertise the extension are left untouched.
   *
   * @param payload - The outgoing payment payload to enrich
   * @param paymentRequired - The PaymentRequired response being answered
   * @returns The enriched payload
   */
  async enrichPaymentPayload(
    payload: PaymentPayloadLike,
    paymentRequired: PaymentRequiredLike,
  ): Promise<PaymentPayloadLike> {
    const advertised = paymentRequired.extensions?.[AUTHORIZATION_EVIDENCE]?.info;
    if (!advertised) return payload;
    const evidence = await this.provider(advertised);
    return {
      ...payload,
      extensions: {
        ...payload.extensions,
        [AUTHORIZATION_EVIDENCE]: {
          info: { ...advertised, evidence },
        },
      },
    };
  }
}
