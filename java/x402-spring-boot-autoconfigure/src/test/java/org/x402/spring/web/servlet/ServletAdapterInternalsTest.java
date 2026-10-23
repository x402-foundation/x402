package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.HandlerMapping;
import org.x402.http.X402Headers;

/** Edge paths of the servlet adapter pieces (buffering, adapter, isolated handler lookup). */
class ServletAdapterInternalsTest {

  @Test
  void bufferingHoldsTheBodyAndIgnoresContentLength() throws IOException {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.setCharacterEncoding("UTF-8");
    wrapper.setContentLength(99);
    wrapper.setContentLengthLong(99);
    wrapper.setHeader("Content-Length", "99");
    wrapper.addHeader("Content-Length", "99");
    wrapper.addHeader("X-Kept", "yes");
    wrapper.getWriter().write("héllo");
    wrapper.flushBuffer();
    assertThat(real.isCommitted()).isFalse();
    assertThat(real.getContentAsByteArray()).isEmpty();
    assertThat(wrapper.isCommitted()).isFalse();
    assertThat(wrapper.getWriter()).isSameAs(wrapper.getWriter());

    wrapper.release();

    assertThat(real.getContentAsString()).isEqualTo("héllo");
    assertThat(real.getContentLength()).isEqualTo("héllo".getBytes("UTF-8").length);
    assertThat(real.getHeader("X-Kept")).isEqualTo("yes");
  }

  @Test
  void outputStreamWritesAreBufferedAndResettable() throws IOException {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.getOutputStream().write('a');
    wrapper.getOutputStream().write(new byte[] {'b', 'c'}, 0, 2);
    assertThat(wrapper.getOutputStream().isReady()).isTrue();
    assertThat(wrapper.getOutputStream()).isSameAs(wrapper.getOutputStream());
    assertThat(wrapper.body()).containsExactly('a', 'b', 'c');
    wrapper.resetBuffer();
    assertThat(wrapper.body()).isEmpty();
    wrapper.setStatus(204);
    wrapper.release();
    assertThat(real.getStatus()).isEqualTo(204);
    assertThat(real.getContentAsByteArray()).isEmpty();
    assertThatThrownBy(() -> wrapper.getOutputStream().setWriteListener(null))
        .isInstanceOf(UnsupportedOperationException.class);
  }

  @Test
  void sendErrorIsHeldBackAndReplayed() throws IOException {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.sendError(503);
    assertThat(wrapper.getStatus()).isEqualTo(503);
    assertThat(wrapper.isCommitted()).isTrue();
    assertThat(real.isCommitted()).isFalse();
    wrapper.release();
    assertThat(real.getStatus()).isEqualTo(503);
  }

  @Test
  void redirectIsHeldBackAndReplayed() throws IOException {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.sendRedirect("/elsewhere");
    assertThat(wrapper.getStatus()).isEqualTo(302);
    wrapper.release();
    assertThat(real.getRedirectedUrl()).isEqualTo("/elsewhere");
  }

  @Test
  void resetClearsEverything() {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.sendError(500, "x");
    wrapper.sendRedirect("/y");
    wrapper.setHeader("X-A", "1");
    wrapper.reset();
    assertThat(wrapper.getStatus()).isEqualTo(200);
    assertThat(wrapper.isCommitted()).isFalse();
    assertThat(real.getHeader("X-A")).isNull();
  }

  @Test
  void settlementOverridesNeverReachTheClient() {
    MockHttpServletResponse real = new MockHttpServletResponse();
    BufferingResponse wrapper = new BufferingResponse(real);
    wrapper.setHeader(X402Headers.SETTLEMENT_OVERRIDES, "{\"amount\":\"1\"}");
    assertThat(wrapper.containsHeader(X402Headers.SETTLEMENT_OVERRIDES)).isTrue();
    assertThat(wrapper.getHeader(X402Headers.SETTLEMENT_OVERRIDES)).isEqualTo("{\"amount\":\"1\"}");
    wrapper.addHeader("settlement-overrides", "{\"amount\":\"2\"}");
    assertThat(wrapper.settlementOverrides()).isEqualTo("{\"amount\":\"2\"}");
    assertThat(real.getHeader(X402Headers.SETTLEMENT_OVERRIDES)).isNull();
    wrapper.setHeader("X-Other", "v");
    assertThat(wrapper.containsHeader("X-Other")).isTrue();
    assertThat(wrapper.getHeader("X-Other")).isEqualTo("v");
  }

  @Test
  void adapterReportsUrlWithQueryAndHidesTheUserAgentWhenThePaywallIsOff() {
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/weather");
    request.setQueryString("city=Berlin");
    request.addHeader("User-Agent", "Mozilla/5.0");
    ServletRequestAdapter on = new ServletRequestAdapter(request, "/weather", "w", "/weather",
        true);
    ServletRequestAdapter off = new ServletRequestAdapter(request, "/weather", "w", null, false);

    assertThat(on.getUrl()).endsWith("/weather?city=Berlin");
    assertThat(on.getUserAgent()).isEqualTo("Mozilla/5.0");
    assertThat(off.getUserAgent()).isEmpty();
    assertThat(on.getMethod()).isEqualTo("GET");
    assertThat(on.getPath()).isEqualTo("/weather");
    assertThat(on.selectedOffer()).isEqualTo("w");
    assertThat(on.selectedPattern()).isEqualTo("/weather");
    request.setQueryString(null);
    assertThat(off.getUrl()).endsWith("/weather");
  }

  @Test
  void isolatedRequestKeepsAttributeWritesLocal() {
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/x");
    request.setAttribute("kept", "real");
    request.setAttribute("hidden", "real");
    ServletHandlerResolver.IsolatedRequest isolated =
        new ServletHandlerResolver.IsolatedRequest(request);
    isolated.setAttribute("local", "v");
    isolated.removeAttribute("hidden");
    isolated.setAttribute("kept", null);

    assertThat(isolated.getAttribute("local")).isEqualTo("v");
    assertThat(isolated.getAttribute("hidden")).isNull();
    assertThat(isolated.getAttribute("kept")).isNull();
    assertThat(Collections.list(isolated.getAttributeNames())).contains("local")
        .doesNotContain("hidden", "kept");
    assertThat(request.getAttribute("local")).isNull();
    assertThat(request.getAttribute("hidden")).isEqualTo("real");
    isolated.setAttribute("hidden", "again");
    assertThat(isolated.getAttribute("hidden")).isEqualTo("again");
  }

  @Test
  void aHandlerMappingThatThrowsMeansNoHandler() {
    HandlerMapping throwing = request -> {
      throw new IllegalStateException("415");
    };
    ServletHandlerResolver resolver = new ServletHandlerResolver(() -> List.of(throwing));
    assertThat(resolver.resolve(new MockHttpServletRequest("GET", "/x")).handler()).isNull();
    ServletHandlerResolver none = new ServletHandlerResolver(List::of);
    assertThat(none.resolve(new MockHttpServletRequest("GET", "/x")).handler()).isNull();
  }
}
