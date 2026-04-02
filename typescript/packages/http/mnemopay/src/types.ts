/**
 * MnemoPay integration types for x402.
 *
 * These types define the interface contract between the x402 payment protocol
 * and the MnemoPay SDK, allowing this package to work with any object that
 * implements the MnemoPayAgent interface — whether that's MnemoPayLite,
 * MnemoPayFull, or a custom implementation.
 */

/**
 * Represents a memory entry recalled from the MnemoPay agent.
 */
export interface MnemoPayMemory {
  /** The content of the stored memory. */
  content: string;
  /** Relevance score from 0 to 1. */
  relevance?: number;
  /** Tags associated with this memory. */
  tags?: string[];
  /** Additional metadata attached to the memory. */
  metadata?: Record<string, unknown>;
}

/**
 * The minimal interface a MnemoPay agent must implement for x402 integration.
 *
 * This mirrors the core API of @mnemopay/sdk's MnemoPayLite class, allowing
 * the middleware to store payment outcomes, recall past experiences, and
 * update reputation based on settlement results.
 */
export interface MnemoPayAgent {
  /**
   * Store a memory about a payment event.
   *
   * @param content - Human-readable description of what happened.
   * @param options - Optional metadata including importance and tags.
   * @returns A promise that resolves when the memory is stored.
   */
  remember(
    content: string,
    options?: { importance?: number; tags?: string[] },
  ): Promise<void>;

  /**
   * Recall memories relevant to a query.
   *
   * @param query - Natural-language query to search memories.
   * @param limit - Maximum number of memories to return.
   * @returns A promise resolving to an array of matching memories.
   */
  recall(query: string, limit?: number): Promise<MnemoPayMemory[]>;

  /**
   * Record a charge/payment and get a transaction ID.
   *
   * @param amount - The payment amount.
   * @param description - Human-readable description of the charge.
   * @returns A promise resolving to a transaction identifier.
   */
  charge(amount: number, description: string): Promise<string>;

  /**
   * Settle a transaction — reinforces the positive memory.
   *
   * @param transactionId - The transaction to settle.
   * @returns A promise that resolves when settlement is recorded.
   */
  settle(transactionId: string): Promise<void>;

  /**
   * Refund a transaction — docks reputation and weakens the memory.
   *
   * @param transactionId - The transaction to refund.
   * @returns A promise that resolves when refund is recorded.
   */
  refund(transactionId: string): Promise<void>;

  /**
   * Get the agent's current balance and reputation.
   *
   * @returns An object with wallet balance and reputation score.
   */
  balance(): { wallet: number; reputation: number };
}

/**
 * Configuration options for the MnemoPay x402 middleware.
 */
export interface MnemoPayMiddlewareConfig {
  /** The MnemoPay agent instance. */
  agent: MnemoPayAgent;

  /**
   * Number of past memories to recall before each request.
   *
   * @defaultValue 5
   */
  recallLimit?: number;

  /**
   * Minimum reputation score of a remembered endpoint to consider it reliable.
   * Endpoints below this threshold trigger a warning in recalled memories.
   *
   * @defaultValue 0.3
   */
  reliabilityThreshold?: number;

  /**
   * Whether to log memory events to the console for debugging.
   *
   * @defaultValue false
   */
  debug?: boolean;

  /**
   * Custom function to extract a cost amount (as a number) from payment requirements.
   * Defaults to parsing the `maxAmountRequired` field.
   *
   * @param paymentRequired - The raw payment requirements object.
   * @returns The cost as a number, or undefined if it cannot be determined.
   */
  extractCost?: (paymentRequired: unknown) => number | undefined;
}

/**
 * Information about an endpoint's payment history, derived from MnemoPay memories.
 */
export interface EndpointInsight {
  /** The endpoint URL. */
  endpoint: string;
  /** Average cost observed across remembered payments. */
  averageCost?: number;
  /** Success rate from 0 to 1 based on remembered outcomes. */
  successRate?: number;
  /** Number of remembered interactions with this endpoint. */
  interactionCount: number;
  /** Raw memories about this endpoint. */
  memories: MnemoPayMemory[];
}

/**
 * Result returned after a MnemoPay-enhanced payment flow completes.
 */
export interface MnemoPayPaymentResult {
  /** Whether the payment succeeded. */
  success: boolean;
  /** The MnemoPay transaction ID, if a charge was recorded. */
  transactionId?: string;
  /** The endpoint that was paid. */
  endpoint: string;
  /** The cost that was paid, if determinable. */
  cost?: number;
  /** Insights recalled about this endpoint before the payment. */
  priorInsights?: EndpointInsight;
}
