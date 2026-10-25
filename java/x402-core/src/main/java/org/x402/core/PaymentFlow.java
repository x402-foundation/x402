package org.x402.core;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/** The ways a payment is verified and settled around the protected handler. */
public enum PaymentFlow {
  /** Verify, run the handler, settle after it. */
  AUTHORIZATION("authorization", true, false, true),
  /** Settle before the handler. */
  UPFRONT("upfront", false, true, false),
  /** Deposit into an escrow before the handler, charge after it. */
  ESCROW("escrow", false, true, true);

  private final String wire;
  private final boolean verifyBeforeHandler;
  private final boolean settleBeforeHandler;
  private final boolean settleAfterHandler;

  PaymentFlow(String wire, boolean verify, boolean settleBefore, boolean settleAfter) {
    this.wire = wire;
    this.verifyBeforeHandler = verify;
    this.settleBeforeHandler = settleBefore;
    this.settleAfterHandler = settleAfter;
  }

  /**
   * The name used on the wire.
   *
   * @return the wire name
   */
  @JsonValue
  public String wire() {
    return wire;
  }

  /**
   * Whether verify runs before the handler.
   *
   * @return the phase flag
   */
  public boolean verifyBeforeHandler() {
    return verifyBeforeHandler;
  }

  /**
   * Whether settle runs before the handler.
   *
   * @return the phase flag
   */
  public boolean settleBeforeHandler() {
    return settleBeforeHandler;
  }

  /**
   * Whether settle runs after the handler.
   *
   * @return the phase flag
   */
  public boolean settleAfterHandler() {
    return settleAfterHandler;
  }

  /**
   * Looks up a flow by its wire name.
   *
   * @param wire the name
   * @return the flow, or {@code null} when unknown
   */
  public static PaymentFlow fromWire(String wire) {
    return Arrays.stream(values()).filter(f -> f.wire.equals(wire)).findFirst().orElse(null);
  }

  /**
   * Flows a transfer method supports, and its default.
   *
   * @param supported supported flows
   * @param defaultFlow the default flow
   */
  public record Config(List<PaymentFlow> supported, PaymentFlow defaultFlow) {

    /** Validates. */
    public Config {
      supported = List.copyOf(supported);
      Objects.requireNonNull(defaultFlow, "defaultFlow");
      if (!supported.contains(defaultFlow)) {
        throw new IllegalArgumentException("default flow must be supported");
      }
    }

    /**
     * Authorization only, the common case.
     *
     * @return the config
     */
    public static Config authorizationOnly() {
      return new Config(List.of(AUTHORIZATION), AUTHORIZATION);
    }
  }
}
