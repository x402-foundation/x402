package org.x402;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;

class InMemoryPendingSettlementStoreTest {

    private static final String KEY = "0x54b9f3b0";
    private static final String TX_HASH = "0x" + "ab".repeat(32);

    @Test
    void storesReplacesAndRemovesEntries() {
        InMemoryPendingSettlementStore store = new InMemoryPendingSettlementStore();

        assertEquals(Optional.empty(), store.get(KEY));
        store.put(KEY, TX_HASH);
        assertEquals(Optional.of(TX_HASH), store.get(KEY));
        store.put(KEY, "0x" + "cd".repeat(32));
        assertEquals(Optional.of("0x" + "cd".repeat(32)), store.get(KEY));
        store.remove(KEY);
        assertEquals(Optional.empty(), store.get(KEY));
        store.remove(KEY);
    }

    @Test
    void expiresEntriesAfterTheTtl() {
        MutableClock clock = new MutableClock();
        InMemoryPendingSettlementStore store = new InMemoryPendingSettlementStore(clock);
        store.put(KEY, TX_HASH);

        clock.now = clock.now.plus(InMemoryPendingSettlementStore.TTL);
        assertEquals(Optional.of(TX_HASH), store.get(KEY));

        clock.now = clock.now.plusNanos(1);
        assertEquals(Optional.empty(), store.get(KEY));
        assertEquals(Duration.ofMinutes(5), InMemoryPendingSettlementStore.TTL);
    }

    /** A clock tests move by hand. */
    private static final class MutableClock extends Clock {

        private Instant now = Instant.parse("2026-11-04T10:00:00Z");

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
