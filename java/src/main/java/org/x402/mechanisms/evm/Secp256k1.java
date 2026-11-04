package org.x402.mechanisms.evm;

import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.ec.CustomNamedCurves;
import org.bouncycastle.crypto.params.ECDomainParameters;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.signers.ECDSASigner;
import org.bouncycastle.crypto.signers.HMacDSAKCalculator;
import org.bouncycastle.math.ec.ECAlgorithms;
import org.bouncycastle.math.ec.ECPoint;
import org.bouncycastle.math.ec.FixedPointCombMultiplier;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Objects;

/**
 * ECDSA over secp256k1 as used by Ethereum externally owned accounts.
 *
 * <p>Signing is deterministic (RFC 6979 with HMAC-SHA256) and always returns a low-s signature
 * ({@code s <= n/2}, EIP-2), so the same key and digest produce the same signature as other Ethereum tooling
 * such as foundry's {@code cast wallet sign --no-hash}. Recovery accepts both low-s and high-s signatures, like
 * the {@code ecrecover} precompile; callers that must reject malleable signatures check
 * {@link Signature#isCanonical()} or {@link #isCanonical(byte[])}.
 *
 * <p>Digests are 32-byte hashes that the caller computed, e.g. an EIP-712 digest; nothing here hashes the
 * input again. Public keys are SEC1 encoded: 65-byte uncompressed {@code 0x04 || X || Y}.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class Secp256k1 {

    private static final X9ECParameters CURVE_PARAMS = CustomNamedCurves.getByName("secp256k1");
    private static final ECDomainParameters DOMAIN = new ECDomainParameters(
            CURVE_PARAMS.getCurve(), CURVE_PARAMS.getG(), CURVE_PARAMS.getN(), CURVE_PARAMS.getH());

    /** The order {@code n} of the secp256k1 base point. Private keys and signature scalars lie in {@code [1, n)}. */
    public static final BigInteger CURVE_ORDER = CURVE_PARAMS.getN();

    /** {@code n / 2}, the largest {@code s} a canonical (low-s) signature may carry. */
    public static final BigInteger HALF_CURVE_ORDER = CURVE_ORDER.shiftRight(1);

    /** Length of a serialized {@code r || s || v} signature in bytes. */
    public static final int SIGNATURE_LENGTH = 65;

    /** Length of a message digest in bytes. */
    public static final int DIGEST_LENGTH = 32;

    private static final int SCALAR_LENGTH = 32;
    private static final int UNCOMPRESSED_LENGTH = 65;
    private static final int RAW_PUBLIC_KEY_LENGTH = 64;
    private static final int COMPRESSED_LENGTH = 33;
    private static final byte UNCOMPRESSED_TAG = 0x04;
    private static final int V_OFFSET = 27;

    private Secp256k1() {
    }

    /**
     * An ECDSA signature with its recovery id.
     *
     * <p>{@link #toString()} omits {@code r} and {@code s}: an unsettled EIP-3009 signature authorizes a transfer
     * and should not end up in logs.
     *
     * @param r the {@code r} scalar, in {@code [1, n)}
     * @param s the {@code s} scalar, in {@code [1, n)}; canonical signatures have {@code s <= n/2}
     * @param recoveryId the recovery id, {@code 0} or {@code 1}, i.e. the parity of the ephemeral point's
     *     {@code y} coordinate
     */
    public record Signature(BigInteger r, BigInteger s, int recoveryId) {

        /**
         * Creates a signature.
         *
         * @throws IllegalArgumentException if {@code r} or {@code s} is outside {@code [1, n)} or
         *     {@code recoveryId} is not 0 or 1
         */
        public Signature {
            requireScalar(Objects.requireNonNull(r, "r"), "r");
            requireScalar(Objects.requireNonNull(s, "s"), "s");
            if (recoveryId != 0 && recoveryId != 1) {
                throw new IllegalArgumentException("Recovery id must be 0 or 1, got " + recoveryId);
            }
        }

        /**
         * Parses a 65-byte {@code r || s || v} signature. {@code r} and {@code s} are 32-byte big-endian
         * integers; {@code v} is {@code 27} or {@code 28}, or the raw recovery id {@code 0} or {@code 1}.
         *
         * @param signature the serialized signature
         * @return the parsed signature
         * @throws IllegalArgumentException if the signature is not 65 bytes, {@code v} is not one of 0, 1, 27, 28,
         *     or {@code r} or {@code s} is outside {@code [1, n)}
         */
        public static Signature fromBytes(byte[] signature) {
            Objects.requireNonNull(signature, "signature");
            if (signature.length != SIGNATURE_LENGTH) {
                throw new IllegalArgumentException(
                        "Signature must be " + SIGNATURE_LENGTH + " bytes, got " + signature.length);
            }
            BigInteger r = new BigInteger(1, Arrays.copyOfRange(signature, 0, SCALAR_LENGTH));
            BigInteger s = new BigInteger(1, Arrays.copyOfRange(signature, SCALAR_LENGTH, 2 * SCALAR_LENGTH));
            int v = signature[2 * SCALAR_LENGTH] & 0xff;
            int recoveryId = v >= V_OFFSET ? v - V_OFFSET : v;
            if (recoveryId != 0 && recoveryId != 1) {
                throw new IllegalArgumentException("Signature v must be 27, 28, 0 or 1, got " + v);
            }
            return new Signature(r, s, recoveryId);
        }

        /**
         * Returns the Ethereum {@code v} value, {@code 27 + recoveryId}.
         *
         * @return 27 or 28
         */
        public int v() {
            return V_OFFSET + recoveryId;
        }

        /**
         * Returns whether {@code s <= n/2}, the canonical form required by EIP-2 and by x402 facilitators.
         *
         * @return {@code true} for a low-s signature
         */
        public boolean isCanonical() {
            return s.compareTo(HALF_CURVE_ORDER) <= 0;
        }

        /**
         * Serializes the signature as 65 bytes {@code r || s || v}, with {@code r} and {@code s} as 32-byte
         * big-endian integers and {@code v} as 27 or 28.
         *
         * @return the serialized signature
         */
        public byte[] toBytes() {
            byte[] out = new byte[SIGNATURE_LENGTH];
            System.arraycopy(Uint256.toBytes(r), 0, out, 0, SCALAR_LENGTH);
            System.arraycopy(Uint256.toBytes(s), 0, out, SCALAR_LENGTH, SCALAR_LENGTH);
            out[2 * SCALAR_LENGTH] = (byte) v();
            return out;
        }

        @Override
        public String toString() {
            return "Signature[recoveryId=" + recoveryId + ", canonical=" + isCanonical() + "]";
        }
    }

    /**
     * Signs a 32-byte digest with RFC 6979 deterministic nonces and low-s normalization.
     *
     * @param digest the 32-byte digest to sign, used as is
     * @param privateKey the private key, in {@code [1, n)}
     * @return the canonical signature with its recovery id
     * @throws IllegalArgumentException if {@code digest} is not 32 bytes or {@code privateKey} is out of range
     */
    public static Signature sign(byte[] digest, BigInteger privateKey) {
        requireDigest(digest);
        requirePrivateKey(privateKey);
        ECDSASigner signer = new ECDSASigner(new HMacDSAKCalculator(SHA256Digest.newInstance()));
        signer.init(true, new ECPrivateKeyParameters(privateKey, DOMAIN));
        BigInteger[] rs = signer.generateSignature(digest);
        BigInteger r = rs[0];
        BigInteger s = rs[1].compareTo(HALF_CURVE_ORDER) > 0 ? CURVE_ORDER.subtract(rs[1]) : rs[1];

        ECPoint publicKey = publicPoint(privateKey);
        for (int recoveryId = 0; recoveryId <= 1; recoveryId++) {
            if (publicKey.equals(recoverPoint(digest, r, s, recoveryId))) {
                return new Signature(r, s, recoveryId);
            }
        }
        // Only reachable when the ephemeral point's x coordinate is >= n (recovery ids 2 and 3), which happens with
        // probability below 2^-127 and cannot be expressed in an Ethereum v of 27 or 28
        throw new IllegalStateException("Could not determine the recovery id of a freshly created signature");
    }

    /**
     * Derives the public key of a private key.
     *
     * @param privateKey the private key, in {@code [1, n)}
     * @return the 65-byte uncompressed SEC1 public key {@code 0x04 || X || Y}
     * @throws IllegalArgumentException if {@code privateKey} is out of range
     */
    public static byte[] publicKey(BigInteger privateKey) {
        requirePrivateKey(privateKey);
        return publicPoint(privateKey).getEncoded(false);
    }

    /**
     * Recovers the public key that produced a signature over a digest.
     *
     * @param digest the 32-byte signed digest
     * @param signature the signature; high-s signatures are accepted
     * @return the 65-byte uncompressed SEC1 public key
     * @throws IllegalArgumentException if {@code digest} is not 32 bytes or no public key matches the signature
     */
    public static byte[] recoverPublicKey(byte[] digest, Signature signature) {
        requireDigest(digest);
        Objects.requireNonNull(signature, "signature");
        ECPoint point = recoverPoint(digest, signature.r(), signature.s(), signature.recoveryId());
        if (point == null) {
            throw new IllegalArgumentException("Signature does not recover to a public key");
        }
        return point.getEncoded(false);
    }

    /**
     * Recovers the EIP-55 checksummed address that produced a signature over a digest.
     *
     * @param digest the 32-byte signed digest
     * @param signature the signature; high-s signatures are accepted
     * @return the signer address
     * @throws IllegalArgumentException if {@code digest} is not 32 bytes or no public key matches the signature
     */
    public static String recoverAddress(byte[] digest, Signature signature) {
        return EvmAddress.fromPublicKey(recoverPublicKey(digest, signature));
    }

    /**
     * Recovers the EIP-55 checksummed address that produced a serialized {@code r || s || v} signature.
     *
     * @param digest the 32-byte signed digest
     * @param signature the 65-byte signature, see {@link Signature#fromBytes(byte[])}
     * @return the signer address
     * @throws IllegalArgumentException if either argument is malformed or no public key matches the signature
     */
    public static String recoverAddress(byte[] digest, byte[] signature) {
        return recoverAddress(digest, Signature.fromBytes(signature));
    }

    /**
     * Returns whether a serialized signature is 65 bytes long and has a low {@code s} ({@code s <= n/2}). Only the
     * length and {@code s} are inspected.
     *
     * @param signature the serialized {@code r || s || v} signature
     * @return {@code true} if the signature is 65 bytes with a canonical {@code s}
     */
    public static boolean isCanonical(byte[] signature) {
        Objects.requireNonNull(signature, "signature");
        if (signature.length != SIGNATURE_LENGTH) {
            return false;
        }
        BigInteger s = new BigInteger(1, Arrays.copyOfRange(signature, SCALAR_LENGTH, 2 * SCALAR_LENGTH));
        return s.compareTo(HALF_CURVE_ORDER) <= 0;
    }

    /**
     * Parses a hex private key, with or without a {@code 0x} prefix.
     *
     * @param hex exactly 64 hex digits
     * @return the private key
     * @throws IllegalArgumentException if {@code hex} is not 32 bytes of hex or the key is outside
     *     {@code [1, n)}; the message never contains the key
     */
    public static BigInteger parsePrivateKey(String hex) {
        Objects.requireNonNull(hex, "hex");
        byte[] bytes;
        try {
            bytes = Hex.decode(hex, SCALAR_LENGTH);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Private key must be 32 bytes of hex (64 digits)", e);
        }
        BigInteger key = new BigInteger(1, bytes);
        requirePrivateKey(key);
        return key;
    }

    /**
     * Normalizes a public key to its 65-byte uncompressed SEC1 form, checking that it lies on the curve.
     *
     * @param publicKey a 65-byte uncompressed, 33-byte compressed or 64-byte raw {@code X || Y} public key
     * @return the 65-byte uncompressed encoding
     * @throws IllegalArgumentException if the bytes are not a valid secp256k1 point
     */
    static byte[] uncompressedPublicKey(byte[] publicKey) {
        Objects.requireNonNull(publicKey, "publicKey");
        byte[] encoded = publicKey;
        if (publicKey.length == RAW_PUBLIC_KEY_LENGTH) {
            encoded = new byte[UNCOMPRESSED_LENGTH];
            encoded[0] = UNCOMPRESSED_TAG;
            System.arraycopy(publicKey, 0, encoded, 1, RAW_PUBLIC_KEY_LENGTH);
        } else if (publicKey.length != UNCOMPRESSED_LENGTH && publicKey.length != COMPRESSED_LENGTH) {
            throw new IllegalArgumentException("Public key must be 33, 64 or 65 bytes, got " + publicKey.length);
        }
        try {
            // decodePoint checks the point is on the curve; the infinity encoding is 1 byte, excluded above
            return DOMAIN.getCurve().decodePoint(encoded).getEncoded(false);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Public key is not a valid secp256k1 point", e);
        }
    }

    /**
     * Recovers the public point for one recovery id (SEC 1 v2, section 4.1.6), or returns {@code null} when
     * {@code r} is not the x coordinate of a curve point or the result is the point at infinity.
     */
    private static ECPoint recoverPoint(byte[] digest, BigInteger r, BigInteger s, int recoveryId) {
        byte[] compressed = new byte[COMPRESSED_LENGTH];
        compressed[0] = (byte) (recoveryId == 1 ? 0x03 : 0x02);
        System.arraycopy(Uint256.toBytes(r), 0, compressed, 1, SCALAR_LENGTH);
        ECPoint ephemeral;
        try {
            ephemeral = DOMAIN.getCurve().decodePoint(compressed);
        } catch (IllegalArgumentException e) {
            return null;
        }
        BigInteger n = CURVE_ORDER;
        BigInteger e = new BigInteger(1, digest);
        BigInteger rInverse = r.modInverse(n);
        BigInteger u1 = n.subtract(e).multiply(rInverse).mod(n);
        BigInteger u2 = s.multiply(rInverse).mod(n);
        ECPoint q = ECAlgorithms.sumOfTwoMultiplies(DOMAIN.getG(), u1, ephemeral, u2).normalize();
        return q.isInfinity() ? null : q;
    }

    private static ECPoint publicPoint(BigInteger privateKey) {
        return new FixedPointCombMultiplier().multiply(DOMAIN.getG(), privateKey).normalize();
    }

    private static void requireDigest(byte[] digest) {
        Objects.requireNonNull(digest, "digest");
        if (digest.length != DIGEST_LENGTH) {
            throw new IllegalArgumentException("Digest must be " + DIGEST_LENGTH + " bytes, got " + digest.length);
        }
    }

    private static void requirePrivateKey(BigInteger privateKey) {
        Objects.requireNonNull(privateKey, "privateKey");
        if (privateKey.signum() <= 0 || privateKey.compareTo(CURVE_ORDER) >= 0) {
            throw new IllegalArgumentException("Private key is outside the secp256k1 range [1, n)");
        }
    }

    private static void requireScalar(BigInteger value, String name) {
        if (value.signum() <= 0 || value.compareTo(CURVE_ORDER) >= 0) {
            throw new IllegalArgumentException("Signature " + name + " is outside [1, n)");
        }
    }
}
