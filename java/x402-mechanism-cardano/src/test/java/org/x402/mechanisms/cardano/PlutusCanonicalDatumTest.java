package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/** {@link PlutusEncoding#canonical}: the bytes TypeScript's decode-then-encode produces. */
class PlutusCanonicalDatumTest {

  private static final HexFormat HEX = HexFormat.of();

  @Test
  void aDefiniteByteStringOver64BytesIsChunkedIn64BytePieces() {
    byte[] definite = new Cbor.Writer().bytes(new byte[130]).toByteArray();
    assertThat(HEX.formatHex(PlutusEncoding.canonical(definite)))
        .isEqualTo("5f5840" + "00".repeat(64) + "5840" + "00".repeat(64) + "4200" + "00" + "ff");
  }

  @Test
  void aByteStringOfExactly64BytesStaysDefinite() {
    byte[] definite = new Cbor.Writer().bytes(new byte[64]).toByteArray();
    assertThat(PlutusEncoding.canonical(definite)).isEqualTo(definite);
  }

  @Test
  void nestedLongByteStringsAreChunked() {
    byte[] datum = new Cbor.Writer().header(6, 121).header(4, 1).bytes(new byte[65]).toByteArray();
    assertThat(HEX.formatHex(PlutusEncoding.canonical(datum)))
        .isEqualTo("d8799f" + "5f5840" + "00".repeat(64) + "4100" + "ff" + "ff");
  }
}
