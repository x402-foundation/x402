/**
 * Payment processor with delegation support
 * Part of the ext-delegation feature for x402
 */

import { DelegationHandler } from '../../extensions/delegation/handler';
import { PaymentPayload } from '../../types/payment';

export class PaymentProcessor {
  private delegationHandler: DelegationHandler;

  constructor(delegationHandler: DelegationHandler) {
    this.delegationHandler = delegationHandler;
  }

  async processPayment(
    payload: PaymentPayload,
    authorizationFrom: string,
  ): Promise<{ processed: boolean; grantUsed?: string }> {
    // Process delegation grant if present
    if (payload.extensions?.delegation?.grant) {
      const { grant } = await this.delegationHandler.processPaymentPayload(
        payload,
        authorizationFrom,
      );

      // Store grant reference for dispute resolution
      return {
        processed: true,
        grantUsed: grant?.id,
      };
    }

    return { processed: true };
  }
}
