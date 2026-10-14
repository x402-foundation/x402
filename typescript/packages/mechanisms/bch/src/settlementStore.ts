/**
 * Atomically claims a BCH transaction for one x402 request binding.
 *
 * A BCH transaction can be valid and broadcast only once, but a successful
 * rebroadcast can otherwise be presented to multiple resource requests. The
 * store is therefore part of the facilitator safety boundary. Applications
 * running more than one facilitator instance should provide a shared store.
 */
export interface BchSettlementStore {
  claim(txid: string, binding: string): Promise<'acquired' | 'same' | 'conflict'>;
  markAccepted(txid: string): Promise<void>;
  release(txid: string): Promise<void>;
}

type SettlementRecord = { binding: string; accepted: boolean };

/** Single-process reference store; use a shared implementation in production. */
export class InMemoryBchSettlementStore implements BchSettlementStore {
  private readonly records = new Map<string, SettlementRecord>();

  async claim(txid: string, binding: string): Promise<'acquired' | 'same' | 'conflict'> {
    const existing = this.records.get(txid);
    if (!existing) {
      this.records.set(txid, { binding, accepted: false });
      return 'acquired';
    }
    return existing.binding === binding ? 'same' : 'conflict';
  }

  async markAccepted(txid: string): Promise<void> {
    const record = this.records.get(txid);
    if (record) record.accepted = true;
  }

  async release(txid: string): Promise<void> {
    const record = this.records.get(txid);
    if (record && !record.accepted) this.records.delete(txid);
  }
}
