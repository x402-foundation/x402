/**
 * CAIP validation utilities
 * Part of the ext-delegation feature for x402
 */

export class CAIPValidator {
  /**
   * Validate CAIP-19 asset identifier
   */
  validateAsset(asset: string): boolean {
    // Basic CAIP-19 validation
    // Format: chainId/namespace:reference
    const pattern = /^[a-z0-9-]+:[a-z0-9-]+\/[a-z0-9-]+:[a-z0-9-]+$/i;
    return pattern.test(asset);
  }

  /**
   * Validate CAIP-2 chain identifier
   */
  validateChain(chain: string): boolean {
    // Basic CAIP-2 validation
    // Format: namespace:reference
    const pattern = /^[a-z0-9-]+:[a-z0-9-]+$/i;
    return pattern.test(chain);
  }
}
