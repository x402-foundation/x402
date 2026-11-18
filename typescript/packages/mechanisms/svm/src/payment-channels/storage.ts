import type { Network } from "@x402/core/types";

/**
 * Stored payment-channel facts the facilitator reads back.
 *
 * Hosts keep tenant and audit columns in their own schema. Every field here
 * is something the SDK cannot recover onchain, except `tokenProgram`, which
 * is stored so cleanup can skip a mint-account read.
 */
export interface PaymentChannelRecord {
  /** CAIP-2 network. Part of the storage key. */
  network: Network;
  /** Channel PDA. Part of the storage key. */
  channelId: string;
  /** Distribution recipient sealed at open (`requirements.payTo`). */
  payTo: string;
  /** Token program that owns the mint. Cleanup distribute uses it directly. */
  tokenProgram: string;
  /**
   * Voucher expiry (Unix seconds). `0` for batch settlement. Moves forward
   * only. Upto treats a row at or past this instant as absent for delegated
   * claims.
   */
  expiresAt: number;
  /**
   * Wall-clock ms of the last open, activity, or discovery write. Drives the
   * batch idle clock and the cleanup grace for an open whose account is not
   * visible yet. Never moves backwards.
   */
  lastActivityAt: number;
  /**
   * Receiver authorizer from the batch open's binding memo. Empty for upto,
   * where that key is onchain.
   */
  receiverAuthorizer: string;
  /** Delegated-mode caller identity. Empty when the open was not delegated. */
  callerIdentity: string;
}

/**
 * Result of {@link PaymentChannelStorage.recordOpen}. `revertToken` is empty
 * when the row already existed, so a later revert leaves that row alone.
 */
export interface PaymentChannelOpenWrite {
  /** Row as stored after the write. */
  record: PaymentChannelRecord;
  /** Opaque host-defined token. Empty when this call did not create the row. */
  revertToken: string;
}

/** Pluggable storage shared by the upto and batch-settlement facilitators. */
export interface PaymentChannelStorage {
  /**
   * Insert the row when it is absent. An existing row keeps its open facts
   * (`payTo`, `tokenProgram`, `receiverAuthorizer`, `callerIdentity`);
   * `expiresAt` and `lastActivityAt` only move forward. Hosts may enforce
   * admission policy here.
   *
   * When an existing row's non-empty `callerIdentity` or `receiverAuthorizer`
   * differs from the requested non-empty value, `recordOpen` MUST leave the
   * row unchanged (no token rotation, no `expiresAt` or `lastActivityAt`
   * advance) and return the stored row with an empty `revertToken`. The SDK
   * then rejects the open through {@link checkOpenBindings}, and the creator's
   * `revertOpen` still matches. The comparison and the write MUST be one
   * atomic operation.
   *
   * The absent-row check and insert MUST be atomic under concurrent callers
   * (for example a unique key on `network` and `channelId` with
   * insert-on-conflict, or one transaction). A naive read-then-write allows
   * two opens on the same key to both insert and breaks first-writer-wins
   * binding checks.
   *
   * @param record - Open facts to store
   * @returns The stored row and a revert token when this call created it
   */
  recordOpen(record: PaymentChannelRecord): Promise<PaymentChannelOpenWrite>;
  /**
   * Delete the row only when `write.revertToken` is non-empty and still
   * matches. A later non-conflicting open rotates the token, so this becomes a
   * no-op.
   *
   * @param write - The {@link PaymentChannelStorage.recordOpen} result
   */
  revertOpen(write: PaymentChannelOpenWrite): Promise<void>;
  /**
   * Bump `lastActivityAt` for channels already verified onchain. A missing
   * row is inserted. Bindings and admission policy are left untouched, and
   * the write is never reverted.
   *
   * @param records - One record per channel the transaction touches
   */
  recordActivity(...records: PaymentChannelRecord[]): Promise<void>;
  /**
   * Read one row.
   *
   * @param network - CAIP-2 network
   * @param channelId - Channel PDA
   * @returns The stored row, or undefined when absent
   */
  get(network: Network, channelId: string): Promise<PaymentChannelRecord | undefined>;
  /**
   * Every row on `network`, in any order. Rent cleanup sorts before scanning.
   *
   * @param network - CAIP-2 network
   * @returns Stored rows for that network
   */
  list(network: Network): Promise<PaymentChannelRecord[]>;
  /**
   * Remove a row. Used after the channel account is gone.
   *
   * @param network - CAIP-2 network
   * @param channelId - Channel PDA
   */
  delete(network: Network, channelId: string): Promise<void>;
}

/** Reported when a revert fails. Must not replace the settle error. */
export type OnStorageError = (error: unknown, network: string, channelId: string) => void;

/** First writer already bound this channel to a different receiver authorizer. */
export class ReceiverAuthorizerConflictError extends Error {
  /** Create the first-writer-wins binding conflict. */
  constructor() {
    super("receiver authorizer binding already exists for a different key");
    this.name = "ReceiverAuthorizerConflictError";
  }
}

/** First writer already bound this channel to a different caller identity. */
export class CallerIdentityConflictError extends Error {
  /** Create the first-writer-wins identity conflict. */
  constructor() {
    super("delegated auth binding already exists for a different identity");
    this.name = "CallerIdentityConflictError";
  }
}

/**
 * Compare the non-empty requested bindings to the row {@link PaymentChannelStorage.recordOpen}
 * stored. A created row carries the requested bindings, so a conflict means
 * the row already existed and there is nothing to revert.
 *
 * @param requested - Bindings this open asked to store
 * @param stored - Row returned by `recordOpen`
 */
export function checkOpenBindings(
  requested: PaymentChannelRecord,
  stored: PaymentChannelRecord,
): void {
  const conflict = openBindingConflict(requested, stored);
  if (conflict) throw conflict;
}

/**
 * Find the binding conflict between a requested open and the stored row.
 * Empty bindings on either side never conflict.
 *
 * @param requested - Bindings this open asked to store
 * @param stored - Row already stored
 * @returns The conflict error, or undefined when the open is compatible
 */
function openBindingConflict(
  requested: PaymentChannelRecord,
  stored: PaymentChannelRecord,
): ReceiverAuthorizerConflictError | CallerIdentityConflictError | undefined {
  if (
    requested.receiverAuthorizer !== "" &&
    stored.receiverAuthorizer !== "" &&
    stored.receiverAuthorizer !== requested.receiverAuthorizer
  ) {
    return new ReceiverAuthorizerConflictError();
  }
  if (
    requested.callerIdentity !== "" &&
    stored.callerIdentity !== "" &&
    stored.callerIdentity !== requested.callerIdentity
  ) {
    return new CallerIdentityConflictError();
  }
  return undefined;
}

/**
 * Reject a value that does not implement {@link PaymentChannelStorage}.
 *
 * @param storage - Configured channel storage
 */
export function assertPaymentChannelStorage(
  storage: object,
): asserts storage is PaymentChannelStorage {
  const candidate = storage as Partial<PaymentChannelStorage>;
  if (
    typeof candidate.recordOpen !== "function" ||
    typeof candidate.revertOpen !== "function" ||
    typeof candidate.recordActivity !== "function" ||
    typeof candidate.get !== "function" ||
    typeof candidate.list !== "function" ||
    typeof candidate.delete !== "function"
  ) {
    throw new Error(
      "channelStorage must implement recordOpen, revertOpen, recordActivity, get, list, and delete",
    );
  }
}

/** How the broadcast of an open ended, for the write-then-broadcast helper. */
export type OpenBroadcastDisposition = "keep" | "revert";

/**
 * Record the channels a transaction depends on, then run `broadcast`.
 *
 * The write is fail-closed: a storage error rejects before `broadcast`. An
 * open is reverted when `broadcast` returns `revert`, or throws before
 * `reserved` is called. Activity is kept either way. A revert error is
 * reported through `onStorageError` and never replaces the broadcast error.
 *
 * @param args - Storage, the records, and the broadcast
 * @param args.storage - Channel storage
 * @param args.kind - `open` reverts on a definitive failure; `activity` does not
 * @param args.records - One record for an open, or each channel an activity transaction touches
 * @param args.onStorageError - Called when reverting an open fails
 * @param args.broadcast - Sends or reconciles. Call `reserved` once this attempt holds the broadcast reservation or is following the winner
 * @returns Whatever `broadcast` returned
 */
export async function writeThenBroadcast<T>(args: {
  storage: PaymentChannelStorage;
  kind: "open" | "activity";
  records: readonly PaymentChannelRecord[];
  onStorageError?: OnStorageError | undefined;
  broadcast: (reserved: () => void) => Promise<{ value: T; disposition: OpenBroadcastDisposition }>;
}): Promise<T> {
  switch (args.kind) {
    case "open":
      return writeOpenThenBroadcast({
        broadcast: args.broadcast,
        onStorageError: args.onStorageError,
        records: args.records,
        storage: args.storage,
      });
    case "activity":
      await args.storage.recordActivity(...args.records);
      return (await args.broadcast(() => undefined)).value;
    default: {
      const exhaustive: never = args.kind;
      throw new Error(`unexpected channel write kind ${String(exhaustive)}`);
    }
  }
}

/**
 * Report a revert failure without letting it replace the settle error.
 *
 * @param onStorageError - Facilitator hook, when configured
 * @param error - Revert error
 * @param network - CAIP-2 network
 * @param channelId - Channel PDA
 */
export function reportStorageError(
  onStorageError: OnStorageError | undefined,
  error: unknown,
  network: string,
  channelId: string,
): void {
  if (onStorageError) {
    onStorageError(error, network, channelId);
    return;
  }
  console.warn("[x402] svm: channel storage revert failed", { channelId, error, network });
}

/**
 * In-memory {@link PaymentChannelStorage}. A per-row counter is the revert
 * token: a non-conflicting {@link InMemoryPaymentChannelStorage.recordOpen} on
 * an existing row rotates it and returns an empty token, so the creator's
 * revert no longer matches. A conflicting open leaves the row and token
 * untouched.
 */
export class InMemoryPaymentChannelStorage implements PaymentChannelStorage {
  private readonly channels = new Map<
    string,
    { record: PaymentChannelRecord; revertToken: string }
  >();
  private nextToken = 0;

  /** @inheritdoc */
  async recordOpen(record: PaymentChannelRecord): Promise<PaymentChannelOpenWrite> {
    const key = channelKey(record.network, record.channelId);
    const existing = this.channels.get(key);
    if (existing && openBindingConflict(record, existing.record)) {
      return { record: { ...existing.record }, revertToken: "" };
    }
    const revertToken = String(++this.nextToken);
    if (!existing) {
      const stored = { ...record };
      this.channels.set(key, { record: stored, revertToken });
      return { record: { ...stored }, revertToken };
    }
    const stored = forwardOnly(existing.record, record);
    this.channels.set(key, { record: stored, revertToken });
    return { record: { ...stored }, revertToken: "" };
  }

  /** @inheritdoc */
  async revertOpen(write: PaymentChannelOpenWrite): Promise<void> {
    if (write.revertToken === "") return;
    const key = channelKey(write.record.network, write.record.channelId);
    const existing = this.channels.get(key);
    if (!existing || existing.revertToken !== write.revertToken) return;
    this.channels.delete(key);
  }

  /** @inheritdoc */
  async recordActivity(...records: PaymentChannelRecord[]): Promise<void> {
    for (const record of records) {
      const key = channelKey(record.network, record.channelId);
      const existing = this.channels.get(key);
      if (!existing) {
        this.channels.set(key, { record: { ...record }, revertToken: "" });
        continue;
      }
      existing.record = {
        ...existing.record,
        lastActivityAt: Math.max(existing.record.lastActivityAt, record.lastActivityAt),
      };
    }
  }

  /** @inheritdoc */
  async get(network: Network, channelId: string): Promise<PaymentChannelRecord | undefined> {
    const existing = this.channels.get(channelKey(network, channelId));
    return existing ? { ...existing.record } : undefined;
  }

  /** @inheritdoc */
  async list(network: Network): Promise<PaymentChannelRecord[]> {
    const records: PaymentChannelRecord[] = [];
    for (const row of this.channels.values()) {
      if (row.record.network === network) records.push({ ...row.record });
    }
    return records;
  }

  /** @inheritdoc */
  async delete(network: Network, channelId: string): Promise<void> {
    this.channels.delete(channelKey(network, channelId));
  }
}

/**
 * Keep the stored open facts. Expiry and activity only move forward.
 *
 * @param existing - Row already stored
 * @param incoming - Facts from this open
 * @returns The row to keep
 */
function forwardOnly(
  existing: PaymentChannelRecord,
  incoming: PaymentChannelRecord,
): PaymentChannelRecord {
  return {
    ...existing,
    expiresAt: Math.max(existing.expiresAt, incoming.expiresAt),
    lastActivityAt: Math.max(existing.lastActivityAt, incoming.lastActivityAt),
  };
}

/**
 * Composite key so the same PDA on two networks cannot collide.
 *
 * @param network - CAIP-2 network
 * @param channelId - Channel PDA
 * @returns Map key
 */
function channelKey(network: string, channelId: string): string {
  return `${network}\0${channelId}`;
}

/**
 * Open half of {@link writeThenBroadcast}.
 *
 * @param args - Same arguments as {@link writeThenBroadcast} for an open
 * @param args.storage - Channel storage
 * @param args.records - The single open record
 * @param args.onStorageError - Facilitator hook, when configured
 * @param args.broadcast - Sends or reconciles the open
 * @returns The broadcast value
 */
async function writeOpenThenBroadcast<T>(args: {
  storage: PaymentChannelStorage;
  records: readonly PaymentChannelRecord[];
  onStorageError?: OnStorageError | undefined;
  broadcast: (reserved: () => void) => Promise<{ value: T; disposition: OpenBroadcastDisposition }>;
}): Promise<T> {
  const requested = args.records[0];
  if (!requested || args.records.length !== 1) {
    throw new Error("an open records exactly one channel");
  }
  const write = await args.storage.recordOpen(requested);
  checkOpenBindings(requested, write.record);
  let reserved = false;
  try {
    const outcome = await args.broadcast(() => {
      reserved = true;
    });
    if (outcome.disposition === "revert") await revertOpenBestEffort(args, write);
    return outcome.value;
  } catch (error) {
    if (!reserved) await revertOpenBestEffort(args, write);
    throw error;
  }
}

/**
 * Revert a created open. Failures are reported and swallowed.
 *
 * @param args - Storage and the error hook
 * @param args.storage - Channel storage
 * @param args.onStorageError - Facilitator hook, when configured
 * @param write - Open write to revert
 */
async function revertOpenBestEffort(
  args: { storage: PaymentChannelStorage; onStorageError?: OnStorageError | undefined },
  write: PaymentChannelOpenWrite,
): Promise<void> {
  try {
    await args.storage.revertOpen(write);
  } catch (error) {
    reportStorageError(args.onStorageError, error, write.record.network, write.record.channelId);
  }
}
