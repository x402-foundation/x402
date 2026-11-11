package org.x402.mechanisms.cardano.exact.client;

/**
 * A signed, unbroadcast payment.
 *
 * @param transaction base64 signed transaction CBOR
 * @param nonce the consumed UTxO reference {@code txHash#index}
 */
public record ClientCardanoSignResult(String transaction, String nonce) {}
