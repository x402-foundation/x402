package org.x402.mechanisms.cardano.exact.script;

import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * Plutus parameter application performed directly on the flat bit stream. Every term is copied bit
 * for bit; only the
 * byte-alignment fillers in front of byte strings are re-emitted for their new position. The
 * result is byte-identical to Aiken's {@code apply_params}; no native library is needed.
 */
public final class FlatApplier {

  private static final int MAX_DEPTH = 4096;

  private FlatApplier() {}

  /**
   * Applies Plutus data parameters to a flat program given with zero, one or two CBOR
   * byte-string wrappers.
   *
   * @param code the program
   * @param params the parameters, applied in order
   * @return the applied program wrapped in exactly one CBOR byte string (the script bytes)
   * @throws IllegalArgumentException when the program is not well-formed flat UPLC
   */
  public static byte[] applyParams(byte[] code, List<PlutusData> params) {
    byte[] flat = code;
    for (int i = 0; i < 2; i++) {
      if (flat.length == 0 || ((flat[0] & 0xff) >>> 5) != 2) {
        break;
      }
      try {
        Cbor.Item item = Cbor.decode(flat);
        flat = item.bytes();
      } catch (RuntimeException e) {
        break;
      }
    }
    Copier c = new Copier(new Reader(flat), new Writer());
    for (int i = 0; i < 3; i++) {
      c.natural();
    }
    for (int i = 0; i < params.size(); i++) {
      c.w.bits(3, 4);
    }
    c.term(0);
    for (PlutusData p : params) {
      c.w.bits(4, 4); // constant
      c.w.bits(1, 1); // type list cons
      c.w.bits(8, 4); // data
      c.w.bits(0, 1); // type list end
      c.w.byteString(PlutusEncoding.encode(p));
    }
    c.w.filler();
    return new Cbor.Writer().bytes(c.w.toByteArray()).toByteArray();
  }

  private static IllegalArgumentException malformed() {
    return new IllegalArgumentException("malformed flat UPLC program");
  }

  private static final class Reader {
    private final byte[] b;
    private int pos;

    Reader(byte[] b) {
      this.b = b;
    }

    int bit() {
      if (pos >= b.length * 8) {
        throw malformed();
      }
      int v = (b[pos / 8] >> (7 - pos % 8)) & 1;
      pos++;
      return v;
    }
  }

  private static final class Writer {
    private final ByteArrayOutputStream out = new ByteArrayOutputStream();
    private int current;
    private int pos;

    void bit(int v) {
      if (v != 0) {
        current |= 1 << (7 - pos % 8);
      }
      pos++;
      if (pos % 8 == 0) {
        out.write(current);
        current = 0;
      }
    }

    void bits(long value, int n) {
      for (int i = n - 1; i >= 0; i--) {
        bit((int) ((value >>> i) & 1));
      }
    }

    void filler() {
      while (pos % 8 != 7) {
        bit(0);
      }
      bit(1);
    }

    void byteString(byte[] b) {
      filler();
      int offset = 0;
      while (offset < b.length) {
        int n = Math.min(b.length - offset, 255);
        bits(n, 8);
        for (int i = 0; i < n; i++) {
          bits(b[offset + i] & 0xff, 8);
        }
        offset += n;
      }
      bits(0, 8);
    }

    byte[] toByteArray() {
      if (pos % 8 != 0) {
        throw new IllegalStateException("flat writer is not byte-aligned");
      }
      return out.toByteArray();
    }
  }

  private static final class Copier {
    private final Reader r;
    private final Writer w;

    Copier(Reader r, Writer w) {
      this.r = r;
      this.w = w;
    }

    long copyBits(int n) {
      long v = 0;
      for (int i = 0; i < n; i++) {
        int b = r.bit();
        w.bit(b);
        v = (v << 1) | b;
      }
      return v;
    }

    void natural() {
      while (true) {
        long more = copyBits(1);
        copyBits(7);
        if (more == 0) {
          return;
        }
      }
    }

    void byteString() {
      while (r.bit() != 1) {
        // skip the source filler
      }
      if (r.pos % 8 != 0) {
        throw malformed();
      }
      w.filler();
      while (true) {
        long n = copyBits(8);
        if (n == 0) {
          return;
        }
        copyBits((int) (8 * n));
      }
    }

    private static final int INTEGER = 0;
    private static final int BYTE_STRING = 1;
    private static final int STRING = 2;
    private static final int UNIT = 3;
    private static final int BOOL = 4;
    private static final int LIST = 5;
    private static final int PAIR = 6;
    private static final int APPLY = 7;
    private static final int DATA = 8;

    private record Type(int tag, List<Type> elems) {}

    private static Type parseType(List<Integer> tags, int[] i) {
      if (i[0] >= tags.size()) {
        throw malformed();
      }
      int tag = tags.get(i[0]++);
      switch (tag) {
        case INTEGER:
        case BYTE_STRING:
        case STRING:
        case UNIT:
        case BOOL:
        case DATA:
          return new Type(tag, List.of());
        case APPLY:
          if (i[0] >= tags.size()) {
            throw malformed();
          }
          int sub = tags.get(i[0]++);
          if (sub == LIST) {
            return new Type(LIST, List.of(parseType(tags, i)));
          }
          if (sub == APPLY) {
            if (i[0] >= tags.size() || tags.get(i[0]) != PAIR) {
              throw malformed();
            }
            i[0]++;
            Type a = parseType(tags, i);
            Type b = parseType(tags, i);
            return new Type(PAIR, List.of(a, b));
          }
          throw malformed();
        default:
          throw malformed();
      }
    }

    void value(Type t, int depth) {
      if (depth > MAX_DEPTH) {
        throw malformed();
      }
      switch (t.tag()) {
        case INTEGER:
          natural();
          return;
        case BYTE_STRING:
        case STRING:
        case DATA:
          byteString();
          return;
        case UNIT:
          return;
        case BOOL:
          copyBits(1);
          return;
        case LIST:
          while (copyBits(1) != 0) {
            value(t.elems().get(0), depth + 1);
          }
          return;
        default: // PAIR
          value(t.elems().get(0), depth + 1);
          value(t.elems().get(1), depth + 1);
      }
    }

    void termList(int depth) {
      while (copyBits(1) != 0) {
        term(depth + 1);
      }
    }

    void term(int depth) {
      if (depth > MAX_DEPTH) {
        throw malformed();
      }
      int tag = (int) copyBits(4);
      switch (tag) {
        case 0: // var
          natural();
          return;
        case 1: // delay
        case 2: // lambda
        case 5: // force
          term(depth + 1);
          return;
        case 3: // apply
          term(depth + 1);
          term(depth + 1);
          return;
        case 4: // constant
          List<Integer> tags = new ArrayList<>();
          while (copyBits(1) != 0) {
            tags.add((int) copyBits(4));
          }
          int[] i = {0};
          Type type = parseType(tags, i);
          if (i[0] != tags.size()) {
            throw malformed();
          }
          value(type, depth);
          return;
        case 6: // error
          return;
        case 7: // builtin
          copyBits(7);
          return;
        case 8: // constr
          natural();
          termList(depth);
          return;
        case 9: // case
          term(depth + 1);
          termList(depth);
          return;
        default:
          throw malformed();
      }
    }
  }
}
