package org.x402.core.hooks;

import java.util.Objects;

/**
 * Result types returned by x402 hooks. Each hook kind returns a small sealed hierarchy of outcomes
 * such as continue, abort, skip the handler or recovered.
 */
public final class HookResults {

  private HookResults() {}

  /**
   * Result of a before-hook that can only continue or abort (facilitator and client hooks).
   */
  public sealed interface Decision permits Proceed, Abort {

    /**
     * Continue normally.
     *
     * @return the decision
     */
    static Decision proceed() {
      return Proceed.INSTANCE;
    }

    /**
     * Abort with a reason.
     *
     * @param reason the machine-readable reason
     * @return the decision
     */
    static Decision abort(String reason) {
      return new Abort(reason, null);
    }
  }

  /**
   * Result of a resource-server before-verify or before-settle hook: continue, abort, or skip the
   * facilitator call with a given result.
   *
   * @param <T> the facilitator result type the hook may substitute
   */
  public sealed interface BeforeResult<T> permits Proceed, Abort, Skip {

    /**
     * Continue normally.
     *
     * @param <T> the result type
     * @return the result
     */
    @SuppressWarnings("unchecked")
    static <T> BeforeResult<T> proceed() {
      return (BeforeResult<T>) Proceed.INSTANCE;
    }

    /**
     * Abort with a reason and optional message.
     *
     * @param reason the machine-readable reason
     * @param message optional detail
     * @param <T> the result type
     * @return the result
     */
    static <T> BeforeResult<T> abort(String reason, String message) {
      return new Abort(reason, message);
    }

    /**
     * Skip the facilitator call and use this result instead.
     *
     * @param result the substitute result
     * @param <T> the result type
     * @return the result
     */
    static <T> BeforeResult<T> skip(T result) {
      return new Skip<>(result);
    }
  }

  /** Result of a resource-server after-verify hook. */
  public sealed interface AfterVerifyResult permits Proceed, Abort, SkipHandler {

    /**
     * Continue normally.
     *
     * @return the result
     */
    static AfterVerifyResult proceed() {
      return Proceed.INSTANCE;
    }

    /**
     * Abort the verified payment; it is cancelled with reason {@code after_verify_aborted}.
     *
     * @param reason the machine-readable reason
     * @param message optional detail
     * @return the result
     */
    static AfterVerifyResult abort(String reason, String message) {
      return new Abort(reason, message);
    }

    /**
     * Skip the protected handler and answer with this directive (settled first).
     *
     * @param response optional response directive
     * @return the result
     */
    static AfterVerifyResult skipHandler(SkipHandlerDirective response) {
      return new SkipHandler(response);
    }
  }

  /**
   * Result of a failure hook: no recovery, or a recovered result.
   *
   * @param <T> the recovered value type
   */
  public sealed interface Recovery<T> permits NotRecovered, Recovered {

    /**
     * Do not recover; the failure propagates.
     *
     * @param <T> the value type
     * @return the result
     */
    @SuppressWarnings("unchecked")
    static <T> Recovery<T> none() {
      return (Recovery<T>) NotRecovered.INSTANCE;
    }

    /**
     * Recover with this value.
     *
     * @param value the recovered value
     * @param <T> the value type
     * @return the result
     */
    static <T> Recovery<T> recovered(T value) {
      return new Recovered<>(value);
    }
  }

  /** Continue normally. */
  @SuppressWarnings("rawtypes")
  public static final class Proceed implements Decision, BeforeResult, AfterVerifyResult {
    static final Proceed INSTANCE = new Proceed();

    private Proceed() {}

    @Override
    public String toString() {
      return "Proceed";
    }
  }

  /**
   * Abort.
   *
   * @param reason the machine-readable reason
   * @param message optional detail
   */
  @SuppressWarnings("rawtypes")
  public record Abort(String reason, String message)
      implements Decision, BeforeResult, AfterVerifyResult {

    /** Validates. */
    public Abort {
      Objects.requireNonNull(reason, "reason");
    }
  }

  /**
   * Skip with a substitute result.
   *
   * @param result the substitute result
   * @param <T> the result type
   */
  public record Skip<T>(T result) implements BeforeResult<T> {

    /** Validates. */
    public Skip {
      Objects.requireNonNull(result, "result");
    }
  }

  /**
   * Skip the protected handler.
   *
   * @param response optional response directive
   */
  public record SkipHandler(SkipHandlerDirective response) implements AfterVerifyResult {}

  /** Not recovered. */
  @SuppressWarnings("rawtypes")
  public static final class NotRecovered implements Recovery {
    static final NotRecovered INSTANCE = new NotRecovered();

    private NotRecovered() {}

    @Override
    public String toString() {
      return "NotRecovered";
    }
  }

  /**
   * Recovered with a value.
   *
   * @param value the recovered value
   * @param <T> the value type
   */
  public record Recovered<T>(T value) implements Recovery<T> {

    /** Validates. */
    public Recovered {
      Objects.requireNonNull(value, "value");
    }
  }

  /**
   * What to answer when an after-verify hook skips the handler.
   *
   * @param contentType optional content type
   * @param body optional body, serialized as JSON unless it is a string
   */
  public record SkipHandlerDirective(String contentType, Object body) {}
}
