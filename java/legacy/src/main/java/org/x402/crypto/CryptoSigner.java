package org.x402.crypto;

import java.util.Map;

/**
 * Produces a protocol-specific signature for an <em>x402 payment-authorization payload</em>.
 *
 * <p>The caller decides which concrete signer to use (e.g. by scheme ID or DI).
 * Each implementation MUST interpret the {@code payload} keys as defined by its
 * payment scheme and return the scheme’s canonical encoding:</p>
 *
 * <ul>
 *   <li><b>exact-evm</b> – ERC-3009 <strong>transferWithAuthorization</strong><br>
 *       keys: {@code from,to,value,validAfter,validBefore,nonce}<br>
 *       return: 0x-prefixed 65-byte hex string {@code r∥s∥v} (v = 27 or 28)</li>
 *
 *   <li><b>exact-solana</b> – Ed25519 over the canonical JSON payload<br>
 *       return: Base58-encoded 64-byte signature</li>
 * </ul>
 *
 * <p>Implementations should throw {@link IllegalArgumentException} for missing
 * or mistyped fields and {@link CryptoSignException} for low-level crypto
 * errors.</p>
 */
public interface CryptoSigner {

    /**
     * Signs the supplied payload and returns the signature.
     *
     * @param payload scheme-specific authorization fields
     * @return encoded signature string (see scheme rules above)
     * @throws IllegalArgumentException for malformed payloads
     * @throws CryptoSignException      for cryptographic failures
     */
    String sign(Map<String, Object> payload) throws CryptoSignException;
}

