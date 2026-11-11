package org.x402.core.server;

import java.util.Objects;
import org.x402.core.hooks.HookResults.SkipHandlerDirective;
import org.x402.core.types.VerifyResponse;

/**
 * The resource server's verify outcome: the verdict, an
 * optional skip-handler directive, and which facilitator verified.
 *
 * @param response the verdict
 * @param skipHandler set when an after-verify hook asked to skip the handler, else {@code null}
 * @param verifiedBy the identifier of the facilitator that verified, or {@code null} when no
 *     facilitator was called (hook skip or abort, recovery, or a flow without verify)
 */
public record ServerVerifyResult(
    VerifyResponse response, SkipHandlerDirective skipHandler, String verifiedBy) {

  /** Validates. */
  public ServerVerifyResult {
    Objects.requireNonNull(response, "response");
  }

  /**
   * Whether the payment is valid.
   *
   * @return the verdict's {@code isValid}
   */
  public boolean isValid() {
    return response.isValid();
  }
}
