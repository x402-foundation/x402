package org.x402.mechanisms.cardano.utils;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.x402.core.SchemeNetworkClient.DefaultAsset;

/**
 * USD-pegged default assets per network Index 0 is what {@code
 * "$0.10"} means. Preview has none; lovelace is never a default.
 */
public final class DefaultAssets {

  /** The table: USDM on mainnet and preprod. */
  public static final Map<String, List<DefaultAsset>> TABLE =
      Map.of(
          CardanoNetworks.MAINNET,
          List.of(new DefaultAsset(CardanoConstants.USDM_MAINNET_ASSET, CardanoConstants.USDM_DECIMALS, "USDM")),
          CardanoNetworks.PREPROD,
          List.of(new DefaultAsset(CardanoConstants.USDM_PREPROD_ASSET, CardanoConstants.USDM_DECIMALS, "USDM")));

  private DefaultAssets() {}

  /**
   * Looks up a default asset by network and optional ticker.
   *
   * @param network the network (CIP-34 aliases accepted)
   * @param symbol the ticker, or {@code null} for the network default
   * @return the entry
   * @throws IllegalArgumentException when the network or symbol is unknown
   */
  public static DefaultAsset get(String network, String symbol) {
    List<DefaultAsset> assets = TABLE.get(CardanoNetworks.normalize(network));
    if (assets == null || assets.isEmpty()) {
      throw new IllegalArgumentException("No default asset configured for network " + network);
    }
    if (symbol == null || symbol.isEmpty()) {
      return assets.get(0);
    }
    String normalized = symbol.toUpperCase(Locale.ROOT);
    return assets.stream()
        .filter(a -> a.symbol().toUpperCase(Locale.ROOT).equals(normalized))
        .findFirst()
        .orElseThrow(
            () ->
                new IllegalArgumentException(
                    "No " + symbol + " default asset configured for network " + network));
  }

  /**
   * Reverse lookup by asset unit (case-insensitive) and network.
   *
   * @param asset the asset unit
   * @param network the network
   * @return the entry, or {@code null}
   */
  public static DefaultAsset find(String asset, String network) {
    List<DefaultAsset> assets = TABLE.get(CardanoNetworks.normalize(network));
    if (assets == null || asset == null) {
      return null;
    }
    String normalized = asset.toLowerCase(Locale.ROOT);
    return assets.stream()
        .filter(a -> a.asset().toLowerCase(Locale.ROOT).equals(normalized))
        .findFirst()
        .orElse(null);
  }
}
