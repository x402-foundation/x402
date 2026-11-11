package org.x402.spring.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.spring.facilitator.X402FacilitatorServerProperties;
import org.x402.spring.properties.X402Properties;

/**
 * Mnemonics, Blockfrost project ids and facilitator auth headers never appear in a properties
 * record's {@code toString} (Spring and debuggers print these).
 */
class SecretRedactionTest {

  private static final String CLIENT_WORDS = "client wallet mnemonic penalty";
  private static final String NETWORK_WORDS = "network override mnemonic hip";
  private static final String SELLER_WORDS = "seller escrow mnemonic soap";
  private static final String FACILITATOR_WORDS = "facilitator mnemonic entry";
  private static final String PROJECT_ID = "preprodS3cretKey";

  private static X402CardanoProperties.Blockfrost blockfrost() {
    return new X402CardanoProperties.Blockfrost(PROJECT_ID, "https://cardano-preprod.blockfrost.io");
  }

  @Test
  void clientPropertiesMaskMnemonicsAndTheProjectId() {
    X402CardanoProperties.ClientCardano client = new X402CardanoProperties.ClientCardano(
        CLIENT_WORDS, List.of(new X402CardanoProperties.CardanoNetwork("cardano:preprod",
            NETWORK_WORDS, blockfrost())));
    String text = client.toString();
    assertThat(text).doesNotContain("penalty").doesNotContain("hip")
        .doesNotContain(PROJECT_ID)
        .contains("mnemonic=***").contains("projectId=***")
        .contains("cardano:preprod").contains("https://cardano-preprod.blockfrost.io");
    assertThat(new X402CardanoProperties.CardanoNetwork("cardano:preprod", null, null).toString())
        .contains("mnemonic=null");
  }

  @Test
  void aBlockfrostBaseUrlIsReducedToItsOrigin() {
    assertThat(new X402CardanoProperties.Blockfrost(PROJECT_ID,
        "https://cardano-preprod.example:8443/k3yInPath/api?key=q").toString())
        .doesNotContain("k3yInPath").doesNotContain("key=q")
        .contains("baseUrl=https://cardano-preprod.example:8443");
    assertThat(new X402CardanoProperties.Blockfrost(PROJECT_ID, null).toString())
        .contains("baseUrl=null");
    assertThat(new X402CardanoProperties.Blockfrost(PROJECT_ID, "no scheme here").toString())
        .contains("baseUrl=***");
  }

  @Test
  void masumiSettingsMaskTheSellerMnemonic() {
    assertThat(new X402CardanoProperties.Masumi(SELLER_WORDS, "addr_test1return", "agent-1", null)
        .toString())
        .doesNotContain("soap").contains("sellerMnemonic=***").contains("addr_test1return")
        .contains("agent-1");
    assertThat(new CardanoServerPlan.MasumiSettings(SELLER_WORDS, "addr_test1return", "agent-1",
        null).toString())
        .doesNotContain("soap").contains("sellerMnemonic=***").contains("agent-1");
  }

  @Test
  void facilitatorNetworkMasksItsMnemonicAndProjectId() {
    String text = new X402FacilitatorServerProperties.Network("cardano:preprod", blockfrost(),
        FACILITATOR_WORDS, null, 1, true, List.of()).toString();
    assertThat(text).doesNotContain("entry").doesNotContain(PROJECT_ID)
        .contains("mnemonic=***").contains("networkMagic=1");
  }

  @Test
  void facilitatorHeadersKeepTheNamesAndMaskTheValues() {
    String text = new X402Properties.FacilitatorHeaders(
        Map.of("Authorization", "Bearer t0ken"), null, Map.of()).toString();
    assertThat(text).doesNotContain("t0ken")
        .contains("Authorization=***").contains("settle=null").contains("supported={}");
  }
}
