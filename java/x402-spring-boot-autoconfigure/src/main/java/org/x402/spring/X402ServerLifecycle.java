package org.x402.spring;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.context.SmartLifecycle;
import org.x402.http.HttpServerState;
import org.x402.http.RouteConfigurationError;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.properties.X402Properties;

/**
 * Startup facilitator sync and background re-sync. Starts before the web server
 * accepts requests.
 *
 * <ul>
 *   <li>All facilitators answered and validation fails: startup fails.
 *   <li>A facilitator failed and only problems it might heal remain: the app starts; affected
 *       routes answer 503 and a single-flight background re-sync retries with exponential backoff.
 *   <li>A re-sync whose validation still fails: affected routes answer 500, logged once; re-sync
 *       continues.
 *   <li>A failed facilitator no route needs: not retried; reported in health details only.
 *   <li>No offers: no sync.
 * </ul>
 */
public final class X402ServerLifecycle implements SmartLifecycle {

  /** Starts before the embedded web server ({@code WebServerStartStopLifecycle}). */
  public static final int PHASE = Integer.MAX_VALUE - 4096;

  private static final Log LOG = LogFactory.getLog(X402ServerLifecycle.class);

  /** The resource server's readiness. */
  public enum Status {
    /** Every route can be served (or there are no offers). */
    READY,
    /** Waiting for a failed facilitator; affected routes answer 503. */
    AWAITING_FACILITATORS,
    /** All facilitators answered but routes are invalid; affected routes answer 500. */
    INVALID
  }

  private final X402HttpResourceServer http;
  private final boolean hasOffers;
  private final X402Properties.Sync sync;
  private volatile Status status = Status.READY;
  private volatile boolean running;
  private volatile boolean synced;
  private ExecutorService executor;
  private ScheduledExecutorService scheduler;
  private Duration nextDelay;
  private boolean invalidLogged;

  /**
   * Creates the lifecycle.
   *
   * @param http the HTTP resource server
   * @param hasOffers whether any offer exists (none = no sync)
   * @param sync the sync settings
   */
  public X402ServerLifecycle(X402HttpResourceServer http, boolean hasOffers,
      X402Properties.Sync sync) {
    this.http = http;
    this.hasOffers = hasOffers;
    this.sync = sync;
  }

  @Override
  public void start() {
    running = true;
    if (!hasOffers) {
      return;
    }
    executor = Executors.newCachedThreadPool(threads("x402-sync"));
    try {
      http.initialize(sync.startupTimeout(), executor);
      synced = true;
      ready(false);
      warnUnneededFailures();
    } catch (RouteConfigurationError e) {
      synced = true;
      if (!awaiting(e)) {
        stopThreads();
        throw X402RouteErrors.withOfferNames(e);
      }
      startResync(e);
    } catch (IllegalStateException e) {
      synced = http.state() != null;
      if (!synced || http.state().failedFacilitators().isEmpty()) {
        stopThreads();
        throw e;
      }
      startResync(e);
    }
  }

  private boolean awaiting(RouteConfigurationError e) {
    HttpServerState state = http.state();
    return e.onlyAwaitingFacilitators() && state != null && !state.failedFacilitators().isEmpty();
  }

  private void startResync(RuntimeException cause) {
    status = Status.AWAITING_FACILITATORS;
    LOG.warn("x402: facilitators " + http.state().failedFacilitators() + " failed at startup; "
        + "affected routes " + http.state().affectedRoutes() + " answer 503 until a background "
        + "re-sync succeeds: " + cause.getMessage());
    scheduler = Executors.newSingleThreadScheduledExecutor(threads("x402-resync"));
    nextDelay = sync.initialBackoff();
    schedule();
  }

  private void schedule() {
    ScheduledExecutorService s = scheduler;
    if (s != null && !s.isShutdown()) {
      s.schedule(this::resync, nextDelay.toMillis(), TimeUnit.MILLISECONDS);
    }
  }

  /** One background re-sync; runs on the single scheduler thread, so at most one is in flight. */
  private void resync() {
    if (!running) {
      return;
    }
    try {
      http.initialize(sync.startupTimeout(), executor);
      ready(true);
      return;
    } catch (RouteConfigurationError e) {
      if (awaiting(e)) {
        status = Status.AWAITING_FACILITATORS;
      } else {
        status = Status.INVALID;
        if (!invalidLogged) {
          invalidLogged = true;
          LOG.error("x402 re-sync: route validation still fails; affected routes answer 500 "
              + "and re-sync continues. " + X402RouteErrors.withOfferNames(e).getMessage());
        }
      }
    } catch (VirtualMachineError e) {
      throw e;
    } catch (Throwable e) {
      // keep the single-flight re-sync alive whatever a scheme or facilitator throws
      status = Status.AWAITING_FACILITATORS;
      LOG.warn("x402 re-sync failed: " + e);
    }
    long doubled = Math.min(nextDelay.toMillis() * 2, sync.maxBackoff().toMillis());
    nextDelay = Duration.ofMillis(Math.max(doubled, 1));
    schedule();
  }

  private void ready(boolean afterResync) {
    status = Status.READY;
    invalidLogged = false;
    if (afterResync) {
      LOG.info("x402 re-sync: every route is available");
      ScheduledExecutorService s = scheduler;
      if (s != null) {
        s.shutdown();
      }
    }
  }

  private void warnUnneededFailures() {
    HttpServerState state = http.state();
    if (state == null) {
      return;
    }
    for (String failed : state.failedFacilitators()) {
      LOG.warn("x402: facilitator \"" + failed + "\" failed at startup but no route needs it; it "
          + "is not retried until restart, so route ownership stays fixed");
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

  private void stopThreads() {
    if (scheduler != null) {
      scheduler.shutdownNow();
    }
    if (executor != null) {
      executor.shutdownNow();
    }
  }

  @Override
  public void stop() {
    running = false;
    stopThreads();
  }

  @Override
  public boolean isRunning() {
    return running;
  }

  @Override
  public int getPhase() {
    return PHASE;
  }

  /**
   * The current readiness.
   *
   * @return the status
   */
  public Status status() {
    return status;
  }

  /**
   * Whether a sync has run (false without offers).
   *
   * @return {@code true} after the first sync
   */
  public boolean synced() {
    return synced;
  }

  /**
   * The published state of the HTTP server, if any.
   *
   * @return the state, or {@code null}
   */
  public HttpServerState state() {
    return http.state();
  }

  /**
   * The configured facilitator identifiers.
   *
   * @return the identifiers in precedence order
   */
  public List<String> facilitators() {
    return http.server().facilitatorIdentifiers();
  }
}
