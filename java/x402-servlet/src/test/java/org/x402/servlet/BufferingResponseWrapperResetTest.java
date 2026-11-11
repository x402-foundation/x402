package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * A reset forgets everything written before it, including characters still held by the
 * writer; releasing merges list-valued headers with the ones already on the real response.
 */
class BufferingResponseWrapperResetTest {

  @Test
  void resetBufferDropsUnflushedWriterCharacters() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponseWrapper wrapper = new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.getWriter().write("PAID CONTENT");
    // DispatcherServlet resets the buffer before an @ExceptionHandler writes the error body.
    wrapper.resetBuffer();
    wrapper.setStatus(500);
    wrapper.getOutputStream().write("{\"error\":\"boom\"}".getBytes(StandardCharsets.UTF_8));
    wrapper.release();
    assertThat(real.getContentAsString()).isEqualTo("{\"error\":\"boom\"}");
  }

  @Test
  void resetDropsUnflushedWriterCharactersToo() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponseWrapper wrapper = new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.getWriter().write("PAID CONTENT");
    wrapper.reset();
    wrapper.getWriter().write("error");
    wrapper.release();
    assertThat(real.getContentAsString()).isEqualTo("error");
  }

  @Test
  void writerAndStreamKeepTheirOrder() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponseWrapper wrapper = new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.getWriter().write("a");
    wrapper.getOutputStream().write('b');
    wrapper.getWriter().write("c");
    wrapper.release();
    assertThat(real.getContentAsString()).isEqualTo("abc");
  }

  @Test
  void releaseKeepsCookiesAndVaryValuesAlreadyOnTheResponse() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    real.addHeader("Set-Cookie", "JSESSIONID=1");
    real.addHeader("Vary", "Origin");
    real.addHeader("X-Single", "outer");
    BufferingResponseWrapper wrapper = new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.addHeader("Set-Cookie", "pref=x");
    wrapper.addHeader("Vary", "Accept");
    wrapper.setHeader("X-Single", "handler");
    wrapper.release();
    assertThat(real.getHeaders("Set-Cookie")).containsExactly("JSESSIONID=1", "pref=x");
    assertThat(real.getHeaders("Vary")).containsExactly("Origin", "Accept");
    assertThat(real.getHeaders("X-Single")).containsExactly("handler");
  }

  @Test
  void aByteOrderMarkIsWrittenOnceAcrossFlushes() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponseWrapper wrapper = new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.setCharacterEncoding("UTF-16");
    wrapper.getWriter().write("ab");
    wrapper.flushBuffer();
    wrapper.getWriter().write("c\uD83D");
    wrapper.flushBuffer();
    wrapper.getWriter().write("\uDE00");
    wrapper.release();
    assertThat(new String(real.getContentAsByteArray(), "UTF-16")).isEqualTo("abc\uD83D\uDE00");
    assertThat(real.getContentAsByteArray()).hasSize(2 + 2 * 5);
  }

  @Test
  void theCharsetFallsBackToTheWrappedResponseAndStopsAtTheNextParameter() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    real.setCharacterEncoding("UTF-8");
    BufferingResponseWrapper wrapper = new BufferingResponseWrapper(real, new MockHttpServletRequest());
    assertThat(wrapper.getCharacterEncoding()).isEqualTo("UTF-8");
    wrapper.setContentType("text/plain; charset=\"UTF-16\"; format=flowed");
    assertThat(wrapper.getCharacterEncoding()).isEqualTo("UTF-16");
  }
}
