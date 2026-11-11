package org.x402.spring.starter;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.context.annotation.ImportCandidates;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.DeferredImportSelector;
import org.springframework.context.annotation.Import;
import org.springframework.core.type.AnnotationMetadata;

/**
 * The starter's whole {@code AutoConfiguration.imports} list, imported by name (so an entry
 * whose web classes are absent is skipped by its conditions, as in an application) on the
 * starter's own classpath, which has no web stack and no mechanism: the context must start with
 * every entry present. The list is read from the classpath, never copied.
 */
class StarterFullImportsTest {

  /** Imports every listed auto-configuration after the user configuration, as Boot does. */
  static class AllAutoConfigurations implements DeferredImportSelector {
    @Override
    public String[] selectImports(AnnotationMetadata metadata) {
      return ImportCandidates.load(AutoConfiguration.class,
          StarterFullImportsTest.class.getClassLoader()).getCandidates().toArray(String[]::new);
    }
  }

  @Configuration(proxyBeanMethods = false)
  @Import(AllAutoConfigurations.class)
  static class Everything {
  }

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner().withUserConfiguration(Everything.class);
  }

  @Test
  void theListCarriesTheX402Entries() {
    assertThat(new AllAutoConfigurations().selectImports(null))
        .contains("org.x402.spring.autoconfigure.X402AutoConfiguration",
            "org.x402.spring.autoconfigure.X402WebMvcAutoConfiguration",
            "org.x402.spring.autoconfigure.X402WebFluxAutoConfiguration",
            "org.x402.spring.facilitator.X402FacilitatorServerAutoConfiguration");
  }

  @Test
  void theContextStartsWithEveryEntryAndNoConfiguration() {
    runner().run(ctx -> assertThat(ctx).hasNotFailed());
  }

  @Test
  void aFacilitatorServerStartsWithEveryEntry() {
    runner().withPropertyValues("x402.enabled=false", "x402.facilitator-server.enabled=true")
        .run(ctx -> assertThat(ctx).hasNotFailed());
  }
}
