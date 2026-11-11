package org.x402.spring.autoconfigure;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;

/** A facilitator URL with credentials stops the application at startup, without echoing them. */
class FacilitatorUrlValidationTest {

  @Test
  void credentialsInTheFacilitatorUrlFailStartup() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withPropertyValues("x402.facilitators[0].url=https://alice:s3cret@facilitator.example")
        .run(ctx -> {
          assertThat(ctx).hasFailed();
          Throwable root = ctx.getStartupFailure();
          while (root.getCause() != null) {
            root = root.getCause();
          }
          assertThat(root).isInstanceOf(IllegalArgumentException.class)
              .hasMessageContaining("x402.facilitators[].headers")
              .hasMessageNotContaining("s3cret");
        });
  }

  @Test
  void anApiKeyInTheQueryFailsStartup() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withPropertyValues("x402.facilitators[0].url=https://facilitator.example/x402?key=k3y")
        .run(ctx -> assertThat(ctx).hasFailed());
  }
}
