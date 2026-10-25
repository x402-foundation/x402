package org.x402.mechanisms.cardano.exact.masumi;

import org.x402.core.types.ResourceInfo;

/**
 * A Masumi V2 registry claim to validate.
 *
 * @param agentIdentifier the non-empty {@code terms.agentIdentifier}
 * @param sellerAddress the address the terms are signed by
 * @param network the x402 network
 * @param amount the signed amount
 * @param asset the signed asset
 * @param resource the protected resource whose URL must match the registry endpoint
 */
public record MasumiRegistryClaim(
    String agentIdentifier, String sellerAddress, String network, String amount, String asset, ResourceInfo resource) {}
