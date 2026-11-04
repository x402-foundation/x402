package org.x402.util;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BoundedBodySubscriberTest {

    private final RecordingSubscription subscription = new RecordingSubscription();

    @Test
    void collectsABodyOfExactlyTheLimit() throws Exception {
        BoundedBodySubscriber subscriber = subscribed(5);

        subscriber.onNext(List.of(bytes("ab"), bytes("c")));
        subscriber.onNext(List.of(bytes("de")));
        subscriber.onComplete();

        assertArrayEquals(bytes("abcde").array(), body(subscriber).get());
        assertEquals(Long.MAX_VALUE, subscription.requested);
        assertFalse(subscription.cancelled);
    }

    @Test
    void cancelsTheDownloadOnceTheBodyExceedsTheLimit() {
        BoundedBodySubscriber subscriber = subscribed(5);

        subscriber.onNext(List.of(bytes("abc"), bytes("def"), bytes("g")));
        subscriber.onNext(List.of(bytes("h")));
        subscriber.onComplete();

        ExecutionException e = assertThrows(ExecutionException.class, () -> body(subscriber).get());
        assertInstanceOf(BoundedBodySubscriber.TooLargeException.class, e.getCause());
        assertEquals("response body exceeds 5 bytes", e.getCause().getMessage());
        assertTrue(subscription.cancelled);
    }

    @Test
    void propagatesTransportErrors() {
        BoundedBodySubscriber subscriber = subscribed(5);
        IOException failure = new IOException("connection reset");

        subscriber.onNext(List.of(bytes("ab")));
        subscriber.onError(failure);

        ExecutionException e = assertThrows(ExecutionException.class, () -> body(subscriber).get());
        assertSame(failure, e.getCause());
    }

    private BoundedBodySubscriber subscribed(int limit) {
        BoundedBodySubscriber subscriber = new BoundedBodySubscriber(limit);
        subscriber.onSubscribe(subscription);
        return subscriber;
    }

    private static CompletableFuture<byte[]> body(BoundedBodySubscriber subscriber) {
        return subscriber.getBody().toCompletableFuture();
    }

    private static ByteBuffer bytes(String text) {
        return ByteBuffer.wrap(text.getBytes(StandardCharsets.US_ASCII));
    }

    private static final class RecordingSubscription implements Flow.Subscription {

        private long requested;
        private boolean cancelled;

        @Override
        public void request(long n) {
            requested += n;
        }

        @Override
        public void cancel() {
            cancelled = true;
        }
    }
}
