package org.x402.core;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.SupportedResponse;

/** Shared test data for the core role tests. */
public final class Fixtures {

  public static final String PREPROD = "cardano:preprod";
  public static final String MAINNET = "cardano:mainnet";
  public static final String USDM = "USDM";
  public static final String PAY_TO = "addr_test1seller";

  private Fixtures() {}

  public static SupportedKind kind(String network) {
    return new SupportedKind(2, "exact", network, null);
  }

  public static SupportedKind kind(String network, Map<String, Object> extra) {
    return new SupportedKind(2, "exact", network, extra);
  }

  public static SupportedResponse supported(SupportedKind... kinds) {
    return new SupportedResponse(List.of(kinds), List.of(), Map.of());
  }

  public static SupportedResponse supported(List<String> extensions, SupportedKind... kinds) {
    return new SupportedResponse(List.of(kinds), extensions, Map.of());
  }

  public static PaymentRequirements requirements(String network, String amount) {
    return new PaymentRequirements("exact", network, USDM, amount, PAY_TO, 300, Map.of());
  }

  public static PaymentRequirements requirements() {
    return requirements(PREPROD, "10000");
  }

  public static PaymentPayload payload(PaymentRequirements accepted) {
    return new PaymentPayload(2, ResourceInfo.of("https://api.example.com/x"), accepted,
        Map.of("transaction", "tx"), null);
  }

  public static PaymentRequired paymentRequired(PaymentRequirements... accepts) {
    return new PaymentRequired(2, null, ResourceInfo.of("https://api.example.com/x"),
        List.of(accepts), null);
  }

  public static SettleResponse settled(String network) {
    return SettleResponse.success("tx-" + network, network, "payer");
  }

  public static SettleResponse pending(String network, String tx) {
    return new SettleResponse(false, SettleResponse.SETTLEMENT_PENDING, null, null, tx, network,
        null, null, null, null);
  }

  public static Map<String, Object> map(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      m.put((String) kv[i], kv[i + 1]);
    }
    return m;
  }
}
