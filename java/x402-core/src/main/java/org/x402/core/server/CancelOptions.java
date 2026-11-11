package org.x402.core.server;

import java.util.Objects;
import org.x402.core.server.ServerHooks.CancellationReason;

/**
 * Why a verified payment is cancelled.
 *
 * @param reason the reason
 * @param error the handler's exception, if any
 * @param responseStatus the handler's status, if any
 */
public record CancelOptions(CancellationReason reason, Throwable error, Integer responseStatus) {

  /** Validates. */
  public CancelOptions {
    Objects.requireNonNull(reason, "reason");
  }
}
