package org.x402.http;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.regex.Pattern;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.SettleResponse;

/**
 * Base64(JSON) encoding of the three x402 headers, reproducible byte for byte
 * (compact JSON in declaration order).
 */
public final class HeaderCodec {

  /** The characters a base64 header value may contain. */
  private static final Pattern BASE64 = Pattern.compile("^[A-Za-z0-9+/]*={0,2}$");

  private HeaderCodec() {}

  /**
   * Encodes a {@code PAYMENT-REQUIRED} header value.
   *
   * @param paymentRequired the value
   * @return the header value
   */
  public static String encodePaymentRequired(PaymentRequired paymentRequired) {
    return encode(paymentRequired);
  }

  /**
   * Decodes a {@code PAYMENT-REQUIRED} header value.
   *
   * @param header the header value
   * @return the value
   * @throws IllegalArgumentException when the header is not valid base64 JSON
   */
  public static PaymentRequired decodePaymentRequired(String header) {
    return decode(header, PaymentRequired.class, "Invalid payment required header");
  }

  /**
   * Encodes a {@code PAYMENT-SIGNATURE} header value.
   *
   * @param paymentPayload the value
   * @return the header value
   */
  public static String encodePaymentSignature(PaymentPayload paymentPayload) {
    return encode(paymentPayload);
  }

  /**
   * Decodes a {@code PAYMENT-SIGNATURE} header value.
   *
   * @param header the header value
   * @return the value
   * @throws IllegalArgumentException when the header is not valid base64 JSON
   */
  public static PaymentPayload decodePaymentSignature(String header) {
    return decode(header, PaymentPayload.class, "Invalid payment signature header");
  }

  /**
   * Encodes a {@code PAYMENT-RESPONSE} header value, stripping the server-internal {@code
   * extensionResponses} side channel, which never goes on the wire.
   *
   * @param settleResponse the value
   * @return the header value
   */
  public static String encodePaymentResponse(SettleResponse settleResponse) {
    return encode(settleResponse.withoutExtensionResponses());
  }

  /**
   * Decodes a {@code PAYMENT-RESPONSE} header value.
   *
   * @param header the header value
   * @return the value
   * @throws IllegalArgumentException when the header is not valid base64 JSON
   */
  public static SettleResponse decodePaymentResponse(String header) {
    return decode(header, SettleResponse.class, "Invalid payment response header");
  }

  private static String encode(Object value) {
    return Base64.getEncoder()
        .encodeToString(X402Json.write(value).getBytes(StandardCharsets.UTF_8));
  }

  private static <T> T decode(String header, Class<T> type, String error) {
    if (header == null || !BASE64.matcher(header).matches()) {
      throw new IllegalArgumentException(error);
    }
    final byte[] bytes;
    try {
      bytes = Base64.getDecoder().decode(header);
    } catch (IllegalArgumentException e) {
      throw new IllegalArgumentException(error, e);
    }
    T value = X402Json.read(new String(bytes, StandardCharsets.UTF_8), type);
    if (value == null) {
      // JSON null (base64 "bnVsbA==") decodes to null; a header must carry an object.
      throw new IllegalArgumentException(error);
    }
    return value;
  }
}
