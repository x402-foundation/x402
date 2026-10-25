package org.x402.mechanisms.cardano.exact.server;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HttpFacilitatorClient;
import org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * A Masumi template is issued by the invocation for its own option, so a route that also
 * accepts another Cardano network builds its 402 instead of breaking the mutation policy.
 */
class MasumiTemplateNetworkTest {

  private static final String PREPROD = "cardano:preprod";
  private static final String MAINNET = "cardano:mainnet";
  private static final String SELLER_MNEMONIC =
      "test walk nut penalty hip pave soap entry language right filter choice";
  private static final Clock CLOCK = Clock.fixed(Instant.ofEpochMilli(1_785_755_400_000L), ZoneOffset.UTC);

  @Test
  void aTemplateAfterAnOptionOnAnotherNetworkIsIssued() {
    ExactCardanoServerScheme scheme = new ExactCardanoServerScheme(
        ExactCardanoServerConfig.builder()
            .masumiStorage(new InMemoryMasumiTermsStorage())
            .masumi(MasumiIssuerConfig.builder()
                .seller(CardanoSellerSigner.fromMnemonic(SELLER_MNEMONIC, PREPROD))
                .clock(CLOCK)
                .build())
            .build());
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(HttpFacilitatorClient.builder().url("http://127.0.0.1:9/unused").build()).build();
    server.register("cardano:*", scheme);

    PaymentRequirements plainMainnet = new PaymentRequirements("exact", MAINNET, "lovelace", "1000000",
        TxBuilder.walletAddress(), 600, Map.of());
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("assetTransferMethod", "masumi");
    extra.put("confirmationPolicy", Map.of("l1Confirmations", 0));
    PaymentRequirements template = new PaymentRequirements("exact", PREPROD, "lovelace", "5000000",
        MasumiBlueprint.escrowAddress(PREPROD, MasumiDeployment.DEFAULT), 600, extra);

    PaymentRequired response = server.createPaymentRequiredResponse(List.of(plainMainnet, template),
        ResourceInfo.of("https://api.example.com/jobs"), null, null, null, null);

    assertThat(response.accepts().get(0)).isEqualTo(plainMainnet);
    assertThat(response.accepts().get(1).extra()).containsKey("terms");
  }
}
