package org.x402.servlet;

import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.x402.http.HttpServerState;
import org.x402.http.RouteConfigurationError;
import org.x402.http.X402HttpResourceServer;

/**
 * The resource server's startup sync and background re-sync for the plain filter: the
 * framework-neutral counterpart of the Spring starter's {@code X402ServerLifecycle}. The first
 * sync runs in {@code Filter.init}. When only facilitators are missing, the affected routes answer
 * 503 while one background re-sync retries with exponential backoff; any other route error stops
 * the application. {@link #stop()} ends the threads.
 */
final class ResourceServerSync {

  /**
   * Sync settings.
   *
   * @param startupTimeout total budget of one sync
   * @param initialBackoff first delay of the background re-sync
   * @param maxBackoff longest delay between re-syncs
   */
  record Settings(Duration startupTimeout, Duration initialBackoff, Duration maxBackoff) {

    /**
     * The Spring starter's defaults: 10 s, 1 s, 60 s.
     *
     * @return the defaults
     */
    static Settings defaults() {
      return new Settings(Duration.ofSeconds(10), Duration.ofSeconds(1), Duration.ofSeconds(60));
    }
  }

  private static final System.Logger LOG = System.getLogger(PaymentFilter.class.getName());

  private final X402HttpResourceServer http;
  private final Settings settings;
  private ExecutorService executor;
  private ScheduledExecutorService scheduler;
  private Duration nextDelay;
  private volatile boolean running;

  ResourceServerSync(X402HttpResourceServer http, Settings settings) {
    this.http = Objects.requireNonNull(http, "http");
    this.settings = Objects.requireNonNull(settings, "settings");
  }

  /**
   * Syncs the server unless the application already did. When the application's own sync left
   * routes waiting for a facilitator, only the background re-sync starts.
   *
   * @throws RuntimeException when the routes are invalid for a reason a re-sync cannot heal
   */
  synchronized void start() {
    if (running) {
      return;
    }
    HttpServerState synced = http.state();
    if (synced != null) {
      if (synced.affectedRoutes().isEmpty()) {
        return;
      }
      running = true;
      executor = Executors.newCachedThreadPool(threads("x402-sync"));
      startResync(new IllegalStateException("the application's sync left routes waiting"));
      return;
    }
    running = true;
    executor = Executors.newCachedThreadPool(threads("x402-sync"));
    try {
      http.initialize(settings.startupTimeout(), executor);
      warnFailedFacilitators();
    } catch (RouteConfigurationError e) {
      if (!awaitingFacilitators(e)) {
        stop();
        throw e;
      }
      startResync(e);
    } catch (IllegalStateException e) {
      HttpServerState state = http.state();
      if (state == null || state.failedFacilitators().isEmpty()) {
        stop();
        throw e;
      }
      startResync(e);
    }
  }

  /** Ends the re-sync and the sync threads. */
  synchronized void stop() {
    running = false;
    if (scheduler != null) {
      scheduler.shutdownNow();
    }
    if (executor != null) {
      executor.shutdownNow();
    }
  }

  private boolean awaitingFacilitators(RouteConfigurationError e) {
    HttpServerState state = http.state();
    return e.onlyAwaitingFacilitators() && state != null
        && !state.failedFacilitators().isEmpty();
  }

  private void startResync(RuntimeException cause) {
    LOG.log(System.Logger.Level.WARNING, "x402: facilitators " + http.state().failedFacilitators()
        + " failed at startup; affected routes " + http.state().affectedRoutes()
        + " answer 503 until a background re-sync succeeds: " + cause.getMessage());
    scheduler = Executors.newSingleThreadScheduledExecutor(threads("x402-resync"));
    nextDelay = settings.initialBackoff();
    schedule();
  }

  private void schedule() {
    ScheduledExecutorService s = scheduler;
    if (s != null && !s.isShutdown()) {
      s.schedule(this::resync, nextDelay.toMillis(), TimeUnit.MILLISECONDS);
    }
  }

  /** One re-sync; runs on the single scheduler thread, so at most one is in flight. */
  private void resync() {
    if (!running) {
      return;
    }
    try {
      http.initialize(settings.startupTimeout(), executor);
      LOG.log(System.Logger.Level.INFO, "x402 re-sync: every route is available");
      scheduler.shutdown();
      return;
    } catch (VirtualMachineError e) {
      throw e;
    } catch (Throwable e) {
      // keep the single-flight re-sync alive whatever a scheme or facilitator throws
      LOG.log(System.Logger.Level.WARNING, "x402 re-sync failed: " + e);
    }
    long doubled = Math.min(nextDelay.toMillis() * 2, settings.maxBackoff().toMillis());
    nextDelay = Duration.ofMillis(Math.max(doubled, 1));
    schedule();
  }

  private void warnFailedFacilitators() {
    HttpServerState state = http.state();
    if (state == null) {
      return;
    }
    for (String failed : state.failedFacilitators()) {
      LOG.log(System.Logger.Level.WARNING, "x402: facilitator \"" + failed + "\" failed at "
          + "startup but no route needs it; it is not retried until restart");
    }
  }

  private static ThreadFactory threads(String name) {
    AtomicInteger n = new AtomicInteger();
    return r -> {
      Thread t = new Thread(r, name + "-" + n.incrementAndGet());
      t.setDaemon(true);
      return t;
    };
  }
}
