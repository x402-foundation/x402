/**
 * Facilitator-delegated receiver authorizer: caller-identity binding.
 *
 * When the facilitator holds the `receiverAuthorizer` key, the `authorizerSignature` it
 * produces is no longer evidence of the server's intent, so the request is authenticated
 * out of band instead. The first authenticated caller to settle a payment is bound to its
 * `paymentInfoHash`; every later facilitator-signed step must come from the same identity.
 * The binding is written after re-verify and before broadcast, and fails closed.
 */

import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";
import { isAddressEqual } from "viem";
import type { AuthCaptureFacilitatorConfig, AuthorizerSigner } from "../types";

export type DelegatedStep = "authorize" | "charge" | "capture" | "void" | "refund";

/** Context passed to {@link AuthCaptureFacilitatorConfig.resolveCallerIdentity}. */
export type DelegatedSettleContext = {
  step: DelegatedStep;
  paymentInfoHash: `0x${string}`;
  network: Network;
  payer: string;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  facilitatorContext?: FacilitatorContext;
};

/** Caller binding for one payment. */
export interface AuthCaptureDelegatedAuthRecord {
  network: Network;
  paymentInfoHash: `0x${string}`;
  /** Stable identity returned by `resolveCallerIdentity`. */
  callerIdentity: string;
  /** Unix seconds (`refundDeadline`). An expired row is treated as absent. */
  expiresAt: number;
}

/**
 * Result of {@link AuthCaptureDelegatedAuthStorage.bind}. `revertToken` is empty when the
 * row already existed, so a later revert leaves that row alone.
 */
export interface AuthCaptureDelegatedAuthWrite {
  /** Row as stored after the write. */
  record: AuthCaptureDelegatedAuthRecord;
  /** Opaque host-defined token. Empty when this call did not create the row. */
  revertToken: string;
}

/** Pluggable storage for facilitator-delegated caller bindings. */
export interface AuthCaptureDelegatedAuthStorage {
  /**
   * Insert the row when it is absent (an expired row counts as absent). The check and the
   * insert MUST be one atomic operation under concurrent callers, for example a unique key
   * on `network` and `paymentInfoHash` with insert-on-conflict.
   *
   * When a live row exists, leave its `callerIdentity` and `expiresAt` untouched and return
   * it with an empty `revertToken`. A different identity is rejected by the SDK through
   * {@link bindThenBroadcast}. A matching identity is an idempotent success; hosts SHOULD
   * rotate the stored token so a concurrent creator's revert no longer matches.
   *
   * @param record - Binding to store
   * @returns The stored row and a revert token when this call created it
   */
  bind(record: AuthCaptureDelegatedAuthRecord): Promise<AuthCaptureDelegatedAuthWrite>;
  /**
   * Delete the row only when `write.revertToken` is non-empty and still matches.
   *
   * @param write - The {@link AuthCaptureDelegatedAuthStorage.bind} result
   */
  revertBind(write: AuthCaptureDelegatedAuthWrite): Promise<void>;
  /**
   * Read one live row.
   *
   * @param network - CAIP-2 network
   * @param paymentInfoHash - Escrow payment identifier
   * @returns The stored row, or undefined when absent or expired
   */
  get(
    network: Network,
    paymentInfoHash: `0x${string}`,
  ): Promise<AuthCaptureDelegatedAuthRecord | undefined>;
  /**
   * Remove a row. Hosts SHOULD also purge expired rows (for example a TTL index on `expiresAt`).
   *
   * @param network - CAIP-2 network
   * @param paymentInfoHash - Escrow payment identifier
   */
  delete(network: Network, paymentInfoHash: `0x${string}`): Promise<void>;
}

/** Reported when a binding revert or early delete fails. Must not replace the settle result. */
export type OnDelegatedAuthStorageError = (
  error: unknown,
  network: string,
  paymentInfoHash: string,
) => void;

/** First writer already bound this payment to a different caller identity. */
export class AuthCaptureCallerIdentityConflictError extends Error {
  /** Create the first-writer-wins identity conflict. */
  constructor() {
    super("delegated auth binding already exists for a different identity");
    this.name = "AuthCaptureCallerIdentityConflictError";
  }
}

/** Resolved delegated-authorizer wiring for one request. */
export type DelegatedAuthorizer = {
  signer: AuthorizerSigner;
  resolveCallerIdentity: NonNullable<AuthCaptureFacilitatorConfig["resolveCallerIdentity"]>;
  storage: AuthCaptureDelegatedAuthStorage;
  onStorageError: OnDelegatedAuthStorageError;
};

/**
 * The delegated authorizer, when `receiverAuthorizer` is the key this facilitator holds.
 *
 * @param config - Facilitator config with delegation fully wired
 * @param receiverAuthorizer - `extra.receiverAuthorizer`
 * @returns The wiring, or undefined when the authorizer is not facilitator-delegated
 */
export function getDelegatedAuthorizer(
  config: AuthCaptureFacilitatorConfig | undefined,
  receiverAuthorizer: `0x${string}`,
): DelegatedAuthorizer | undefined {
  const signer = config?.authorizerSigner;
  const resolveCallerIdentity = config?.resolveCallerIdentity;
  const storage = config?.delegatedAuthStorage;
  const onStorageError = config?.onStorageError;
  if (!signer || !resolveCallerIdentity || !storage || !onStorageError) return undefined;
  if (!isAddressEqual(signer.address, receiverAuthorizer)) return undefined;
  return { signer, resolveCallerIdentity, storage, onStorageError };
}

/**
 * Resolve a delegated settle's caller identity. Throws and empty results are treated as
 * unauthenticated.
 *
 * @param delegated - Delegated-authorizer wiring
 * @param ctx - Settle context passed to the operator resolver
 * @returns Stable identity, or undefined when the caller is unauthenticated
 */
export async function resolveDelegatedCallerIdentity(
  delegated: DelegatedAuthorizer,
  ctx: DelegatedSettleContext,
): Promise<string | undefined> {
  try {
    const identity = await delegated.resolveCallerIdentity(ctx);
    return typeof identity === "string" && identity.length > 0 ? identity : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Report a storage failure that must not replace the settle result.
 *
 * @param delegated - Delegated-authorizer wiring
 * @param error - Storage error
 * @param network - CAIP-2 network
 * @param paymentInfoHash - Escrow payment identifier
 */
export function reportDelegatedStorageError(
  delegated: DelegatedAuthorizer,
  error: unknown,
  network: string,
  paymentInfoHash: string,
): void {
  delegated.onStorageError(error, network, paymentInfoHash);
}

/** How a broadcast ended, for {@link bindThenBroadcast}. */
export type BindDisposition = "keep" | "revert";

export type BindThenBroadcastResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "conflict" | "unavailable"; error: unknown };

/**
 * Bind the caller to the payment, then run `broadcast`.
 *
 * The bind is fail-closed: a storage error or an identity conflict returns without calling
 * `broadcast`. A binding this call created is reverted when `broadcast` returns `revert`;
 * `keep` leaves it, as does a thrown `broadcast` error because the outcome is then unknown.
 * A revert error goes to `onStorageError` and never replaces the broadcast result.
 *
 * @param args - Delegated wiring, the record to bind, and the broadcast
 * @param args.delegated - Delegated-authorizer wiring
 * @param args.record - Binding to write before broadcast
 * @param args.broadcast - Sends or reconciles the transaction
 * @returns The broadcast value, or the reason the bind failed closed
 */
export async function bindThenBroadcast<T>(args: {
  delegated: DelegatedAuthorizer;
  record: AuthCaptureDelegatedAuthRecord;
  broadcast: () => Promise<{ value: T; disposition: BindDisposition }>;
}): Promise<BindThenBroadcastResult<T>> {
  const { delegated, record } = args;
  let write: AuthCaptureDelegatedAuthWrite;
  try {
    write = await delegated.storage.bind(record);
  } catch (error) {
    return { ok: false, reason: "unavailable", error };
  }
  if (write.record.callerIdentity !== record.callerIdentity) {
    return { ok: false, reason: "conflict", error: new AuthCaptureCallerIdentityConflictError() };
  }

  const outcome = await args.broadcast();
  if (outcome.disposition === "revert") {
    try {
      await delegated.storage.revertBind(write);
    } catch (error) {
      reportDelegatedStorageError(delegated, error, record.network, record.paymentInfoHash);
    }
  }
  return { ok: true, value: outcome.value };
}

/**
 * Reject a value that does not implement {@link AuthCaptureDelegatedAuthStorage}.
 *
 * @param storage - Configured delegated-auth storage
 */
export function assertDelegatedAuthStorage(
  storage: object,
): asserts storage is AuthCaptureDelegatedAuthStorage {
  const candidate = storage as Partial<AuthCaptureDelegatedAuthStorage>;
  if (
    typeof candidate.bind !== "function" ||
    typeof candidate.revertBind !== "function" ||
    typeof candidate.get !== "function" ||
    typeof candidate.delete !== "function"
  ) {
    throw new Error("delegatedAuthStorage must implement bind, revertBind, get, and delete");
  }
}

/**
 * In-memory {@link AuthCaptureDelegatedAuthStorage}. A per-row counter is the revert token:
 * a matching-identity bind on a live row rotates it and returns an empty token, so the
 * creator's revert no longer matches. Expired rows are purged lazily on `bind` and `get`.
 * Bindings are lost on restart, which fails closed.
 */
export class InMemoryAuthCaptureDelegatedAuthStorage implements AuthCaptureDelegatedAuthStorage {
  private readonly rows = new Map<
    string,
    { record: AuthCaptureDelegatedAuthRecord; revertToken: string }
  >();
  private nextToken = 0;

  /** @inheritdoc */
  async bind(record: AuthCaptureDelegatedAuthRecord): Promise<AuthCaptureDelegatedAuthWrite> {
    this.purgeExpired();
    const key = rowKey(record.network, record.paymentInfoHash);
    const existing = this.rows.get(key);
    const revertToken = String(++this.nextToken);
    if (!existing) {
      this.rows.set(key, { record: { ...record }, revertToken });
      return { record: { ...record }, revertToken };
    }
    if (existing.record.callerIdentity === record.callerIdentity) {
      existing.revertToken = revertToken;
    }
    return { record: { ...existing.record }, revertToken: "" };
  }

  /** @inheritdoc */
  async revertBind(write: AuthCaptureDelegatedAuthWrite): Promise<void> {
    if (write.revertToken === "") return;
    const key = rowKey(write.record.network, write.record.paymentInfoHash);
    if (this.rows.get(key)?.revertToken !== write.revertToken) return;
    this.rows.delete(key);
  }

  /** @inheritdoc */
  async get(
    network: Network,
    paymentInfoHash: `0x${string}`,
  ): Promise<AuthCaptureDelegatedAuthRecord | undefined> {
    const key = rowKey(network, paymentInfoHash);
    const existing = this.rows.get(key);
    if (!existing) return undefined;
    if (isExpired(existing.record)) {
      this.rows.delete(key);
      return undefined;
    }
    return { ...existing.record };
  }

  /** @inheritdoc */
  async delete(network: Network, paymentInfoHash: `0x${string}`): Promise<void> {
    this.rows.delete(rowKey(network, paymentInfoHash));
  }

  /** Drop every expired row. */
  private purgeExpired(): void {
    for (const [key, row] of this.rows) {
      if (isExpired(row.record)) this.rows.delete(key);
    }
  }
}

/**
 * Whether a binding is past `expiresAt`.
 *
 * @param record - Stored binding
 * @returns True when the binding no longer authorizes anything
 */
function isExpired(record: AuthCaptureDelegatedAuthRecord): boolean {
  return record.expiresAt <= Math.floor(Date.now() / 1000);
}

/**
 * Composite key so the same hash on two networks cannot collide.
 *
 * @param network - CAIP-2 network
 * @param paymentInfoHash - Escrow payment identifier
 * @returns Map key
 */
function rowKey(network: string, paymentInfoHash: string): string {
  return `${network}\0${paymentInfoHash.toLowerCase()}`;
}
