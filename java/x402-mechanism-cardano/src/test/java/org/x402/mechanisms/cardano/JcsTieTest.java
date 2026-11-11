package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.Jcs;

/**
 * {@link Jcs#number} on doubles whose two shortest candidates are equally close: ECMAScript picks
 * the one with an even last digit. The vector holds raw IEEE-754 bits and node's {@code String(x)}.
 */
class JcsTieTest {

  @Test
  void exactTiesRoundToTheEvenDigitLikeV8() throws IOException {
    List<String> lines;
    try (InputStream in = JcsTieTest.class.getResourceAsStream("/jcs/ties.txt")) {
      lines = new String(in.readAllBytes(), StandardCharsets.UTF_8).lines().toList();
    }
    assertThat(lines).hasSize(667);
    for (String line : lines) {
      int sp = line.indexOf(' ');
      double d = Double.longBitsToDouble(Long.parseUnsignedLong(line.substring(0, sp), 16));
      assertThat(Jcs.number(d)).as(line).isEqualTo(line.substring(sp + 1));
    }
  }

  @Test
  void theReviewExamples() {
    assertThat(Jcs.number(854928755964335.75)).isEqualTo("854928755964335.8");
    assertThat(Jcs.number(1125899906842624.75)).isEqualTo("1125899906842624.8");
    assertThat(Jcs.number(70368744177664.375)).isEqualTo("70368744177664.38");
  }
}
