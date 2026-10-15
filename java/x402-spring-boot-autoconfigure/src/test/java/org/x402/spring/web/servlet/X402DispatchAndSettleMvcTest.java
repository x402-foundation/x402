package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.Ordered;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.filter.OncePerRequestFilter;
import org.x402.spring.ContractApp;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.X402DispatchAndSettleContract;

/** Dispatch and settle contract on WebMvc, plus the servlet-only forward case. */
@SpringBootTest(classes = X402DispatchAndSettleMvcTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "spring.main.web-application-type=servlet")
class X402DispatchAndSettleMvcTest extends X402DispatchAndSettleContract {

  @LocalServerPort
  int port;

  @Autowired
  HookRecorder recorder;

  /** Forwards to a paid handler from a free one. */
  @RestController
  static class Forwarding {
    @GetMapping("/forward-to-weather")
    void forward(HttpServletRequest request, HttpServletResponse response)
        throws ServletException, IOException {
      request.getRequestDispatcher("/weather").forward(request, response);
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  @Import({ContractApp.class, Forwarding.class})
  static class App {
    /** Runs after x402 and rewrites one path, as a URL-rewrite filter would. */
    @Bean
    FilterRegistrationBean<OncePerRequestFilter> rewriting() {
      FilterRegistrationBean<OncePerRequestFilter> registration = new FilterRegistrationBean<>(
          new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(HttpServletRequest request,
                HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
              if (!"/rewrite-to-weather".equals(request.getRequestURI())) {
                chain.doFilter(request, response);
                return;
              }
              chain.doFilter(new HttpServletRequestWrapper(request) {
                @Override
                public String getRequestURI() {
                  return "/weather";
                }

                @Override
                public String getServletPath() {
                  return "/weather";
                }

                @Override
                public StringBuffer getRequestURL() {
                  return new StringBuffer("http://localhost/weather");
                }
              }, response);
            }
          });
      registration.setOrder(Ordered.LOWEST_PRECEDENCE);
      return registration;
    }
  }

  @Override
  protected int port() {
    return port;
  }

  @Override
  protected HookRecorder recorder() {
    return recorder;
  }

  @Test
  void aForwardToAPaidHandlerIsNotRun() {
    HttpResponse<String> response = TestHttp.get(url("/forward-to-weather"));

    assertThat(response.statusCode()).isEqualTo(500);
    assertThat(response.body()).doesNotContain("sunny");
  }
}
