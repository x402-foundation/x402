import type { Network } from "@x402/core/types";
import type { AuthCaptureOperatorType, AuthCapturePaymentFlow, PaymentInfoStruct } from "../types";
import type { AssetTransferMethod } from "../../types";

/**
 * Per-key async mutex. Concurrent calls with the same key are serialized;
 * different keys run in parallel.
 *
 * The in-memory backend only provides this guarantee inside one JS runtime;
 * production multi-instance deployments need storage with backend-level atomic
 * conditional mutation, such as Redis/Valkey Lua scripts, SQL transactions, or
 * Durable Objects.
 *
 * @returns A `withLock(key, fn)` function.
 */
function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<void>>();

  return async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const next = previous.catch(() => { }).then(() => current);
    locks.set(key, next);

    await previous.catch(() => { });
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === next) {
        locks.delete(key);
      }
    }
  };
}

export interface AuthorizedPayment {
  paymentInfoHash: `0x${string}`;
  paymentInfo: PaymentInfoStruct;
  saltNonce?: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
  policy: `0x${string}`;
  network: Network;
  capturableAmount: string;
  refundableAmount: string;
  collectTransaction: string;
  createdAt: number;
  name: string;
  version: string;
  paymentFlow: AuthCapturePaymentFlow;
  operatorType: Exclude<AuthCaptureOperatorType, "policy">;
  assetTransferMethod: AssetTransferMethod;
  authCaptureEscrow: `0x${string}`;
}

export interface AuthorizedPaymentUpdateResult {
  payment: AuthorizedPayment | undefined;
  status: "updated" | "unchanged" | "deleted";
}

export interface AuthorizedPaymentStorage {
  get(paymentInfoHash: string): Promise<AuthorizedPayment | undefined>;
  list(): Promise<AuthorizedPayment[]>;
  /**
   * Atomically inspects and mutates a payment record.
   *
   * Implementations must guarantee that no concurrent mutation can interleave
   * between reading `current` and writing the callback result for all
   * application instances that share the backend. The in-memory backend only
   * provides this guarantee inside one JS runtime; production multi-instance
   * deployments need storage with backend-level atomic conditional mutation.
   *
   * @param paymentInfoHash - Storage key = AuthCaptureEscrow.getHash(paymentInfo).
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored payment and whether storage updated, stayed unchanged, or deleted.
   */
  update(
    paymentInfoHash: string,
    update: (current: AuthorizedPayment | undefined) => AuthorizedPayment | undefined,
  ): Promise<AuthorizedPaymentUpdateResult>;
}

/**
 * Lowercase a paymentInfoHash so Map keys are case-insensitive.
 *
 * @param hash - Escrow payment identifier.
 * @returns Lowercase hash string.
 */
function normalizeHash(hash: string): string {
  return hash.toLowerCase();
}

/**
 * In-memory {@link AuthorizedPaymentStorage} backed by a Map keyed by paymentInfoHash.
 *
 * Atomicity is guaranteed only inside one JS runtime. Deferred captures are lost
 * on restart; the payer's protection in that case is `reclaim` after the capture
 * deadline.
 */
export class InMemoryAuthorizedPaymentStorage implements AuthorizedPaymentStorage {
  private readonly payments = new Map<string, AuthorizedPayment>();
  private readonly withLock = createKeyedLock();

  /**
   * Returns the payment record for a hash, if present.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @returns The payment record or undefined when not found.
   */
  async get(paymentInfoHash: string): Promise<AuthorizedPayment | undefined> {
    return this.payments.get(normalizeHash(paymentInfoHash));
  }

  /**
   * Lists all stored payment records.
   *
   * @returns All payment records in storage.
   */
  async list(): Promise<AuthorizedPayment[]> {
    return [...this.payments.values()];
  }

  /**
   * Atomically inspects and mutates a payment record while holding a per-key lock.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored payment and whether storage updated, stayed unchanged, or deleted.
   */
  async update(
    paymentInfoHash: string,
    update: (current: AuthorizedPayment | undefined) => AuthorizedPayment | undefined,
  ): Promise<AuthorizedPaymentUpdateResult> {
    const key = normalizeHash(paymentInfoHash);
    return this.withLock(key, async () => {
      const current = this.payments.get(key);
      const next = update(current);

      if (next === current) {
        return { payment: current, status: "unchanged" };
      }

      if (!next) {
        this.payments.delete(key);
        return { payment: undefined, status: current ? "deleted" : "unchanged" };
      }

      this.payments.set(key, next);
      return { payment: next, status: "updated" };
    });
  }
}

/**
 * Apply a successful capture to stored capturable/refundable balances.
 *
 * @param storage - Authorized-payment storage.
 * @param paymentInfoHash - Storage key.
 * @param amount - Captured atomic amount.
 * @param voidRemainder - When true, zero the remaining hold.
 * @returns Nothing.
 */
export async function applyCaptureBalances(
  storage: AuthorizedPaymentStorage,
  paymentInfoHash: string,
  amount: string,
  voidRemainder: boolean,
): Promise<void> {
  await storage.update(paymentInfoHash, current => {
    if (!current) return current;
    const captured = BigInt(amount);
    const capturable = BigInt(current.capturableAmount) - captured;
    const refundable = BigInt(current.refundableAmount) + captured;
    return {
      ...current,
      capturableAmount: voidRemainder ? "0" : capturable.toString(),
      refundableAmount: refundable.toString(),
    };
  });
}
