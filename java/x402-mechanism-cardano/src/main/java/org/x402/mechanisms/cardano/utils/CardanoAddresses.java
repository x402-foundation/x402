package org.x402.mechanisms.cardano.utils;

import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.address.CredentialType;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Bech32;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.HexFormat;

/**
 * Shelley address parsing (CIP-19): bech32 ↔ bytes, network tag and credentials. Only the parts
 * verification reads are exposed.
 */
public final class CardanoAddresses {

  private CardanoAddresses() {}

  /**
   * A pointer stake reference.
   *
   * @param slot the slot
   * @param txIndex the transaction index
   * @param certIndex the certificate index
   */
  public record Pointer(BigInteger slot, BigInteger txIndex, BigInteger certIndex) {}

  /**
   * A parsed Shelley address.
   *
   * @param type the CIP-19 header type (0–7 for addresses with a payment credential)
   * @param networkId the network nibble (1 mainnet, 0 testnets)
   * @param payment the payment credential
   * @param stake the stake credential of a base address, else {@code null}
   * @param pointer the pointer of a pointer address, else {@code null}
   */
  public record Parsed(int type, int networkId, Credential payment, Credential stake, Pointer pointer) {

    /**
     * Whether this is a base address.
     *
     * @return true for types 0–3
     */
    public boolean isBase() {
      return type <= 3;
    }

    /**
     * Whether this is an enterprise address.
     *
     * @return true for types 6–7
     */
    public boolean isEnterprise() {
      return type == 6 || type == 7;
    }
  }

  /**
   * Decodes a bech32 address to its raw bytes.
   *
   * @param bech32 the address
   * @return the bytes
   * @throws IllegalArgumentException when not a valid bech32 address
   */
  public static byte[] toBytes(String bech32) {
    if (bech32 == null || bech32.isEmpty()) {
      throw new IllegalArgumentException("address is empty");
    }
    Bech32.Bech32Data data;
    try {
      data = Bech32.decode(bech32);
    } catch (RuntimeException e) {
      throw new IllegalArgumentException("invalid bech32 address: " + bech32, e);
    }
    if ((!"addr".equals(data.hrp) && !"addr_test".equals(data.hrp)) || data.data.length == 0) {
      throw new IllegalArgumentException("not a Shelley payment address: " + bech32);
    }
    byte[] bytes = data.data;
    if ((bytes[0] & 0x0f) != ("addr".equals(data.hrp) ? 1 : 0)) {
      throw new IllegalArgumentException("address prefix does not match its network: " + bech32);
    }
    return bytes;
  }

  /**
   * Encodes raw Shelley address bytes as bech32.
   *
   * @param bytes the address bytes
   * @return the bech32 address
   * @throws IllegalArgumentException for Byron, reward or malformed addresses
   */
  public static String toBech32(byte[] bytes) {
    parse(bytes);
    return Bech32.encode(bytes, (bytes[0] & 0x0f) == 1 ? "addr" : "addr_test");
  }

  /**
   * Parses a bech32 address.
   *
   * @param bech32 the address
   * @return the parsed address
   */
  public static Parsed parse(String bech32) {
    return parse(toBytes(bech32));
  }

  /**
   * Parses raw address bytes (types 0–7 only).
   *
   * @param bytes the address bytes
   * @return the parsed address
   * @throws IllegalArgumentException when not a Shelley address with a payment credential
   */
  public static Parsed parse(byte[] bytes) {
    if (bytes == null || bytes.length < 29) {
      throw new IllegalArgumentException("address too short");
    }
    int header = bytes[0] & 0xff;
    int type = header >>> 4;
    int networkId = header & 0x0f;
    if (type > 7) {
      throw new IllegalArgumentException("address type " + type + " has no payment credential");
    }
    Credential payment = credential((type & 1) == 1, Arrays.copyOfRange(bytes, 1, 29));
    if (type <= 3) {
      if (bytes.length != 57) {
        throw new IllegalArgumentException("base address must be 57 bytes");
      }
      return new Parsed(type, networkId, payment, credential((type & 2) == 2, Arrays.copyOfRange(bytes, 29, 57)), null);
    }
    if (type == 4 || type == 5) {
      int[] cursor = {29};
      BigInteger slot = natural(bytes, cursor);
      BigInteger txIndex = natural(bytes, cursor);
      BigInteger certIndex = natural(bytes, cursor);
      if (cursor[0] != bytes.length) {
        throw new IllegalArgumentException("trailing bytes in pointer address");
      }
      return new Parsed(type, networkId, payment, null, new Pointer(slot, txIndex, certIndex));
    }
    if (bytes.length != 29) {
      throw new IllegalArgumentException("enterprise address must be 29 bytes");
    }
    return new Parsed(type, networkId, payment, null, null);
  }

  /**
   * Whether an address parses, is on the network, and is an enterprise address with a key
   * payment credential or a base address with key payment and stake credentials.
   *
   * @param value the candidate
   * @param network the network
   * @return true for an accepted key-credential address
   */
  public static boolean isKeyCredentialAddressOn(Object value, String network) {
    if (!(value instanceof String s) || s.isEmpty()) {
      return false;
    }
    try {
      Parsed p = parse(s);
      if (!p.isBase() && !p.isEnterprise()) {
        return false;
      }
      if (isScript(p.payment()) || (p.isBase() && isScript(p.stake()))) {
        return false;
      }
      return p.networkId() == CardanoNetworks.networkId(network);
    } catch (RuntimeException e) {
      return false;
    }
  }

  /**
   * The script hash of an address' payment credential.
   *
   * @param bech32 the address
   * @return lowercase hex, or {@code null} for key credentials or unparsable addresses
   */
  public static String scriptPaymentCredentialHex(String bech32) {
    try {
      Parsed p = parse(bech32);
      return isScript(p.payment()) ? hashHex(p.payment()) : null;
    } catch (RuntimeException e) {
      return null;
    }
  }

  /**
   * The lowercase key hash of an address' payment credential.
   *
   * @param bech32 the address
   * @return the key hash, or {@code null} for script credentials or unparsable addresses
   */
  public static String paymentKeyHash(String bech32) {
    try {
      Parsed p = parse(bech32);
      return isScript(p.payment()) ? null : hashHex(p.payment());
    } catch (RuntimeException e) {
      return null;
    }
  }

  /**
   * An enterprise script address for a script hash.
   *
   * @param network the network
   * @param scriptHashHex the 28-byte script hash
   * @return the bech32 address
   */
  public static String enterpriseScriptAddress(String network, String scriptHashHex) {
    Network on = CardanoNetworks.networkId(network) == 1 ? Networks.mainnet() : Networks.testnet();
    return AddressProvider.getEntAddress(Credential.fromScript(scriptHashHex), on).toBech32();
  }

  /**
   * Whether a credential is a script hash.
   *
   * @param credential the credential
   * @return true for a script credential
   */
  public static boolean isScript(Credential credential) {
    return credential.getType() == CredentialType.Script;
  }

  /**
   * A credential's 28-byte hash as lowercase hex.
   *
   * @param credential the credential
   * @return the hex hash
   */
  public static String hashHex(Credential credential) {
    return HexFormat.of().formatHex(credential.getBytes());
  }

  private static Credential credential(boolean script, byte[] hash) {
    return script ? Credential.fromScript(hash) : Credential.fromKey(hash);
  }

  private static BigInteger natural(byte[] bytes, int[] cursor) {
    BigInteger value = BigInteger.ZERO;
    while (true) {
      if (cursor[0] >= bytes.length) {
        throw new IllegalArgumentException("truncated pointer");
      }
      int b = bytes[cursor[0]++] & 0xff;
      value = value.shiftLeft(7).or(BigInteger.valueOf(b & 0x7f));
      if (value.bitLength() > 64) {
        throw new IllegalArgumentException("pointer component exceeds 64 bits");
      }
      if ((b & 0x80) == 0) {
        return value;
      }
    }
  }
}
