package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Map;
import java.util.Objects;

/**
 * An exact amount of one asset in atomic units.
 *
 * @param asset the asset identifier
 * @param amount the amount in atomic units
 * @param extra optional data merged under the requirements' {@code extra}
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"asset", "amount", "extra"})
public record AssetAmount(String asset, String amount, Map<String, Object> extra) implements Price {

  /** Validates and copies. */
  public AssetAmount {
    Objects.requireNonNull(amount, "amount");
    extra = Collections2.copyMap(extra);
  }

  /**
   * Creates an asset amount without extra data.
   *
   * @param asset the asset
   * @param amount the atomic amount
   * @return the asset amount
   */
  public static AssetAmount of(String asset, String amount) {
    return new AssetAmount(asset, amount, null);
  }
}
