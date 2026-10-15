package org.x402.mechanisms.cardano.utils;

import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * CBOR for cardano-client-lib's {@link PlutusData}, in the Aiken / Plutus convention used on
 * chain: non-empty lists and maps indefinite-length, byte strings over 64 bytes chunked, integers
 * beyond 64 bits as tagged byte strings, constructors as tags 121–127, 1280–1400 or 102.
 *
 * <p>The model is the library's; the encoding is written here because the library's own
 * serializer writes maps definite and key-sorted and chunks every big integer (with a
 * non-minimal sign byte on some magnitudes),
 * so it would change datum bytes and parameterised script hashes. Decoding reads untrusted bytes
 * with the strict {@link Cbor} reader.
 */
public final class PlutusEncoding {

  private static final HexFormat HEX = HexFormat.of();

  private PlutusEncoding() {}

  /**
   * A constructor application.
   *
   * @param index the constructor index
   * @param fields the fields
   * @return the data
   */
  public static ConstrPlutusData constr(long index, PlutusData... fields) {
    return ConstrPlutusData.of(index, fields);
  }

  /**
   * A byte string from hex.
   *
   * @param hex the bytes as hex
   * @return the data
   */
  public static BytesPlutusData bytes(String hex) {
    return BytesPlutusData.of(HEX.parseHex(hex));
  }

  /**
   * An integer.
   *
   * @param value the value
   * @return the data
   */
  public static BigIntPlutusData integer(BigInteger value) {
    return BigIntPlutusData.of(value);
  }

  /**
   * A list.
   *
   * @param items the items
   * @return the data
   */
  public static ListPlutusData list(List<? extends PlutusData> items) {
    ListPlutusData list = new ListPlutusData();
    items.forEach(list::add);
    return list;
  }

  /**
   * The constructor fields of a value.
   *
   * @param data the value
   * @return its fields, or {@code null} when it is not a constructor
   */
  public static List<PlutusData> fields(PlutusData data) {
    return data instanceof ConstrPlutusData c ? c.getData().getPlutusDataList() : null;
  }

  /**
   * Encodes a value.
   *
   * @param data the value
   * @return the CBOR bytes
   */
  public static byte[] encode(PlutusData data) {
    Cbor.Writer w = new Cbor.Writer();
    encode(data, w);
    return w.toByteArray();
  }

  /**
   * Decodes Plutus data.
   *
   * @param cbor the bytes
   * @return the data
   * @throws IllegalArgumentException when the bytes are not Plutus data, or hold a constructor
   *     index this model cannot represent (above 2^63 − 1)
   */
  public static PlutusData decode(byte[] cbor) {
    return decode(Cbor.decode(cbor));
  }

  /**
   * Decodes Plutus data from an item the strict reader produced.
   *
   * @param item the item
   * @return the data
   * @throws IllegalArgumentException as {@link #decode(byte[])}
   */
  public static PlutusData decode(Cbor.Item item) {
    return fromItem(item);
  }

  /**
   * Checks that bytes are Plutus data, with constructor indexes up to 2^64 − 1.
   *
   * @param cbor the bytes
   * @throws IllegalArgumentException when they are not
   */
  public static void check(byte[] cbor) {
    check(Cbor.decode(cbor));
  }

  /**
   * Checks that a CBOR item is Plutus data.
   *
   * @param item the item
   * @throws IllegalArgumentException when it is not
   */
  public static void check(Cbor.Item item) {
    switch (item.major()) {
      case UNSIGNED:
      case NEGATIVE:
      case BYTES:
        return;
      case ARRAY:
        item.items().forEach(PlutusEncoding::check);
        return;
      case MAP:
        for (Map.Entry<Cbor.Item, Cbor.Item> e : item.entries()) {
          check(e.getKey());
          check(e.getValue());
        }
        return;
      case TAG:
        Tagged t = tagged(item);
        if (t.fields() != null) {
          t.fields().items().forEach(PlutusEncoding::check);
        }
        return;
      default:
        throw new IllegalArgumentException("CBOR item is not Plutus data: " + item.major());
    }
  }

  private static PlutusData fromItem(Cbor.Item item) {
    switch (item.major()) {
      case UNSIGNED:
      case NEGATIVE:
        return BigIntPlutusData.of(item.integer());
      case BYTES:
        return BytesPlutusData.of(item.bytes());
      case ARRAY:
        ListPlutusData list = new ListPlutusData();
        item.items().forEach(i -> list.add(fromItem(i)));
        return list;
      case MAP:
        MapPlutusData map = new MapPlutusData();
        for (Map.Entry<Cbor.Item, Cbor.Item> e : item.entries()) {
          map.put(fromItem(e.getKey()), fromItem(e.getValue()));
        }
        return map;
      case TAG:
        Tagged t = tagged(item);
        if (t.fields() == null) {
          return BigIntPlutusData.of(t.bignum());
        }
        if (t.index().bitLength() > 63) {
          throw new IllegalArgumentException("constructor index exceeds 2^63 - 1");
        }
        ListPlutusData fields = new ListPlutusData();
        t.fields().items().forEach(i -> fields.add(fromItem(i)));
        return ConstrPlutusData.builder().alternative(t.index().longValueExact()).data(fields).build();
      default:
        throw new IllegalArgumentException("CBOR item is not Plutus data: " + item.major());
    }
  }

  /** A tagged item: a bignum ({@code fields == null}) or a constructor. */
  private record Tagged(BigInteger bignum, BigInteger index, Cbor.Item fields) {}

  private static Tagged tagged(Cbor.Item item) {
    long tag = item.integer().longValueExact();
    Cbor.Item inner = item.tagged();
    if (tag == 2 || tag == 3) {
      if (inner.major() != Cbor.Major.BYTES) {
        throw new IllegalArgumentException("bignum tag must wrap a byte string");
      }
      BigInteger magnitude = new BigInteger(1, inner.bytes());
      return new Tagged(tag == 2 ? magnitude : magnitude.add(BigInteger.ONE).negate(), null, null);
    }
    if (tag >= 121 && tag <= 127) {
      return new Tagged(null, BigInteger.valueOf(tag - 121), fieldsOf(inner));
    }
    if (tag >= 1280 && tag <= 1400) {
      return new Tagged(null, BigInteger.valueOf(tag - 1280 + 7), fieldsOf(inner));
    }
    if (tag == 102) {
      if (inner.major() != Cbor.Major.ARRAY
          || inner.items().size() != 2
          || inner.items().get(0).major() != Cbor.Major.UNSIGNED) {
        throw new IllegalArgumentException("general constructor must be [index, fields]");
      }
      return new Tagged(null, inner.items().get(0).integer(), fieldsOf(inner.items().get(1)));
    }
    throw new IllegalArgumentException("unsupported Plutus data tag " + tag);
  }

  private static Cbor.Item fieldsOf(Cbor.Item item) {
    if (item.major() != Cbor.Major.ARRAY) {
      throw new IllegalArgumentException("constructor fields must be an array");
    }
    return item;
  }

  private static void encode(PlutusData data, Cbor.Writer w) {
    if (data instanceof BigIntPlutusData i) {
      encodeInt(i.getValue(), w);
    } else if (data instanceof BytesPlutusData b) {
      encodeBytes(b.getValue(), w);
    } else if (data instanceof ListPlutusData l) {
      encodeList(l.getPlutusDataList(), w);
    } else if (data instanceof MapPlutusData m) {
      if (m.getMap().isEmpty()) {
        w.raw(0xa0);
      } else {
        w.raw(0xbf);
        for (Map.Entry<PlutusData, PlutusData> e : m.getMap().entrySet()) {
          encode(e.getKey(), w);
          encode(e.getValue(), w);
        }
        w.raw(0xff);
      }
    } else if (data instanceof ConstrPlutusData c) {
      long index = c.getAlternative();
      List<PlutusData> fields = c.getData() == null ? List.of() : c.getData().getPlutusDataList();
      if (index >= 0 && index < 7) {
        w.header(6, 121 + index);
        encodeList(fields, w);
      } else if (index >= 0 && index < 128) {
        w.header(6, 1280 + index - 7);
        encodeList(fields, w);
      } else {
        w.header(6, 102);
        w.header(4, 2);
        encodeInt(BigInteger.valueOf(index), w);
        encodeList(fields, w);
      }
    } else {
      throw new IllegalArgumentException("unsupported Plutus data: " + data.getClass().getName());
    }
  }

  private static void encodeList(List<PlutusData> items, Cbor.Writer w) {
    if (items.isEmpty()) {
      w.raw(0x80);
      return;
    }
    w.raw(0x9f);
    for (PlutusData item : items) {
      encode(item, w);
    }
    w.raw(0xff);
  }

  private static void encodeInt(BigInteger value, Cbor.Writer w) {
    if (value.signum() >= 0 && value.bitLength() <= 64) {
      w.header(0, value);
    } else if (value.signum() < 0 && value.negate().subtract(BigInteger.ONE).bitLength() <= 64) {
      w.header(1, value.negate().subtract(BigInteger.ONE));
    } else if (value.signum() >= 0) {
      w.header(6, 2);
      encodeBytes(magnitude(value), w);
    } else {
      w.header(6, 3);
      encodeBytes(magnitude(value.negate().subtract(BigInteger.ONE)), w);
    }
  }

  private static byte[] magnitude(BigInteger value) {
    byte[] raw = value.toByteArray();
    return raw.length > 1 && raw[0] == 0 ? Arrays.copyOfRange(raw, 1, raw.length) : raw;
  }

  private static void encodeBytes(byte[] bytes, Cbor.Writer w) {
    if (bytes.length <= 64) {
      w.bytes(bytes);
      return;
    }
    w.raw(0x5f);
    for (int offset = 0; offset < bytes.length; offset += 64) {
      w.bytes(Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + 64)));
    }
    w.raw(0xff);
  }

  /**
   * Lowercase hex of a byte-string value.
   *
   * @param data the value
   * @return the hex, or {@code null} when it is not a byte string
   */
  public static String hex(PlutusData data) {
    return data instanceof BytesPlutusData b ? HEX.formatHex(b.getValue()) : null;
  }

}
