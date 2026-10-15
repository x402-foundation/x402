package org.x402.examples.server;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.x402.core.json.X402Json;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.http.HeaderCodec;
import org.x402.mechanisms.cardano.CardanoConstants;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;
import org.yaml.snakeyaml.Yaml;

/**
 * Smoke test for the example profiles. It
 * <ul>
 *   <li>parses every YAML snippet in the Java READMEs with SnakeYAML and binds the {@code x402}
 *       ones through the real properties classes, failing on unknown keys;</li>
 *   <li>binds {@code application-reference.yml} the same way and checks it lists every {@code
 *       x402.*} key of the starter's configuration metadata;</li>
 *   <li>starts the example in its default, {@code multi-facilitator} and {@code mainnet}
 *       profiles against WireMock facilitators: 402 unpaid, 200 paid.</li>
 * </ul>
 * Nothing here touches a chain or a public network.
 */
class ExampleProfilesSmokeTest {

  static final String MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
      + "abandon abandon abandon abandon art";
  static final String PREPROD = "cardano:preprod";
  static final String MAINNET = "cardano:mainnet";
  static final String PREPROD_PAY_TO =
      CardanoSellerSigner.fromMnemonic(MNEMONIC, PREPROD, 1).sellerAddress();
  static final String MAINNET_PAY_TO =
      CardanoSellerSigner.fromMnemonic(MNEMONIC, MAINNET, 1).sellerAddress();
  static final String FACILITATOR_AUTHORIZATION = "Basic "
      + Base64.getEncoder().encodeToString("x402:s3cret".getBytes(StandardCharsets.UTF_8));

  /** Values for README placeholders without a default (typed fields need a parsable value). */
  static final Map<String, String> PLACEHOLDERS = Map.of(
      "PREPROD_PAY_TO", PREPROD_PAY_TO, "MAINNET_PAY_TO", MAINNET_PAY_TO);

  private static final Pattern YAML_BLOCK =
      Pattern.compile("```ya?ml\\R(.*?)\\R```", Pattern.DOTALL);

  private static FacilitatorStub primary;
  private static FacilitatorStub backup;
  private final HttpClient http = HttpClient.newHttpClient();

  @BeforeAll
  static void startFacilitators() {
    primary = new FacilitatorStub();
    backup = new FacilitatorStub();
  }

  @AfterAll
  static void stopFacilitators() {
    primary.close();
    backup.close();
  }

  @BeforeEach
  void resetFacilitators() {
    primary.reset();
    backup.reset();
  }

  // ---------------------------------------------------------------- README snippets

  @Test
  void everyYamlSnippetInTheJavaReadmesParsesAndBindsWithoutUnknownKeys() throws IOException {
    Path root = repositoryRoot();
    List<Path> readmes = new ArrayList<>();
    readmes.add(root.resolve("java/README.md"));
    try (Stream<Path> walk = Files.walk(root.resolve("examples/java"))) {
      walk.filter(p -> p.getFileName().toString().equals("README.md"))
          .filter(p -> !p.toString().contains("/target/"))
          .sorted().forEach(readmes::add);
    }
    assertThat(readmes).allSatisfy(p -> assertThat(p).exists());
    assertThat(readmes).hasSizeGreaterThanOrEqualTo(5);

    List<String> failures = new ArrayList<>();
    int snippets = 0;
    int bound = 0;
    for (Path readme : readmes) {
      Matcher m = YAML_BLOCK.matcher(Files.readString(readme));
      int index = 0;
      while (m.find()) {
        index++;
        snippets++;
        String snippet = m.group(1);
        String where = root.relativize(readme) + " yaml block #" + index;
        try {
          boolean hasX402 = false;
          for (Object document : new Yaml().loadAll(snippet)) {
            hasX402 |= document instanceof Map<?, ?> map && map.containsKey("x402");
          }
          if (hasX402) {
            StrictX402Binding.bind(snippet, PLACEHOLDERS);
            bound++;
          }
        } catch (RuntimeException e) {
          failures.add(where + ": " + rootCause(e));
        }
      }
    }
    assertThat(failures).as("README YAML snippets").isEmpty();
    assertThat(snippets).as("YAML snippets found").isGreaterThanOrEqualTo(20);
    assertThat(bound).as("x402 snippets bound").isGreaterThanOrEqualTo(15);
  }

  // ---------------------------------------------------------------- reference YAML

  @Test
  void theReferenceYamlBindsThroughTheRealPropertiesAndListsEveryKey() throws IOException {
    String reference = classpath("application-reference.yml");
    StrictX402Binding.Bound bound = StrictX402Binding.bind(reference, PLACEHOLDERS);
    assertThat(bound.x402().facilitators()).hasSizeGreaterThanOrEqualTo(2);
    assertThat(bound.x402().accounts()).containsKeys("preprod", "preprod-escrow", "mainnet");
    assertThat(bound.x402().routes()).isNotEmpty();
    assertThat(bound.cardano().client().cardano().networks()).isNotEmpty();
    assertThat(bound.cardano().accounts().values())
        .anySatisfy(a -> assertThat(a.cardano()).isNotNull());
    assertThat(bound.facilitatorServer().cardano().networks()).isNotEmpty();

    Set<String> keys = StrictX402Binding.keys(reference);
    Set<String> documented = metadataNames();
    assertThat(documented).as("starter configuration metadata on the classpath")
        .contains("x402.enabled", "x402.facilitator-server.enabled");

    Set<String> missing = new TreeSet<>();
    for (String name : leaves(documented)) {
      Pattern p = pattern(name);
      if (keys.stream().noneMatch(k -> p.matcher(k).matches())) {
        missing.add(name);
      }
    }
    assertThat(missing).as("x402.* keys missing from application-reference.yml").isEmpty();

    List<Pattern> known = documented.stream().map(ExampleProfilesSmokeTest::pattern).toList();
    Set<String> undocumented = new TreeSet<>();
    for (String key : keys) {
      if (known.stream().noneMatch(p -> p.matcher(key).matches())) {
        undocumented.add(key);
      }
    }
    assertThat(undocumented).as("keys in application-reference.yml without metadata").isEmpty();
  }

  // ---------------------------------------------------------------- profiles

  @Test
  void theDefaultProfileAnswers402UnpaidAnd200Paid() throws Exception {
    try (ConfigurableApplicationContext app = start(primary.url(), null)) {
      String base = base(app);
      assertThat(get(base + "/free", null).statusCode()).isEqualTo(200);

      HttpResponse<String> weather = get(base + "/weather", null);
      assertThat(weather.statusCode()).isEqualTo(402);
      PaymentRequired required = paymentRequired(weather);
      assertThat(required.accepts()).singleElement().satisfies(r -> {
        assertThat(r.network()).isEqualTo(PREPROD);
        assertThat(r.asset()).isEqualTo(CardanoConstants.USDM_PREPROD_ASSET);
        assertThat(r.amount()).isEqualTo("10000");
        assertThat(r.payTo()).isEqualTo(PREPROD_PAY_TO);
      });

      PaymentRequired report = paymentRequired(get(base + "/report", null));
      assertThat(report.accepts()).hasSize(3);
      assertThat(report.accepts().get(0).asset()).isEqualTo(CardanoConstants.USDM_PREPROD_ASSET);
      assertThat(report.accepts().get(0).amount()).isEqualTo("500000");
      assertThat(report.accepts().get(1).asset()).isEqualTo("lovelace");
      assertThat(report.accepts().get(1).amount()).isEqualTo("1500000");
      assertThat(report.accepts().get(2).extra()).containsEntry("assetTransferMethod", "masumi");
      assertThat(report.accepts().get(2).payTo())
          .isEqualTo(MasumiBlueprint.escrowAddress(PREPROD, MasumiDeployment.DEFAULT));

      HttpResponse<String> paid = get(base + "/weather", signature(required, 0));
      assertThat(paid.statusCode()).isEqualTo(200);
      assertThat(paid.body()).contains("temperature");
      SettleResponse settled = HeaderCodec.decodePaymentResponse(
          paid.headers().firstValue("PAYMENT-RESPONSE").orElseThrow());
      assertThat(settled.success()).isTrue();
      assertThat(primary.requests("verify")).singleElement().satisfies(r ->
          assertThat(r.getHeader("Authorization")).isEqualTo(FACILITATOR_AUTHORIZATION));
      assertThat(primary.count("settle")).isEqualTo(1);
    }
  }

  @Test
  void theMultiFacilitatorProfileFailsVerifyOverAndSettlesOnTheVerifier() throws Exception {
    try (ConfigurableApplicationContext app = start(primary.url(), backup.url(),
        "multi-facilitator")) {
      String base = base(app);
      assertThat(primary.count("supported")).isEqualTo(1);
      assertThat(backup.count("supported")).isEqualTo(1);

      PaymentRequired report = paymentRequired(get(base + "/report", null));
      assertThat(report.accepts()).hasSize(3);

      primary.verifyUnavailable();
      HttpResponse<String> paid = get(base + "/report", signature(report, 0));
      assertThat(paid.statusCode()).isEqualTo(200);
      assertThat(primary.count("verify")).isEqualTo(1);
      assertThat(backup.count("verify")).isEqualTo(1);
      assertThat(backup.count("settle")).isEqualTo(1);
      assertThat(primary.count("settle")).isZero();

      HttpResponse<String> health = get(base + "/actuator/health/x402", null);
      assertThat(health.statusCode()).isEqualTo(200);
      JsonNode details = X402Json.mapper().readTree(health.body()).path("details");
      assertThat(details.path("facilitators").path("primary").path("status").asText())
          .isEqualTo("UP");
      assertThat(details.path("facilitators").path("backup").path("status").asText())
          .isEqualTo("UP");
      assertThat(get(base + "/actuator/health/readiness", null).statusCode()).isEqualTo(200);
    }
  }

  @Test
  void theMainnetProfileOffersPreprodAndMainnetOnOneRoute() throws Exception {
    try (ConfigurableApplicationContext app = start(primary.url(), null, "mainnet")) {
      PaymentRequired market = paymentRequired(get(base(app) + "/market", null));
      assertThat(market.accepts()).extracting(PaymentRequirements::network)
          .containsExactly(PREPROD, MAINNET);
      assertThat(market.accepts().get(1).payTo()).isEqualTo(MAINNET_PAY_TO);
      assertThat(market.accepts().get(1).asset())
          .isEqualTo(CardanoConstants.USDM_MAINNET_ASSET);
    }
  }

  // ---------------------------------------------------------------- helpers

  private static ConfigurableApplicationContext start(String facilitator, String backupUrl,
      String... profiles) {
    List<String> args = new ArrayList<>(List.of(
        "--server.port=0",
        "--FACILITATOR_URL=" + facilitator,
        "--FACILITATOR_AUTHORIZATION=" + FACILITATOR_AUTHORIZATION,
        "--PREPROD_PAY_TO=" + PREPROD_PAY_TO,
        "--MAINNET_PAY_TO=" + MAINNET_PAY_TO,
        "--SELLER_MNEMONIC=" + MNEMONIC));
    if (backupUrl != null) {
      args.add("--BACKUP_FACILITATOR_URL=" + backupUrl);
    }
    return new SpringApplicationBuilder(ExampleServerApplication.class).profiles(profiles)
        .run(args.toArray(String[]::new));
  }

  private static String base(ConfigurableApplicationContext app) {
    return "http://127.0.0.1:"
        + ((WebServerApplicationContext) app).getWebServer().getPort();
  }

  private HttpResponse<String> get(String url, String paymentSignature) throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url)).GET()
        .header("Accept", "application/json");
    if (paymentSignature != null) {
      request.header("PAYMENT-SIGNATURE", paymentSignature);
    }
    return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }

  private static PaymentRequired paymentRequired(HttpResponse<String> response) {
    assertThat(response.statusCode()).isEqualTo(402);
    return HeaderCodec.decodePaymentRequired(
        response.headers().firstValue("PAYMENT-REQUIRED").orElseThrow());
  }

  /** A payload for option {@code index}; the WireMock facilitator accepts any transaction. */
  private static String signature(PaymentRequired required, int index) {
    return HeaderCodec.encodePaymentSignature(new PaymentPayload(2, required.resource(),
        required.accepts().get(index), Map.of("transaction", "84a400"), null));
  }

  private static Path repositoryRoot() {
    Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
    while (dir != null && !(Files.exists(dir.resolve("java/pom.xml"))
        && Files.isDirectory(dir.resolve("examples/java")))) {
      dir = dir.getParent();
    }
    assertThat(dir).as("repository root above " + System.getProperty("user.dir")).isNotNull();
    return dir;
  }

  private static String classpath(String name) throws IOException {
    try (InputStream in = ExampleProfilesSmokeTest.class.getClassLoader()
        .getResourceAsStream(name)) {
      assertThat(in).as(name + " on the classpath").isNotNull();
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  /**
   * Every {@code x402.*} property name in the configuration metadata on the classpath. Both the
   * generated file and the hand-written additional file are read, so a stale merge in an
   * incrementally built jar cannot hide a key.
   */
  private static Set<String> metadataNames() throws IOException {
    Set<String> names = new LinkedHashSet<>();
    List<URI> files = new ArrayList<>();
    for (String file : List.of("META-INF/spring-configuration-metadata.json",
        "META-INF/additional-spring-configuration-metadata.json")) {
      Collections.list(ExampleProfilesSmokeTest.class.getClassLoader().getResources(file))
          .forEach(u -> files.add(URI.create(u.toString())));
    }
    for (URI uri : files) {
      try (InputStream in = uri.toURL().openStream()) {
        JsonNode root = X402Json.mapper().readTree(in);
        for (JsonNode p : root.path("properties")) {
          String name = p.path("name").asText();
          if (name.startsWith("x402.")) {
            names.add(name);
          }
        }
      }
    }
    return names;
  }

  /** Names that no other name extends ({@code a.b} is not a leaf when {@code a.b.c} exists). */
  private static Set<String> leaves(Set<String> names) {
    Set<String> leaves = new TreeSet<>();
    for (String name : names) {
      boolean parent = names.stream().anyMatch(o -> o.startsWith(name + ".")
          || o.startsWith(name + "["));
      if (!parent) {
        leaves.add(name);
      }
    }
    return leaves;
  }

  /**
   * A metadata name as a pattern over flattened keys: {@code *} is any map key, {@code []} any
   * index, and map-valued names also match their entries.
   */
  private static Pattern pattern(String name) {
    StringBuilder regex = new StringBuilder();
    for (int i = 0; i < name.length(); i++) {
      char c = name.charAt(i);
      if (c == '*') {
        regex.append("[^.\\[\\]]+");
      } else if (c == '[' && i + 1 < name.length() && name.charAt(i + 1) == ']') {
        regex.append("\\[\\d+\\]");
        i++;
      } else {
        regex.append(Pattern.quote(String.valueOf(c)));
      }
    }
    return Pattern.compile(regex + "([.\\[].*)?");
  }

  private static String rootCause(Throwable e) {
    Throwable t = e;
    StringBuilder all = new StringBuilder();
    while (t != null) {
      all.append(t.getClass().getSimpleName()).append(": ").append(t.getMessage()).append(" | ");
      t = t.getCause();
    }
    return all.toString();
  }
}
