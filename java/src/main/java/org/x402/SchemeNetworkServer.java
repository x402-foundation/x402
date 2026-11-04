package org.x402;

import org.x402.types.PaymentRequirements;
import org.x402.types.SupportedKind;

/**
 * Resource-server side of a payment scheme: converts prices into assets and completes the
 * {@link PaymentRequirements} advertised to clients.
 *
 * <p>Implementations are registered on an {@link X402ResourceServer} for a concrete CAIP-2 network and
 * must be thread-safe.
 */
public interface SchemeNetworkServer {

    /**
     * Returns the scheme this server implements, e.g. {@code "exact"}.
     *
     * @return the scheme id
     */
    String scheme();

    /**
     * Converts a price into an amount of a concrete asset.
     *
     * @param price the configured price
     * @param network the CAIP-2 network the price applies to
     * @return the asset amount in atomic units
     * @throws IllegalArgumentException if the price cannot be expressed on {@code network}
     */
    AssetAmount parsePrice(Price price, String network);

    /**
     * Completes requirements built from route configuration, e.g. by adding the EIP-712 domain to
     * {@code extra}.
     *
     * @param requirements the requirements built from the parsed price
     * @param supportedKind the matching kind advertised by the facilitator
     * @return the completed requirements
     * @throws IllegalArgumentException if the requirements cannot be completed
     */
    PaymentRequirements enhancePaymentRequirements(PaymentRequirements requirements, SupportedKind supportedKind);
}
