package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * {@link PlutusEncoding#canonical} gives the bytes the TypeScript SDK gives after decoding and
 * re-encoding a datum (every expected value below is Evolution 0.5.12's output). A repeated
 * byte-string key is kept, a repeated integer key merges (first position, last value), the order
 * is the sender's.
 */
class PlutusCanonicalMapTest {

  private static final HexFormat HEX = HexFormat.of();

  private static String canonical(String hex) {
    return HEX.formatHex(PlutusEncoding.canonical(HEX.parseHex(hex)));
  }

  @Test
  void aRepeatedMapKeyKeepsBothEntries() {
    assertThat(canonical("a2" + "4101" + "01" + "4101" + "02"))
        .isEqualTo("bf" + "4101" + "01" + "4101" + "02" + "ff");
  }

  @Test
  void entriesKeepTheSendersOrder() {
    assertThat(canonical("a2" + "4102" + "01" + "4101" + "02"))
        .isEqualTo("bf" + "4102" + "01" + "4101" + "02" + "ff");
  }

  @Test
  void aConstructorIndexAboveTheLibraryModelIsStillReEncoded() {
    // tag 102 [2^63, []]: the library model cannot hold this index. TypeScript writes the
    // [index, fields] pair as an indefinite array.
    assertThat(canonical("d866" + "82" + "1b8000000000000000" + "80"))
        .isEqualTo("d866" + "9f" + "1b8000000000000000" + "80" + "ff");
  }

  @Test
  void aRepeatedIntegerKeyMergesIntoTheLastValue() {
    assertThat(canonical("a2" + "01" + "02" + "01" + "03")).isEqualTo("bf" + "01" + "03" + "ff");
  }

  @Test
  void aMergedIntegerKeyKeepsItsFirstPosition() {
    assertThat(canonical("a3" + "01" + "4141" + "02" + "4142" + "01" + "4143"))
        .isEqualTo("bf" + "01" + "4143" + "02" + "4142" + "ff");
  }

  @Test
  void aBignumKeyMergesWithTheEqualPlainInteger() {
    assertThat(canonical("a2" + "c24105" + "01" + "05" + "02")).isEqualTo("bf" + "05" + "02" + "ff");
  }

  @Test
  void aBignumOver64BytesIsOneDefiniteString() {
    String magnitude = "01" + "00".repeat(63) + "01";
    String chunked = "c2" + "5f" + "5840" + magnitude.substring(0, 128) + "41" + "01" + "ff";
    assertThat(canonical(chunked)).isEqualTo("c2" + "5841" + magnitude);
    assertThat(canonical("c3" + "5841" + magnitude)).isEqualTo("c3" + "5841" + magnitude);
  }

  @Test
  void minusTwoToThe64IsABignumAsInTypeScript() {
    assertThat(canonical("3bffffffffffffffff")).isEqualTo("c348ffffffffffffffff");
  }
}
