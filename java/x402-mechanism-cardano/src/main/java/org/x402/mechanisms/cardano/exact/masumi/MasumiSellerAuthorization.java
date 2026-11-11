package org.x402.mechanisms.cardano.exact.masumi;

/**
 * The seller's CIP-30 {@code signData} result as the wire carries it.
 *
 * @param key complete CBOR COSE_Key, lowercase hex
 * @param signature complete CBOR COSE_Sign1, lowercase hex
 */
public record MasumiSellerAuthorization(String key, String signature) {}
