package org.x402.mechanisms.evm;

import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.ec.CustomNamedCurves;
import org.bouncycastle.crypto.params.ECDomainParameters;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.signers.ECDSASigner;
import org.bouncycastle.crypto.signers.HMacDSAKCalculator;
import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_KEY_1;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_PUBLIC_KEY_0;
import static org.x402.mechanisms.evm.CastVectors.BASE_MAX_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.BASE_MAX_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.BASE_SEPOLIA_SIGNATURE;
import static org.x402.mechanisms.evm.CastVectors.HIGH_S_DIGEST;
import static org.x402.mechanisms.evm.CastVectors.HIGH_S_DIGEST_SIGNATURE;

class Secp256k1Test {

    private static final BigInteger KEY_0 = Secp256k1.parsePrivateKey(ANVIL_KEY_0);
    private static final BigInteger KEY_1 = Secp256k1.parsePrivateKey(ANVIL_KEY_1);

    @Test
    void curveOrderMatchesSecp256k1() {
        // n from SEC 2, section 2.4.1
        assertEquals(new BigInteger("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16),
                Secp256k1.CURVE_ORDER);
        assertEquals(Secp256k1.CURVE_ORDER.shiftRight(1), Secp256k1.HALF_CURVE_ORDER);
    }

    @Test
    void derivesUncompressedPublicKey() {
        String expected = "0x04" + Hex.stripPrefix(ANVIL_PUBLIC_KEY_0);

        assertEquals(expected, Hex.encode(Secp256k1.publicKey(KEY_0)));
    }

    @Test
    void signsLikeCast() {
        assertEquals(BASE_SEPOLIA_SIGNATURE,
                Hex.encode(Secp256k1.sign(Hex.decode(BASE_SEPOLIA_DIGEST), KEY_0).toBytes()));
        assertEquals(BASE_MAX_SIGNATURE, Hex.encode(Secp256k1.sign(Hex.decode(BASE_MAX_DIGEST), KEY_1).toBytes()));
    }

    @Test
    void normalizesHighSToLowS() {
        byte[] digest = Hex.decode(HIGH_S_DIGEST);
        BigInteger rawS = rawRfc6979S(digest, KEY_0);

        Secp256k1.Signature signature = Secp256k1.sign(digest, KEY_0);

        assertTrue(rawS.compareTo(Secp256k1.HALF_CURVE_ORDER) > 0, "fixture must produce a high raw s");
        assertEquals(Secp256k1.CURVE_ORDER.subtract(rawS), signature.s());
        assertTrue(signature.isCanonical());
        assertEquals(HIGH_S_DIGEST_SIGNATURE, Hex.encode(signature.toBytes()));
    }

    @Test
    void recoversSignerAddressFromCastSignature() {
        assertEquals(ANVIL_ADDRESS_0,
                Secp256k1.recoverAddress(Hex.decode(BASE_SEPOLIA_DIGEST), Hex.decode(BASE_SEPOLIA_SIGNATURE)));
        assertEquals(ANVIL_ADDRESS_1,
                Secp256k1.recoverAddress(Hex.decode(BASE_MAX_DIGEST), Hex.decode(BASE_MAX_SIGNATURE)));
    }

    @Test
    void acceptsRawRecoveryIdAsV() {
        byte[] signature = Hex.decode(BASE_SEPOLIA_SIGNATURE);
        signature[64] = (byte) (signature[64] - 27);

        assertEquals(ANVIL_ADDRESS_0, Secp256k1.recoverAddress(Hex.decode(BASE_SEPOLIA_DIGEST), signature));
    }

    @Test
    void wrongRecoveryIdRecoversAnotherAddress() {
        Secp256k1.Signature signature = Secp256k1.Signature.fromBytes(Hex.decode(BASE_SEPOLIA_SIGNATURE));
        Secp256k1.Signature flipped = new Secp256k1.Signature(signature.r(), signature.s(), 1 - signature.recoveryId());

        assertNotEquals(ANVIL_ADDRESS_0, Secp256k1.recoverAddress(Hex.decode(BASE_SEPOLIA_DIGEST), flipped));
    }

    @Test
    void recoversMalleatedHighSSignatureButReportsItNonCanonical() {
        byte[] digest = Hex.decode(BASE_SEPOLIA_DIGEST);
        Secp256k1.Signature low = Secp256k1.Signature.fromBytes(Hex.decode(BASE_SEPOLIA_SIGNATURE));
        Secp256k1.Signature high = new Secp256k1.Signature(
                low.r(), Secp256k1.CURVE_ORDER.subtract(low.s()), 1 - low.recoveryId());

        assertEquals(ANVIL_ADDRESS_0, Secp256k1.recoverAddress(digest, high));
        assertFalse(high.isCanonical());
        assertFalse(Secp256k1.isCanonical(high.toBytes()));
        assertTrue(Secp256k1.isCanonical(low.toBytes()));
    }

    @Test
    void isCanonicalRequires65Bytes() {
        assertFalse(Secp256k1.isCanonical(new byte[64]));
        assertFalse(Secp256k1.isCanonical(new byte[66]));
    }

    @Test
    void signatureRoundTripsThroughBytes() {
        byte[] bytes = Hex.decode(BASE_SEPOLIA_SIGNATURE);

        Secp256k1.Signature signature = Secp256k1.Signature.fromBytes(bytes);

        assertEquals(28, signature.v());
        assertEquals(1, signature.recoveryId());
        assertEquals(BASE_SEPOLIA_SIGNATURE, Hex.encode(signature.toBytes()));
    }

    @Test
    void rejectsMalformedSignatures() {
        byte[] valid = Hex.decode(BASE_SEPOLIA_SIGNATURE);
        byte[] badV = valid.clone();
        badV[64] = 29;
        byte[] smallBadV = valid.clone();
        smallBadV[64] = 2;
        byte[] zeroR = valid.clone();
        Arrays.fill(zeroR, 0, 32, (byte) 0);
        byte[] sAboveOrder = valid.clone();
        Arrays.fill(sAboveOrder, 32, 64, (byte) 0xff);

        assertThrows(IllegalArgumentException.class, () -> Secp256k1.Signature.fromBytes(new byte[64]));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.Signature.fromBytes(badV));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.Signature.fromBytes(smallBadV));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.Signature.fromBytes(zeroR));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.Signature.fromBytes(sAboveOrder));
        assertThrows(IllegalArgumentException.class,
                () -> new Secp256k1.Signature(BigInteger.ONE, BigInteger.ONE, 2));
        assertThrows(IllegalArgumentException.class,
                () -> new Secp256k1.Signature(BigInteger.ONE, Secp256k1.CURVE_ORDER, 0));
    }

    @Test
    void failsWhenRIsNotTheXCoordinateOfACurvePoint() {
        // 5^3 + 7 is a quadratic non-residue mod p (Euler's criterion), so no point has x = 5
        Secp256k1.Signature signature = new Secp256k1.Signature(BigInteger.valueOf(5), BigInteger.ONE, 0);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> Secp256k1.recoverAddress(Hex.decode(BASE_SEPOLIA_DIGEST), signature));
        assertEquals("Signature does not recover to a public key", e.getMessage());
    }

    @Test
    void failsWhenRecoveryYieldsThePointAtInfinity() {
        // With R = G (r = Gx, even y), s = 1 and digest e = 1, recovery computes r^-1 (s*R - e*G) = infinity.
        // Gx is the secp256k1 generator x coordinate from SEC 2, section 2.4.1.
        BigInteger gx = new BigInteger("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", 16);
        Secp256k1.Signature degenerate = new Secp256k1.Signature(gx, BigInteger.ONE, 0);
        byte[] digest = Uint256.toBytes(BigInteger.ONE);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> Secp256k1.recoverPublicKey(digest, degenerate));
        assertEquals("Signature does not recover to a public key", e.getMessage());
    }

    @Test
    void signatureToStringHidesScalars() {
        Secp256k1.Signature signature = Secp256k1.Signature.fromBytes(Hex.decode(BASE_SEPOLIA_SIGNATURE));

        assertEquals("Signature[recoveryId=1, canonical=true]", signature.toString());
    }

    @Test
    void parsesPrivateKeyWithOrWithoutPrefix() {
        assertEquals(KEY_0, Secp256k1.parsePrivateKey(Hex.stripPrefix(ANVIL_KEY_0)));
        assertEquals(KEY_0, Secp256k1.parsePrivateKey(ANVIL_KEY_0.toUpperCase(Locale.ROOT).replace("0X", "0x")));
    }

    @Test
    void rejectsMalformedPrivateKeysWithoutEchoingThem() {
        String shortKey = ANVIL_KEY_0.substring(0, 64);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> Secp256k1.parsePrivateKey(shortKey));

        assertEquals("Private key must be 32 bytes of hex (64 digits)", e.getMessage());
        assertFalse(String.valueOf(e.getCause().getMessage()).contains("ac0974"));
    }

    @Test
    void rejectsPrivateKeysOutsideTheCurveOrder() {
        String zero = "0x" + "00".repeat(32);
        String order = Hex.encode(Uint256.toBytes(Secp256k1.CURVE_ORDER));

        assertThrows(IllegalArgumentException.class, () -> Secp256k1.parsePrivateKey(zero));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.parsePrivateKey(order));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.publicKey(BigInteger.ZERO));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.sign(new byte[32], Secp256k1.CURVE_ORDER));
    }

    @Test
    void rejectsDigestsThatAreNot32Bytes() {
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.sign(new byte[31], KEY_0));
        assertThrows(IllegalArgumentException.class,
                () -> Secp256k1.recoverAddress(new byte[33], Hex.decode(BASE_SEPOLIA_SIGNATURE)));
    }

    @Test
    void normalizesPublicKeyEncodings() {
        byte[] raw = Hex.decode(ANVIL_PUBLIC_KEY_0);
        byte[] uncompressed = Secp256k1.publicKey(KEY_0);
        // Y ends in 0xa5, an odd value, so the SEC1 compressed tag is 0x03
        byte[] compressed = Hex.decode("0x03" + Hex.stripPrefix(ANVIL_PUBLIC_KEY_0).substring(0, 64));

        assertEquals(Hex.encode(uncompressed), Hex.encode(Secp256k1.uncompressedPublicKey(raw)));
        assertEquals(Hex.encode(uncompressed), Hex.encode(Secp256k1.uncompressedPublicKey(compressed)));
        assertEquals(Hex.encode(uncompressed), Hex.encode(Secp256k1.uncompressedPublicKey(uncompressed)));
    }

    @Test
    void rejectsInvalidPublicKeys() {
        byte[] offCurve = Hex.decode(ANVIL_PUBLIC_KEY_0);
        offCurve[63] ^= 1;
        byte[] infinity = new byte[33];

        assertThrows(IllegalArgumentException.class, () -> Secp256k1.uncompressedPublicKey(new byte[20]));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.uncompressedPublicKey(offCurve));
        assertThrows(IllegalArgumentException.class, () -> Secp256k1.uncompressedPublicKey(infinity));
    }

    /** Signs with BouncyCastle directly, without low-s normalization, to observe the raw RFC 6979 s. */
    private static BigInteger rawRfc6979S(byte[] digest, BigInteger key) {
        X9ECParameters params = CustomNamedCurves.getByName("secp256k1");
        ECDomainParameters domain = new ECDomainParameters(
                params.getCurve(), params.getG(), params.getN(), params.getH());
        ECDSASigner signer = new ECDSASigner(new HMacDSAKCalculator(SHA256Digest.newInstance()));
        signer.init(true, new ECPrivateKeyParameters(key, domain));
        return signer.generateSignature(digest)[1];
    }
}
