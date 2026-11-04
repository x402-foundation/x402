package org.x402;

import org.x402.types.PaymentRequirements;

import java.util.Map;
import java.util.OptionalInt;

/**
 * Client side of a payment scheme on one network family: turns {@link PaymentRequirements} into a signed
 * scheme payload.
 *
 * <p>Implementations are registered on an {@link X402Client} for a network or a {@code namespace:*}
 * wildcard and must be thread-safe.
 */
public interface SchemeNetworkClient {

    /**
     * Returns the scheme this client implements, e.g. {@code "exact"}.
     *
     * @return the scheme id
     */
    String scheme();

    /**
     * Creates the scheme-specific payload that becomes {@code PaymentPayload.payload}.
     *
     * <p>The caller wraps the result with the protocol version, the accepted requirements and the resource,
     * so implementations only produce the inner payload, e.g. an EIP-3009 {@code signature} and
     * {@code authorization}.
     *
     * @param requirements the requirements selected for payment
     * @return the inner payload
     * @throws PaymentException if the payload cannot be created, e.g. the amount is malformed or signing fails
     */
    Map<String, Object> createPaymentPayload(PaymentRequirements requirements);

    /**
     * Returns whether this client can pay {@code requirements}, which already match its scheme and network.
     * {@link X402Client} skips options for which this returns {@code false}, e.g. an asset transfer method the
     * scheme does not implement, so it never selects an option it cannot sign.
     *
     * @param requirements an offered option
     * @return {@code true} if {@link #createPaymentPayload} can handle it; the default accepts every option
     */
    default boolean supports(PaymentRequirements requirements) {
        return true;
    }

    /**
     * Returns the decimals of {@code asset} when it is one of this scheme's default assets on
     * {@code network}. Used by spend controls to convert a USD cap into atomic units.
     *
     * @param asset the token address
     * @param network the CAIP-2 network
     * @return the decimals, or empty when the asset is not a known default asset
     */
    default OptionalInt defaultAssetDecimals(String asset, String network) {
        return OptionalInt.empty();
    }
}
