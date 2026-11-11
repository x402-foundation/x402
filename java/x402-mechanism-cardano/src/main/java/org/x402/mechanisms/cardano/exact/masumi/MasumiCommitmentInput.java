package org.x402.mechanisms.cardano.exact.masumi;

/**
 * One request part the issuer commits to.
 *
 * @param name unique non-empty part name
 * @param canonicalization {@code jcs} or {@code raw}
 * @param mediaType optional media type, or {@code null}
 * @param content JSON content for {@code jcs}, unpadded base64url for {@code raw}
 * @param echoContent whether {@code content} goes on the wire (required for issuer-originated
 *     content)
 */
public record MasumiCommitmentInput(
    String name, String canonicalization, String mediaType, Object content, boolean echoContent) {}
