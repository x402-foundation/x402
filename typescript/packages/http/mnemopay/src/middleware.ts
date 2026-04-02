import type {
  MnemoPayAgent,
  MnemoPayMiddlewareConfig,
  EndpointInsight,
  MnemoPayMemory,
  MnemoPayPaymentResult,
} from "./types";

const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_RELIABILITY_THRESHOLD = 0.3;

/**
 * Extract the endpoint URL from a fetch Request or URL input.
 *
 * @param input - The fetch input (string URL, URL object, or Request).
 * @returns The URL string for the endpoint.
 */
function extractEndpoint(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Try to extract a cost value from the 402 response body.
 *
 * Walks common x402 payment-required shapes to find a numeric cost.
 *
 * @param body - The parsed JSON body from the 402 response.
 * @param customExtractor - Optional user-supplied cost extractor.
 * @returns The cost as a number, or undefined.
 */
function extractCostFromPaymentRequired(
  body: unknown,
  customExtractor?: (paymentRequired: unknown) => number | undefined,
): number | undefined {
  if (customExtractor) {
    return customExtractor(body);
  }

  if (!body || typeof body !== "object") return undefined;

  const record = body as Record<string, unknown>;

  // v2: accepts[].maxAmountRequired
  if (Array.isArray(record.accepts)) {
    for (const accept of record.accepts) {
      if (accept && typeof accept === "object" && "maxAmountRequired" in accept) {
        const val = Number(accept.maxAmountRequired);
        if (!isNaN(val)) return val;
      }
    }
  }

  // v1: maxAmountRequired at top level
  if ("maxAmountRequired" in record) {
    const val = Number(record.maxAmountRequired);
    if (!isNaN(val)) return val;
  }

  return undefined;
}

/**
 * Build an EndpointInsight from recalled memories about a specific endpoint.
 *
 * @param endpoint - The URL of the endpoint.
 * @param memories - The recalled memories to analyze.
 * @returns An EndpointInsight summarizing the agent's experience with this endpoint.
 */
function buildInsight(endpoint: string, memories: MnemoPayMemory[]): EndpointInsight {
  const costs: number[] = [];
  let successes = 0;
  let failures = 0;

  for (const mem of memories) {
    const costMatch = mem.content.match(/cost[:\s]+\$?([\d.]+)/i);
    if (costMatch) {
      const c = parseFloat(costMatch[1]);
      if (!isNaN(c)) costs.push(c);
    }
    if (/success|settled|completed/i.test(mem.content)) successes++;
    if (/fail|refund|error/i.test(mem.content)) failures++;
  }

  const total = successes + failures;

  return {
    endpoint,
    averageCost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : undefined,
    successRate: total > 0 ? successes / total : undefined,
    interactionCount: memories.length,
    memories,
  };
}

/**
 * Recall what the agent knows about a given endpoint before making a payment.
 *
 * This is the "look before you leap" step — the agent checks its memory for
 * past interactions with this endpoint, including cost history, reliability,
 * and any alternative endpoints it has learned about.
 *
 * @param agent - The MnemoPay agent instance.
 * @param endpoint - The URL being requested.
 * @param recallLimit - Maximum number of memories to recall.
 * @returns An EndpointInsight, or undefined if the agent has no memories.
 */
export async function recallEndpointInsight(
  agent: MnemoPayAgent,
  endpoint: string,
  recallLimit: number = DEFAULT_RECALL_LIMIT,
): Promise<EndpointInsight | undefined> {
  try {
    const memories = await agent.recall(`x402 payment to ${endpoint}`, recallLimit);
    if (!memories || memories.length === 0) return undefined;
    return buildInsight(endpoint, memories);
  } catch {
    // Recall failures should not block the payment flow
    return undefined;
  }
}

/**
 * Record the outcome of a payment in the agent's memory.
 *
 * After a 402 payment completes (successfully or not), this function stores
 * a rich memory entry that the agent can use to make better decisions in the
 * future — choosing cheaper endpoints, avoiding unreliable ones, or
 * negotiating better terms.
 *
 * @param agent - The MnemoPay agent instance.
 * @param result - The payment result to remember.
 * @param debug - Whether to log to console.
 * @returns A promise that resolves when the memory is stored.
 */
export async function rememberPaymentOutcome(
  agent: MnemoPayAgent,
  result: MnemoPayPaymentResult,
  debug: boolean = false,
): Promise<void> {
  const costStr = result.cost !== undefined ? `, cost: $${result.cost}` : "";
  const status = result.success ? "success" : "failure";
  const content = `x402 payment to ${result.endpoint}: ${status}${costStr}`;

  const tags = ["x402", status];
  if (result.cost !== undefined) tags.push("cost-tracked");

  const importance = result.success ? 0.7 : 0.9; // failures are more important to remember

  try {
    await agent.remember(content, { importance, tags });

    if (result.success && result.transactionId) {
      await agent.settle(result.transactionId);
      if (debug) console.log(`[mnemopay] settled tx ${result.transactionId} for ${result.endpoint}`);
    } else if (!result.success && result.transactionId) {
      await agent.refund(result.transactionId);
      if (debug) console.log(`[mnemopay] refunded tx ${result.transactionId} for ${result.endpoint}`);
    }
  } catch {
    // Memory storage failures should not disrupt the payment flow
    if (debug) console.log(`[mnemopay] failed to store memory for ${result.endpoint}`);
  }
}

/**
 * Wraps a fetch function with MnemoPay memory-enhanced x402 payment handling.
 *
 * This is the primary integration point. It intercepts every fetch call and:
 * 1. Before the request: recalls past payment experiences with the endpoint
 * 2. If a 402 is returned: records a charge via MnemoPay
 * 3. After the retry succeeds: settles the transaction (reinforcing the memory)
 * 4. If the retry fails: refunds the transaction (docking reputation)
 *
 * The wrapped fetch does NOT replace x402 payment logic — it layers memory on
 * top of an already-x402-wrapped fetch function. Use it like:
 *
 * ```typescript
 * const payFetch = wrapFetchWithPayment(fetch, client);        // x402 layer
 * const smartFetch = withMnemoPay(payFetch, { agent: myAgent }); // memory layer
 * ```
 *
 * @param fetchFn - A fetch function (ideally already wrapped with x402 payment handling).
 * @param config - MnemoPay middleware configuration.
 * @returns A wrapped fetch function with memory-enhanced payment awareness.
 */
export function withMnemoPay(
  fetchFn: typeof globalThis.fetch,
  config: MnemoPayMiddlewareConfig,
): typeof globalThis.fetch {
  const { agent, recallLimit = DEFAULT_RECALL_LIMIT, debug = false, extractCost } = config;
  const reliabilityThreshold =
    config.reliabilityThreshold ?? DEFAULT_RELIABILITY_THRESHOLD;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const endpoint = extractEndpoint(input);

    // --- Phase 1: Recall past experience ---
    const insight = await recallEndpointInsight(agent, endpoint, recallLimit);

    if (debug && insight) {
      console.log(
        `[mnemopay] recalled ${insight.interactionCount} memories for ${endpoint}` +
          (insight.successRate !== undefined ? `, success rate: ${(insight.successRate * 100).toFixed(0)}%` : "") +
          (insight.averageCost !== undefined ? `, avg cost: $${insight.averageCost.toFixed(4)}` : ""),
      );
    }

    // Warn if we know this endpoint is unreliable
    if (
      insight &&
      insight.successRate !== undefined &&
      insight.successRate < reliabilityThreshold &&
      insight.interactionCount >= 3
    ) {
      if (debug) {
        console.log(
          `[mnemopay] WARNING: ${endpoint} has low reliability (${(insight.successRate * 100).toFixed(0)}%). Consider alternatives.`,
        );
      }
    }

    // --- Phase 2: Make the request (x402 payment happens inside fetchFn) ---
    let response: Response;
    try {
      response = await fetchFn(input, init);
    } catch (error) {
      // The request itself failed (network error, x402 payment creation failed, etc.)
      await rememberPaymentOutcome(
        agent,
        {
          success: false,
          endpoint,
          priorInsights: insight ?? undefined,
        },
        debug,
      );
      throw error;
    }

    // --- Phase 3: Analyze the outcome ---
    // If the response is a 402, the upstream x402 wrapper already tried to pay
    // and the retry still failed — this is a payment failure.
    const success = response.status !== 402 && response.ok;

    // Try to extract cost from payment response headers
    let cost: number | undefined;
    const paymentResponseHeader =
      response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
    if (paymentResponseHeader) {
      try {
        const parsed = JSON.parse(atob(paymentResponseHeader));
        if (parsed && typeof parsed === "object" && "amount" in parsed) {
          cost = Number(parsed.amount);
        }
      } catch {
        // Not all payment response headers are base64 JSON; that's fine
      }
    }

    // Record a charge in MnemoPay if we detected a payment was made
    let transactionId: string | undefined;
    if (cost !== undefined) {
      try {
        transactionId = await agent.charge(cost, `x402 payment to ${endpoint}`);
      } catch {
        if (debug) console.log(`[mnemopay] failed to record charge for ${endpoint}`);
      }
    }

    // --- Phase 4: Remember the outcome ---
    await rememberPaymentOutcome(
      agent,
      {
        success,
        transactionId,
        endpoint,
        cost,
        priorInsights: insight ?? undefined,
      },
      debug,
    );

    return response;
  };
}

/**
 * Creates a MnemoPay-enhanced fetch function with default configuration.
 *
 * Convenience wrapper around `withMnemoPay` for quick setup.
 *
 * @param fetchFn - A fetch function (ideally already wrapped with x402 payment handling).
 * @param agent - The MnemoPay agent instance.
 * @returns A wrapped fetch function with memory-enhanced payment awareness.
 */
export function withMnemoPayAgent(
  fetchFn: typeof globalThis.fetch,
  agent: MnemoPayAgent,
): typeof globalThis.fetch {
  return withMnemoPay(fetchFn, { agent });
}
