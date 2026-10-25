package org.x402.http;

/** x402 v2 HTTP header names. */
public final class X402Headers {

  /** Server → client: base64 {@code PaymentRequired}. */
  public static final String PAYMENT_REQUIRED = "PAYMENT-REQUIRED";

  /** Client → server: base64 {@code PaymentPayload}. */
  public static final String PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";

  /** Server → client: base64 {@code SettleResponse}. */
  public static final String PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

  /** The v1 payment header. Clients treat a request that already carries it as paid. */
  public static final String X_PAYMENT = "X-PAYMENT";

  /** Response header a handler may set to adjust the settled amount. */
  public static final String SETTLEMENT_OVERRIDES = "Settlement-Overrides";

  private X402Headers() {}
}
