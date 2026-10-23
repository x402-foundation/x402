package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.x402.core.facilitator.X402Facilitator;

/**
 * The Cardano mechanism is optional for the auto-configuration: only the nested configuration
 * guarded by {@code @ConditionalOnClass} may link against it, never the always-loaded outer class.
 */
class OptionalMechanismLinkingTest {

  private static String classBytes(Class<?> type) throws IOException {
    String resource = type.getName().replace('.', '/') + ".class";
    try (InputStream in = type.getClassLoader().getResourceAsStream(resource)) {
      return new String(in.readAllBytes(), StandardCharsets.ISO_8859_1);
    }
  }

  @Test
  void theOuterFacilitatorConfigurationDoesNotReferenceTheCardanoMechanism() throws IOException {
    assertThat(classBytes(X402FacilitatorServerAutoConfiguration.class))
        .doesNotContain("org/x402/mechanisms/cardano");
  }

  @Test
  void theFacilitatorStartsWithoutTheCardanoMechanism() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withClassLoader(new FilteredClassLoader("org.x402.mechanisms.cardano"))
        .withPropertyValues("x402.facilitator-server.enabled=true")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          assertThat(ctx.getBean(X402Facilitator.class).getSupported().kinds()).isEmpty();
        });
  }
}
