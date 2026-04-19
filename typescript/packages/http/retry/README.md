# @x402/retry

A robust retry and idempotency utility for x402 payment operations. This package provides configurable retry logic with exponential backoff, error classification, circuit breaker pattern, and observability hooks to handle transient failures safely in payment flows.

## Features

- ✅ **Exponential Backoff** with configurable jitter to prevent thundering herd
- ✅ **Error Classification** - distinguishes retryable vs non-retryable errors
- ✅ **Circuit Breaker** - optional pattern to prevent excessive retries during outages
- ✅ **Idempotency Keys** - deterministic key generation for payment deduplication
- ✅ **Observability Hooks** - track retry attempts, successes, and failures
- ✅ **Timeout Enforcement** - prevents infinite retry loops
- ✅ **Zero Dependencies** - pure TypeScript implementation
- ✅ **Type Safe** - full TypeScript support with strict types

## Installation

```bash
pnpm install @x402/retry
```

## Quick Start

```typescript
import { RetryExecutor, defaultRetryPolicy } from "@x402/retry";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// Setup x402 client
const account = privateKeyToAccount("0xYourPrivateKey");
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));

// Create retry executor
const executor = new RetryExecutor();
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// Execute with automatic retry on transient failures
const response = await executor.execute(
  () => fetchWithPayment("https://api.example.com/paid-endpoint"),
  defaultRetryPolicy,
);

const data = await response.json();
```

## Core Concepts

### RetryExecutor

The `RetryExecutor` is the main class that handles retry logic. It executes operations with configurable retry behavior including exponential backoff, error classification, and circuit breaker pattern.

### RetryPolicy

A `RetryPolicy` defines how retries should behave:

- **maxAttempts**: Maximum number of retry attempts (default: 3)
- **timeoutMs**: Overall operation timeout (default: 60000ms)
- **backoff**: Exponential backoff configuration
- **circuitBreaker**: Optional circuit breaker settings
- **errorClassifier**: Determines which errors are retryable
- **hooks**: Optional callbacks for observability

### Error Classification

By default, the following HTTP errors are considered **retryable**:

- `429` - Rate Limiting
- `500` - Internal Server Error
- `502` - Bad Gateway
- `503` - Service Unavailable
- `504` - Gateway Timeout

Client errors (4xx) are **not retryable** as they indicate permanent failures.

### Idempotency Keys

The package includes utilities to generate deterministic idempotency keys from payment payloads, ensuring the same payment parameters always produce the same key for safe retries.

## API Reference

### RetryExecutor

#### `execute<T>(operation, policy): Promise<T>`

Executes an async operation with retry logic.

**Parameters:**

- `operation`: The async function to execute
- `policy`: Retry policy configuration

**Returns:** Result of the successful operation

**Throws:**

- `RetryExhaustedError` - when all retry attempts fail
- `CircuitBreakerOpenError` - when circuit breaker blocks the request
- `RetryTimeoutError` - when operation timeout is exceeded
- Original error - when a non-retryable error occurs

**Example:**

```typescript
const executor = new RetryExecutor();

try {
  const result = await executor.execute(async () => {
    const response = await fetch("https://api.example.com/data");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }, defaultRetryPolicy);
  console.log("Success:", result);
} catch (error) {
  if (error instanceof RetryExhaustedError) {
    console.error(`Failed after ${error.attempts} attempts`);
    console.error("Errors:", error.retriedErrors);
  }
}
```

#### `resetCircuit(): void`

Manually reset the circuit breaker state. Useful for testing or manual intervention.

#### `getCircuitState(): string`

Get the current circuit breaker state (`'closed'`, `'open'`, or `'half-open'`).

#### `getConsecutiveFailures(): number`

Get the count of consecutive failures.

### Retry Policy

#### `defaultRetryPolicy`

Pre-configured policy with safe defaults:

- 3 retry attempts
- 60 second timeout
- Exponential backoff: 1s, 2s, 4s (with 10% jitter)
- Circuit breaker disabled
- Retries on 429, 5xx errors only

#### `createRetryPolicy(options): RetryPolicy`

Create a custom retry policy by overriding defaults.

**Example:**

```typescript
import { createRetryPolicy } from "@x402/retry";

const customPolicy = createRetryPolicy({
  maxAttempts: 5,
  timeoutMs: 120000,
  backoff: {
    initialMs: 500,
    maxMs: 10000,
    multiplier: 1.5,
    jitter: true,
    jitterFactor: 0.2,
  },
  hooks: {
    onRetry: (attempt, error, backoffMs) => {
      console.log(`Retry ${attempt}: ${error.message} (waiting ${backoffMs}ms)`);
    },
  },
});
```

### Error Classification

#### `DefaultErrorClassifier`

Built-in classifier that identifies retryable errors based on HTTP status codes.

#### `createErrorClassifier(options): ErrorClassifier`

Create a custom error classifier with additional rules.

**Example:**

```typescript
import { createErrorClassifier } from "@x402/retry";

const classifier = createErrorClassifier({
  retryableHttpCodes: [418, 425], // Add custom retryable codes
  nonRetryableHttpCodes: [451], // Add custom non-retryable codes
});
```

### Idempotency

#### `DefaultIdempotencyKeyGenerator`

Generates deterministic idempotency keys from payment payloads using SHA-256 hashing.

#### `createIdempotencyKeyGenerator(fn): IdempotencyKeyGenerator`

Create a custom key generator.

**Example:**

```typescript
import { createIdempotencyKeyGenerator } from "@x402/retry";

const generator = createIdempotencyKeyGenerator(payload => {
  return `custom_${payload.scheme}_${payload.network}_${Date.now()}`;
});
```

## Usage Examples

### Basic Usage with Fetch

```typescript
import { RetryExecutor, defaultRetryPolicy } from "@x402/retry";
import { wrapFetchWithPayment } from "@x402/fetch";

const executor = new RetryExecutor();
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// Automatically retries on 429, 500, 502, 503, 504 errors
const response = await executor.execute(
  () => fetchWithPayment("https://api.example.com/resource"),
  defaultRetryPolicy,
);
```

### Basic Usage with Axios

```typescript
import axios from "axios";
import { wrapAxiosWithPayment } from "@x402/axios";
import { RetryExecutor, defaultRetryPolicy } from "@x402/retry";

const api = wrapAxiosWithPayment(axios.create(), client);
const executor = new RetryExecutor();

const response = await executor.execute(
  () => api.get("https://api.example.com/resource"),
  defaultRetryPolicy,
);
```

### Custom Retry Policy

```typescript
import { createRetryPolicy } from "@x402/retry";

const aggressivePolicy = createRetryPolicy({
  maxAttempts: 5,
  timeoutMs: 120000, // 2 minutes
  backoff: {
    initialMs: 500, // Start with 500ms
    maxMs: 10000, // Cap at 10s
    multiplier: 1.5, // Slower exponential growth
    jitter: true,
    jitterFactor: 0.2, // ±20% randomization
  },
});

const response = await executor.execute(
  () => fetchWithPayment("https://api.example.com/resource"),
  aggressivePolicy,
);
```

### With Observability Hooks

```typescript
import { createRetryPolicy } from "@x402/retry";

const observablePolicy = createRetryPolicy({
  hooks: {
    onRetry: (attempt, error, backoffMs) => {
      console.warn(`Retry attempt ${attempt} after error: ${error.message}`);
      console.debug(`Waiting ${backoffMs}ms before next attempt`);
    },
    onSuccess: (attempts, totalTimeMs) => {
      console.log(`Payment succeeded after ${attempts} attempt(s) in ${totalTimeMs}ms`);
      // Send metrics to monitoring service
    },
    onFailure: (attempts, errors, totalTimeMs) => {
      console.error(`Payment failed after ${attempts} attempts in ${totalTimeMs}ms`);
      console.error(
        "Errors:",
        errors.map(e => e.message),
      );
      // Alert on-call engineer
    },
  },
});
```

### With Circuit Breaker (Production)

Circuit breaker is useful for high-volume production systems to prevent cascade failures.

```typescript
import { createRetryPolicy } from "@x402/retry";

const productionPolicy = createRetryPolicy({
  maxAttempts: 3,
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5, // Open circuit after 5 consecutive failures
    resetTimeoutMs: 60000, // Try again after 60 seconds
  },
  hooks: {
    onCircuitOpen: failureCount => {
      console.error(`Circuit breaker opened after ${failureCount} failures`);
      // Show user-friendly error message
      // Switch to fallback behavior
    },
    onCircuitClose: () => {
      console.log("Circuit breaker closed - service recovered");
    },
  },
});
```

### Different Policies for Different Operations

```typescript
// Conservative policy for critical operations
const criticalPolicy = createRetryPolicy({
  maxAttempts: 5,
  backoff: { initialMs: 2000, maxMs: 30000, multiplier: 2, jitter: true, jitterFactor: 0.1 },
});

// Fast-fail policy for non-critical operations
const fastFailPolicy = createRetryPolicy({
  maxAttempts: 2,
  backoff: { initialMs: 500, maxMs: 5000, multiplier: 2, jitter: false, jitterFactor: 0 },
});

// Critical payment - more retries
const paymentResponse = await executor.execute(
  () => fetchWithPayment("/api/payment"),
  criticalPolicy,
);

// Non-critical metadata - fail fast
const metadataResponse = await executor.execute(() => fetch("/api/metadata"), fastFailPolicy);
```

## Error Handling

### Handling Retry Exhausted

```typescript
import { RetryExhaustedError } from "@x402/retry";

try {
  const result = await executor.execute(operation, defaultRetryPolicy);
} catch (error) {
  if (error instanceof RetryExhaustedError) {
    console.error(`Failed after ${error.attempts} attempts`);
    console.error(`Total time: ${error.totalTimeMs}ms`);
    console.error("All errors:", error.retriedErrors);

    // Show user-friendly error message
    alert("Payment failed after multiple attempts. Please try again later.");
  }
}
```

### Handling Circuit Breaker

```typescript
import { CircuitBreakerOpenError } from "@x402/retry";

try {
  const result = await executor.execute(operation, policy);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    console.error("Service is currently unavailable");
    console.error(`Failed after ${error.failureCount} consecutive failures`);

    // Show maintenance message
    alert("Service is temporarily unavailable. Please try again in a few minutes.");
  }
}
```

### Handling Timeout

```typescript
import { RetryTimeoutError } from "@x402/retry";

try {
  const result = await executor.execute(operation, policy);
} catch (error) {
  if (error instanceof RetryTimeoutError) {
    console.error(`Operation timed out after ${error.timeoutMs}ms`);
    console.error(`Made ${error.attempts} attempts`);

    // Handle timeout appropriately
  }
}
```

## Best Practices

### 1. Reuse Executor Instances

Create one executor instance and reuse it across operations:

```typescript
// ✅ Good - reuse executor
const executor = new RetryExecutor();

async function fetchData(url: string) {
  return executor.execute(() => fetch(url), defaultRetryPolicy);
}

// ❌ Bad - creates new executor every time
async function fetchData(url: string) {
  const executor = new RetryExecutor(); // Don't do this
  return executor.execute(() => fetch(url), defaultRetryPolicy);
}
```

### 2. Use Appropriate Retry Policies

Choose policies based on operation criticality:

```typescript
// Critical operations - more retries, longer timeouts
const criticalPolicy = createRetryPolicy({ maxAttempts: 5, timeoutMs: 120000 });

// Non-critical operations - fewer retries, shorter timeouts
const nonCriticalPolicy = createRetryPolicy({ maxAttempts: 2, timeoutMs: 30000 });
```

### 3. Add Observability in Production

Always use hooks to monitor retry behavior:

```typescript
const policy = createRetryPolicy({
  hooks: {
    onRetry: (attempt, error, backoff) => {
      metrics.increment("payment.retry", { attempt });
      logger.warn("Payment retry", { attempt, error: error.message, backoff });
    },
    onFailure: (attempts, errors, time) => {
      metrics.increment("payment.failure", { attempts });
      logger.error("Payment failed", { attempts, time, errors });
      alerts.notify("Payment failure", { attempts, time });
    },
  },
});
```

### 4. Circuit Breaker for High Volume

Enable circuit breaker in production systems with high request volumes:

```typescript
const productionPolicy = createRetryPolicy({
  circuitBreaker: {
    enabled: true,
    failureThreshold: 10, // Higher threshold for production
    resetTimeoutMs: 120000, // 2 minute recovery window
  },
});
```

### 5. Disable Circuit Breaker for Low Volume

For applications with few payment requests, circuit breaker adds unnecessary complexity:

```typescript
// For most users - circuit breaker not needed
const simplePolicy = createRetryPolicy({
  maxAttempts: 3,
  circuitBreaker: { enabled: false }, // Default
});
```

## Migration Guide

### From Manual Retry Logic

**Before:**

```typescript
async function fetchWithRetry(url: string, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
}
```

**After:**

```typescript
import { RetryExecutor, defaultRetryPolicy } from "@x402/retry";

const executor = new RetryExecutor();

async function fetchWithRetry(url: string) {
  return executor.execute(() => fetch(url), defaultRetryPolicy);
}
```

### Adding to Existing x402 Integration

**Before:**

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment("https://api.example.com/resource");
```

**After (with retry):**

```typescript
import { RetryExecutor, defaultRetryPolicy } from "@x402/retry";
import { wrapFetchWithPayment } from "@x402/fetch";

const executor = new RetryExecutor();
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const response = await executor.execute(
  () => fetchWithPayment("https://api.example.com/resource"),
  defaultRetryPolicy,
);
```

## TypeScript Support

This package is written in TypeScript with strict type checking. All exports are fully typed:

```typescript
import type {
  RetryPolicy,
  BackoffConfig,
  CircuitBreakerConfig,
  RetryHooks,
  ErrorClassifier,
  IdempotencyKeyGenerator,
} from "@x402/retry";
```

## Performance

- **Minimal Overhead**: <5ms per operation when no retries are needed
- **Efficient Backoff**: Non-blocking delays using `setTimeout`
- **No Memory Leaks**: Proper cleanup of timers and state
- **Zero Dependencies**: Pure TypeScript implementation

## Testing

The package includes comprehensive test coverage (>95%):

```bash
pnpm test
```

## License

MIT

## Contributing

Contributions are welcome! Please see the main [x402 repository](https://github.com/coinbase/x402) for contribution guidelines.

## Related Packages

- [@x402/core](../core) - Core x402 client and types
- [@x402/fetch](../fetch) - Fetch wrapper with x402 payment handling
- [@x402/axios](../axios) - Axios wrapper with x402 payment handling
- [@x402/evm](../../schemes/evm) - EVM scheme implementation
- [@x402/svm](../../schemes/svm) - Solana scheme implementation

## Support

- [GitHub Issues](https://github.com/coinbase/x402/issues)
- [Documentation](https://docs.x402.org)
- [Discord Community](https://discord.gg/x402)
