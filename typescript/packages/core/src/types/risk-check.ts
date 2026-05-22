/**
 * Types for the `risk-check` x402 extension.
 *
 * Enables counterparty risk verification in x402 payment flows.
 * Resource servers declare risk-check requirements in PaymentRequired,
 * facilitators perform the check and include results in VerifyResponse
 * and SettleResponse.
 *
 * @see {@link https://github.com/x402-foundation/x402/blob/main/specs/extensions/risk-check.md}
 */

/**
 * Risk-check extension info advertised by the resource server
 * in PaymentRequired.extensions["risk-check"].info
 */
export type RiskCheckExtensionInfo = {
  /** Whether the server requires a risk check to proceed */
  required: boolean;
  /** URL to the provider's /.well-known/risk-check.json discovery document */
  risk_check_url?: string;
  /** Minimum acceptable score (0 = highest risk, 100 = safest) */
  min_score?: number;
  /** Required attestation categories (e.g., "compliance_risk", "behavioral") */
  categories?: string[];
};

/**
 * Additional fields the client may append in PaymentPayload
 */
export type RiskCheckClientInfo = RiskCheckExtensionInfo & {
  /** Payer's wallet address for risk scoring */
  payer_wallet?: string;
  /** Payer's domain for domain-level risk signals */
  payer_domain?: string;
};

/**
 * Risk-check result included in VerifyResponse and SettleResponse
 * extensions["risk-check"]
 */
export type RiskCheckResult = {
  /** Whether a risk check was performed */
  checked: boolean;
  /** Risk score 0-100 (0 = highest risk, 100 = safest) */
  score?: number;
  /** Risk tier */
  tier?: "low" | "medium" | "high" | "critical";
  /** Provider DID (e.g., "did:web:provider.example") */
  provider?: string;
  /** Categories covered by this attestation */
  categories?: string[];
  /** Compact JWS (RFC 7515) signed attestation */
  jws?: string;
  /** URL to provider's JWKS for signature verification */
  jwks_url?: string;
  /** ISO 8601 timestamp when the check was performed */
  checked_at?: string;
  /** ISO 8601 expiry timestamp for the attestation */
  expires_at?: string;
};

/**
 * Risk-check provider discovery document
 * served at /.well-known/risk-check.json
 */
export type RiskCheckDiscovery = {
  name: string;
  version: string;
  description?: string;
  endpoint: string;
  method: "POST" | "GET";
  pricing?: {
    amount: string;
    currency: string;
    protocol: string;
    network: string;
  };
  signals?: string[];
  chains_supported?: string[];
  response_time_ms?: string;
  attestation?: {
    jwks_url: string;
    algorithm: string;
    kid: string;
    ttl: string;
  };
};
