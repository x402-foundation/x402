/**
 * Delegation extension handler
 * Part of the ext-delegation feature for x402
 */

import { DelegationValidator } from './validator';
import { DelegationGrant, DelegationExtension, VerifyResponseExtensions } from './types';
import { PaymentPayload, PaymentRequiredExtensions } from '../../types/payment';

export class DelegationHandler {
  private validator: DelegationValidator;

  constructor(validator: DelegationValidator) {
    this.validator = validator;
  }

  /**
   * Process delegation in payment required
   */
  async processPaymentRequired(
    paymentRequired: PaymentRequiredExtensions,
  ): Promise<PaymentRequiredExtensions> {
    return {
      ...paymentRequired,
      delegation: {
        required: paymentRequired.delegation?.required || false,
        supportedPrivacyModes: paymentRequired.delegation?.supportedPrivacyModes || ['full'],
      },
    };
  }

  /**
   * Process delegation in payment payload
   */
  async processPaymentPayload(
    payload: PaymentPayload,
    authorizationFrom: string,
  ): Promise<{ payload: PaymentPayload; grant?: DelegationGrant }> {
    const delegationExtension = payload.extensions?.delegation;

    if (!delegationExtension?.grant) {
      return { payload };
    }

    const grant = delegationExtension.grant;

    // Validate grant structure
    if (!grant.principal || !grant.agent || !grant.maxAmount || !grant.asset || !grant.expiry || !grant.id) {
      throw new Error('Invalid delegation grant structure');
    }

    return {
      payload,
      grant,
    };
  }

  /**
   * Verify delegation in payment verification
   */
  async verifyDelegation(
    grant: DelegationGrant,
    authorizationFrom: string,
    paymentAsset: string,
    paymentNetwork: string,
    paymentRecipient?: string,
    paymentAmount?: string,
  ): Promise<VerifyResponseExtensions['delegation']> {
    const result = await this.validator.validateGrant(
      grant,
      authorizationFrom,
      paymentAsset,
      paymentNetwork,
      paymentRecipient,
      paymentAmount,
    );

    if (!result.valid) {
      return {
        verified: false,
        error: result.error,
      };
    }

    return {
      verified: true,
      details: result.details,
    };
  }
}
