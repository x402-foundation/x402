package org.x402.util;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

/**
 * Collects a response body into a byte array, cancelling the download as soon as it exceeds a limit, in which case
 * the body completes with {@link TooLargeException}. Create one per response, e.g.
 * {@code httpClient.sendAsync(request, info -> new BoundedBodySubscriber(limit))}. The {@code Flow} contract
 * delivers signals serially, so no synchronization is needed.
 */
public final class BoundedBodySubscriber implements HttpResponse.BodySubscriber<byte[]> {

    private final int limit;
    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private final CompletableFuture<byte[]> body = new CompletableFuture<>();
    private Flow.Subscription subscription;

    /**
     * Creates a subscriber.
     *
     * @param limit the largest body accepted, in bytes
     */
    public BoundedBodySubscriber(int limit) {
        this.limit = limit;
    }

    @Override
    public CompletionStage<byte[]> getBody() {
        return body;
    }

    @Override
    public void onSubscribe(Flow.Subscription newSubscription) {
        subscription = newSubscription;
        subscription.request(Long.MAX_VALUE);
    }

    @Override
    public void onNext(List<ByteBuffer> items) {
        for (ByteBuffer item : items) {
            if (body.isDone()) {
                return;
            }
            if ((long) buffer.size() + item.remaining() > limit) {
                subscription.cancel();
                body.completeExceptionally(new TooLargeException(limit));
                return;
            }
            byte[] chunk = new byte[item.remaining()];
            item.get(chunk);
            buffer.writeBytes(chunk);
        }
    }

    @Override
    public void onError(Throwable throwable) {
        body.completeExceptionally(throwable);
    }

    @Override
    public void onComplete() {
        body.complete(buffer.toByteArray());
    }

    /** Signals that a response body exceeded the subscriber's limit. */
    public static final class TooLargeException extends IOException {

        private static final long serialVersionUID = 1L;

        TooLargeException(int limit) {
            super("response body exceeds " + limit + " bytes");
        }
    }
}
