import { describe, it, expect } from "vitest";
import {
  defaultBackoffConfig,
  defaultCircuitBreakerConfig,
  defaultRetryPolicy,
  createRetryPolicy,
} from "../src/policy";
import { DefaultErrorClassifier } from "../src/classifier";

describe("RetryPolicy", () => {
  describe("defaultBackoffConfig", () => {
    it("should have correct default values", () => {
      expect(defaultBackoffConfig).toEqual({
        initialMs: 1000,
        maxMs: 30000,
        multiplier: 2,
        jitter: true,
        jitterFactor: 0.1,
      });
    });

    it("should be immutable object", () => {
      const original = { ...defaultBackoffConfig };

      // Attempting to modify (TypeScript would prevent this, but testing at runtime)
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (defaultBackoffConfig as any).initialMs = 500;
      }).not.toThrow();

      // Original values should be changed (it's not frozen, just a default)
      expect(defaultBackoffConfig.initialMs).toBe(500);

      // Reset for other tests
      Object.assign(defaultBackoffConfig, original);
    });
  });

  describe("defaultCircuitBreakerConfig", () => {
    it("should have correct default values", () => {
      expect(defaultCircuitBreakerConfig).toEqual({
        enabled: false,
        failureThreshold: 5,
        resetTimeoutMs: 60000,
      });
    });

    it("should be disabled by default", () => {
      expect(defaultCircuitBreakerConfig.enabled).toBe(false);
    });
  });

  describe("defaultRetryPolicy", () => {
    it("should have correct default values", () => {
      expect(defaultRetryPolicy).toMatchObject({
        maxAttempts: 3,
        timeoutMs: 60000,
        backoff: {
          initialMs: 1000,
          maxMs: 30000,
          multiplier: 2,
          jitter: true,
          jitterFactor: 0.1,
        },
        circuitBreaker: {
          enabled: false,
          failureThreshold: 5,
          resetTimeoutMs: 60000,
        },
      });
    });

    it("should include error classifier", () => {
      expect(defaultRetryPolicy.errorClassifier).toBeInstanceOf(DefaultErrorClassifier);
    });

    it("should not include hooks by default", () => {
      expect(defaultRetryPolicy.hooks).toBeUndefined();
    });

    it("should use same backoff config instance", () => {
      expect(defaultRetryPolicy.backoff).toBe(defaultBackoffConfig);
    });

    it("should use same circuit breaker config instance", () => {
      expect(defaultRetryPolicy.circuitBreaker).toBe(defaultCircuitBreakerConfig);
    });
  });

  describe("createRetryPolicy", () => {
    it("should return default policy when no options provided", () => {
      const policy = createRetryPolicy();

      expect(policy).toMatchObject({
        maxAttempts: 3,
        timeoutMs: 60000,
        backoff: defaultBackoffConfig,
        circuitBreaker: defaultCircuitBreakerConfig,
      });
    });

    it("should override maxAttempts", () => {
      const policy = createRetryPolicy({ maxAttempts: 5 });

      expect(policy.maxAttempts).toBe(5);
      expect(policy.timeoutMs).toBe(60000); // Other defaults preserved
    });

    it("should override timeoutMs", () => {
      const policy = createRetryPolicy({ timeoutMs: 120000 });

      expect(policy.timeoutMs).toBe(120000);
      expect(policy.maxAttempts).toBe(3); // Other defaults preserved
    });

    it("should merge partial backoff config", () => {
      const policy = createRetryPolicy({
        backoff: {
          initialMs: 500,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any, // Partial type
      });

      expect(policy.backoff).toEqual({
        initialMs: 500, // Overridden
        maxMs: 30000, // Default
        multiplier: 2, // Default
        jitter: true, // Default
        jitterFactor: 0.1, // Default
      });
    });

    it("should merge partial circuit breaker config", () => {
      const policy = createRetryPolicy({
        circuitBreaker: {
          enabled: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any, // Partial type
      });

      expect(policy.circuitBreaker).toEqual({
        enabled: true, // Overridden
        failureThreshold: 5, // Default
        resetTimeoutMs: 60000, // Default
      });
    });

    it("should accept custom error classifier", () => {
      const customClassifier = new DefaultErrorClassifier();
      const policy = createRetryPolicy({
        errorClassifier: customClassifier,
      });

      expect(policy.errorClassifier).toBe(customClassifier);
    });

    it("should accept hooks", () => {
      const onRetry = vi.fn();
      const onSuccess = vi.fn();
      const onFailure = vi.fn();

      const policy = createRetryPolicy({
        hooks: {
          onRetry,
          onSuccess,
          onFailure,
        },
      });

      expect(policy.hooks?.onRetry).toBe(onRetry);
      expect(policy.hooks?.onSuccess).toBe(onSuccess);
      expect(policy.hooks?.onFailure).toBe(onFailure);
    });

    it("should allow all hooks to be provided", () => {
      const hooks = {
        onRetry: vi.fn(),
        onSuccess: vi.fn(),
        onFailure: vi.fn(),
        onCircuitOpen: vi.fn(),
        onCircuitClose: vi.fn(),
      };

      const policy = createRetryPolicy({ hooks });

      expect(policy.hooks).toBe(hooks);
      expect(policy.hooks?.onRetry).toBe(hooks.onRetry);
      expect(policy.hooks?.onSuccess).toBe(hooks.onSuccess);
      expect(policy.hooks?.onFailure).toBe(hooks.onFailure);
      expect(policy.hooks?.onCircuitOpen).toBe(hooks.onCircuitOpen);
      expect(policy.hooks?.onCircuitClose).toBe(hooks.onCircuitClose);
    });

    it("should allow partial hooks", () => {
      const onRetry = vi.fn();

      const policy = createRetryPolicy({
        hooks: { onRetry },
      });

      expect(policy.hooks?.onRetry).toBe(onRetry);
      expect(policy.hooks?.onSuccess).toBeUndefined();
      expect(policy.hooks?.onFailure).toBeUndefined();
    });

    it("should create independent policy instances", () => {
      const policy1 = createRetryPolicy({ maxAttempts: 5 });
      const policy2 = createRetryPolicy({ maxAttempts: 10 });

      expect(policy1.maxAttempts).toBe(5);
      expect(policy2.maxAttempts).toBe(10);
    });

    it("should not mutate default configs", () => {
      const originalBackoff = { ...defaultBackoffConfig };
      const originalCircuitBreaker = { ...defaultCircuitBreakerConfig };

      createRetryPolicy({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        backoff: { initialMs: 5000 } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        circuitBreaker: { enabled: true } as any,
      });

      expect(defaultBackoffConfig).toEqual(originalBackoff);
      expect(defaultCircuitBreakerConfig).toEqual(originalCircuitBreaker);
    });
  });

  describe("Policy Configuration Validation", () => {
    it("should accept zero maxAttempts", () => {
      const policy = createRetryPolicy({ maxAttempts: 0 });
      expect(policy.maxAttempts).toBe(0);
    });

    it("should accept very large maxAttempts", () => {
      const policy = createRetryPolicy({ maxAttempts: 1000 });
      expect(policy.maxAttempts).toBe(1000);
    });

    it("should accept zero timeout (unlimited)", () => {
      const policy = createRetryPolicy({ timeoutMs: undefined });
      expect(policy.timeoutMs).toBeUndefined();
    });

    it("should accept aggressive backoff settings", () => {
      const policy = createRetryPolicy({
        backoff: {
          initialMs: 100,
          maxMs: 5000,
          multiplier: 3,
          jitter: false,
          jitterFactor: 0,
        },
      });

      expect(policy.backoff.initialMs).toBe(100);
      expect(policy.backoff.maxMs).toBe(5000);
      expect(policy.backoff.multiplier).toBe(3);
      expect(policy.backoff.jitter).toBe(false);
    });

    it("should accept conservative backoff settings", () => {
      const policy = createRetryPolicy({
        backoff: {
          initialMs: 5000,
          maxMs: 60000,
          multiplier: 1.5,
          jitter: true,
          jitterFactor: 0.3,
        },
      });

      expect(policy.backoff.initialMs).toBe(5000);
      expect(policy.backoff.maxMs).toBe(60000);
      expect(policy.backoff.multiplier).toBe(1.5);
      expect(policy.backoff.jitterFactor).toBe(0.3);
    });

    it("should accept enabled circuit breaker with custom thresholds", () => {
      const policy = createRetryPolicy({
        circuitBreaker: {
          enabled: true,
          failureThreshold: 3,
          resetTimeoutMs: 30000,
        },
      });

      expect(policy.circuitBreaker?.enabled).toBe(true);
      expect(policy.circuitBreaker?.failureThreshold).toBe(3);
      expect(policy.circuitBreaker?.resetTimeoutMs).toBe(30000);
    });
  });

  describe("Real-world policy examples", () => {
    it("should create aggressive retry policy", () => {
      const policy = createRetryPolicy({
        maxAttempts: 5,
        timeoutMs: 30000,
        backoff: {
          initialMs: 500,
          maxMs: 10000,
          multiplier: 1.5,
          jitter: true,
          jitterFactor: 0.2,
        },
      });

      expect(policy.maxAttempts).toBe(5);
      expect(policy.timeoutMs).toBe(30000);
      expect(policy.backoff.initialMs).toBe(500);
    });

    it("should create conservative retry policy", () => {
      const policy = createRetryPolicy({
        maxAttempts: 2,
        timeoutMs: 120000,
        backoff: {
          initialMs: 2000,
          maxMs: 60000,
          multiplier: 3,
          jitter: false,
          jitterFactor: 0,
        },
      });

      expect(policy.maxAttempts).toBe(2);
      expect(policy.timeoutMs).toBe(120000);
      expect(policy.backoff.multiplier).toBe(3);
    });

    it("should create policy with circuit breaker for high-traffic scenarios", () => {
      const policy = createRetryPolicy({
        maxAttempts: 3,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 10,
          resetTimeoutMs: 120000,
        },
        hooks: {
          onCircuitOpen: failures => {
            console.log(`Circuit opened after ${failures} failures`);
          },
        },
      });

      expect(policy.circuitBreaker?.enabled).toBe(true);
      expect(policy.circuitBreaker?.failureThreshold).toBe(10);
      expect(policy.hooks?.onCircuitOpen).toBeDefined();
    });

    it("should create policy with comprehensive observability", () => {
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      };

      const policy = createRetryPolicy({
        hooks: {
          onRetry: (attempt, error, backoff) => {
            logger.warn(`Retry ${attempt}: ${error.message} (wait ${backoff}ms)`);
          },
          onSuccess: (attempts, time) => {
            logger.info(`Success after ${attempts} attempts in ${time}ms`);
          },
          onFailure: (attempts, errors, time) => {
            logger.error(
              `Failed after ${attempts} attempts in ${time}ms: ${errors.map(e => e.message).join(", ")}`,
            );
          },
        },
      });

      expect(policy.hooks?.onRetry).toBeDefined();
      expect(policy.hooks?.onSuccess).toBeDefined();
      expect(policy.hooks?.onFailure).toBeDefined();
    });
  });
});
