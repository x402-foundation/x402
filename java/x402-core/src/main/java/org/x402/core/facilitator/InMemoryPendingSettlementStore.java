package org.x402.core.facilitator;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.x402.core.PendingSettlementStore;

/**
 * The default in-memory {@link PendingSettlementStore}. Entries expire {@link #TTL} after they
 * were set; expired entries are pruned on read. Thread-safe; only correct for a single
 * facilitator instance.
 */
public final class InMemoryPendingSettlementStore implements PendingSettlementStore {

  /** How long a pending entry is kept: 5 minutes. */
  public static final Duration TTL = Duration.ofMinutes(5);

  private record Entry(String txHash, Instant storedAt) {}

  private final Clock clock;
  private final Map<String, Entry> entries = new ConcurrentHashMap<>();

  /** Creates a store on the system clock. */
  public InMemoryPendingSettlementStore() {
    this(Clock.systemUTC());
  }

  /**
   * Creates a store on a given clock.
   *
   * @param clock the clock
   */
  public InMemoryPendingSettlementStore(Clock clock) {
    this.clock = clock;
  }

  @Override
  public Optional<String> get(String key) {
    prune();
    Entry entry = entries.get(key);
    return entry == null ? Optional.empty() : Optional.of(entry.txHash());
  }

  @Override
  public void set(String key, String txHash) {
    entries.put(key, new Entry(txHash, clock.instant()));
  }

  @Override
  public void delete(String key) {
    entries.remove(key);
  }

  /**
   * The current entries, for diagnostics.
   *
   * @return key → transaction hash
   */
  public Map<String, String> entriesSnapshot() {
    Map<String, String> out = new LinkedHashMap<>();
    entries.forEach((k, v) -> out.put(k, v.txHash()));
    return out;
  }

  private void prune() {
    Instant cutoff = clock.instant().minus(TTL);
    entries.entrySet().removeIf(e -> e.getValue().storedAt().isBefore(cutoff));
  }
}
