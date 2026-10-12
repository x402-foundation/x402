/**
 * Delegation extension types for agent payments
 * Part of the ext-delegation feature for x402
 */

export interface DelegationGrant {
  /**
   * Principal identifier (DID or address)
   */
  principal: string;

  /**
   * Agent identifier (must match authorization.from)
   */
  agent: string;

  /**
   * Audience - which resource server(s) this grant is valid for
   */
  audience: string[];

  /**
   * Amount constraint as string in minor currency units
   */
  maxAmount: string;

  /**
   * Asset/network denomination (CAIP-19)
   */
  asset: string;

  /**
   * Allowed networks (CAIP-2 array)
   */
  allowedNetworks: string[];

  /**
   * Allowed recipients (chain-appropriate format)
   */
  allowedRecipients?: string[];

  /**
   * Expiry as Unix timestamp
   */
  expiry: number;

  /**
   * Unique ID for tracking and single-use enforcement
   */
  id: string;

  /**
   * Optional budget reference for aggregate limit enforcement
   */
  budgetRef?: string;

  /**
   * Privacy mode: 'full', 'attestation', or 'none'
   * @default 'full'
   */
  disclosure?: 'full' | 'attestation' | 'none';

  /**
   * Additional constraints (namespaced)
   */
  constraints?: Record<string, unknown>;

  /**
   * Signature of the principal
   */
  signature?: string;
}

export interface DelegationExtension {
  /**
   * The delegation grant
   */
  grant?: DelegationGrant;

  /**
   * Verification result
   */
  verified?: boolean;

  /**
   * Error code if verification failed
   */
  error?: DelegationErrorCode;

  /**
   * Verification details
   */
  details?: {
    principal?: string;
    agent?: string;
    expiry?: number;
    maxAmount?: string;
    asset?: string;
    constraints?: Record<string, unknown>;
  };
}

export type DelegationErrorCode =
  | 'delegation_required'
  | 'delegation_expired'
  | 'delegation_constraint_violated'
  | 'delegation_signature_invalid'
  | 'delegation_agent_mismatch'
  | 'delegation_network_unsupported'
  | 'delegation_audience_mismatch'
  | 'delegation_asset_mismatch';

export interface PaymentRequiredExtensions {
  delegation?: {
    required: boolean;
    supportedPrivacyModes?: Array<'full' | 'attestation' | 'none'>;
  };
}

export interface PaymentPayloadExtensions {
  delegation?: {
    grant?: DelegationGrant;
  };
}

export interface VerifyResponseExtensions {
  delegation?: DelegationExtension;
}
