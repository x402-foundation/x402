package org.x402.spring.facilitator;

import java.util.LinkedHashMap;
import java.util.Map;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;

/** Request bodies for the facilitator endpoints. */
final class FacilitatorWire {

  static final String MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon abandon abandon art";

  private FacilitatorWire() {}

  static PaymentRequirements requirements() {
    return new PaymentRequirements("exact", "test:net", "USDM", "10000", "addr", 300, Map.of());
  }

  static PaymentPayload payload(String mode) {
    Map<String, Object> inner = new LinkedHashMap<>();
    inner.put("signature", "sig");
    if (mode != null) {
      inner.put("mode", mode);
    }
    return new PaymentPayload(2, ResourceInfo.of("https://api.example.com/x"), requirements(),
        inner, null);
  }

  static String body(String mode) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("x402Version", 2);
    body.put("paymentPayload", payload(mode));
    body.put("paymentRequirements", requirements());
    return X402Json.write(body);
  }

  static String missingRequirements() {
    return X402Json.write(Map.of("x402Version", 2, "paymentPayload", payload(null)));
  }
}
