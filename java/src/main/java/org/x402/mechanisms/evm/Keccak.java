package org.x402.mechanisms.evm;

import org.bouncycastle.crypto.digests.KeccakDigest;

import java.util.Objects;

/**
 * Keccak-256, the hash function Ethereum uses for addresses, EIP-712 and transaction signing.
 *
 * <p>This is the original Keccak submission with {@code 0x01} padding, not the NIST SHA3-256 standard; the
 * two produce different digests. For example {@code keccak256("")} is
 * {@code 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470}.
 *
 * <p>This class is stateless and thread-safe: every call uses a fresh digest instance.
 */
public final class Keccak {

    /** Length of a Keccak-256 digest in bytes. */
    public static final int DIGEST_LENGTH = 32;

    private Keccak() {
    }

    /**
     * Hashes the concatenation of {@code parts}, e.g. {@code keccak256(prefix, domainSeparator, structHash)}.
     *
     * @param parts the byte arrays to hash, in order; none may be {@code null}
     * @return the 32-byte digest
     */
    public static byte[] keccak256(byte[]... parts) {
        Objects.requireNonNull(parts, "parts");
        KeccakDigest digest = new KeccakDigest(256);
        for (byte[] part : parts) {
            Objects.requireNonNull(part, "part");
            digest.update(part, 0, part.length);
        }
        byte[] out = new byte[DIGEST_LENGTH];
        digest.doFinal(out, 0);
        return out;
    }
}
