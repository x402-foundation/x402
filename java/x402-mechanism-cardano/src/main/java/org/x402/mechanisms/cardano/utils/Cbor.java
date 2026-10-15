package org.x402.mechanisms.cardano.utils;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * A minimal CBOR (RFC 8949) reader that keeps the byte span of every item, and a writer for the
 * few encodings this module produces. Spans matter on Cardano: the transaction id hashes the
 * body's exact wire bytes, and min-UTxO is computed over an output's serialized size, so nothing
 * may be re-encoded on the way.
 */
public final class Cbor {

  /** Maximum nesting accepted while decoding. */
  public static final int MAX_DEPTH = 256;

  private Cbor() {}

  /** Thrown for malformed CBOR. */
  public static final class CborException extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;

    CborException(String message) {
      super(message);
    }
  }

  /** CBOR major types. */
  public enum Major {
    /** Unsigned integer. */
    UNSIGNED,
    /** Negative integer. */
    NEGATIVE,
    /** Byte string. */
    BYTES,
    /** Text string. */
    TEXT,
    /** Array. */
    ARRAY,
    /** Map. */
    MAP,
    /** Tag. */
    TAG,
    /** Simple value or float. */
    SIMPLE
  }

  /** One decoded item with its byte span in the source. */
  public static final class Item {
    private final Major major;
    private final int start;
    private final int end;
    private final BigInteger integer;
    private final byte[] bytes;
    private final String text;
    private final List<Item> items;
    private final List<Map.Entry<Item, Item>> entries;
    private final Item tagged;
    private final boolean indefinite;
    private final byte[] source;

    private Item(Builder b, byte[] source) {
      this.major = b.major;
      this.start = b.start;
      this.end = b.end;
      this.integer = b.integer;
      this.bytes = b.bytes;
      this.text = b.text;
      this.items = b.items == null ? null : Collections.unmodifiableList(b.items);
      this.entries = b.entries == null ? null : Collections.unmodifiableList(b.entries);
      this.tagged = b.tagged;
      this.indefinite = b.indefinite;
      this.source = source;
    }

    /**
     * The major type.
     *
     * @return the major type
     */
    public Major major() {
      return major;
    }

    /**
     * The integer value of an unsigned or negative integer, the tag number of a tag, or the
     * simple value of a simple item.
     *
     * @return the value
     */
    public BigInteger integer() {
      return integer;
    }

    /**
     * The content of a byte string (chunks joined).
     *
     * @return a copy of the bytes
     */
    public byte[] bytes() {
      return bytes == null ? null : bytes.clone();
    }

    /**
     * The text of a text string.
     *
     * @return the text
     */
    public String text() {
      return text;
    }

    /**
     * Array elements (break marker excluded).
     *
     * @return the elements
     */
    public List<Item> items() {
      return items;
    }

    /**
     * Map entries in wire order.
     *
     * @return the entries
     */
    public List<Map.Entry<Item, Item>> entries() {
      return entries;
    }

    /**
     * The item a tag wraps.
     *
     * @return the tagged item
     */
    public Item tagged() {
      return tagged;
    }

    /**
     * Whether the array, map or string used indefinite-length encoding.
     *
     * @return true when indefinite
     */
    public boolean indefinite() {
      return indefinite;
    }

    /**
     * The exact wire bytes of this item.
     *
     * @return a copy of the span
     */
    public byte[] raw() {
      return Arrays.copyOfRange(source, start, end);
    }

    /**
     * The length of this item's wire encoding.
     *
     * @return {@code end - start}
     */
    public int size() {
      return end - start;
    }

    /**
     * Whether this is an unsigned or negative integer.
     *
     * @return true for integers
     */
    public boolean isInteger() {
      return major == Major.UNSIGNED || major == Major.NEGATIVE;
    }

    /**
     * Looks up a map entry by unsigned integer key.
     *
     * @param key the key
     * @return the value, or {@code null}
     * @throws CborException when the key occurs more than once
     */
    public Item get(long key) {
      if (entries == null) {
        return null;
      }
      Item found = null;
      for (Map.Entry<Item, Item> e : entries) {
        Item k = e.getKey();
        if (k.major == Major.UNSIGNED && k.integer.equals(BigInteger.valueOf(key))) {
          if (found != null) {
            throw new CborException("duplicate map key " + key);
          }
          found = e.getValue();
        }
      }
      return found;
    }

    /**
     * Fails when two entries of this map have the same key. Integer, text and byte-string keys
     * compare by value (so a non-minimal number or a chunked byte string equal to a definite one is
     * a duplicate), other keys by their wire bytes. Readers disagree on duplicate entries (some keep the last, a first-match reader
     * keeps the first), so a keyed map that is read must have unique keys.
     *
     * @param what the map's name, for the message
     * @return this item
     * @throws CborException when a key repeats
     */
    public Item requireUniqueKeys(String what) {
      if (entries == null) {
        return this;
      }
      java.util.Set<String> seen = new java.util.HashSet<>();
      for (Map.Entry<Item, Item> e : entries) {
        Item k = e.getKey();
        String identity;
        if (k.isInteger()) {
          identity = "i" + k.integer;
        } else if (k.major == Major.TEXT) {
          identity = "t" + k.text;
        } else if (k.major == Major.BYTES) {
          identity = "b" + java.util.HexFormat.of().formatHex(k.bytes());
        } else {
          identity = "r" + java.util.HexFormat.of().formatHex(k.raw());
        }
        if (!seen.add(identity)) {
          throw new CborException("duplicate map key in " + what);
        }
      }
      return this;
    }

    /**
     * Looks up a map entry by text key.
     *
     * @param key the key
     * @return the value, or {@code null}
     * @throws CborException when the key occurs more than once
     */
    public Item get(String key) {
      if (entries == null) {
        return null;
      }
      Item found = null;
      for (Map.Entry<Item, Item> e : entries) {
        if (e.getKey().major == Major.TEXT && key.equals(e.getKey().text)) {
          if (found != null) {
            throw new CborException("duplicate map key " + key);
          }
          found = e.getValue();
        }
      }
      return found;
    }

    /**
     * Whether this is the simple value {@code true} / {@code false} / {@code null}.
     *
     * @param simple 20 (false), 21 (true), 22 (null)
     * @return true when it is that simple value
     */
    public boolean isSimple(int simple) {
      return major == Major.SIMPLE && integer != null && integer.intValue() == simple;
    }

    /**
     * Unwraps a CBOR set tag (258) or returns the item itself.
     *
     * @return the array beneath an optional set tag
     */
    public Item untagSet() {
      return major == Major.TAG && integer.equals(BigInteger.valueOf(258)) ? tagged : this;
    }
  }

  private static final class Builder {
    Major major;
    int start;
    int end;
    BigInteger integer;
    byte[] bytes;
    String text;
    List<Item> items;
    List<Map.Entry<Item, Item>> entries;
    Item tagged;
    boolean indefinite;
  }

  /**
   * Decodes exactly one item spanning all of {@code data}.
   *
   * @param data the bytes
   * @return the item
   * @throws CborException when malformed or followed by trailing bytes
   */
  public static Item decode(byte[] data) {
    Reader reader = new Reader(data);
    Item item = reader.read(0);
    if (reader.pos != data.length) {
      throw new CborException(
          "expected to consume " + data.length + " bytes, but consumed " + reader.pos);
    }
    return item;
  }

  private static final class Reader {
    private final byte[] data;
    private int pos;

    Reader(byte[] data) {
      this.data = data;
    }

    private int next() {
      if (pos >= data.length) {
        throw new CborException("unexpected end of CBOR input");
      }
      return data[pos++] & 0xff;
    }

    private BigInteger argument(int info) {
      if (info < 24) {
        return BigInteger.valueOf(info);
      }
      int count;
      switch (info) {
        case 24:
          count = 1;
          break;
        case 25:
          count = 2;
          break;
        case 26:
          count = 4;
          break;
        case 27:
          count = 8;
          break;
        default:
          throw new CborException("invalid CBOR additional information " + info);
      }
      if (pos + count > data.length) {
        throw new CborException("unexpected end of CBOR input");
      }
      byte[] raw = Arrays.copyOfRange(data, pos, pos + count);
      pos += count;
      return new BigInteger(1, raw);
    }

    private int length(BigInteger arg) {
      if (arg.bitLength() > 31 || arg.intValue() > data.length - pos) {
        throw new CborException("CBOR length exceeds the input");
      }
      return arg.intValue();
    }

    Item read(int depth) {
      if (depth > MAX_DEPTH) {
        throw new CborException("CBOR nesting exceeds the decoder budget");
      }
      Builder b = new Builder();
      b.start = pos;
      int initial = next();
      int majorBits = initial >>> 5;
      int info = initial & 0x1f;
      b.major = Major.values()[majorBits];
      switch (b.major) {
        case UNSIGNED:
          b.integer = argument(info);
          break;
        case NEGATIVE:
          b.integer = argument(info).add(BigInteger.ONE).negate();
          break;
        case BYTES:
        case TEXT:
          readString(b, info, depth);
          break;
        case ARRAY:
          readArray(b, info, depth);
          break;
        case MAP:
          readMap(b, info, depth);
          break;
        case TAG:
          b.integer = argument(info);
          b.tagged = read(depth + 1);
          break;
        default:
          readSimple(b, info);
          break;
      }
      b.end = pos;
      return new Item(b, data);
    }

    private void readString(Builder b, int info, int depth) {
      if (info == 31) {
        b.indefinite = true;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
          if (pos >= data.length) {
            throw new CborException("unterminated indefinite string");
          }
          if ((data[pos] & 0xff) == 0xff) {
            pos++;
            break;
          }
          Item chunk = read(depth + 1);
          if (chunk.major != b.major || chunk.indefinite) {
            throw new CborException("invalid chunk in indefinite string");
          }
          byte[] chunkBytes = chunk.major == Major.BYTES ? chunk.bytes : chunk.text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
          out.write(chunkBytes, 0, chunkBytes.length);
        }
        finishString(b, out.toByteArray());
        return;
      }
      int len = length(argument(info));
      if (pos + len > data.length) {
        throw new CborException("CBOR string exceeds the input");
      }
      byte[] content = Arrays.copyOfRange(data, pos, pos + len);
      pos += len;
      finishString(b, content);
    }

    private static void finishString(Builder b, byte[] content) {
      if (b.major == Major.BYTES) {
        b.bytes = content;
      } else {
        try {
          b.text =
              java.nio.charset.StandardCharsets.UTF_8
                  .newDecoder()
                  .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                  .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                  .decode(java.nio.ByteBuffer.wrap(content))
                  .toString();
        } catch (java.nio.charset.CharacterCodingException e) {
          throw new CborException("invalid UTF-8 in CBOR text");
        }
      }
    }

    private void readArray(Builder b, int info, int depth) {
      b.items = new ArrayList<>();
      if (info == 31) {
        b.indefinite = true;
        while (true) {
          if (pos >= data.length) {
            throw new CborException("unterminated indefinite array");
          }
          if ((data[pos] & 0xff) == 0xff) {
            pos++;
            return;
          }
          b.items.add(read(depth + 1));
        }
      }
      int count = length(argument(info));
      for (int i = 0; i < count; i++) {
        b.items.add(read(depth + 1));
      }
    }

    private void readMap(Builder b, int info, int depth) {
      b.entries = new ArrayList<>();
      if (info == 31) {
        b.indefinite = true;
        while (true) {
          if (pos >= data.length) {
            throw new CborException("unterminated indefinite map");
          }
          if ((data[pos] & 0xff) == 0xff) {
            pos++;
            return;
          }
          Item key = read(depth + 1);
          b.entries.add(Map.entry(key, read(depth + 1)));
        }
      }
      int count = length(argument(info));
      for (int i = 0; i < count; i++) {
        Item key = read(depth + 1);
        b.entries.add(Map.entry(key, read(depth + 1)));
      }
    }

    private void readSimple(Builder b, int info) {
      if (info < 24) {
        b.integer = BigInteger.valueOf(info);
      } else if (info == 24) {
        b.integer = BigInteger.valueOf(next());
      } else if (info >= 25 && info <= 27) {
        argument(info);
      } else {
        throw new CborException("unexpected CBOR break or reserved value");
      }
    }
  }

  // ---------------------------------------------------------------- writer

  /** Encodes CBOR items into a byte stream. */
  public static final class Writer {
    private final ByteArrayOutputStream out = new ByteArrayOutputStream();

    /**
     * Writes a major type header with its argument in minimal form.
     *
     * @param major the major type (0..7)
     * @param argument the argument
     * @return this writer
     */
    public Writer header(int major, BigInteger argument) {
      int m = major << 5;
      if (argument.signum() < 0 || argument.bitLength() > 64) {
        throw new IllegalArgumentException("CBOR argument out of range");
      }
      long v = argument.longValue();
      if (argument.compareTo(BigInteger.valueOf(24)) < 0) {
        out.write(m | (int) v);
      } else if (argument.bitLength() <= 8) {
        out.write(m | 24);
        out.write((int) v);
      } else if (argument.bitLength() <= 16) {
        out.write(m | 25);
        writeBigEndian(v, 2);
      } else if (argument.bitLength() <= 32) {
        out.write(m | 26);
        writeBigEndian(v, 4);
      } else {
        out.write(m | 27);
        writeBigEndian(v, 8);
      }
      return this;
    }

    /**
     * Writes a major type header with a small argument.
     *
     * @param major the major type
     * @param argument the argument
     * @return this writer
     */
    public Writer header(int major, long argument) {
      return header(major, BigInteger.valueOf(argument));
    }

    private void writeBigEndian(long v, int count) {
      for (int i = count - 1; i >= 0; i--) {
        out.write((int) (v >>> (8 * i)) & 0xff);
      }
    }

    /**
     * Writes a definite byte string.
     *
     * @param bytes the content
     * @return this writer
     */
    public Writer bytes(byte[] bytes) {
      header(2, bytes.length);
      out.write(bytes, 0, bytes.length);
      return this;
    }

    /**
     * Writes a definite text string.
     *
     * @param text the text
     * @return this writer
     */
    public Writer text(String text) {
      byte[] utf8 = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      header(3, utf8.length);
      out.write(utf8, 0, utf8.length);
      return this;
    }

    /**
     * Writes a signed integer that fits in 64 bits.
     *
     * @param value the value
     * @return this writer
     */
    public Writer integer(long value) {
      return value >= 0 ? header(0, value) : header(1, BigInteger.valueOf(value).negate().subtract(BigInteger.ONE));
    }

    /**
     * Writes a raw byte (e.g. 0x9f, 0xff, 0xf4).
     *
     * @param b the byte
     * @return this writer
     */
    public Writer raw(int b) {
      out.write(b);
      return this;
    }

    /**
     * Writes pre-encoded CBOR.
     *
     * @param encoded the encoded bytes
     * @return this writer
     */
    public Writer raw(byte[] encoded) {
      out.write(encoded, 0, encoded.length);
      return this;
    }

    /**
     * The bytes written so far.
     *
     * @return the encoding
     */
    public byte[] toByteArray() {
      return out.toByteArray();
    }
  }
}
