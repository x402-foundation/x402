package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;
import org.x402.http.X402HttpResourceServer;

/**
 * The filter rewrites Cache-Control from every directive the client would get: an outer filter's
 * eager value and the handler's own, so the handler's {@code no-store} survives.
 */
class PaidCacheControlTest {

  @Test
  void theHandlersDirectiveSurvivesAnEagerOuterValue() throws Exception {
    MockHttpServletResponse real = new MockHttpServletResponse();
    real.setHeader("Cache-Control", "public, max-age=60");
    BufferingResponse wrapper = new BufferingResponse(real);
    // ResponseEntity.ok().cacheControl(CacheControl.noStore()) writes through addHeader.
    wrapper.addHeader("Cache-Control", "no-store");

    wrapper.setHeader("Cache-Control",
        X402HttpResourceServer.withPrivateCacheControl(X402ServletFilter.cacheControl(wrapper)));
    wrapper.release();

    assertThat(String.join(", ", real.getHeaders("Cache-Control")))
        .contains("no-store").contains("private");
  }

  @Test
  void noValueStaysNoValue() {
    BufferingResponse wrapper = new BufferingResponse(new MockHttpServletResponse());
    assertThat(X402ServletFilter.cacheControl(wrapper)).isNull();
  }
}
