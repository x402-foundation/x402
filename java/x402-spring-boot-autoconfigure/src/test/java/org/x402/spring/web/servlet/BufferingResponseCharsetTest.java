package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.Charset;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * The charset the client is told always matches the bytes it gets: as on a servlet container, the
 * charset is fixed once the writer is taken, a Content-Type header carries its charset to the
 * encoder, and a reset frees the charset again.
 */
class BufferingResponseCharsetTest {

  /** The body decoded with the charset the real response declares. */
  private static String asDeclared(MockHttpServletResponse real) throws Exception {
    return new String(real.getContentAsByteArray(), Charset.forName(real.getCharacterEncoding()));
  }

  @Test
  void aCharsetSetAfterGetWriterDoesNotChangeTheDeclaredOne() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    String before = wrapper.getCharacterEncoding();
    wrapper.getWriter().write("é");
    wrapper.setContentType("application/json;charset=UTF-8");
    wrapper.setCharacterEncoding("UTF-16");
    wrapper.release();

    assertThat(wrapper.getCharacterEncoding()).isEqualTo(before);
    assertThat(real.getContentType()).startsWith("application/json");
    assertThat(asDeclared(real)).isEqualTo("é");
  }

  @Test
  void aContentTypeHeaderCarriesItsCharsetToTheWriter() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.setHeader("Content-Type", "text/csv; charset=UTF-8");
    wrapper.getWriter().write("é");
    wrapper.release();

    assertThat(real.getContentAsByteArray()).containsExactly(0xC3, 0xA9);
    assertThat(asDeclared(real)).isEqualTo("é");
  }

  @Test
  void anAddedContentTypeHeaderDoesTooAndStaysSingle() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.addHeader("Content-Type", "text/plain");
    wrapper.addHeader("Content-Type", "text/csv; charset=UTF-8");
    wrapper.getWriter().write("é");
    wrapper.release();

    assertThat(real.getHeaders("Content-Type")).hasSize(1);
    assertThat(asDeclared(real)).isEqualTo("é");
  }

  @Test
  void aResetFreesTheCharsetForTheNextWriterUse() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.getWriter().write("x");
    wrapper.reset();
    wrapper.setCharacterEncoding("UTF-8");
    wrapper.getWriter().write("é");
    wrapper.release();

    assertThat(real.getContentAsByteArray()).containsExactly(0xC3, 0xA9);
    assertThat(asDeclared(real)).isEqualTo("é");
  }
}
