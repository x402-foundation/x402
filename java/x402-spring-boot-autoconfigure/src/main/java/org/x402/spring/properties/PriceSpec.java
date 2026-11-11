package org.x402.spring.properties;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.Price;

/**
 * A {@code price} value: a money string (e.g. {@code "$0.50"}, {@code "0.50 USDM"}) bound by
 * {@link PriceSpecConverter}, or an object {@code {amount, asset, extra}} bound by the binder.
 */
public final class PriceSpec {

  private final String money;
  private final String amount;
  private final String asset;
  private final Map<String, Object> extra;

  /**
   * The object form: an explicit amount of a named asset.
   *
   * @param amount the amount in atomic units
   * @param asset the asset identifier
   * @param extra asset data merged below the option's {@code extra}
   */
  @ConstructorBinding
  public PriceSpec(String amount, String asset, Map<String, Object> extra) {
    this(null, amount, asset, extra);
  }

  private PriceSpec(String money, String amount, String asset, Map<String, Object> extra) {
    this.money = money;
    this.amount = amount;
    this.asset = asset;
    this.extra = extra == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(extra));
  }

  /**
   * The money form.
   *
   * @param money a money string
   * @return the spec
   */
  public static PriceSpec money(String money) {
    return new PriceSpec(Objects.requireNonNull(money, "money"), null, null, null);
  }

  /**
   * The money string, or {@code null} for the object form.
   *
   * @return the money string
   */
  public String money() {
    return money;
  }

  /**
   * The atomic amount of the object form.
   *
   * @return the amount, or {@code null}
   */
  public String amount() {
    return amount;
  }

  /**
   * The asset of the object form.
   *
   * @return the asset, or {@code null}
   */
  public String asset() {
    return asset;
  }

  /**
   * The asset data of the object form.
   *
   * @return the extra map, empty when absent
   */
  public Map<String, Object> extra() {
    return extra;
  }

  /**
   * Whether this is the money form.
   *
   * @return {@code true} for a money string
   */
  public boolean isMoney() {
    return money != null;
  }

  /**
   * The core price.
   *
   * @return a {@link Money} or an {@link AssetAmount}
   * @throws IllegalArgumentException when the object form lacks {@code amount} or {@code asset}
   */
  public Price toPrice() {
    if (money != null) {
      return new Money(money);
    }
    if (amount == null || amount.isBlank() || asset == null || asset.isBlank()) {
      throw new IllegalArgumentException("a price object needs both amount and asset");
    }
    return new AssetAmount(asset, amount, extra.isEmpty() ? null : extra);
  }

  @Override
  public String toString() {
    return money != null ? money : "{amount=" + amount + ", asset=" + asset + ", extra=" + extra
        + "}";
  }
}
