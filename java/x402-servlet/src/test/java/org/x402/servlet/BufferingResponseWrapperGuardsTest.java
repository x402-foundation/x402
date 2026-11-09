package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Locale;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * The guards #4129 adds to the buffering wrapper: an include cannot change the status, the
 * headers or reset the response, and every {@code sendRedirect} form is held back and replayed
 * with Servlet 6.0 methods.
 */
class BufferingResponseWrapperGuardsTest {

  private static MockHttpServletRequest including(boolean byDispatcherType) {
    MockHttpServletRequest request = new MockHttpServletRequest();
    if (byDispatcherType) {
      request.setDispatcherType(DispatcherType.INCLUDE);
    } else {
      request.setAttribute(RequestDispatcher.INCLUDE_REQUEST_URI, "/fragment");
    }
    return request;
  }

  @Test
  void anIncludeCannotChangeTheStatusTheHeadersOrResetTheResponse() throws IOException {
    for (boolean byDispatcherType : new boolean[] {true, false}) {
      BufferingResponseWrapper wrapper = new BufferingResponseWrapper(
          new MockHttpServletResponse(), including(byDispatcherType));
      wrapper.getWriter().print("paid");
      wrapper.setStatus(418);
      wrapper.sendError(500);
      wrapper.sendError(500, "boom");
      wrapper.sendRedirect("/elsewhere");
      wrapper.sendRedirect("/elsewhere", 301, false);
      wrapper.setHeader("X-Fragment", "set");
      wrapper.addHeader("X-Fragment", "added");
      wrapper.addCookie(new Cookie("c", "v"));
      wrapper.setContentType("text/html");
      wrapper.setCharacterEncoding("ISO-8859-1");
      wrapper.setLocale(Locale.GERMAN);
      wrapper.reset();
      assertThat(wrapper.getStatus()).isEqualTo(200);
      assertThat(wrapper.isCommitted()).isFalse();
      assertThat(wrapper.getHeader("X-Fragment")).isNull();
      assertThat(wrapper.getContentType()).isNull();
      assertThat(new String(wrapper.body(), "UTF-8")).isEqualTo("paid");
    }
  }

  @Test
  void aRedirectWithAnotherStatusIsReplayedWithoutTheServlet61Method() throws IOException {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponseWrapper wrapper =
        new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.getWriter().print("dropped");
    wrapper.sendRedirect("/new-home", HttpServletResponse.SC_MOVED_PERMANENTLY);
    assertThat(wrapper.getStatus()).isEqualTo(301);
    assertThat(wrapper.isCommitted()).isTrue();
    wrapper.release();
    assertThat(real.getStatus()).isEqualTo(301);
    assertThat(real.getHeader("Location")).isEqualTo("/new-home");
    assertThat(real.getContentAsString()).isEmpty();
  }

  @Test
  void aRedirectThatKeepsTheBufferWritesTheBodyToo() throws IOException {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponseWrapper wrapper =
        new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.getWriter().print("kept");
    wrapper.sendRedirect("/new-home", false);
    wrapper.release();
    assertThat(real.getStatus()).isEqualTo(302);
    assertThat(real.getHeader("Location")).isEqualTo("/new-home");
    assertThat(real.getContentAsString()).isEqualTo("kept");
  }

  @Test
  void aPlainRedirectUsesSendRedirectAndAResetForgetsTheRedirect() throws IOException {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponseWrapper wrapper =
        new BufferingResponseWrapper(real, new MockHttpServletRequest());
    wrapper.sendRedirect("/elsewhere", 307, true);
    wrapper.reset();
    assertThat(wrapper.getStatus()).isEqualTo(200);
    wrapper.sendRedirect("/new-home");
    wrapper.release();
    assertThat(real.getStatus()).isEqualTo(302);
    assertThat(real.getRedirectedUrl()).isEqualTo("/new-home");
  }
}
