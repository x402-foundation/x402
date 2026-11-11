package org.x402.mechanisms.cardano.exact.server;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.SchemeNetworkServer.PaymentRequiredContext;
import org.x402.core.hooks.HookResults.Abort;
import org.x402.core.json.X402Json;
import org.x402.core.server.ServerHooks.VerifyResultContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SupportedKind;
import org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiCommitmentInput;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Server scheme branches: stored-quote matching, issuer options, transport payloads and the
 * advertisement check.
 */
class ServerBranchesTest {

  private static final String PREPROD = "cardano:preprod";
  private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(1_785_755_400_000L), ZoneOffset.UTC);
  private static final MasumiDeployment CUSTOM = new MasumiDeployment("1", List.of(TxBuilder.hash28(4)), "0");

  private static PaymentRequirements template(String payTo, Map<String, Object> extra) {
    return new PaymentRequirements("exact", PREPROD, "lovelace", "5000000", payTo, 600, extra);
  }

  private static PaymentRequiredContext context(List<PaymentRequirements> accepts, PaymentPayload paid, Object transport) {
    return new PaymentRequiredContext(accepts, paid, ResourceInfo.of("https://api.example.com/jobs"), null, null, transport);
  }

  @Test
  void issuerOptionsFlowIntoTheQuote() {
    String escrow = MasumiBlueprint.escrowAddress(PREPROD, CUSTOM);
    var server =
        new ExactCardanoServerScheme(
            ExactCardanoServerConfig.builder()
                .masumi(
                    MasumiIssuerConfig.builder()
                        .sellerResolver(network -> MasumiFixtures.SELLER)
                        .sellerReturnAddress(MasumiFixtures.SELLER.sellerAddress())
                        .agentIdentifier(null)
                        .deployment(CUSTOM)
                        .commitment(ctx -> List.of(new MasumiCommitmentInput("job", "jcs", null, Map.of("n", 1), false)))
                        .deadlines(new MasumiDeadlineOffsets(16 * 60_000, 40 * 60_000, 60 * 60_000))
                        .maxDeadlineHorizonMs(BigInteger.valueOf(10L * 24 * 3600 * 1000))
                        .clock(CLOCK)
                        .build())
                .build());
    PaymentRequirements quote =
        server.enrichPaymentRequiredResponse(context(List.of(template(escrow, Map.of("assetTransferMethod", "masumi"))), null, null)).get(0);
    var extra = MasumiSchema.validate(quote.extra(), PREPROD).extra();
    assertThat(extra.deployment()).isEqualTo(CUSTOM);
    assertThat(extra.terms().agentIdentifierPresent()).isTrue();
    assertThat(extra.terms().sellerReturnAddress()).isEqualTo(MasumiFixtures.SELLER.sellerAddress());
    assertThat(extra.inputCommitment().parts().get(0).hasContent()).isFalse();
    assertThat(extra.terms().submitResultTime()).isEqualTo(String.valueOf(1_785_755_400_000L + 600_000 + 16 * 60_000));

    var wrong = template(TxBuilder.walletAddress(), Map.of("assetTransferMethod", "masumi"));
    assertThatThrownBy(() -> server.enrichPaymentRequiredResponse(context(List.of(wrong), null, null)))
        .hasMessageStartingWith("Masumi route payTo must be the escrow address " + escrow);
  }

  @Test
  void storedQuotesAreReservedForMatchingPaidRetries() {
    var storage = new InMemoryMasumiTermsStorage();
    var server =
        new ExactCardanoServerScheme(
            ExactCardanoServerConfig.builder()
                .masumiStorage(storage)
                .masumi(
                    MasumiIssuerConfig.builder()
                        .seller(MasumiFixtures.SELLER)
                        .paymentPayloadFromTransport(t -> t instanceof PaymentPayload p ? p : null)
                        .clock(CLOCK)
                        .build())
                .build());
    String escrow = MasumiBlueprint.escrowAddress(PREPROD, MasumiDeployment.DEFAULT);
    PaymentRequirements tpl = template(escrow, Map.of("assetTransferMethod", "masumi"));
    PaymentRequirements quote = server.enrichPaymentRequiredResponse(context(List.of(tpl), null, null)).get(0);
    PaymentPayload paid = new PaymentPayload(2, null, quote, Map.of("transaction", "x"), null);

    assertThat(server.enrichPaymentRequiredResponse(context(List.of(tpl), null, paid)).get(0)).isEqualTo(quote);
    Map<String, Object> meta = Map.of("meta", Map.of("x402/payment", X402Json.mapper().convertValue(paid, Map.class)));
    assertThat(server.enrichPaymentRequiredResponse(context(List.of(tpl), null, meta)).get(0)).isEqualTo(quote);
    var badHeader = Map.of("request", Map.of("paymentHeader", "%%%"));
    assertThat(server.enrichPaymentRequiredResponse(context(List.of(tpl), null, badHeader)).get(0)).isNotEqualTo(quote);
    String notPayload = Base64.getEncoder().encodeToString("{\"x\":1}".getBytes(StandardCharsets.UTF_8));
    assertThat(MasumiQuoteIssuer.paymentPayloadFromTransportContext(Map.of("request", Map.of("paymentHeader", notPayload)))).isNull();
    assertThat(MasumiQuoteIssuer.paymentPayloadFromTransportContext("x")).isNull();

    // A stored quote that no longer fits the template is not re-served.
    for (PaymentRequirements other :
        List.of(
            tpl.withAmount("6000000"),
            new PaymentRequirements("exact", PREPROD, "lovelace", "5000000", escrow, 300, tpl.extra()),
            tpl.withExtra(Map.of("assetTransferMethod", "masumi", "confirmationPolicy", Map.of("l1Confirmations", 0))))) {
      assertThat(server.enrichPaymentRequiredResponse(context(List.of(other), paid, null)).get(0)).isNotEqualTo(quote);
    }
    PaymentPayload wrongNetwork =
        new PaymentPayload(2, null, new PaymentRequirements("exact", "cardano:mainnet", "lovelace", "1", escrow, 600, quote.extra()), Map.of(), null);
    PaymentPayload plain = new PaymentPayload(2, null, tpl.withExtra(Map.of()), Map.of(), null);
    PaymentPayload upto = new PaymentPayload(2, null, new PaymentRequirements("upto", PREPROD, "lovelace", "1", escrow, 600, quote.extra()), Map.of(), null);
    Map<String, Object> broken = new LinkedHashMap<>(quote.extra());
    broken.put("x", 1);
    PaymentPayload invalid = new PaymentPayload(2, null, quote.withExtra(broken), Map.of(), null);
    PaymentRequirements unknownQuote = MasumiFixtures.issue(b -> {});
    PaymentPayload unknown = new PaymentPayload(2, null, unknownQuote, Map.of(), null);
    for (PaymentPayload p : List.of(wrongNetwork, plain, upto, invalid, unknown)) {
      assertThat(server.enrichPaymentRequiredResponse(context(List.of(tpl), p, null)).get(0)).isNotEqualTo(quote);
    }

    // Only one template per call; non-Cardano and non-Masumi accepts are left alone.
    PaymentRequirements evm = new PaymentRequirements("exact", "eip155:8453", "usdc", "1", "0x1", 60, Map.of());
    PaymentRequirements plainCardano = tpl.withExtra(Map.of());
    List<PaymentRequirements> out =
        server.enrichPaymentRequiredResponse(context(List.of(evm, plainCardano, tpl, tpl), null, null));
    assertThat(out.get(0)).isEqualTo(evm);
    assertThat(out.get(1)).isEqualTo(plainCardano);
    assertThat(out.get(2).extra()).containsKey("terms");
    assertThat(out.get(3)).isEqualTo(tpl);
  }

  @Test
  void advertisementChecksAndHookEdges() {
    var server = new ExactCardanoServerScheme();
    Map<String, Object> ranged = new LinkedHashMap<>();
    ranged.put("assetTransferMethods", List.of("default", "masumi"));
    ranged.put("l1Confirmations", Map.of("minimum", 0.0, "maximum", 20L));
    PaymentRequirements ok = template(TxBuilder.walletAddress(), Map.of());
    assertThat(server.enhancePaymentRequirements(ok, new SupportedKind(2, "exact", PREPROD, ranged), List.of()).extra()).isEmpty();
    ranged.put("l1Confirmations", Map.of("minimum", 0.5, "maximum", 20));
    assertThatThrownBy(() -> server.enhancePaymentRequirements(ok, new SupportedKind(2, "exact", PREPROD, ranged), List.of()))
        .hasMessage("Cardano facilitator confirmation range does not include 1");
    ranged.put("l1Confirmations", Map.of("minimum", 0, "maximum", 5_000_000_000L));
    assertThatThrownBy(() -> server.enhancePaymentRequirements(ok, new SupportedKind(2, "exact", PREPROD, ranged), List.of()))
        .hasMessage("Cardano facilitator confirmation range does not include 1");
    ranged.put("l1Confirmations", Map.of("minimum", 0, "maximum", 20));
    Map<String, Object> brokenMasumi = new LinkedHashMap<>(MasumiFixtures.issue(b -> {}).extra());
    brokenMasumi.put("referenceKey", "");
    PaymentRequirements bad = template(TxBuilder.walletAddress(), brokenMasumi);
    assertThatThrownBy(() -> server.enhancePaymentRequirements(bad, new SupportedKind(2, "exact", PREPROD, ranged), List.of()))
        .hasMessage("Cardano Masumi requirements are invalid: extra.referenceKey must be non-empty lowercase even-length hex");

    var nullResult = new VerifyResultContext(null, null, Map.of(), null, null);
    assertThat(server.schemeHooks().onAfterVerify().apply(nullResult)).isNotInstanceOf(Abort.class);
    var noAccepted =
        new VerifyResultContext(
            new PaymentPayload(2, null, null, Map.of(), null), null, Map.of(), null, org.x402.core.types.VerifyResponse.valid("p"));
    assertThat(server.schemeHooks().onAfterVerify().apply(noAccepted)).isNotInstanceOf(Abort.class);
    assertThat(CardanoSellerSigner.fromMnemonic("test walk nut penalty hip pave soap entry language right filter choice", PREPROD, 1)
            .sellerAddress())
        .startsWith("addr_test1q");
    assertThat(MasumiQuoteIssuer.isMasumiTemplate(Map.of("assetTransferMethod", "masumi", "terms", Map.of()))).isFalse();
    assertThat(MasumiQuoteIssuer.isMasumiExtra("masumi")).isFalse();
  }
}
