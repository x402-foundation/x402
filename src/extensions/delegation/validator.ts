/**
 * Delegation grant validator
 * Part of the ext-delegation feature for x402
 */

import { DelegationGrant, DelegationErrorCode } from './types';
import { verifySignature } from '../../crypto/signature';
import { CAIPValidator } from '../../utils/caip';

export class DelegationValidator {
  private caipValidator: CAIPValidator;

  constructor(caipValidator: CAIPValidator) {
    this.caipValidator = caipValidator;
  }

  /**
   * Validate a delegation grant
   */
  async validateGrant(
    grant: DelegationGrant,
    authorizationFrom: string,
    paymentAsset: string,
    paymentNetwork: string,
    paymentRecipient?: string,
    paymentAmount?: string,
  ): Promise<{ valid: boolean; error?: DelegationErrorCode; details?: any }> {
    // Check if grant is expired
    if (grant.expiry && Date.now() > grant.expiry * 1000) {
      return { valid: false, error: 'delegation_expired' };
    }

    // Check principal signature
    if (!grant.signature) {
      return { valid: false, error: 'delegation_signature_invalid' };
    }

    const signatureValid = await verifySignature(
      grant.principal,
      grant.signature,
      JSON.stringify({
        principal: grant.principal,
        agent: grant.agent,
        audience: grant.audience,
        maxAmount: grant.maxAmount,
        asset: grant.asset,
        allowedNetworks: grant.allowedNetworks,
        allowedRecipients: grant.allowedRecipients,
        expiry: grant.expiry,
        id: grant.id,
        budgetRef: grant.budgetRef,
        disclosure: grant.disclosure,
        constraints: grant.constraints,
      }),
    );

    if (!signatureValid) {
      return { valid: false, error: 'delegation_signature_invalid' };
    }

    // Check agent matches authorization.from
    if (grant.agent.toLowerCase() !== authorizationFrom.toLowerCase()) {
      return { valid: false, error: 'delegation_agent_mismatch' };
    }

    // Check asset matches
    if (grant.asset !== paymentAsset) {
      return { valid: false, error: 'delegation_asset_mismatch' };
    }

    // Check network is allowed
    if (grant.allowedNetworks && !grant.allowedNetworks.includes(paymentNetwork)) {
      return { valid: false, error: 'delegation_network_unsupported' };
    }

    // Check audience includes the server
    if (grant.audience && !grant.audience.includes('x402-foundation/x402')) {
      return { valid: false, error: 'delegation_audience_mismatch' };
    }

    // Check amount constraint
    if (grant.maxAmount && paymentAmount) {
      const maxAmount = BigInt(grant.maxAmount);
      const paymentAmt = BigInt(paymentAmount);

      if (paymentAmt > maxAmount) {
        return { valid: false, error: 'delegation_constraint_violated' };
      }
    }

    // Check recipient constraint
    if (grant.allowedRecipients && paymentRecipient) {
      if (!grant.allowedRecipients.includes(paymentRecipient)) {
        return { valid: false, error: 'delegation_constraint_violated' };
      }
    }

    return {
      valid: true,
      details: {
        principal: grant.principal,
        agent: grant.agent,
        expiry: grant.expiry,
        maxAmount: grant.maxAmount,
        asset: grant.asset,
        constraints: grant.constraints,
      },
    };
  }
}
