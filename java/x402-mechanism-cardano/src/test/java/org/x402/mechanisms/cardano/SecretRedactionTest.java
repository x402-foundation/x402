package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;

/** Wallet mnemonics and provider keys never appear in a settings record's {@code toString}. */
class SecretRedactionTest {

  private static final String MNEMONIC = "test walk nut penalty hip pave soap entry language right "
      + "filter choice";
  private static final String PROJECT_ID = "preprodS3cretKey";

  private static BlockfrostChainBackend.Config blockfrost() {
    return BlockfrostChainBackend.Config.builder()
        .network("cardano:preprod")
        .baseUrl("https://cardano-preprod.blockfrost.io/api/v0/k3yInPath")
        .projectId(PROJECT_ID)
        .build();
  }

  @Test
  void blockfrostConfigMasksTheProjectIdAndTheUrlPath() {
    String text = blockfrost().toString();
    assertThat(text).doesNotContain(PROJECT_ID).doesNotContain("k3yInPath")
        .contains("projectId=***")
        .contains("baseUrl=https://cardano-preprod.blockfrost.io")
        .contains("network=cardano:preprod");
  }

  @Test
  void signerConfigMasksTheMnemonic() {
    ClientCardanoSignerConfig config = ClientCardanoSignerConfig.builder()
        .mnemonic(MNEMONIC)
        .network("cardano:preprod")
        .walletProvider(new BlockfrostChainBackend(blockfrost()))
        .build();
    String text = config.toString();
    assertThat(text).doesNotContain("penalty").doesNotContain("choice")
        .contains("mnemonic=***")
        .contains("network=cardano:preprod");
  }
}
