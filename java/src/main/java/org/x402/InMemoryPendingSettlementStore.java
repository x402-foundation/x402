package org.x402;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The default {@link PendingSettlementStore}: a map in this process whose entries expire after {@link #TTL}.
 * Expired entries are pruned on every {@link #get(String)}, so the map stays as small as the number of settlements
 * currently pending. It never throws {@link java.io.IOException}.
 *
 * <p>Instances are thread-safe.
 */
public final class InMemoryPendingSettlementStore implements PendingSettlementStore {

    /** How long an entry is kept. */
    public static final Duration TTL = Duration.ofMinutes(5);

    private final Clock clock;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    /** Creates an empty store that ages entries with the system clock. */
    public InMemoryPendingSettlementStore() {
        this(Clock.systemUTC());
    }

    InMemoryPendingSettlementStore(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public Optional<String> get(String key) {
        Objects.requireNonNull(key, "key");
        Instant cutoff = clock.instant().minus(TTL);
        entries.values().removeIf(entry -> entry.storedAt().isBefore(cutoff));
        Entry entry = entries.get(key);
        return entry == null ? Optional.empty() : Optional.of(entry.transactionHash());
    }

    @Override
    public void put(String key, String transactionHash) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(transactionHash, "transactionHash");
        entries.put(key, new Entry(transactionHash, clock.instant()));
    }

    @Override
    public void remove(String key) {
        entries.remove(Objects.requireNonNull(key, "key"));
    }

    private record Entry(String transactionHash, Instant storedAt) {
    }
}
