package org.x402.spring;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.Price;
import org.x402.core.types.SupportedKind;
import org.x402.core.utils.Amounts;

/**
 * A server scheme for the starter tests: {@code $x} and {@code x USDM} become x × 10⁶ {@code USDM};
 * any other ticker is refused (for example {@code "1.5 ADA"}). Transfer methods: {@code default}
 * (authorization) and {@code prepaid} (upfront).
 */
public final class TestServerScheme implements SchemeNetworkServer {

  /** The default stablecoin of the test networks. */
  public static final String USDM = "USDM";

  private final String scheme;

  /** An {@code exact} scheme. */
  public TestServerScheme() {
    this("exact");
  }

  /**
   * A scheme with another name.
   *
   * @param scheme the scheme name
   */
  public TestServerScheme(String scheme) {
    this.scheme = scheme;
  }

  @Override
  public String scheme() {
    return scheme;
  }

  @Override
  public String defaultAssetTransferMethod() {
    return "default";
  }

  @Override
  public Map<String, PaymentFlow.Config> paymentFlows() {
    Map<String, PaymentFlow.Config> flows = new LinkedHashMap<>();
    flows.put("default", PaymentFlow.Config.authorizationOnly());
    flows.put("prepaid", new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT), PaymentFlow.UPFRONT));
    return flows;
  }

  @Override
  public AssetAmount parsePrice(Price price, String network) {
    if (price instanceof AssetAmount a) {
      return a;
    }
    Amounts.ParsedMoney parsed = Amounts.parseMoney(((Money) price).value());
    if (parsed.symbol() != null && !parsed.symbol().equals(USDM)) {
      throw new IllegalArgumentException("unknown ticker " + parsed.symbol());
    }
    String atomic = new BigDecimal(parsed.amount()).movePointRight(6).toBigInteger().toString();
    return AssetAmount.of(USDM, atomic);
  }

  @Override
  public PaymentRequirements enhancePaymentRequirements(
      PaymentRequirements requirements, SupportedKind supportedKind, List<String> extensions) {
    Object feePayer = supportedKind.extra() == null ? null : supportedKind.extra().get("feePayer");
    return feePayer == null ? requirements : requirements.withExtra("feePayer", feePayer);
  }

  @Override
  public Integer getAssetDecimals(String asset, String network) {
    return 6;
  }
}
