/**
 * Storage interface for SIWX payment tracking.
 *
 * Implementations track which addresses have paid for which resources,
 * enabling SIWX authentication to grant access without re-payment.
 *
 * Optionally supports nonce tracking to prevent signature replay attacks.
 */
export interface SIWxStorage {
  /**
   * Check if an address has paid for a resource.
   *
   * @param resource - The resource path (e.g., "/weather")
   * @param address - The wallet address to check
   * @returns True if the address has paid for the resource
   */
  hasPaid(resource: string, address: string): boolean | Promise<boolean>;

  /**
   * Record that an address has paid for a resource.
   *
   * @param resource - The resource path
   * @param address - The wallet address that paid
   */
  recordPayment(resource: string, address: string): void | Promise<void>;

  /**
   * Check if a nonce has already been used (optional).
   *
   * Implementing this method prevents signature replay attacks where
   * an intercepted SIWX header could be reused by an attacker.
   *
   * @param nonce - The nonce from the SIWX payload
   * @returns True if the nonce has been used
   */
  hasUsedNonce?(nonce: string): boolean | Promise<boolean>;

  /**
   * Record that a nonce has been used (optional).
   *
   * Called after successfully granting access via SIWX.
   * Implementations should consider adding expiration to avoid unbounded growth.
   *
   * @param nonce - The nonce to record as used
   */
  recordNonce?(nonce: string): void | Promise<void>;
}

/**
 * In-memory implementation of SIWxStorage.
 *
 * Suitable for development and single-instance deployments.
 * For production multi-instance deployments, use a persistent storage implementation.
 */
export class InMemorySIWxStorage implements SIWxStorage {
  private paidAddresses = new Map<string, Set<string>>();

  /**
   * Check if an address has paid for a resource.
   *
   * @param resource - The resource path
   * @param address - The wallet address to check
   * @returns True if the address has paid
   */
  hasPaid(resource: string, address: string): boolean {
    return this.paidAddresses.get(resource)?.has(address.toLowerCase()) ?? false;
  }

  /**
   * Record that an address has paid for a resource.
   *
   * @param resource - The resource path
   * @param address - The wallet address that paid
   */
  recordPayment(resource: string, address: string): void {
    if (!this.paidAddresses.has(resource)) {
      this.paidAddresses.set(resource, new Set());
    }
    this.paidAddresses.get(resource)!.add(address.toLowerCase());
  }
}
