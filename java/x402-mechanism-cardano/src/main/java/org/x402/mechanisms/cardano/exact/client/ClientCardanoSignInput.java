package org.x402.mechanisms.cardano.exact.client;

import java.util.Map;
import org.x402.core.types.ResourceInfo;

/**
 * What a signer is asked to pay.
 *
 * @param network the x402 network
 * @param payTo the recipient
 * @param asset the asset unit
 * @param amount atomic amount
 * @param maxTimeoutSeconds the validity window
 * @param extra the requirements' {@code extra}
 * @param resource the protected resource, or {@code null} when none is known
 */
public record ClientCardanoSignInput(
    String network,
    String payTo,
    String asset,
    String amount,
    int maxTimeoutSeconds,
    Map<String, Object> extra,
    ResourceInfo resource) {}
