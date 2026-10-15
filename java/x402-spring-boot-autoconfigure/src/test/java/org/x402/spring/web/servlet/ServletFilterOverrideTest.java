package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.autoconfigure.X402WebMvcAutoConfiguration;

/** An application's own {@code x402ServletFilter} registration replaces the auto-configured one. */
class ServletFilterOverrideTest {

  @Configuration(proxyBeanMethods = false)
  static class OwnRegistration {
    @Bean
    FilterRegistrationBean<X402ServletFilter> x402ServletFilter() {
      FilterRegistrationBean<X402ServletFilter> registration = new FilterRegistrationBean<>();
      registration.setEnabled(false);
      return registration;
    }
  }

  @Test
  void theAutoConfiguredFilterBacksOff() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(WebMvcAutoConfiguration.class,
            X402AutoConfiguration.class, X402WebMvcAutoConfiguration.class))
        .withUserConfiguration(OwnRegistration.class)
        .withPropertyValues("x402.facilitators[0].url=http://127.0.0.1:1")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean("x402ServletFilter", FilterRegistrationBean.class).isEnabled())
              .isFalse();
        });
  }
}
