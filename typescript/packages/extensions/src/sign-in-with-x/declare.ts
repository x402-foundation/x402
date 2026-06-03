/**
 * Server-side declaration helper for SIWX extension
 *
 * Helps servers declare SIWX authentication requirements in PaymentRequired responses.
 */

import type {
  SIWxExtension,
  SIWxExtensionInfo,
  DeclareSIWxOptions,
  SignatureType,
  SupportedChain,
} from "./types";
import { SIGN_IN_WITH_X } from "./types";
import { buildSIWxSchema } from "./schema";

/**
 * Derive signature type from network.
 *
 * @param network - CAIP-2 network identifier
 * @returns Signature algorithm type
 */
export function getSignatureType(network: string): SignatureType {
  return network.startsWith("solana:") ? "ed25519" : "eip191";
}

/**
 * Internal type for SIWX declaration with stored options.
 * The _options field is used by enrichPaymentRequiredResponse to derive
 * values from request context.
 */
export interface SIWxDeclaration extends SIWxExtension {
  _options: DeclareSIWxOptions;
}

/**
 * Create SIWX extension declaration for PaymentRequired.extensions
 *
 * Most fields are derived automatically from request context when using
 * createSIWxResourceServerExtension:
 * - `network`: From payment requirements (accepts[].network)
 * - `resourceUri`: From request URL
 * - `domain`: Parsed from resourceUri
 *
 * Explicit values in options override automatic derivation.
 *
 * @param options - Configuration options (most are optional)
 * @returns Extension object ready for PaymentRequired.extensions
 *
 * @example
 * ```typescript
 * // Minimal - derives network, domain, resourceUri from context
 * const extensions = declareSIWxExtension({
 *   statement: 'Sign in to access your purchased content',
 * });
 *
 * // With explicit network (overrides accepts)
 * const extensions = declareSIWxExtension({
 *   network: 'eip155:8453',
 *   statement: 'Sign in to access',
 * });
 *
 * // Full explicit config (no derivation)
 * const extensions = declareSIWxExtension({
 *   domain: 'api.example.com',
 *   resourceUri: 'https://api.example.com/data',
 *   network: ['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
 *   statement: 'Sign in to access',
 *   expirationSeconds: 300,
 * });
 * ```
 */
export function declareSIWxExtension(
  options: DeclareSIWxOptions = {},
): Record<string, SIWxDeclaration> {
  // Time-based challenge fields are generated per request by the server extension.
  const info: Partial<SIWxExtensionInfo> & { version: string } = {
    version: options.version ?? "1",
  };

  // Add fields that are provided
  if (options.domain) {
    info.domain = options.domain;
  }
  if (options.resourceUri) {
    info.uri = options.resourceUri;
    info.resources = [options.resourceUri];
  }
  if (options.statement) {
    info.statement = options.statement;
  }
  // Note: expirationSeconds is stored in _options and used by
  // enrichPaymentRequiredResponse to calculate expirationTime per-request

  // Build supportedChains if network is provided
  let supportedChains: SupportedChain[] = [];
  if (options.network) {
    const networks = Array.isArray(options.network) ? options.network : [options.network];
    supportedChains = networks.map(network => ({
      chainId: network,
      type: getSignatureType(network),
    }));
  }

  const declaration: SIWxDeclaration = {
    info: info as SIWxExtensionInfo,
    supportedChains,
    schema: buildSIWxSchema(),
    _options: options,
  };

  return { [SIGN_IN_WITH_X]: declaration };
}
