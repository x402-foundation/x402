/**
 * Dispute evidence with delegation support
 * Part of the ext-delegation feature for x402
 */

import { DelegationGrant } from '../extensions/delegation/types';

export interface DisputeEvidence {
  /**
   * The offer that was made
   */
  offer: any;

  /**
   * The receipt that was settled
   */
  receipt: any;

  /**
   * Authorization scope artifact (delegation grant)
   * This completes the evidence triple: Grant = what principal allowed
   */
  authorizationScope?: {
    /**
     * Reference to the grant (hash)
     */
    scope_ref: string;

    /**
     * Grant details (in full mode) or attestation
     */
    grant_data?: DelegationGrant | any;

    /**
     * Privacy mode used
     */
    privacy_mode: 'full' | 'attestation' | 'none';

    /**
     * Verification status
     */
    verified: boolean;

    /**
     * Error if verification failed
     */
    error?: string;
  };
}

export class DisputeEvidenceGenerator {
  /**
   * Generate dispute evidence with delegation support
   */
  async generateEvidence(
    offer: any,
    receipt: any,
    grant?: DelegationGrant,
    privacyMode: 'full' | 'attestation' | 'none' = 'full',
    verification?: {
      verified: boolean;
      error?: string;
    },
  ): Promise<DisputeEvidence> {
    const evidence: DisputeEvidence = {
      offer,
      receipt,
    };

    if (grant) {
      const grantHash = this.hashGrant(grant);
      evidence.authorizationScope = {
        scope_ref: grantHash,
        grant_data: privacyMode === 'full' ? grant : undefined,
        privacy_mode: privacyMode,
        verified: verification?.verified || false,
        error: verification?.error,
      };
    }

    return evidence;
  }

  private hashGrant(grant: DelegationGrant): string {
    // Simple hash for demonstration
    // In production, use proper cryptographic hash
    const grantString = JSON.stringify(grant);
    return require('crypto')
      .createHash('sha256')
      .update(grantString)
      .digest('hex');
  }
}
