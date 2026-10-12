/**
 * Payment verifier with delegation support
 * Part of the ext-delegation feature for x402
 */

import { DelegationHandler } from '../../extensions/delegation/handler';
import { VerifyResponseExtensions } from '../../extensions/delegation/types';
import { PaymentPayload } from '../../types/payment';

export class PaymentVerifier {
  private delegationHandler: DelegationHandler;

  constructor(delegationHandler: DelegationHandler) {
    this.delegationHandler = delegationHandler;
  }

  async verifyPayment(
    payload: PaymentPayload,
    authorizationFrom: string,
    paymentAsset: string,
    paymentNetwork: string,
    paymentRecipient?: string,
    paymentAmount?: string,
  ): Promise<{
    valid: boolean;
    extensions?: VerifyResponseExtensions;
    error?: string;
  }> {
    const extensions: VerifyResponseExtensions = {};

    // Process delegation if present
    if (payload.extensions?.delegation?.grant) {
      const delegationResult = await this.delegationHandler.verifyDelegation(
        payload.extensions.delegation.grant,
        authorizationFrom,
        paymentAsset,
        paymentNetwork,
        paymentRecipient,
        paymentAmount,
      );

      extensions.delegation = delegationResult;

      if (delegationResult.error) {
        return {
          valid: false,
          extensions,
          error: `Delegation verification failed: ${delegationResult.error}`,
        };
      }
    }

    // ... rest of verification logic

    return {
      valid: true,
      extensions,
    };
  }
}
