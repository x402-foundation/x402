package org.x402;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * An amount of a specific token, in the token's atomic units.
 *
 * @param amount the amount in atomic units, as a non-negative decimal integer string
 * @param asset the token contract address
 * @param extra optional scheme-specific data merged into {@code PaymentRequirements.extra}
 */
public record AssetAmount(String amount, String asset, Map<String, Object> extra) implements Price {

    /** Creates an asset amount, copying {@code extra}. */
    public AssetAmount {
        Objects.requireNonNull(amount, "amount");
        Objects.requireNonNull(asset, "asset");
        extra = extra == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(extra));
    }

    /**
     * Creates an asset amount without extra data.
     *
     * @param amount the amount in atomic units
     * @param asset the token contract address
     * @return the asset amount
     */
    public static AssetAmount of(String amount, String asset) {
        return new AssetAmount(amount, asset, null);
    }
}
