package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * {@link PlutusEncoding#canonical} against the TypeScript reference. Each line of the vector is a
 * random Plutus datum (definite and indefinite containers, chunked and definite byte strings,
 * bignums under and over 64 bytes, constructors in all three tag forms with indexes up to
 * 2^64 − 1, maps with repeated integer, bignum and byte-string keys) and the hex Evolution SDK
 * 0.5.12 gives for {@code Data.toCBORHex(Data.fromCBORHex(datum))}.
 */
class PlutusCanonicalVectorsTest {

  private static final HexFormat HEX = HexFormat.of();

  @Test
  void matchesTheTypeScriptDecodeThenEncode() throws IOException {
    List<String> lines;
    try (InputStream in =
        PlutusCanonicalVectorsTest.class.getResourceAsStream("/plutus/canonical.txt")) {
      lines = new String(in.readAllBytes(), StandardCharsets.UTF_8).lines().toList();
    }
    assertThat(lines).hasSize(500);
    for (String line : lines) {
      int sp = line.indexOf(' ');
      byte[] datum = HEX.parseHex(line.substring(0, sp));
      assertThat(HEX.formatHex(PlutusEncoding.canonical(datum)))
          .as(line.substring(0, sp))
          .isEqualTo(line.substring(sp + 1));
    }
  }
}
