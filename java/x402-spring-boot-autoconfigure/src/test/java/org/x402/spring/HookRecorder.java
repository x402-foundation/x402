package org.x402.spring;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.x402.core.server.X402ResourceServer;

/**
 * Registers the test scheme on {@code test:net} / {@code test:main} and records lifecycle hooks.
 */
public final class HookRecorder implements X402ResourceServerCustomizer {

  /** The test networks. */
  public static final String NET = "test:net";

  /** The second test network. */
  public static final String MAIN = "test:main";

  /** {@code onVerifiedPaymentCanceled} calls. */
  public final AtomicInteger canceled = new AtomicInteger();

  /** {@code onAfterSettle} calls. */
  public final AtomicInteger settled = new AtomicInteger();

  /** Cancel reasons, in order. */
  public final List<String> cancelReasons = new CopyOnWriteArrayList<>();

  /** Resets the counters. */
  public void reset() {
    canceled.set(0);
    settled.set(0);
    cancelReasons.clear();
  }

  @Override
  public void customize(X402ResourceServer server) {
    server.register(NET, new TestServerScheme());
    server.register(MAIN, new TestServerScheme());
    server.onVerifiedPaymentCanceled(ctx -> {
      canceled.incrementAndGet();
      cancelReasons.add(ctx.reason().wire());
    });
    server.onAfterSettle(ctx -> settled.incrementAndGet());
  }
}
