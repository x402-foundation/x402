package org.x402.http.facilitator;

import java.util.Objects;
import org.x402.core.FacilitatorStatusException;
import org.x402.core.InProcessFacilitatorClient;
import org.x402.core.SettleAbortedException;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;

/**
 * A resource server's facilitator in the same process: calls an {@link X402Facilitator} directly
 * and answers exactly what an {@code HttpFacilitatorClient} would get from a {@link
 * FacilitatorHttpHandler} serving that facilitator.
 *
 * <ul>
 *   <li>A {@link SettleAbortedException} becomes the wire abort result {@code {success:false,
 *       errorReason, transaction:"", network:<requirements.network>}}.
 *   <li>Any other exception becomes the {@link FacilitatorStatusException} the HTTP client
 *       throws for the handler's 500 {@code {error}} answer (same message, status 500), with the
 *       original exception as its cause.
 *   <li>The server-internal {@code extensionResponses} side channel is dropped, as on the wire.
 * </ul>
 *
 * <p>Its identifier is the reserved {@value #IDENTIFIER}; register it with {@code
 * X402ResourceServer.Builder.localFacilitator(...)}.
 */
public final class LocalFacilitatorClient implements InProcessFacilitatorClient {

  /** The reserved identifier of the in-process facilitator. */
  public static final String IDENTIFIER = "local";

  private final X402Facilitator facilitator;

  /**
   * Creates a client.
   *
   * @param facilitator the in-process facilitator
   */
  public LocalFacilitatorClient(X402Facilitator facilitator) {
    this.facilitator = Objects.requireNonNull(facilitator, "facilitator");
  }

  /**
   * The wrapped facilitator.
   *
   * @return the facilitator
   */
  public X402Facilitator facilitator() {
    return facilitator;
  }

  @Override
  public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
    try {
      return FacilitatorHttpHandler.verify(facilitator, payload, requirements);
    } catch (RuntimeException e) {
      throw failure("verify", e);
    }
  }

  @Override
  public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
    try {
      return FacilitatorHttpHandler.settle(facilitator, payload, requirements);
    } catch (RuntimeException e) {
      throw failure("settle", e);
    }
  }

  @Override
  public SupportedResponse getSupported() {
    try {
      return facilitator.getSupported();
    } catch (RuntimeException e) {
      throw failure("getSupported", e);
    }
  }

  @Override
  public String identifier() {
    return IDENTIFIER;
  }

  /** What {@code HttpFacilitatorClient} throws for the handler's 500 answer. */
  private static FacilitatorStatusException failure(String operation, RuntimeException cause) {
    String body = FacilitatorHttpHandler.errorBody(FacilitatorHttpHandler.errorMessage(cause));
    FacilitatorStatusException error = new FacilitatorStatusException("Facilitator " + operation
        + " failed (500): " + FacilitatorHttpHandler.excerpt(body), 500);
    error.initCause(cause);
    return error;
  }
}
