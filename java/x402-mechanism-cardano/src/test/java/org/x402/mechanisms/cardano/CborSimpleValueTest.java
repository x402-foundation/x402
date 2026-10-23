package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.Cbor;

/** RFC 8949 section 3.3: a two-byte simple value below 32 is not well-formed. */
class CborSimpleValueTest {

  private static Cbor.Item cbor(String hex) {
    return Cbor.decode(HexFormat.of().parseHex(hex));
  }

  @Test
  void aTwoByteSimpleValueBelow32IsRefused() {
    for (String bad : new String[] {"f800", "f814", "f818", "f81f"}) {
      assertThatThrownBy(() -> cbor(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
    }
  }

  @Test
  void aTwoByteSimpleValueFrom32IsStillRead() {
    assertThat(cbor("f820").integer()).isEqualTo(java.math.BigInteger.valueOf(32));
    assertThat(cbor("f8ff").integer()).isEqualTo(java.math.BigInteger.valueOf(255));
  }
}
