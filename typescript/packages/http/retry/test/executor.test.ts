import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RetryExecutor,
  RetryExhaustedError,
  CircuitBreakerOpenError,
  RetryTimeoutError,
} from "../src/executor";
import { defaultRetryPolicy, createRetryPolicy } from "../src/policy";
import { DefaultErrorClassifier } from "../src/classifier";

describe("RetryExecutor", () => {
  let executor: RetryExecutor;

  beforeEach(() => {
    executor = new RetryExecutor();
  });

  describe("execute()", () => {
    it("should return result on successful operation", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      const result = await executor.execute(operation, defaultRetryPolicy);

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should retry on retryable errors", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 }) // Retryable
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      const result = await executor.execute(operation, policy);

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("should not retry on non-retryable errors", async () => {
      const operation = vi.fn().mockRejectedValue({ status: 400 }); // Non-retryable

      await expect(executor.execute(operation, defaultRetryPolicy)).rejects.toMatchObject({
        status: 400,
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should throw RetryExhaustedError after maxAttempts", async () => {
      const operation = vi.fn().mockRejectedValue({ status: 503 });

      const policy = createRetryPolicy({
        maxAttempts: 3,
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      await expect(executor.execute(operation, policy)).rejects.toThrow(RetryExhaustedError);

      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("should include all errors in RetryExhaustedError", async () => {
      const error1 = { status: 503, message: "Service Unavailable" };
      const error2 = { status: 500, message: "Internal Server Error" };
      const operation = vi
        .fn()
        .mockRejectedValueOnce(error1)
        .mockRejectedValueOnce(error2)
        .mockRejectedValueOnce(error1);

      const policy = createRetryPolicy({
        maxAttempts: 3,
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      try {
        await executor.execute(operation, policy);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(RetryExhaustedError);
        const retryError = error as RetryExhaustedError;
        expect(retryError.retriedErrors).toHaveLength(3);
        expect(retryError.attempts).toBe(3);
      }
    });

    it("should normalize non-Error thrown values", async () => {
      const operation = vi.fn().mockRejectedValue("string error");

      const policy = createRetryPolicy({
        maxAttempts: 1,
      });

      await expect(executor.execute(operation, policy)).rejects.toBeInstanceOf(Error);
    });
  });

  describe("exponential backoff", () => {
    it("should apply exponential backoff without jitter", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        backoff: {
          initialMs: 100,
          maxMs: 10000,
          multiplier: 2,
          jitter: false,
          jitterFactor: 0,
        },
      });

      const startTime = Date.now();
      await executor.execute(operation, policy);
      const elapsed = Date.now() - startTime;

      // Should have waited: 100ms + 200ms = 300ms
      // Allow some tolerance for execution time
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(400);
    });

    it("should respect maxMs cap", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        backoff: {
          initialMs: 100,
          maxMs: 150, // Cap at 150ms
          multiplier: 2,
          jitter: false,
          jitterFactor: 0,
        },
      });

      const startTime = Date.now();
      await executor.execute(operation, policy);
      const elapsed = Date.now() - startTime;

      // Should have waited: 100ms + 150ms (capped) = 250ms
      expect(elapsed).toBeGreaterThanOrEqual(240);
      expect(elapsed).toBeLessThan(350);
    });

    it("should apply jitter when enabled", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        backoff: {
          initialMs: 100,
          maxMs: 10000,
          multiplier: 2,
          jitter: true,
          jitterFactor: 0.1, // ±10%
        },
      });

      const startTime = Date.now();
      await executor.execute(operation, policy);
      const elapsed = Date.now() - startTime;

      // Should be around 100ms with ±10% jitter (90-110ms)
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe("timeout enforcement", () => {
    it("should throw RetryTimeoutError when timeout exceeded", async () => {
      const operation = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        throw { status: 503 };
      });

      const policy = createRetryPolicy({
        timeoutMs: 150,
        maxAttempts: 10,
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      await expect(executor.execute(operation, policy)).rejects.toThrow(RetryTimeoutError);
    });

    it("should include attempt count in timeout error", async () => {
      const operation = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        throw { status: 503 };
      });

      const policy = createRetryPolicy({
        timeoutMs: 120,
        maxAttempts: 10,
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      try {
        await executor.execute(operation, policy);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(RetryTimeoutError);
        const timeoutError = error as RetryTimeoutError;
        expect(timeoutError.timeoutMs).toBe(120);
        expect(timeoutError.attempts).toBeGreaterThan(0);
      }
    });

    it("should not timeout on successful operations", async () => {
      const operation = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return "success";
      });

      const policy = createRetryPolicy({
        timeoutMs: 100,
        maxAttempts: 3,
      });

      const result = await executor.execute(operation, policy);
      expect(result).toBe("success");
    });
  });

  describe("circuit breaker", () => {
    it("should open circuit after threshold failures", async () => {
      const operation = vi.fn().mockRejectedValue({ status: 503 });

      const policy = createRetryPolicy({
        maxAttempts: 1,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 2,
          resetTimeoutMs: 60000,
        },
      });

      // First failure
      await expect(executor.execute(operation, policy)).rejects.toThrow();
      expect(executor.getCircuitState()).toBe("closed");

      // Second failure - should open circuit
      await expect(executor.execute(operation, policy)).rejects.toThrow();
      expect(executor.getCircuitState()).toBe("open");

      // Third attempt - should be blocked by circuit breaker
      await expect(executor.execute(operation, policy)).rejects.toThrow(CircuitBreakerOpenError);
    });

    it("should transition to half-open after reset timeout", async () => {
      const operation = vi.fn().mockRejectedValue({ status: 503 });

      const policy = createRetryPolicy({
        maxAttempts: 1,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 1,
          resetTimeoutMs: 100,
        },
      });

      // Open circuit
      await expect(executor.execute(operation, policy)).rejects.toThrow();
      expect(executor.getCircuitState()).toBe("open");

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should transition to half-open and allow request
      operation.mockResolvedValueOnce("success");
      const result = await executor.execute(operation, policy);
      expect(result).toBe("success");
      expect(executor.getCircuitState()).toBe("closed");
    });

    it("should close circuit on successful request", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        maxAttempts: 2,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 5,
          resetTimeoutMs: 60000,
        },
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      const result = await executor.execute(operation, policy);
      expect(result).toBe("success");
      expect(executor.getCircuitState()).toBe("closed");
      expect(executor.getConsecutiveFailures()).toBe(0);
    });

    it("should reset circuit breaker manually", async () => {
      const operation = vi.fn().mockRejectedValue({ status: 503 });

      const policy = createRetryPolicy({
        maxAttempts: 1,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 1,
          resetTimeoutMs: 60000,
        },
      });

      // Open circuit
      await expect(executor.execute(operation, policy)).rejects.toThrow();
      expect(executor.getCircuitState()).toBe("open");

      // Manual reset
      executor.resetCircuit();
      expect(executor.getCircuitState()).toBe("closed");
      expect(executor.getConsecutiveFailures()).toBe(0);

      // Should allow requests again
      operation.mockResolvedValueOnce("success");
      const result = await executor.execute(operation, policy);
      expect(result).toBe("success");
    });
  });

  describe("hooks", () => {
    it("should call onRetry hook before each retry", async () => {
      const onRetry = vi.fn();
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        hooks: { onRetry },
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      await executor.execute(operation, policy);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), expect.any(Number));
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), expect.any(Number));
    });

    it("should call onSuccess hook on successful completion", async () => {
      const onSuccess = vi.fn();
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        hooks: { onSuccess },
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      await executor.execute(operation, policy);

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith(2, expect.any(Number)); // 2 attempts
    });

    it("should call onFailure hook on exhausted retries", async () => {
      const onFailure = vi.fn();
      const operation = vi.fn().mockRejectedValue({ status: 503 });

      const policy = createRetryPolicy({
        maxAttempts: 2,
        hooks: { onFailure },
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      await expect(executor.execute(operation, policy)).rejects.toThrow(RetryExhaustedError);

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith(
        2, // attempts
        expect.arrayContaining([expect.any(Error)]),
        expect.any(Number), // totalTimeMs
      );
    });

    it("should call onCircuitOpen hook when circuit opens", async () => {
      const onCircuitOpen = vi.fn();
      const operation = vi.fn().mockRejectedValue({ status: 503 });

      const policy = createRetryPolicy({
        maxAttempts: 1,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 2,
          resetTimeoutMs: 60000,
        },
        hooks: { onCircuitOpen },
      });

      // First failure - circuit still closed
      await expect(executor.execute(operation, policy)).rejects.toThrow();
      expect(onCircuitOpen).not.toHaveBeenCalled();

      // Second failure - circuit opens
      await expect(executor.execute(operation, policy)).rejects.toThrow();
      expect(onCircuitOpen).toHaveBeenCalledTimes(1);
      expect(onCircuitOpen).toHaveBeenCalledWith(2);
    });

    it("should call onCircuitClose hook when circuit closes", async () => {
      const onCircuitClose = vi.fn();
      const operation = vi.fn().mockRejectedValue({ status: 503 });

      const policy = createRetryPolicy({
        maxAttempts: 1,
        circuitBreaker: {
          enabled: true,
          failureThreshold: 1,
          resetTimeoutMs: 50,
        },
        hooks: { onCircuitClose },
      });

      // Open circuit
      await expect(executor.execute(operation, policy)).rejects.toThrow();

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 100));

      // Successful request should close circuit
      operation.mockResolvedValueOnce("success");
      await executor.execute(operation, policy);

      expect(onCircuitClose).toHaveBeenCalledTimes(1);
    });

    it("should not break on hook errors", async () => {
      const onRetry = vi.fn().mockImplementation(() => {
        throw new Error("Hook error");
      });
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        hooks: { onRetry },
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      // Should still succeed despite hook error
      const result = await executor.execute(operation, policy);
      expect(result).toBe("success");
    });
  });

  describe("error classification", () => {
    it("should use custom error classifier", async () => {
      const customClassifier = new DefaultErrorClassifier();
      const isRetryable = vi.spyOn(customClassifier, "isRetryable");

      const operation = vi.fn().mockRejectedValue({ status: 500 });

      const policy = createRetryPolicy({
        maxAttempts: 2,
        errorClassifier: customClassifier,
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      await expect(executor.execute(operation, policy)).rejects.toThrow();

      expect(isRetryable).toHaveBeenCalled();
    });

    it("should handle mixed retryable and non-retryable errors", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 }) // Retryable
        .mockRejectedValueOnce({ status: 400 }); // Non-retryable

      const policy = createRetryPolicy({
        backoff: { initialMs: 10, maxMs: 100, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      await expect(executor.execute(operation, policy)).rejects.toMatchObject({ status: 400 });

      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe("edge cases", () => {
    it("should handle maxAttempts = 1", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      const policy = createRetryPolicy({ maxAttempts: 1 });

      const result = await executor.execute(operation, policy);
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should handle zero backoff", async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce("success");

      const policy = createRetryPolicy({
        backoff: { initialMs: 0, maxMs: 0, multiplier: 2, jitter: false, jitterFactor: 0 },
      });

      const startTime = Date.now();
      await executor.execute(operation, policy);
      const elapsed = Date.now() - startTime;

      // Should complete very quickly with no backoff
      expect(elapsed).toBeLessThan(50);
    });

    it("should handle operations that return undefined", async () => {
      const operation = vi.fn().mockResolvedValue(undefined);

      const result = await executor.execute(operation, defaultRetryPolicy);
      expect(result).toBeUndefined();
    });

    it("should handle operations that return null", async () => {
      const operation = vi.fn().mockResolvedValue(null);

      const result = await executor.execute(operation, defaultRetryPolicy);
      expect(result).toBeNull();
    });
  });
});
