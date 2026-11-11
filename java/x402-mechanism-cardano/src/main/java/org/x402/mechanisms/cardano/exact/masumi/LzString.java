package org.x402.mechanisms.cardano.exact.masumi;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * LZString 1.5.0 {@code compressToUint8Array}, and a decompressor that enforces its output limit
 * while expanding.
 */
public final class LzString {

  private LzString() {}

  /** Bit sink for 16-bit code units. */
  private static final class Sink {
    private final StringBuilder data = new StringBuilder();
    private int value;
    private int position;

    void write(int bits, int numBits) {
      int v = bits;
      for (int i = 0; i < numBits; i++) {
        value = (value << 1) | (v & 1);
        if (position == 15) {
          position = 0;
          data.append((char) value);
          value = 0;
        } else {
          position++;
        }
        v = v >> 1;
      }
    }

    void zeros(int numBits) {
      for (int i = 0; i < numBits; i++) {
        value = value << 1;
        if (position == 15) {
          position = 0;
          data.append((char) value);
          value = 0;
        } else {
          position++;
        }
      }
    }

    void flush() {
      while (true) {
        value = value << 1;
        if (position == 15) {
          data.append((char) value);
          return;
        }
        position++;
      }
    }
  }

  /**
   * LZString {@code compressToUint8Array}.
   *
   * @param uncompressed the text
   * @return big-endian UCS-2 bytes of the compressed string
   */
  public static byte[] compressToUint8Array(String uncompressed) {
    String compressed = compress(uncompressed);
    byte[] buf = new byte[compressed.length() * 2];
    for (int i = 0; i < compressed.length(); i++) {
      char c = compressed.charAt(i);
      buf[i * 2] = (byte) (c >>> 8);
      buf[i * 2 + 1] = (byte) (c & 0xff);
    }
    return buf;
  }

  private static String compress(String uncompressed) {
    Map<String, Integer> dictionary = new HashMap<>();
    Set<String> toCreate = new HashSet<>();
    String w = "";
    int enlargeIn = 2;
    int dictSize = 3;
    int numBits = 2;
    Sink sink = new Sink();

    for (int ii = 0; ii < uncompressed.length(); ii++) {
      String c = String.valueOf(uncompressed.charAt(ii));
      if (!dictionary.containsKey(c)) {
        dictionary.put(c, dictSize++);
        toCreate.add(c);
      }
      String wc = w + c;
      if (dictionary.containsKey(wc)) {
        w = wc;
        continue;
      }
      int[] state = emit(w, dictionary, toCreate, sink, enlargeIn, numBits);
      enlargeIn = state[0];
      numBits = state[1];
      enlargeIn--;
      if (enlargeIn == 0) {
        enlargeIn = 1 << numBits;
        numBits++;
      }
      dictionary.put(wc, dictSize++);
      w = c;
    }
    if (!w.isEmpty()) {
      int[] state = emit(w, dictionary, toCreate, sink, enlargeIn, numBits);
      enlargeIn = state[0];
      numBits = state[1];
      enlargeIn--;
      if (enlargeIn == 0) {
        numBits++;
      }
    }
    sink.write(2, numBits);
    sink.flush();
    return sink.data.toString();
  }

  /** Emits the code for {@code w}; returns the updated {enlargeIn, numBits}. */
  private static int[] emit(
      String w, Map<String, Integer> dictionary, Set<String> toCreate, Sink sink, int enlargeIn, int numBits) {
    int e = enlargeIn;
    int n = numBits;
    if (toCreate.contains(w)) {
      int ch = w.charAt(0);
      if (ch < 256) {
        sink.zeros(n);
        sink.write(ch, 8);
      } else {
        sink.write(1, n);
        sink.write(ch, 16);
      }
      e--;
      if (e == 0) {
        e = 1 << n;
        n++;
      }
      toCreate.remove(w);
    } else {
      sink.write(dictionary.get(w), n);
    }
    return new int[] {e, n};
  }

  /**
   * Decompresses big-endian UCS-2 bytes from {@code compressToUint8Array}, refusing to produce
   * more than {@code maxOutputChars} code units.
   *
   * @param compressed the bytes
   * @param maxOutputChars the output limit
   * @return the text, or {@code null} for malformed or oversized input
   */
  public static String decompressBounded(byte[] compressed, int maxOutputChars) {
    if (compressed.length == 0 || compressed.length % 2 != 0 || maxOutputChars <= 0) {
      return null;
    }
    BitReader reader = new BitReader(compressed);
    List<String> dictionary = new ArrayList<>();
    dictionary.add(null);
    dictionary.add(null);
    dictionary.add(null);
    int enlargeIn = 4;
    int dictionarySize = 4;
    int bitsPerCode = 3;

    Integer initialKind = reader.read(2);
    if (initialKind == null) {
      return null;
    }
    if (initialKind == 2) {
      return "";
    }
    Integer initialValue = reader.read(initialKind == 0 ? 8 : 16);
    if (initialValue == null) {
      return null;
    }
    String previous = String.valueOf((char) initialValue.intValue());
    dictionary.add(previous);
    StringBuilder output = new StringBuilder(previous);
    if (output.length() > maxOutputChars) {
      return null;
    }
    while (true) {
      Integer encoded = reader.read(bitsPerCode);
      if (encoded == null) {
        return null;
      }
      int code = encoded;
      if (code == 0 || code == 1) {
        Integer literal = reader.read(code == 0 ? 8 : 16);
        if (literal == null) {
          return null;
        }
        set(dictionary, dictionarySize, String.valueOf((char) literal.intValue()));
        code = dictionarySize;
        dictionarySize++;
        enlargeIn--;
      } else if (code == 2) {
        return output.toString();
      }
      if (enlargeIn == 0) {
        enlargeIn = 1 << bitsPerCode;
        bitsPerCode++;
      }
      String entry = code < dictionary.size() ? dictionary.get(code) : null;
      if (entry == null) {
        if (code != dictionarySize) {
          return null;
        }
        entry = previous + previous.charAt(0);
      }
      if (output.length() + entry.length() > maxOutputChars) {
        return null;
      }
      output.append(entry);
      set(dictionary, dictionarySize, previous + entry.charAt(0));
      dictionarySize++;
      enlargeIn--;
      previous = entry;
      if (enlargeIn == 0) {
        enlargeIn = 1 << bitsPerCode;
        bitsPerCode++;
      }
    }
  }

  private static void set(List<String> dictionary, int index, String value) {
    while (dictionary.size() <= index) {
      dictionary.add(null);
    }
    dictionary.set(index, value);
  }

  private static final class BitReader {
    private final byte[] bytes;
    private final int codeUnitCount;
    private int codeUnitIndex;
    private int bitMask = 0x8000;
    private int current;

    BitReader(byte[] bytes) {
      this.bytes = bytes;
      this.codeUnitCount = bytes.length / 2;
      this.current = codeUnitAt(0);
    }

    private int codeUnitAt(int index) {
      return ((bytes[index * 2] & 0xff) << 8) | (bytes[index * 2 + 1] & 0xff);
    }

    Integer read(int count) {
      int value = 0;
      int power = 1;
      for (int i = 0; i < count; i++) {
        if (codeUnitIndex >= codeUnitCount) {
          return null;
        }
        if ((current & bitMask) != 0) {
          value |= power;
        }
        power <<= 1;
        bitMask >>= 1;
        if (bitMask == 0) {
          bitMask = 0x8000;
          codeUnitIndex++;
          if (codeUnitIndex < codeUnitCount) {
            current = codeUnitAt(codeUnitIndex);
          }
        }
      }
      return value;
    }
  }
}
