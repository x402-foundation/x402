package org.x402.spring.starter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/**
 * The starter brings the x402 auto-configuration and extensions, but no payment mechanism:
 * applications add the chains they use.
 */
class StarterClasspathTest {

  @Test
  void theStarterRegistersTheAutoConfigurations() throws IOException {
    // Every jar on the classpath may carry this file (Boot's own does too): read them all.
    StringBuilder imports = new StringBuilder();
    java.util.Enumeration<java.net.URL> files = getClass().getClassLoader().getResources(
        "META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports");
    while (files.hasMoreElements()) {
      try (InputStream in = files.nextElement().openStream()) {
        imports.append(new String(in.readAllBytes(), StandardCharsets.UTF_8)).append('\n');
      }
    }
    assertThat(imports)
        .contains("org.x402.spring.autoconfigure.X402AutoConfiguration")
        .contains("org.x402.spring.cardano.X402CardanoAutoConfiguration")
        .contains("org.x402.spring.facilitator.X402FacilitatorServerAutoConfiguration");
  }

  @Test
  void theStarterBringsExtensionsButNoMechanism() throws ClassNotFoundException {
    assertThat(Class.forName("org.x402.extensions.bazaar.Bazaar")).isNotNull();
    assertThatThrownBy(() -> Class.forName(
        "org.x402.mechanisms.cardano.exact.server.ExactCardanoServerScheme"))
        .isInstanceOf(ClassNotFoundException.class);
  }
}
