package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/** How a servlet request becomes the paths and headers the core HTTP layer reads. */
class ServletAdaptersTest {

  private static MockHttpServletRequest request(String contextPath, String uri) {
    MockHttpServletRequest request = new MockHttpServletRequest("GET", uri);
    request.setContextPath(contextPath);
    return request;
  }

  @Test
  void theRawPathDropsSemicolonParametersAndTheContextPathOnlyAtASegmentBoundary() {
    assertThat(ServletRequestAdapter.rawPath(request("/ctx", "/ctx/a;b/%2e%2e/c")))
        .isEqualTo("/a/%2e%2e/c");
    assertThat(ServletRequestAdapter.rawPath(request("/ctx", "/ctx;jsessionid=1/a")))
        .isEqualTo("/a");
    assertThat(ServletRequestAdapter.rawPath(request("", "/reports;/../x")))
        .isEqualTo("/reports/../x");
    assertThat(ServletRequestAdapter.rawPath(request("", "/premium%3Bx;y=1")))
        .isEqualTo("/premium%3Bx");
    assertThat(ServletRequestAdapter.removeSemicolonContent("/a;x/;y/b;")).isEqualTo("/a//b");
    assertThat(ServletRequestAdapter.rawPath(request("/ctx", "/ctxx/a"))).isEqualTo("/ctxx/a");
    assertThat(ServletRequestAdapter.rawPath(request("/ctx", "/ctx"))).isEqualTo("/");
    assertThat(ServletRequestAdapter.rawPath(request("", ""))).isEqualTo("/");
    assertThat(ServletRequestAdapter.rawPath(request("", "/a"))).isEqualTo("/a");
  }

  @Test
  void theDecodedPathIsServletPathPlusPathInfo() {
    MockHttpServletRequest request = request("", "/s/p");
    request.setServletPath("/s");
    request.setPathInfo("/p");
    assertThat(ServletRequestAdapter.decodedPath(request)).isEqualTo("/s/p");
    request.setPathInfo(null);
    assertThat(ServletRequestAdapter.decodedPath(request)).isEqualTo("/s");
    request.setServletPath("");
    assertThat(ServletRequestAdapter.decodedPath(request)).isNull();
  }

  @Test
  void theAdapterReadsHeadersMethodUrlAndHidesTheBrowserWhenThePaywallIsOff() {
    MockHttpServletRequest request = request("", "/weather");
    request.setQueryString("city=Graz");
    request.addHeader("User-Agent", "Mozilla/5.0");
    request.addHeader("Accept", "text/html");
    ServletRequestAdapter withPaywall = new ServletRequestAdapter(request, "/weather", true);
    assertThat(withPaywall.getMethod()).isEqualTo("GET");
    assertThat(withPaywall.getPath()).isEqualTo("/weather");
    assertThat(withPaywall.getUrl()).endsWith("/weather?city=Graz");
    assertThat(withPaywall.getHeader("Accept")).isEqualTo("text/html");
    assertThat(withPaywall.getUserAgent()).isEqualTo("Mozilla/5.0");
    assertThat(new ServletRequestAdapter(request, "/weather", false).getUserAgent()).isEmpty();
    request.setQueryString(null);
    assertThat(withPaywall.getUrl()).endsWith("/weather");
  }

  @Test
  void aPaidRequestRefusesAsyncAndUpgrades() {
    PaidRequest paid = new PaidRequest(new MockHttpServletRequest());
    assertThat(paid.isAsyncSupported()).isFalse();
    assertThatThrownBy(paid::startAsync).isInstanceOf(IllegalStateException.class)
        .hasMessage(PaidRequest.UNSUPPORTED);
    assertThatThrownBy(() -> paid.startAsync(paid, null))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(() -> paid.upgrade(PaymentFilterIntegrationTest.Echo.class))
        .isInstanceOf(ServletException.class);
  }
}
