package org.x402.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.x402.core.json.X402Json;

/** IDE metadata covers map values and list elements the processor cannot see. */
class ConfigurationMetadataTest {

  @Test
  void additionalMetadataDocumentsAccountsRoutesAndFacilitators() throws Exception {
    try (InputStream in = getClass().getResourceAsStream(
        "/META-INF/additional-spring-configuration-metadata.json")) {
      String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
      assertThat(X402Json.mapper().readTree(json).get("properties").size()).isGreaterThan(30);
      assertThat(json).contains("\"x402.accounts.*.network\"", "\"x402.facilitators[].url\"",
          "\"x402.routes.*.path\"", "\"x402.routes.*.accepts[].price\"",
          "\"x402.routes.*.accepts[].account\"");
    }
  }
}
