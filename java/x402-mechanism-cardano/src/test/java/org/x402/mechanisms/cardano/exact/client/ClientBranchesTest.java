package org.x402.mechanisms.cardano.exact.client;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.api.model.Utxo;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.signer.ClientCardanoSignerConfig;
import org.x402.mechanisms.cardano.signer.MnemonicClientCardanoSigner;
import org.x402.mechanisms.cardano.testing.StubWallet;
import org.x402.mechanisms.cardano.testing.Ccl;
import org.x402.mechanisms.cardano.utils.CardanoUtils;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Balancing, coin selection, signer and wallet-provider edges.
 */
class ClientBranchesTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  private static final String WALLET = TxBuilder.walletAddress();
  private static final String PAY_TO = CardanoClientAcceptanceTest.PAY_TO;
  private static final String USDM = CardanoClientAcceptanceTest.USDM;
  private static final String OTHER = TxBuilder.hash28(9) + ".01";
  private static final ProtocolParams PARAMS = Ccl.PARAMS;
  private static final PaymentTransactionBuilder.BodySigner SIGNER =
      hash -> new byte[][] {TxBuilder.WALLET.publicKeyBytes(), new byte[64]};

  private static Utxo utxo(int b, long coin, Map<String, BigInteger> assets) {
    return Ccl.utxo(TxBuilder.hash32(b), 0, WALLET, BigInteger.valueOf(coin), assets, false);
  }

  private static PaymentTransactionBuilder.Built build(List<Utxo> utxos, long coin, Map<String, BigInteger> assets, boolean raise) {
    return PaymentTransactionBuilder.build(
        new PaymentTransactionBuilder.Spec(
            utxos,
            WALLET,
            new PaymentTransactionBuilder.Payment(new PaymentTransactionBuilder.Output(PAY_TO, BigInteger.valueOf(coin), assets, null), raise),
            BigInteger.valueOf(1000),
            PARAMS),
        SIGNER);
  }

  @Test
  void coinSelectionChangeAndFeeFolding() {
    var built = build(List.of(utxo(1, 1_000_000, Map.of()), utxo(2, 9_000_000, Map.of(OTHER, BigInteger.ONE)),
        utxo(3, 30_000_000, Map.of())), 5_000_000, Map.of(), false);
    assertThat(built.inputs()).containsExactly(TxBuilder.hash32(1) + "#0", TxBuilder.hash32(3) + "#0");
    assertThat(built.nonce()).isEqualTo(TxBuilder.hash32(1) + "#0");

    // A remainder too small for a change output is folded into the fee.
    var folded = build(List.of(utxo(1, 2_200_000, Map.of())), 2_000_000, Map.of(), false);
    DecodedCardanoTransaction tx = CardanoTransactionDecoder.decode(java.util.Base64.getEncoder().encodeToString(folded.bytes()));
    assertThat(tx.outputs()).hasSize(1);
    assertThat(tx.fee()).isEqualTo(BigInteger.valueOf(200_000));

    // Change carries the wallet's other tokens back, policies in canonical order.
    var multi = build(List.of(utxo(1, 10_000_000, Map.of(USDM, BigInteger.TEN, OTHER, BigInteger.TWO,
        TxBuilder.hash28(9) + ".0102", BigInteger.ONE))), 2_000_000, Map.of(USDM, BigInteger.ONE), true);
    DecodedCardanoTransaction change = CardanoTransactionDecoder.decode(java.util.Base64.getEncoder().encodeToString(multi.bytes()));
    assertThat(change.outputs().get(1).assets()).containsKeys(USDM, OTHER).containsEntry(USDM, BigInteger.valueOf(9));

    assertThatThrownBy(() -> build(List.of(utxo(1, 2_100_000, Map.of())), 2_000_000, Map.of(), false))
        .hasMessageStartingWith("insufficient funds: short ").hasMessageEndingWith(" lovelace");
    assertThatThrownBy(() -> build(List.of(utxo(1, 50_000_000, Map.of())), 2_000_000, Map.of(USDM, BigInteger.ONE), true))
        .hasMessageStartingWith("insufficient funds: short 0 lovelace and 1 " + USDM);
    assertThatThrownBy(() -> build(List.of(utxo(1, 50_000_000, Map.of())), 100, Map.of(), false))
        .hasMessageStartingWith("payment of 100 lovelace is below the min-UTxO of ");
    assertThatThrownBy(() -> build(List.of(), 1, Map.of(), false))
        .hasMessage("Funding wallet has no UTXOs available for the payment");
    var noChangeWithTokens = List.of(utxo(1, 2_150_000, Map.of(OTHER, BigInteger.ONE)));
    assertThatThrownBy(() -> build(noChangeWithTokens, 2_000_000, Map.of(), false)).hasMessageStartingWith("insufficient funds");
  }

  @Test
  void theSignerRefusesAnEmptyWalletAndSkipsReferenceScripts() {
    StubWallet wallet = new StubWallet();
    var signer =
        new MnemonicClientCardanoSigner(
            ClientCardanoSignerConfig.builder()
                .mnemonic(CardanoClientAcceptanceTest.MNEMONIC)
                .network("cip34:0-1")
                .walletProvider(wallet)
                .clock(CardanoClientAcceptanceTest.CLOCK)
                .build());
    assertThat(signer.getAddress()).isEqualTo(WALLET);
    var scheme = new ExactCardanoClientScheme(signer);
    PaymentRequirements req = new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000", PAY_TO, 600, null);
    assertThatThrownBy(() -> scheme.createPaymentPayload(2, req, SchemeNetworkClient.PaymentPayloadContext.EMPTY))
        .hasMessage("Funding wallet has no UTXOs available for the payment");
    wallet.utxos.add(Ccl.utxo(TxBuilder.hash32(5), 0, WALLET, BigInteger.valueOf(90_000_000), Map.of(), true));
    wallet.utxo(TxBuilder.hash32(6), 2, WALLET, 9_000_000, Map.of());
    assertThat(scheme.createPaymentPayload(2, req, SchemeNetworkClient.PaymentPayloadContext.EMPTY).payload())
        .containsEntry("nonce", TxBuilder.hash32(6) + "#2");
    assertThatThrownBy(() -> ClientCardanoSignerConfig.builder().mnemonic("m").network("x").walletProvider(wallet).build())
        .hasMessage("Unsupported Cardano network: x");
  }

  @Test
  void theSchemeChecksWhatTheSignerReturns() {
    PaymentRequirements req = new PaymentRequirements("exact", "cardano:preprod", "lovelace", "1", PAY_TO, 60, null);
    for (ClientCardanoSignResult bad : java.util.Arrays.asList(null, new ClientCardanoSignResult("", "x"), new ClientCardanoSignResult("tx", "bad"))) {
      ClientCardanoSigner signer =
          new ClientCardanoSigner() {
            @Override
            public String getAddress() {
              return WALLET;
            }

            @Override
            public ClientCardanoSignResult buildAndSignPaymentTransaction(ClientCardanoSignInput input) {
              return bad;
            }
          };
      assertThatThrownBy(() -> new ExactCardanoClientScheme(signer).createPaymentPayload(2, req, SchemeNetworkClient.PaymentPayloadContext.EMPTY))
          .hasMessageStartingWith("Cardano signer returned an");
    }
  }

  @Test
  void blockfrostServesTheWalletUtxosAcrossPages() {
    StringBuilder page1 = new StringBuilder("[");
    for (int i = 0; i < 100; i++) {
      page1.append(i == 0 ? "" : ",")
          .append("{\"tx_hash\":\"").append("AB".repeat(32)).append("\",\"output_index\":").append(i)
          .append(",\"amount\":[{\"unit\":\"lovelace\",\"quantity\":\"1000000\"},{\"unit\":\"")
          .append(TxBuilder.hash28(1)).append("01\",\"quantity\":\"3\"}],\"reference_script_hash\":")
          .append(i == 1 ? "\"ff\"" : "null").append("}");
    }
    page1.append("]");
    wm.stubFor(get(urlPathEqualTo("/addresses/" + WALLET + "/utxos")).withQueryParam("page", equalTo("1")).willReturn(okJson(page1.toString())));
    wm.stubFor(get(urlPathEqualTo("/addresses/" + WALLET + "/utxos")).withQueryParam("page", equalTo("2")).willReturn(aResponse().withStatus(404)));
    var backend =
        new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder().network("cardano:preprod").baseUrl(wm.baseUrl()).build());

    List<Utxo> utxos = backend.getAll(WALLET);

    assertThat(utxos).hasSize(100);
    assertThat(CardanoUtils.ref(utxos.get(0))).isEqualTo("ab".repeat(32) + "#0");
    assertThat(utxos.get(0).getAddress()).isEqualTo(WALLET);
    assertThat(CardanoUtils.assets(utxos.get(0))).containsEntry(TxBuilder.hash28(1) + ".01", BigInteger.valueOf(3));
    assertThat(utxos.get(1).getReferenceScriptHash() != null).isTrue();
  }

  @Test
  void outputDefaultsAndTheEmptyBuyerInput() {
    var output = new PaymentTransactionBuilder.Output(PAY_TO, BigInteger.ONE, null, new byte[] {1});
    assertThat(output.datum()).containsExactly(1);
    assertThat(output.assets()).isEmpty();
    assertThat(MasumiBuyerInput.NONE.buyerReturnAddress()).isNull();
  }
}
