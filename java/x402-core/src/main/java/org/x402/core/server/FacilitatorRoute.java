package org.x402.core.server;

import java.util.Objects;

/**
 * Which facilitator verifies and settles a payment (by kind, by pin, or by kind
 * with verify failover). Server-side only: nothing of it appears on the wire.
 */
public sealed interface FacilitatorRoute
    permits FacilitatorRoute.Auto, FacilitatorRoute.AutoWithVerifyFailover,
        FacilitatorRoute.Pinned {

  /**
   * Route by kind: the first facilitator listing the kind owns it.
   *
   * @return the route
   */
  static FacilitatorRoute auto() {
    return Auto.INSTANCE;
  }

  /**
   * Route by kind, and retry {@code /verify} once on the next facilitator with an identical kind
   * when the owner fails at transport level.
   *
   * @return the route
   */
  static FacilitatorRoute autoWithVerifyFailover() {
    return AutoWithVerifyFailover.INSTANCE;
  }

  /**
   * Use only the named facilitator.
   *
   * @param identifier the effective identifier; trailing slashes are ignored
   * @return the route
   */
  static FacilitatorRoute pinned(String identifier) {
    return new Pinned(identifier);
  }

  /**
   * The route of a payment option.
   *
   * @param pin the option's pin, or {@code null}
   * @param failover whether the route enables verify failover
   * @return the pinned route when pinned, else auto with or without failover
   */
  static FacilitatorRoute of(String pin, boolean failover) {
    if (pin != null) {
      return pinned(pin);
    }
    return failover ? autoWithVerifyFailover() : auto();
  }

  /** Route by kind. */
  final class Auto implements FacilitatorRoute {
    static final Auto INSTANCE = new Auto();

    private Auto() {}

    @Override
    public String toString() {
      return "Auto";
    }
  }

  /** Route by kind with one-hop verify failover. */
  final class AutoWithVerifyFailover implements FacilitatorRoute {
    static final AutoWithVerifyFailover INSTANCE = new AutoWithVerifyFailover();

    private AutoWithVerifyFailover() {}

    @Override
    public String toString() {
      return "AutoWithVerifyFailover";
    }
  }

  /**
   * Only this facilitator.
   *
   * @param identifier the effective identifier, normalized (trailing slashes removed)
   */
  record Pinned(String identifier) implements FacilitatorRoute {

    /** Validates and normalizes. */
    public Pinned {
      identifier = Identifiers.normalize(Objects.requireNonNull(identifier, "identifier"));
    }
  }
}
