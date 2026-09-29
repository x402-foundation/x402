export class SettlementCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  isDuplicate(settlementHash: string, maxTimeoutSeconds = 300): boolean {
    this.evictExpired(maxTimeoutSeconds);
    if (this.entries.has(settlementHash)) {
      return true;
    }
    this.entries.set(settlementHash, this.now());
    return false;
  }

  release(settlementHash: string): void {
    this.entries.delete(settlementHash);
  }

  has(settlementHash: string, maxTimeoutSeconds = 300): boolean {
    this.evictExpired(maxTimeoutSeconds);
    return this.entries.has(settlementHash);
  }

  private evictExpired(maxTimeoutSeconds: number): void {
    const cutoff = this.now() - maxTimeoutSeconds * 1000;
    for (const [hash, insertedAt] of this.entries) {
      if (insertedAt <= cutoff) {
        this.entries.delete(hash);
      }
    }
  }
}
