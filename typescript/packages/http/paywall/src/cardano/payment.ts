/**
 * Payment state machine for the Cardano paywall page.
 *
 * Funds invariant: every transaction signed for one payment record spends
 * the same pinned nonce UTxO, so at most one of them can ever land. The
 * classifier and limits below only decide between "resend the identical
 * header" and "re-sign", and are tuned for UX; they never need to be perfect
 * for funds to be safe.
 */
import {
  ERR_AMOUNT_INSUFFICIENT,
  ERR_ASSET_MISMATCH,
  ERR_CHAIN_LOOKUP_FAILED,
  ERR_EVIDENCE_UNAVAILABLE,
  ERR_FEE_BELOW_MINIMUM,
  ERR_INPUT_NOT_AVAILABLE,
  ERR_INPUT_VALUE_UNAVAILABLE,
  ERR_INVALID_PAYLOAD,
  ERR_INVALID_SIGNATURE,
  ERR_MIN_UTXO_INSUFFICIENT,
  ERR_NETWORK_ID_MISMATCH,
  ERR_NETWORK_MISMATCH,
  ERR_NONCE_INVALID,
  ERR_NONCE_NOT_IN_INPUTS,
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_POLICY_INVALID,
  ERR_RECIPIENT_MISMATCH,
  ERR_REQUIREMENTS_INVALID,
  ERR_SETTLEMENT_PENDING,
  ERR_TRANSACTION_DECODE_FAILED,
  ERR_TRANSACTION_PHASE1_INVALID,
  ERR_TRANSACTION_PHASE2_INVALID,
  ERR_TRANSACTION_UNSIGNED,
  ERR_TTL_EXPIRED,
  ERR_TTL_TOO_FAR,
  ERR_UNSUPPORTED_SCHEME,
  ERR_VALIDITY_NOT_YET_VALID,
  ERR_VALUE_NOT_CONSERVED,
} from "@x402/cardano";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

import { signerErrorCode } from "./messages";
import { canonicalCardanoNetwork } from "./protocolParams";

/** Outcome classes for a paid request. */
export type ResponseClass =
  | "SUCCESS"
  | "STATIC"
  | "STATE"
  | "TRANSIENT"
  | "REQS_CHANGED"
  | "CONFIG"
  | "AMBIGUOUS";

/** Verify-phase reasons that depend only on the payment bytes (never broadcast). */
export const STATIC_REASONS: ReadonlySet<string> = new Set([
  ERR_INVALID_PAYLOAD,
  `${ERR_INVALID_PAYLOAD}_unsupported_version`,
  ERR_UNSUPPORTED_SCHEME,
  ERR_NETWORK_MISMATCH,
  ERR_REQUIREMENTS_INVALID,
  ERR_POLICY_INVALID,
  ERR_TRANSACTION_DECODE_FAILED,
  ERR_NETWORK_ID_MISMATCH,
  ERR_TRANSACTION_UNSIGNED,
  ERR_INVALID_SIGNATURE,
  ERR_NONCE_INVALID,
  ERR_NONCE_NOT_IN_INPUTS,
  ERR_TRANSACTION_PHASE2_INVALID,
  ERR_RECIPIENT_MISMATCH,
  ERR_ASSET_MISMATCH,
  ERR_AMOUNT_INSUFFICIENT,
  ERR_MIN_UTXO_INSUFFICIENT,
  ERR_FEE_BELOW_MINIMUM,
  ERR_VALUE_NOT_CONSERVED,
  ERR_TTL_TOO_FAR,
  ERR_VALIDITY_NOT_YET_VALID,
]);

/** Verify-phase reasons where this request did not broadcast, but an earlier one may have landed. */
export const STATE_REASONS: ReadonlySet<string> = new Set([
  ERR_TTL_EXPIRED,
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_INPUT_NOT_AVAILABLE,
  ERR_TRANSACTION_PHASE1_INVALID,
]);

/** Verify-phase lookups that failed transiently. */
export const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  ERR_CHAIN_LOOKUP_FAILED,
  ERR_INPUT_VALUE_UNAVAILABLE,
]);

/** The merchant's facilitator cannot settle at all. */
export const CONFIG_REASONS: ReadonlySet<string> = new Set([ERR_EVIDENCE_UNAVAILABLE]);

/** Every response class (record validation). */
const RESPONSE_CLASSES: ReadonlySet<string> = new Set([
  "SUCCESS",
  "STATIC",
  "STATE",
  "TRANSIENT",
  "REQS_CHANGED",
  "CONFIG",
  "AMBIGUOUS",
]);

/** Classes that prove nothing was broadcast for the last attempt. */
const DEFINITE_REJECTIONS: ReadonlySet<ResponseClass> = new Set([
  "STATIC",
  "STATE",
  "REQS_CHANGED",
  "CONFIG",
]);

/** Core's reason when the payload's accepted requirement no longer matches. */
export const REQS_CHANGED_REASON = "No matching payment requirements";

/** At most this many sends of one signed header. */
export const MAX_SENDS_PER_HEADER = 5;
/** Minimum time between two sends of the same header. */
export const MIN_SEND_INTERVAL_MS = 10_000;
/** At most this many signatures per payment record. */
export const MAX_SIGNS_PER_RECORD = 3;
/** After a possible broadcast, no re-sign until the TTL plus this much has passed. */
export const RESIGN_LOCKOUT_AFTER_TTL_MS = 300_000;
/** Records are kept at most this long after their TTL. */
export const RECORD_RETENTION_AFTER_TTL_MS = 24 * 60 * 60_000;
/** Required validity left before (re)sending a never-sent header. */
export const MIN_REMAINING_TO_SEND_MS = 90_000;

/** Minimal response shape the classifier reads. */
export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
}

/** Classification result. */
export interface ClassifiedResponse {
  cls: ResponseClass;
  reason?: string;
}

/**
 * Classifies the server's answer to a paid request. Anything not provably
 * pre-broadcast is AMBIGUOUS. The transaction id in `PAYMENT-RESPONSE` is
 * ignored: the page shows the id of the transaction its wallet signed.
 *
 * @param response - The response, or undefined when fetch failed.
 * @returns Its class and reason.
 */
export function classifyPaymentResponse(response: ResponseLike | undefined): ClassifiedResponse {
  if (!response) return { cls: "AMBIGUOUS", reason: "network_error" };
  const settleHeader = response.headers.get("PAYMENT-RESPONSE");
  let settle: { errorReason?: string } | undefined;
  if (settleHeader) {
    try {
      settle = decodePaymentResponseHeader(settleHeader);
    } catch {
      settle = {};
    }
  }
  if (response.status >= 200 && response.status < 300) return { cls: "SUCCESS" };
  if (settleHeader) return { cls: "AMBIGUOUS", reason: settle?.errorReason };
  if (response.status !== 402) return { cls: "AMBIGUOUS", reason: `http_${response.status}` };
  const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) return { cls: "AMBIGUOUS", reason: "bare_402" };
  let reason: unknown;
  try {
    reason = decodePaymentRequiredHeader(requiredHeader).error;
  } catch {
    return { cls: "AMBIGUOUS", reason: "undecodable_402" };
  }
  if (typeof reason !== "string") return { cls: "AMBIGUOUS", reason: "unknown" };
  if (STATIC_REASONS.has(reason)) return { cls: "STATIC", reason };
  if (STATE_REASONS.has(reason)) return { cls: "STATE", reason };
  if (TRANSIENT_REASONS.has(reason)) return { cls: "TRANSIENT", reason };
  if (CONFIG_REASONS.has(reason)) return { cls: "CONFIG", reason };
  if (reason === REQS_CHANGED_REASON) return { cls: "REQS_CHANGED", reason };
  return { cls: "AMBIGUOUS", reason };
}

/** Storage the record lives in (`localStorage` in browsers). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Persisted state of one payment. */
export interface PaymentRecord {
  v: 1;
  /** Bumped on every write (diagnostics; exclusivity comes from the lock). */
  version: number;
  /** Pinned nonce; set at first signature and never changed. */
  nonce: string;
  /** Current signed `PAYMENT-SIGNATURE`, cleared after a definite rejection. */
  header?: string;
  txId?: string;
  ttlMs: number;
  requirement: PaymentRequirements;
  /** Sends of the current header. */
  sendCount: number;
  /** Sends of any header for this record. */
  totalSends: number;
  signCount: number;
  lastSentAtMs?: number;
  possiblyBroadcast: boolean;
  reqsReloaded: boolean;
  /** True while every answer so far was a verify-phase answer. */
  verifyOnlyRejections: boolean;
  lastClass?: ResponseClass;
  lastReason?: string;
  expiresAt: number;
  /**
   * The server confirmed this payment. Sticky: no later answer (and no
   * write-ahead) clears it; only completeDelivery() or an acknowledged
   * discard removes the record. A settled record is never signed again.
   */
  settled?: boolean;
  /** The one extra "Check again" past the send cap has been used. */
  postCapCheckUsed?: boolean;
}

/**
 * Storage key of a payment record: resource and canonical network only (a
 * CIP-34 alias and its `cardano:*` id share one record). Amount, payee
 * and asset are left out on purpose, so a changed price, payee or asset still
 * finds the pinned nonce of an unresolved earlier payment instead of starting
 * a second one.
 *
 * @param resourceUrl - Protected resource URL.
 * @param requirement - Selected requirement.
 * @returns Key.
 */
export function paymentRecordKey(resourceUrl: string, requirement: PaymentRequirements): string {
  const network = canonicalCardanoNetwork(requirement.network) ?? requirement.network.toLowerCase();
  return ["x402.cardano.v1", resourceUrl, network]
    .map(part => part.replace(/\|/g, "%7C"))
    .join("|");
}

/**
 * Runs `fn` exclusively for `name` across every tab of the origin. Signing
 * requires a real cross-tab lock (Web Locks); there is no storage-based
 * fallback because it cannot be made atomic.
 */
export type LockRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Returns a cross-tab lock using the Web Locks API, if the browser has it.
 *
 * @param nav - The navigator object.
 * @returns Lock runner, or undefined.
 */
export function webLocksRunner(nav: unknown): LockRunner | undefined {
  const locks = (nav as { locks?: { request?: unknown } } | undefined)?.locks;
  if (!locks || typeof locks.request !== "function") return undefined;
  const request = locks.request.bind(locks) as (
    name: string,
    fn: () => Promise<unknown>,
  ) => Promise<unknown>;
  return <T>(name: string, fn: () => Promise<T>) => request(name, fn) as Promise<T>;
}

/** A signed payment, as produced by the page's signer. */
export interface SignedPayment {
  header: string;
  nonce: string;
  txId: string;
  ttlMs: number;
}

/** What the page shows next. */
export type PaymentView =
  | { kind: "ready" }
  | { kind: "success"; response: Response }
  | { kind: "rejected"; reason?: string }
  | { kind: "wrong_network"; reason?: string }
  | { kind: "retry"; reason?: string }
  | { kind: "ambiguous"; reason?: string; txId?: string; autoRetry: boolean; retryAtMs: number }
  | {
      kind: "unresolved";
      txId?: string;
      unlockAtMs: number;
      unlocked: boolean;
      /** Whether a sent payment is stored that "Check again" can resend. */
      canCheckAgain: boolean;
    }
  | { kind: "reload" }
  /** Another tab completed and delivered this payment after this page loaded. */
  | { kind: "paid_elsewhere" }
  /** The server confirmed payment; content may not have been delivered yet. */
  | { kind: "settled"; txId?: string }
  | {
      kind: "terminal";
      reason:
        | "too_many_attempts"
        | "merchant_misconfigured"
        | "storage_unavailable"
        | "no_cross_tab_lock"
        | "record_unreadable";
      /** An earlier attempt of this payment may have been broadcast. */
      possiblyPaid?: boolean;
      txId?: string;
    };

/** Dependencies of {@link PaymentController}. */
export interface PaymentControllerDeps {
  resourceUrl: string;
  requirement: PaymentRequirements;
  storage: StorageLike;
  clock: { now(): number };
  /** Sends the paid request; resolves undefined on network failure. */
  send: (header: string) => Promise<Response | undefined>;
  /** Signs a payment, spending `pinnedNonce` when given. */
  sign: (pinnedNonce: string | undefined) => Promise<SignedPayment>;
  /** Cross-tab lock (Web Locks). Without one the controller refuses to pay. */
  lock?: LockRunner;
}

/**
 * Drives one payment record: decides whether a click resends the stored
 * header or signs again with the pinned nonce, persists every step before it
 * happens, and maps server answers to page states.
 */
export class PaymentController {
  readonly key: string;
  private readonly deliveredKey: string;
  /**
   * The delivery marker this tab already knows about: the one present when
   * the page loaded (create the controller at load), or the one it wrote.
   */
  private markerAtLoad: string | null;
  /** A delivery marker this tab's user explicitly chose to buy again after. */
  private acknowledgedMarker?: string;
  private readonly lock?: LockRunner;
  private readonly storageOk: boolean;

  /**
   * Creates a controller.
   *
   * @param deps - Storage, clock, network and signing functions.
   */
  constructor(private readonly deps: PaymentControllerDeps) {
    this.key = paymentRecordKey(deps.resourceUrl, deps.requirement);
    this.deliveredKey = `${this.key}|delivered`;
    this.lock = deps.lock;
    this.storageOk = probeStorage(deps.storage);
    let marker: string | null = null;
    try {
      marker = deps.storage.getItem(this.deliveredKey);
    } catch {
      marker = null; // storageOk is false; the controller refuses to pay anyway.
    }
    this.markerAtLoad = marker;
  }

  /**
   * Reads the stored record (dropping an expired one).
   *
   * @returns The record, if any.
   */
  load(): PaymentRecord | undefined {
    const raw = this.deps.storage.getItem(this.key);
    if (!raw) return undefined;
    const record = parseRecord(raw);
    // Unreadable records are surfaced by unreadable(); callers never treat
    // them as "no record".
    if (!record) return undefined;
    // Only a record that never left the page may expire, and only when both
    // the server-anchored clock and the device clock agree. Anything sent or
    // settled stays until delivery is confirmed or the user discards it.
    if (
      !record.settled &&
      record.totalSends === 0 &&
      Math.min(this.deps.clock.now(), Date.now()) > record.expiresAt
    ) {
      this.deps.storage.removeItem(this.key);
      return undefined;
    }
    return record;
  }

  /**
   * The view for a freshly loaded page.
   *
   * @returns Current view.
   */
  view(): PaymentView {
    const blocked = this.blocked();
    if (blocked) return blocked;
    const record = this.load();
    if (!record) {
      return this.deliveredSinceLoad() !== undefined
        ? { kind: "paid_elsewhere" }
        : { kind: "ready" };
    }
    if (record.settled) return { kind: "settled", txId: record.txId };
    if (record.lastClass === "CONFIG") return this.misconfigured(record);
    if (record.header && record.sendCount > 0) {
      if (record.sendCount >= MAX_SENDS_PER_HEADER || this.deps.clock.now() >= unlockAt(record)) {
        return this.unresolved(record);
      }
      return {
        kind: "ambiguous",
        reason: record.lastReason,
        txId: record.txId,
        autoRetry: false,
        retryAtMs: (record.lastSentAtMs ?? 0) + MIN_SEND_INTERVAL_MS,
      };
    }
    if (!record.header && record.lastClass) {
      // "Nothing was charged" only after a definite pre-broadcast answer; a
      // record whose last answer was ambiguous may have paid.
      return DEFINITE_REJECTIONS.has(record.lastClass)
        ? { kind: "rejected", reason: record.lastReason }
        : this.unresolved(record);
    }
    return { kind: "ready" };
  }

  /**
   * Pay / Try again / Check status: resends or signs as the record allows.
   * Never signs for a payment the server already confirmed.
   *
   * @returns The next view.
   */
  pay(): Promise<PaymentView> {
    const blocked = this.blocked();
    if (blocked) return Promise.resolve(blocked);
    return this.lock!(this.key, () => this.payLocked("pay"));
  }

  /**
   * Resends the stored header once: past the send cap after the lockout, or
   * at any time for a settled payment whose content did not load.
   *
   * @returns The next view.
   */
  checkAgain(): Promise<PaymentView> {
    const blocked = this.blocked();
    if (blocked) return Promise.resolve(blocked);
    return this.lock!(this.key, () => this.payLocked("check"));
  }

  /**
   * "Try again with the same funds": once a sent payment's lockout has passed,
   * signs again spending the pinned nonce (so at most one payment can land).
   * Before the lockout it only reports the unresolved state.
   *
   * @returns The next view.
   */
  resign(): Promise<PaymentView> {
    const blocked = this.blocked();
    if (blocked) return Promise.resolve(blocked);
    return this.lock!(this.key, () => this.payLocked("resign"));
  }

  /**
   * Marks a settled payment's content as delivered and forgets the record.
   * Call only after the page has rendered or saved the paid content.
   *
   * @returns Resolves when the record is gone.
   */
  async completeDelivery(): Promise<void> {
    if (this.blocked()) return;
    await this.lock!(this.key, async () => {
      if (!this.load()?.settled) return;
      // Leave a marker so a tab that loaded before this delivery cannot start
      // a fresh payment without an explicit "buy again".
      const marker = JSON.stringify({
        atMs: Math.floor(this.deps.clock.now()),
        // Unique per delivery, so a tab's acknowledgement covers only this one.
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      });
      this.deps.storage.setItem(this.deliveredKey, marker);
      // This tab delivered it, so it is not "paid elsewhere" for itself.
      this.markerAtLoad = marker;
      this.deps.storage.removeItem(this.key);
    });
  }

  /**
   * Forgets the record so the next payment may use other funds. Allowed only
   * with an explicit acknowledgement, and after the lockout if a header was
   * ever sent (a settled payment may be discarded at once: paying again is
   * then a deliberate new purchase).
   *
   * @param acknowledged - The user confirmed the double-pay warning.
   * @returns The next view.
   */
  discard(acknowledged: boolean): Promise<PaymentView> {
    if (!this.storageOk) {
      return Promise.resolve({ kind: "terminal", reason: "storage_unavailable" });
    }
    if (!this.lock) return Promise.resolve({ kind: "terminal", reason: "no_cross_tab_lock" });
    return this.lock(this.key, async () => {
      if (this.unreadable()) {
        if (!acknowledged) return { kind: "terminal", reason: "record_unreadable" };
        this.deps.storage.removeItem(this.key);
        return { kind: "ready" };
      }
      const record = this.load();
      if (!record) {
        const marker = this.deliveredSinceLoad();
        if (marker !== undefined) {
          if (!acknowledged) return { kind: "paid_elsewhere" };
          this.acknowledgedMarker = marker;
        }
        return { kind: "ready" };
      }
      if (!acknowledged) return this.view();
      if (!record.settled && record.totalSends > 0 && this.deps.clock.now() < unlockAt(record)) {
        return this.unresolved(record);
      }
      this.deps.storage.removeItem(this.key);
      return { kind: "ready" };
    });
  }

  /**
   * Why this page cannot pay at all, if it cannot.
   *
   * @returns Terminal view, or undefined when paying is possible.
   */
  private blocked(): PaymentView | undefined {
    if (!this.storageOk) return { kind: "terminal", reason: "storage_unavailable" };
    if (!this.lock) return { kind: "terminal", reason: "no_cross_tab_lock" };
    if (this.unreadable()) return { kind: "terminal", reason: "record_unreadable" };
    return undefined;
  }

  /**
   * The delivery marker another tab wrote after this page loaded, unless this
   * tab's user acknowledged that exact marker. "After" is decided on this
   * device (the marker differs from the one present at load), never by
   * comparing server clocks. Markers carry a unique id, so acknowledging one
   * never covers a later delivery, and any changed marker counts, readable or
   * not.
   *
   * @returns The marker's raw text, or undefined.
   */
  private deliveredSinceLoad(): string | undefined {
    const raw = this.deps.storage.getItem(this.deliveredKey);
    if (raw === null || raw === this.markerAtLoad || raw === this.acknowledgedMarker) {
      return undefined;
    }
    return raw;
  }

  /**
   * Whether a record exists under this key that cannot be read safely. It
   * might pin a sent payment, so the page must not pay until the user resets
   * it explicitly.
   *
   * @returns True for a present but invalid record.
   */
  private unreadable(): boolean {
    const raw = this.deps.storage.getItem(this.key);
    return raw !== null && parseRecord(raw) === undefined;
  }

  /**
   * Body of pay()/checkAgain()/resign() under the lock.
   *
   * @param mode - "pay": resend or sign as allowed, never re-signing a sent
   *   payment; "check": resend the stored header (past the cap once unlocked);
   *   "resign": after the lockout, sign again with the pinned nonce.
   * @returns The next view.
   */
  private async payLocked(mode: "pay" | "check" | "resign"): Promise<PaymentView> {
    const forceResend = mode === "check";
    let record = this.load();
    if (record?.settled) {
      // Paid: only resend the identical header (to collect content), never
      // sign. Checked before CONFIG: a settled payment stays loadable.
      return forceResend && record.header
        ? this.send(record)
        : { kind: "settled", txId: record.txId };
    }
    if (record?.lastClass === "CONFIG") {
      // Only an acknowledged reset (discard) leaves this state.
      return this.misconfigured(record);
    }
    const now = this.deps.clock.now();

    if (record?.header) {
      if (record.sendCount === 0) {
        if (now <= record.ttlMs - MIN_REMAINING_TO_SEND_MS) return this.send(record);
        record = this.save({ ...record, header: undefined });
      } else {
        // A header that left the page: resend it, never sign, until the
        // transaction it carries can no longer land.
        if (record.lastClass === undefined && !record.possiblyBroadcast) {
          // Sent, but the answer was lost (reload or crash mid-request).
          record = this.save({ ...record, possiblyBroadcast: true, verifyOnlyRejections: false });
        }
        const unlocked = now >= unlockAt(record);
        if (forceResend && unlocked) {
          // One extra "Check again" past the send cap, not unlimited.
          if (record.sendCount >= MAX_SENDS_PER_HEADER) {
            if (record.postCapCheckUsed) return this.unresolved(record);
            record = this.save({ ...record, postCapCheckUsed: true });
          }
          return this.send(record);
        }
        if (!unlocked) {
          if (mode === "resign" || record.sendCount >= MAX_SENDS_PER_HEADER) {
            return this.unresolved(record);
          }
          if (
            record.lastSentAtMs !== undefined &&
            now < record.lastSentAtMs + MIN_SEND_INTERVAL_MS
          ) {
            return {
              kind: "ambiguous",
              reason: record.lastReason,
              txId: record.txId,
              autoRetry: record.lastReason === ERR_SETTLEMENT_PENDING,
              retryAtMs: record.lastSentAtMs + MIN_SEND_INTERVAL_MS,
            };
          }
          return this.send(record);
        }
        // Past TTL + lockout. Only an explicit "try again with the same funds"
        // (resign) signs; a status check or plain pay() never does.
        if (mode !== "resign") return this.unresolved(record);
        // The old transaction landed (its nonce is gone, so signing fails
        // safely) or can never land. Signing again is safe. Nothing is saved
        // until the replacement is signed: if signing fails, the stored
        // record keeps the old header so "Check again" can still collect
        // content for a payment that landed.
        return this.signAndSend(
          { ...record, possiblyBroadcast: false, verifyOnlyRejections: true },
          true,
        );
      }
    }
    if (!record && this.deliveredSinceLoad() !== undefined) return { kind: "paid_elsewhere" };
    return this.signAndSend(record);
  }

  /**
   * Signs with the pinned nonce (or a fresh one for a new record), then sends.
   *
   * @param record - Existing record (for a re-sign, an in-memory copy whose
   *   stored version still holds the previous header).
   * @param replacesStoredHeader - True for a re-sign after the lockout: the
   *   stored header is only replaced once the new signature is saved.
   * @returns The next view.
   */
  private async signAndSend(
    record: PaymentRecord | undefined,
    replacesStoredHeader = false,
  ): Promise<PaymentView> {
    if (record?.possiblyBroadcast && this.deps.clock.now() < unlockAt(record)) {
      return this.unresolved(record);
    }
    if (record && record.signCount >= MAX_SIGNS_PER_RECORD) {
      return record.totalSends > 0
        ? this.unresolved(record)
        : { kind: "terminal", reason: "too_many_attempts" };
    }
    let signed: SignedPayment;
    try {
      signed = await this.deps.sign(record?.nonce);
    } catch (error) {
      const code = signerErrorCode(error);
      if (record && code === "pinned_nonce_missing") {
        if (record.totalSends > 0) return this.unresolved(record);
        // Never sent: nothing can land, so the record may go.
        this.deps.storage.removeItem(this.key);
        return this.signAndSend(undefined);
      }
      throw error;
    }
    const now = this.deps.clock.now();
    const next: PaymentRecord = record
      ? {
          ...record,
          header: signed.header,
          txId: signed.txId,
          ttlMs: signed.ttlMs,
          requirement: this.deps.requirement,
          sendCount: 0,
          postCapCheckUsed: false,
          signCount: record.signCount + 1,
          lastClass: undefined,
          lastReason: undefined,
          expiresAt: signed.ttlMs + RECORD_RETENTION_AFTER_TTL_MS,
        }
      : {
          v: 1,
          version: 0,
          nonce: signed.nonce,
          header: signed.header,
          txId: signed.txId,
          ttlMs: signed.ttlMs,
          requirement: this.deps.requirement,
          sendCount: 0,
          totalSends: 0,
          signCount: 1,
          possiblyBroadcast: false,
          reqsReloaded: false,
          verifyOnlyRejections: true,
          expiresAt: signed.ttlMs + RECORD_RETENTION_AFTER_TTL_MS,
        };
    if (next.nonce !== signed.nonce) {
      throw new Error("Signer spent a different nonce than the pinned one");
    }
    if (now > signed.ttlMs - MIN_REMAINING_TO_SEND_MS) {
      // Drop the late signature. A re-sign keeps the previous (sent) payment
      // stored and returns to its status view so it can still be checked.
      if (replacesStoredHeader) {
        const stored = this.load();
        if (stored) return this.unresolved(stored);
      }
      this.save({ ...next, header: undefined });
      return { kind: "rejected", reason: "payment_window_expired" };
    }
    return this.send(this.save(next));
  }

  /**
   * Sends the record's header with a write-ahead, then applies the answer.
   *
   * @param before - Record holding the header.
   * @returns The next view.
   */
  private async send(before: PaymentRecord): Promise<PaymentView> {
    const sentAt = this.deps.clock.now();
    const record = this.save({
      ...before,
      sendCount: before.sendCount + 1,
      totalSends: before.totalSends + 1,
      lastSentAtMs: sentAt,
      lastClass: undefined,
    });
    let response: Response | undefined;
    try {
      response = await this.deps.send(record.header!);
    } catch {
      response = undefined;
    }
    const outcome = classifyPaymentResponse(response);
    const updated: PaymentRecord = {
      ...record,
      lastClass: outcome.cls,
      lastReason: outcome.reason,
    };
    if (record.settled && outcome.cls !== "SUCCESS") {
      // Resending a confirmed payment to collect content: whatever the server
      // answers now, the payment stays settled and is never signed again.
      this.save({ ...updated, header: record.header });
      return { kind: "settled", txId: updated.txId };
    }
    switch (outcome.cls) {
      case "SUCCESS":
        // Kept until the page confirms delivery (completeDelivery), so a
        // failed content load can never lead to a second signature.
        this.save({ ...updated, settled: true });
        return { kind: "success", response: response! };
      case "CONFIG":
        // The merchant's facilitator cannot settle: terminal. The record keeps
        // its pin; the page never asks for another signature on its own.
        // After a possible broadcast the header is kept (the pin and the
        // lockout still apply); either way this state never signs.
        return this.misconfigured(
          this.save(updated.possiblyBroadcast ? updated : { ...updated, header: undefined }),
        );
      case "STATIC":
      case "STATE":
        if (updated.possiblyBroadcast) return this.ambiguous(updated);
        this.save({ ...updated, header: undefined });
        if (
          outcome.cls === "STATE" &&
          outcome.reason === ERR_NONCE_NOT_ON_CHAIN &&
          updated.verifyOnlyRejections
        ) {
          return { kind: "wrong_network", reason: outcome.reason };
        }
        return { kind: "rejected", reason: outcome.reason };
      case "TRANSIENT":
        this.save(updated);
        return { kind: "retry", reason: outcome.reason };
      case "REQS_CHANGED":
        if (updated.reqsReloaded) return this.unresolved(this.save(updated));
        if (updated.possiblyBroadcast) return this.ambiguous({ ...updated, reqsReloaded: true });
        this.save({ ...updated, reqsReloaded: true, header: undefined });
        return { kind: "reload" };
      default:
        return this.ambiguous(updated);
    }
  }

  /**
   * Records a possible broadcast and returns the resend view.
   *
   * @param record - Updated record.
   * @returns Ambiguous or unresolved view.
   */
  private ambiguous(record: PaymentRecord): PaymentView {
    const saved = this.save({ ...record, possiblyBroadcast: true, verifyOnlyRejections: false });
    if (saved.sendCount >= MAX_SENDS_PER_HEADER) return this.unresolved(saved);
    return {
      kind: "ambiguous",
      reason: saved.lastReason,
      txId: saved.txId,
      autoRetry: saved.lastReason === ERR_SETTLEMENT_PENDING,
      retryAtMs: (saved.lastSentAtMs ?? this.deps.clock.now()) + MIN_SEND_INTERVAL_MS,
    };
  }

  /**
   * Builds the merchant-misconfigured terminal view, saying whether an earlier
   * attempt may already be on chain.
   *
   * @param record - The record.
   * @returns Terminal view.
   */
  private misconfigured(record: PaymentRecord): PaymentView {
    return record.possiblyBroadcast
      ? {
          kind: "terminal",
          reason: "merchant_misconfigured",
          possiblyPaid: true,
          txId: record.txId,
        }
      : { kind: "terminal", reason: "merchant_misconfigured" };
  }

  /**
   * Builds the unresolved view.
   *
   * @param record - The record.
   * @returns Unresolved view.
   */
  private unresolved(record: PaymentRecord): PaymentView {
    const at = unlockAt(record);
    return {
      kind: "unresolved",
      txId: record.txId,
      unlockAtMs: at,
      unlocked: this.deps.clock.now() >= at,
      canCheckAgain:
        record.header !== undefined &&
        record.sendCount > 0 &&
        !(record.sendCount >= MAX_SENDS_PER_HEADER && record.postCapCheckUsed),
    };
  }

  /**
   * Persists a record, bumping its version.
   *
   * @param record - Record to write.
   * @returns The written record.
   */
  private save(record: PaymentRecord): PaymentRecord {
    const next = { ...record, version: record.version + 1 };
    this.deps.storage.setItem(this.key, JSON.stringify(next));
    return next;
  }
}

/**
 * Parses and validates a stored record.
 *
 * @param raw - Stored JSON.
 * @returns The record, or undefined when it is not a valid v1 record.
 */
function parseRecord(raw: string): PaymentRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const time = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const optional = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v);
  const text = (v: unknown) => typeof v === "string";
  const flag = (v: unknown) => typeof v === "boolean";
  const valid =
    r.v === 1 &&
    count(r.version) &&
    typeof r.nonce === "string" &&
    /^[0-9a-f]{64}#\d+$/i.test(r.nonce) &&
    optional(r.header, text) &&
    optional(r.txId, text) &&
    time(r.ttlMs) &&
    typeof r.requirement === "object" &&
    r.requirement !== null &&
    count(r.sendCount) &&
    count(r.totalSends) &&
    count(r.signCount) &&
    optional(r.lastSentAtMs, time) &&
    flag(r.possiblyBroadcast) &&
    flag(r.reqsReloaded) &&
    flag(r.verifyOnlyRejections) &&
    optional(r.lastClass, v => typeof v === "string" && RESPONSE_CLASSES.has(v)) &&
    optional(r.lastReason, text) &&
    time(r.expiresAt) &&
    optional(r.settled, flag) &&
    optional(r.postCapCheckUsed, flag);
  return valid ? (value as PaymentRecord) : undefined;
}

/**
 * When re-signing becomes safe after a possible broadcast.
 *
 * @param record - The record.
 * @returns Unix ms.
 */
function unlockAt(record: PaymentRecord): number {
  return record.ttlMs + RESIGN_LOCKOUT_AFTER_TTL_MS;
}

/**
 * Checks that storage accepts writes (private modes may throw).
 *
 * @param storage - Storage to probe.
 * @returns True when usable.
 */
function probeStorage(storage: StorageLike): boolean {
  try {
    const probe = "x402.cardano.v1.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}
