import type { WorkConsumeResult, WorkReservationState, WorkSettlementStore } from "./types";

/**
 * Process-local replay store for tests and single-process examples. Not durable.
 */
export class InMemoryWorkSettlementStore implements WorkSettlementStore {
  private readonly records = new Map<string, Exclude<WorkReservationState, { status: "none" }>>();

  /**
   * Reads the consumption state of a fingerprint.
   *
   * @param fingerprint - Work fingerprint
   * @returns The stored state, or `none`
   */
  async inspect(fingerprint: string): Promise<WorkReservationState> {
    const record = this.records.get(fingerprint);
    if (!record) return { status: "none" };
    return { ...record };
  }

  /**
   * Consumes a fingerprint under a requirement binding.
   *
   * @param fingerprint - Work fingerprint
   * @param binding - Requirement binding from `workBinding`
   * @returns `consumed` on first use, else `settled` (same binding) or `conflict`
   */
  async consume(fingerprint: string, binding: string): Promise<WorkConsumeResult> {
    const existing = this.records.get(fingerprint);
    if (existing) {
      return { status: existing.binding === binding ? "settled" : "conflict" };
    }
    this.records.set(fingerprint, { status: "settled", binding });
    return { status: "consumed" };
  }
}
