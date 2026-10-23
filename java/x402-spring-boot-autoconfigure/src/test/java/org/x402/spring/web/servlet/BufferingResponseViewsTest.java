package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.Charset;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * What the handler reads back matches what the client will get: one charset in the content type,
 * header lists merged as release() merges them, and a stateful charset's closing sequence.
 */
class BufferingResponseViewsTest {

  @Test
  void theContentTypeCarriesExactlyOneCharsetTheCurrentOne() {
    BufferingResponse wrapper = new BufferingResponse(new MockHttpServletResponse());
    wrapper.setContentType("text/plain; charset = UTF-8");
    wrapper.setCharacterEncoding("UTF-16");
    assertThat(wrapper.getContentType()).isEqualTo("text/plain;charset=UTF-16");
  }

  @Test
  void anAddedHeaderReadsBackAfterTheValuesAlreadyThere() {
    MockHttpServletResponse real = new MockHttpServletResponse();
    real.addHeader("Set-Cookie", "JSESSIONID=1");
    real.addHeader("X-Single", "outer");
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.addHeader("Set-Cookie", "pref=x");
    wrapper.setHeader("X-Single", "handler");

    assertThat(wrapper.getHeaders("Set-Cookie")).containsExactly("JSESSIONID=1", "pref=x");
    assertThat(wrapper.getHeader("Set-Cookie")).isEqualTo("JSESSIONID=1");
    assertThat(wrapper.getHeaders("X-Single")).containsExactly("handler");
    assertThat(wrapper.getHeader("X-Single")).isEqualTo("handler");
  }

  @Test
  void aStatefulCharsetEndsWithItsResetSequence() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.setCharacterEncoding("ISO-2022-JP");
    wrapper.getWriter().write("日");
    wrapper.release();

    byte[] bytes = real.getContentAsByteArray();
    // ESC ( B: back to ASCII, written only when the encoder is told the input ended.
    assertThat(bytes).endsWith(0x1b, 0x28, 0x42);
    assertThat(new String(bytes, Charset.forName("ISO-2022-JP"))).isEqualTo("日");
  }

  @Test
  void readingTheBodyTwiceDoesNotRepeatTheEnding() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.setCharacterEncoding("ISO-2022-JP");
    wrapper.getWriter().write("日");
    byte[] first = wrapper.body();
    wrapper.release();
    assertThat(real.getContentAsByteArray()).isEqualTo(first);
  }
}
