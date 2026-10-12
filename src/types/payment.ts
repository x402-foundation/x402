/**
 * Updated payment types with delegation extension
 */

export interface PaymentRequiredExtensions {
  delegation?: {
    required?: boolean;
    supportedPrivacyModes?: Array<'full' | 'attestation' | 'none'>;
  };
  // ... other existing extensions
}

export interface PaymentPayloadExtensions {
  delegation?: {
    grant?: DelegationGrant;
  };
  // ... other existing extensions
}

export interface VerifyResponseExtensions {
  delegation?: DelegationExtension;
  // ... other existing extensions
}

// Re-export delegation types
export * from '../extensions/delegation/types';
