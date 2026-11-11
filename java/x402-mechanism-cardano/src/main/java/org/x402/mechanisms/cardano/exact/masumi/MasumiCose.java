package org.x402.mechanisms.cardano.exact.masumi;

import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.Cbor;

/**
 * The seller's CIP-8 authorization over {@code termsDigest}. Verification re-encodes the decoded
 * protected header
 * map definitely and minimally in its original order to rebuild the Sig_structure the signer
 * signed; signing produces the CIP-30 {@code signData} byte layout.
 */
public final class MasumiCose {

  private static final EdDSASigningProvider ED25519 = new EdDSASigningProvider();
  private static final BigInteger EDDSA = BigInteger.valueOf(-8);

  private MasumiCose() {}

  // Cbor.decode keeps duplicate map entries; lookups here take the last match, and reencodeMap
  // keeps the last value at the first position.

  private static Cbor.Item mapGet(Cbor.Item map, long label) {
    Cbor.Item found = null;
    for (Map.Entry<Cbor.Item, Cbor.Item> e : map.entries()) {
      Cbor.Item k = e.getKey();
      if (k.isInteger() && k.integer().equals(BigInteger.valueOf(label))) {
        found = e.getValue();
      }
    }
    return found;
  }

  private static Cbor.Item mapGet(Cbor.Item map, String label) {
    Cbor.Item found = null;
    for (Map.Entry<Cbor.Item, Cbor.Item> e : map.entries()) {
      if (e.getKey().major() == Cbor.Major.TEXT && label.equals(e.getKey().text())) {
        found = e.getValue();
      }
    }
    return found;
  }

  private static boolean isInt(Cbor.Item item, long value) {
    return item != null && item.isInteger() && item.integer().equals(BigInteger.valueOf(value));
  }

  /**
   * Verifies the seller's COSE authorization over {@code termsDigest}. Total: any structural,
   * policy or cryptographic failure answers {@code false}.
   *
   * @param referenceKeyHex complete CBOR COSE_Key hex
   * @param referenceSignatureHex complete CBOR COSE_Sign1 hex
   * @param sellerAddressBech32 the address the signature must bind to
   * @param termsDigestHex the 32-byte digest as hex
   * @return true when every check passes
   */
  public static boolean verifySellerTermsSignature(
      String referenceKeyHex, String referenceSignatureHex, String sellerAddressBech32, String termsDigestHex) {
    try {
      Cbor.Item key = Cbor.decode(HexFormat.of().parseHex(referenceKeyHex));
      if (key.major() != Cbor.Major.MAP
          || !isInt(mapGet(key, 1), 1)
          || !isInt(mapGet(key, 3), -8)
          || !isInt(mapGet(key, -1), 6)
          || mapGet(key, -4) != null) {
        return false;
      }
      Cbor.Item x = mapGet(key, -2);
      if (x == null || x.major() != Cbor.Major.BYTES || x.bytes().length != 32) {
        return false;
      }
      byte[] publicKey = x.bytes();
      Cbor.Item keyKid = mapGet(key, 2);

      Cbor.Item sign1 = Cbor.decode(HexFormat.of().parseHex(referenceSignatureHex));
      if (sign1.major() != Cbor.Major.ARRAY || sign1.items().size() != 4) {
        return false;
      }
      Cbor.Item protectedBstr = sign1.items().get(0);
      Cbor.Item unprotected = sign1.items().get(1);
      Cbor.Item payload = sign1.items().get(2);
      Cbor.Item signature = sign1.items().get(3);
      if (protectedBstr.major() != Cbor.Major.BYTES
          || unprotected.major() != Cbor.Major.MAP
          || signature.major() != Cbor.Major.BYTES
          || signature.bytes().length != 64) {
        return false;
      }
      Cbor.Item protectedMap = Cbor.decode(protectedBstr.bytes());
      if (protectedMap.major() != Cbor.Major.MAP || !labelsValid(protectedMap) || !labelsValid(unprotected)) {
        return false;
      }
      Cbor.Item hashed = mapGet(unprotected, "hashed");
      if (hashed == null || !hashed.isSimple(20)) {
        return false;
      }
      Cbor.Item signatureKid = mapGet(protectedMap, 4);
      if (keyKid != null
          && keyKid.major() == Cbor.Major.BYTES
          && signatureKid != null
          && signatureKid.major() == Cbor.Major.BYTES
          && !Arrays.equals(keyKid.bytes(), signatureKid.bytes())) {
        return false;
      }
      CardanoAddresses.Parsed seller = CardanoAddresses.parse(sellerAddressBech32);
      if (CardanoAddresses.isScript(seller.payment())) {
        return false;
      }
      byte[] digest = HexFormat.of().parseHex(termsDigestHex);
      if (payload.major() != Cbor.Major.BYTES || !Arrays.equals(payload.bytes(), digest)) {
        return false;
      }
      Cbor.Item address = mapGet(protectedMap, "address");
      if (address == null
          || address.major() != Cbor.Major.BYTES
          || !Arrays.equals(address.bytes(), CardanoAddresses.toBytes(sellerAddressBech32))) {
        return false;
      }
      Cbor.Item alg = mapGet(protectedMap, 1);
      if (alg == null || !alg.isInteger() || !alg.integer().equals(EDDSA)) {
        return false;
      }
      String keyHash = HexFormat.of().formatHex(Blake2bUtil.blake2bHash224(publicKey));
      if (!keyHash.equals(CardanoAddresses.hashHex(seller.payment()))) {
        return false;
      }
      byte[] sigStructure = sigStructure(reencodeMap(protectedMap), payload.bytes());
      return ED25519.verify(signature.bytes(), sigStructure, publicKey);
    } catch (RuntimeException e) {
      return false;
    }
  }

  private static boolean labelsValid(Cbor.Item map) {
    for (Map.Entry<Cbor.Item, Cbor.Item> e : map.entries()) {
      if (!e.getKey().isInteger() && e.getKey().major() != Cbor.Major.TEXT) {
        return false;
      }
    }
    return true;
  }

  /** Re-encodes a header map definitely; a repeated key keeps its last value, first position. */
  private static byte[] reencodeMap(Cbor.Item map) {
    List<Cbor.Item> keys = new ArrayList<>();
    List<Cbor.Item> values = new ArrayList<>();
    for (Map.Entry<Cbor.Item, Cbor.Item> e : map.entries()) {
      int existing = -1;
      for (int i = 0; i < keys.size(); i++) {
        if (sameLabel(keys.get(i), e.getKey())) {
          existing = i;
        }
      }
      if (existing >= 0) {
        values.set(existing, e.getValue());
      } else {
        keys.add(e.getKey());
        values.add(e.getValue());
      }
    }
    Cbor.Writer w = new Cbor.Writer();
    w.header(5, keys.size());
    for (int i = 0; i < keys.size(); i++) {
      reencode(keys.get(i), w);
      reencode(values.get(i), w);
    }
    return w.toByteArray();
  }

  private static boolean sameLabel(Cbor.Item a, Cbor.Item b) {
    if (a.isInteger() && b.isInteger()) {
      return a.integer().equals(b.integer());
    }
    return a.major() == Cbor.Major.TEXT && b.major() == Cbor.Major.TEXT && a.text().equals(b.text());
  }

  private static void reencode(Cbor.Item item, Cbor.Writer w) {
    switch (item.major()) {
      case UNSIGNED:
        w.header(0, item.integer());
        break;
      case NEGATIVE:
        w.header(1, item.integer().negate().subtract(BigInteger.ONE));
        break;
      case BYTES:
        w.bytes(item.bytes());
        break;
      case TEXT:
        w.text(item.text());
        break;
      case ARRAY:
        w.header(4, item.items().size());
        for (Cbor.Item i : item.items()) {
          reencode(i, w);
        }
        break;
      case MAP:
        w.raw(reencodeMap(item));
        break;
      case TAG:
        w.header(6, item.integer());
        reencode(item.tagged(), w);
        break;
      default:
        if (item.integer() == null) {
          throw new IllegalArgumentException("floats are not supported in COSE headers");
        }
        w.header(7, item.integer());
    }
  }

  private static byte[] sigStructure(byte[] protectedBytes, byte[] payload) {
    return new Cbor.Writer()
        .header(4, 4)
        .text("Signature1")
        .bytes(protectedBytes)
        .bytes(new byte[0])
        .bytes(payload)
        .toByteArray();
  }

  /**
   * CIP-30 {@code signData}: protected {@code {1: -8, "address":
   * bytes}}, unprotected {@code {"hashed": false}}, attached payload, and a COSE_Key {@code {1:
   * 1, 3: -8, -1: 6, -2: publicKey}}.
   *
   * @param addressBech32 the signing address
   * @param payload the payload (the 32-byte terms digest)
   * @param extendedPrivateKey the 64-byte BIP32-Ed25519 private key
   * @param publicKey the 32-byte public key
   * @return the authorization
   */
  public static MasumiSellerAuthorization signData(
      String addressBech32, byte[] payload, byte[] extendedPrivateKey, byte[] publicKey) {
    byte[] protectedBytes =
        new Cbor.Writer()
            .header(5, 2)
            .header(0, 1)
            .integer(-8)
            .text("address")
            .bytes(CardanoAddresses.toBytes(addressBech32))
            .toByteArray();
    byte[] signature = ED25519.signExtended(sigStructure(protectedBytes, payload), extendedPrivateKey, publicKey);
    byte[] sign1 =
        new Cbor.Writer()
            .header(4, 4)
            .bytes(protectedBytes)
            .header(5, 1)
            .text("hashed")
            .raw(0xf4)
            .bytes(payload)
            .bytes(signature)
            .toByteArray();
    byte[] key =
        new Cbor.Writer()
            .header(5, 4)
            .header(0, 1)
            .header(0, 1)
            .header(0, 3)
            .integer(-8)
            .integer(-1)
            .header(0, 6)
            .integer(-2)
            .bytes(publicKey)
            .toByteArray();
    return new MasumiSellerAuthorization(HexFormat.of().formatHex(key), HexFormat.of().formatHex(sign1));
  }
}
