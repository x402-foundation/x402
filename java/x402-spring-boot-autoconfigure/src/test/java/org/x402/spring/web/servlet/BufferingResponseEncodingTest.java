package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * Writer output is encoded as it is written, in bounded pieces, without splitting a surrogate
 * pair at a piece boundary; an invalid charset set behind a kept writer never fails a paid body.
 */
class BufferingResponseEncodingTest {

  @Test
  void aLargeBodyWithPairsAcrossPieceBoundariesEncodesExactly() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.setCharacterEncoding("UTF-8");
    StringBuilder expected = new StringBuilder();
    PrintWriter writer = wrapper.getWriter();
    for (int i = 0; i < 50; i++) {
      // 8191 chars then a pair: the pair straddles the 8192-char encoding threshold.
      String piece = (i % 3 == 0 ? "a".repeat(8191) : "é") + "😀";
      writer.write(piece);
      expected.append(piece);
    }
    wrapper.release();

    assertThat(new String(real.getContentAsByteArray(), StandardCharsets.UTF_8))
        .isEqualTo(expected.toString());
  }

  @Test
  void anInvalidCharsetBehindAKeptWriterFallsBackInsteadOfThrowing() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    PrintWriter writer = wrapper.getWriter();
    wrapper.reset();
    wrapper.setCharacterEncoding("x-bogus");
    writer.print("x");

    assertThat(wrapper.body()).containsExactly('x');
    wrapper.release();
    assertThat(real.getContentAsString()).isEqualTo("x");
  }
}
