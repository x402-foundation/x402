/**
 * Open Payments payment payload structure.
 * The incomingPaymentUrl uniquely identifies the completed payment.
 */
export type OpenPaymentsPayload = {
  /** Full URL of the incoming payment at the server's wallet. Used to verify payment status. */
  incomingPaymentUrl: string;
};

/**
 * Client configuration for Open Payments.
 */
export interface OpenPaymentsClientConfig {
  /** Client's Open Payments wallet address URL. */
  clientWalletAddress: string;
  /** Key ID (kid) for the client's Ed25519 key pair. */
  keyId: string;
  /** Base64-encoded Ed25519 private key for signing requests. */
  privateKey: string;
  /** Pre-approved grant token for outgoing payments. */
  grantToken: string;
  /** Management URL for token rotation. */
  grantTokenManageUrl?: string;
  /** Allow HTTP connections (for local/testnet environments). Defaults to false. */
  useHttp?: boolean;
}

/**
 * Facilitator configuration for Open Payments.
 */
export interface OpenPaymentsFacilitatorConfig {
  /** Key ID (kid) for the facilitator's Ed25519 key pair. */
  keyId: string;
  /** Base64-encoded Ed25519 private key for signing requests. */
  privateKey: string;
  /** Public key corresponding to the private key. Used for JWKS. */
  publicKey?: string;
  /** Facilitator's Open Payments wallet address URL. */
  walletAddress: string;
  /** Allow HTTP connections (for local/testnet environments). Defaults to false. */
  useHttp?: boolean;
  /**
   * Maximum number of retries when checking for payment completion.
   *
   * @default 3
   */
  maxRetries?: number;
  /**
   * Initial delay between retries in milliseconds.
   *
   * @default 1000
   */
  retryDelayMs?: number;
  /** Custom cache for tracking used payment URLs. Defaults to in-memory Map. */
  usedPaymentUrlsCache?: PaymentUrlCache;
  /**
   * Window in milliseconds during which the same incoming payment URL may be reused
   * for network retries of the same request.
   *
   * @default 5000
   */
  idempotencyWindowMs?: number;
  /**
   * TTL in milliseconds after which used payment URL cache entries are evicted.
   *
   * @default 600000
   */
  cacheEvictionTtlMs?: number;
}

/**
 * Server configuration for Open Payments.
 */
export interface OpenPaymentsServerConfig {
  /** Server's Open Payments wallet address URL. */
  walletAddress: string;
}

/**
 * Cache entry for tracking used payment URLs.
 */
export interface PaymentUrlCacheEntry {
  /** Timestamp when the payment URL was first used. */
  timestamp: number;
  /** Resource URL associated with this payment. */
  resourceUrl: string;
}

/**
 * Interface for payment URL cache used for replay attack prevention.
 */
export interface PaymentUrlCache {
  /**
   * Retrieve a cache entry by key.
   *
   * @param key - Cache key in format `{incomingPaymentUrl}:{resourceUrl}`
   * @returns Cache entry if found, undefined otherwise
   */
  get(key: string): PaymentUrlCacheEntry | undefined;

  /**
   * Store a payment URL entry.
   *
   * @param key - Cache key
   * @param entry - Cache entry with timestamp and resource URL
   */
  set(key: string, entry: PaymentUrlCacheEntry): void;

  /**
   * Delete a cache entry.
   *
   * @param key - Cache key to delete
   */
  delete(key: string): void;

  /**
   * Clear all entries older than the specified timestamp.
   *
   * @param beforeTimestamp - Delete all entries with timestamp older than this value
   */
  clearOlderThan(beforeTimestamp: number): void;
}

/** In-memory implementation of PaymentUrlCache. */
export class InMemoryPaymentUrlCache implements PaymentUrlCache {
  private cache = new Map<string, PaymentUrlCacheEntry>();

  /**
   * Returns an entry by key.
   *
   * @param key - Cache key
   * @returns Cache entry if found
   */
  get(key: string): PaymentUrlCacheEntry | undefined {
    return this.cache.get(key);
  }

  /**
   * Stores an entry.
   *
   * @param key - Cache key
   * @param entry - Entry to store
   */
  set(key: string, entry: PaymentUrlCacheEntry): void {
    this.cache.set(key, entry);
  }

  /**
   * Removes an entry by key.
   *
   * @param key - Cache key to remove
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Removes all entries older than the given timestamp.
   *
   * @param beforeTimestamp - Cutoff timestamp
   */
  clearOlderThan(beforeTimestamp: number): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < beforeTimestamp) {
        this.cache.delete(key);
      }
    }
  }
}
