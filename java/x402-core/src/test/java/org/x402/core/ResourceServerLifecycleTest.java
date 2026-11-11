package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PAY_TO;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.json.X402Json;
import org.x402.core.server.FacilitatorCapabilityError;
import org.x402.core.server.ResourceConfig;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.SettlementOverrides;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SupportedResponse;

class ResourceServerLifecycleTest {

  private static ResourceConfig option(String price) {
    return ResourceConfig.of("exact", PREPROD, PAY_TO, new Money(price));
  }

  @Test
  void builderRequiresAtLeastOneFacilitator() {
    assertThatThrownBy(() -> X402ResourceServer.builder().build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("at least one facilitator");
  }

  @Test
  void duplicateEffectiveIdentifiersAreRejectedAfterNormalization() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("https://a", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("https://a/", supported(kind(PREPROD)));
    assertThatThrownBy(() -> X402ResourceServer.builder().facilitators(List.of(a, b)).build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("https://a");
  }

  @Test
  void facilitatorsKeepDeclarationOrderAndNormalizedIdentifiers() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("team/", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("https://b", supported(kind(PREPROD)));
    X402ResourceServer server =
        X402ResourceServer.builder().facilitator(a).facilitator(b).build();
    assertThat(server.facilitatorIdentifiers()).containsExactly("team", "https://b");
    assertThat(server.facilitator("team/")).isSameAs(a);
    assertThat(server.facilitator("team")).isSameAs(a);
    assertThat(server.facilitator("nope")).isNull();
  }

  @Test
  void registrationIsRejectedAfterTheFirstInitialize() {
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(new FakeFacilitatorClient("f", supported(kind(PREPROD)))).build();
    server.register(PREPROD, new FakeServerScheme());
    server.initialize();
    assertThatThrownBy(() -> server.register(MAINNET, new FakeServerScheme()))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(() -> server.onBeforeVerify(c -> BeforeResult.proceed()))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(() -> server.onAfterSettle(c -> { }))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void initializeAgainBuildsANewSnapshotAndNeverMutatesThePublishedOne() {
    AtomicReference<SupportedResponse> answer = new AtomicReference<>(supported(kind(PREPROD)));
    FakeFacilitatorClient f = new FakeFacilitatorClient("f", null).supported(answer::get);
    X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
    server.register("cardano:*", new FakeServerScheme());

    RoutingSnapshot first = server.initialize();
    assertThat(server.snapshot()).isSameAs(first);
    assertThat(first.supportedKind(2, MAINNET, "exact")).isNull();

    answer.set(supported(kind(PREPROD), kind(MAINNET)));
    RoutingSnapshot second = server.initialize();

    assertThat(server.snapshot()).isSameAs(second);
    assertThat(second.supportedKind(2, MAINNET, "exact")).isNotNull();
    assertThat(first.supportedKind(2, MAINNET, "exact")).isNull();
    assertThat(second.generation()).isGreaterThan(first.generation());
  }

  @Test
  void zeroKindsFromEveryFacilitatorFailsWithTheTsMessage() {
    RuntimeException down = new FacilitatorResponseException("down", 0, null);
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(new FakeFacilitatorClient("a", null).failSupported(down)).build();
    assertThatThrownBy(server::initialize)
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("Failed to initialize: no supported payment kinds loaded from any facilitator.")
        .hasCause(down);
  }

  @Test
  void buildsRequirementsLikeTs() {
    FakeServerScheme scheme = new FakeServerScheme();
    FakeFacilitatorClient f = new FakeFacilitatorClient("f",
        supported(List.of("bazaar"), kind(PREPROD, map("feePayer", "fp"))));
    X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
    server.register(PREPROD, scheme);
    server.initialize();

    PaymentRequirements built = server.buildPaymentRequirements(new ResourceConfig("exact",
        PREPROD, PAY_TO, new AssetAmount("lovelace", "1500000", map("a", 1, "b", 1)), null,
        map("b", 2, "assetTransferMethod", "default"), null)).get(0);

    assertThat(built.maxTimeoutSeconds()).isEqualTo(300);
    assertThat(built.asset()).isEqualTo("lovelace");
    assertThat(built.amount()).isEqualTo("1500000");
    // price.extra below config extra; the SDK "default" method never goes on the wire
    assertThat(built.extra()).containsExactly(Map.entry("a", 1), Map.entry("b", 2),
        Map.entry("feePayer", "fp"));
    assertThat(scheme.enhancedWith).containsExactly(kind(PREPROD, map("feePayer", "fp")));
    assertThat(scheme.enhancedExtensions).containsExactly(List.of("bazaar"));

    PaymentRequirements money = server.buildPaymentRequirements(
        new ResourceConfig("exact", PREPROD, PAY_TO, new Money("$0.01"), 60, null, null)).get(0);
    assertThat(money.amount()).isEqualTo("10000");
    assertThat(money.maxTimeoutSeconds()).isEqualTo(60);
  }

  @Test
  void buildFailsWithTsMessagesForMissingSchemeOrKind() {
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(new FakeFacilitatorClient("f", supported(kind(PREPROD)))).build();
    server.register(MAINNET, new FakeServerScheme());
    server.register(PREPROD, new FakeServerScheme());
    server.initialize();
    assertThatThrownBy(() -> server.buildPaymentRequirements(
        ResourceConfig.of("exact", "cardano:preview", PAY_TO, new Money("$1"))))
        .hasMessage("No server implementation registered for exact on cardano:preview. "
            + "Make sure to call register() with a scheme server for this network.");
    assertThatThrownBy(() -> server.buildPaymentRequirements(
        ResourceConfig.of("exact", MAINNET, PAY_TO, new Money("$1"))))
        .hasMessage("Facilitator does not support exact on cardano:mainnet. "
            + "Make sure to call initialize() to fetch supported kinds from facilitators.");
  }

  @Test
  void capabilityProblemsFailInitializeAfterPublishing() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.capabilityCheck = k -> "no masumi";
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(new FakeFacilitatorClient("f", supported(kind(PREPROD)))).build();
    server.register(PREPROD, scheme);
    assertThatThrownBy(server::initialize)
        .isInstanceOfSatisfying(FacilitatorCapabilityError.class, e -> {
          assertThat(e.problems()).containsExactly("exact on cardano:preprod: no masumi");
          assertThat(e).hasMessage(
              "x402 facilitator capability errors:\n  - exact on cardano:preprod: no masumi");
        });
    assertThat(server.snapshot()).isNotNull();
  }

  @Test
  void paymentRequiredResponseCarriesResourceErrorAndExtensions() {
    X402ResourceServer server = initialized(new FakeServerScheme());
    PaymentRequirements r = server.buildPaymentRequirements(option("$0.01")).get(0);
    ResourceInfo resource = ResourceInfo.of("https://api.example.com/x");

    PaymentRequired plain = server.createPaymentRequiredResponse(List.of(r), resource,
        "Payment required", Map.of(), null, null);
    assertThat(X402Json.write(plain)).startsWith(
        "{\"x402Version\":2,\"error\":\"Payment required\",\"resource\":");
    assertThat(plain.extensions()).isNull();

    PaymentRequired withExt = server.createPaymentRequiredResponse(List.of(r), resource, null,
        map("bazaar", map("info", 1)), null, null);
    assertThat(withExt.extensions()).containsKey("bazaar");
    assertThat(withExt.error()).isNull();
  }

  @Test
  void schemeEnrichmentOfThe402MayOnlyAddExtra() {
    FakeServerScheme scheme = new FakeServerScheme();
    X402ResourceServer server = initialized(scheme);
    PaymentRequirements r = server.buildPaymentRequirements(option("$0.01")).get(0);
    ResourceInfo resource = ResourceInfo.of("u");

    scheme.enrich402 = ctx -> List.of(ctx.requirements().get(0).withExtra("quote", "q1"));
    PaymentRequired enriched =
        server.createPaymentRequiredResponse(List.of(r), resource, null, null, null, null);
    assertThat(enriched.accepts().get(0).extra()).containsEntry("quote", "q1");

    scheme.enrich402 = ctx -> List.of(ctx.requirements().get(0).withAmount("1"));
    assertThatThrownBy(() ->
        server.createPaymentRequiredResponse(List.of(r), resource, null, null, null, null))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("[x402] scheme \"exact\" violated accepts mutation policy: "
            + "payment terms are immutable (index 0)");
  }

  @Test
  void matchingRequiresEqualCoreFieldsAndASubsetOfExtra() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.dynamicExtra = List.of("nonce");
    X402ResourceServer server = initialized(scheme);
    PaymentRequirements advertised = Fixtures.requirements().withExtra(map("a", 1, "nonce", "n1"));

    PaymentPayload additive = Fixtures.payload(advertised.withExtra(map("a", 1, "nonce", "n2",
        "client", true)));
    assertThat(server.findMatchingRequirements(List.of(advertised), additive))
        .isEqualTo(advertised);

    PaymentPayload otherAmount = Fixtures.payload(advertised.withAmount("1"));
    assertThat(server.findMatchingRequirements(List.of(advertised), otherAmount)).isNull();

    PaymentPayload otherExtra = Fixtures.payload(advertised.withExtra(map("a", 2)));
    assertThat(server.findMatchingRequirements(List.of(advertised), otherExtra)).isNull();

    PaymentPayload numberForm = Fixtures.payload(advertised.withExtra(map("a", 1.0)));
    assertThat(server.findMatchingRequirements(List.of(advertised), numberForm))
        .isEqualTo(advertised);

    PaymentPayload noAccepted = new PaymentPayload(2, null, null, Map.of(), null);
    assertThat(server.findMatchingRequirements(List.of(advertised), noAccepted)).isNull();
    assertThatThrownBy(() -> server.findMatchingRequirements(List.of(advertised),
        new PaymentPayload(3, null, advertised, Map.of(), null)))
        .hasMessage("Unsupported x402 version: 3");
  }

  @Test
  void settlementOverrideAmountsFollowTs() {
    PaymentRequirements r = Fixtures.requirements(PREPROD, "1000");
    assertThat(SettlementOverrides.resolveAmount("50%", r, null)).isEqualTo("500");
    assertThat(SettlementOverrides.resolveAmount("33.33%", r, null)).isEqualTo("333");
    assertThat(SettlementOverrides.resolveAmount("$0.05", r, 6)).isEqualTo("50000");
    assertThat(SettlementOverrides.resolveAmount("777", r, null)).isEqualTo("777");
    assertThatThrownBy(() -> SettlementOverrides.resolveAmount("$0.05", r, null))
        .hasMessage("Cannot convert dollar settlement override \"$0.05\" to atomic units: "
            + "asset decimals are unknown. Pass an atomic amount or register the asset.");
  }

  @Test
  void settleAppliesOverridesBeforeCallingTheFacilitator() {
    FakeServerScheme scheme = new FakeServerScheme();
    FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));
    X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
    server.register(PREPROD, scheme);
    server.initialize();
    PaymentRequirements r = Fixtures.requirements(PREPROD, "1000");
    server.settlePayment(Fixtures.payload(r), r, null, null, new SettlementOverrides("$0.0002"),
        org.x402.core.server.ServerHooks.SettlePhase.AFTER_HANDLER);
    assertThat(f.settledRequirements.get(0).amount()).isEqualTo("200");
  }

  @Test
  void assetDecimalsFallBackToSix() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.decimals = null;
    X402ResourceServer server = initialized(scheme);
    assertThat(server.getAssetDecimalsForRequirements(Fixtures.requirements())).isEqualTo(6);
    assertThat(server.getAssetDecimalsForRequirements(
        Fixtures.requirements("eip155:1", "1"))).isEqualTo(6);
  }

  static X402ResourceServer initialized(SchemeNetworkServer scheme) {
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(new FakeFacilitatorClient("f", supported(kind(PREPROD)))).build();
    server.register(PREPROD, scheme);
    server.initialize();
    return server;
  }
}
