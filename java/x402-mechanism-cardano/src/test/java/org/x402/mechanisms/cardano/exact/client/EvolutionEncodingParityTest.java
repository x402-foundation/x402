package org.x402.mechanisms.cardano.exact.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * The Java encoder writes transactions in the canonical form: re-encoding the parts of a
 * fixture transaction built by the TypeScript SDK reproduces its bytes. This matters because a
 * facilitator that decodes and re-encodes before submitting would otherwise change the
 * transaction id.
 */
class EvolutionEncodingParityTest {

  @ParameterizedTest
  @ValueSource(strings = {"01-default-happy", "01e-native-asset-happy", "16-script-happy", "12-masumi-happy", "10-below-min-utxo"})
  void reEncodingAnEvolutionTransactionReproducesItsBytes(String fixtureId) {
    String base64 = Vectors.fixture(fixtureId).get("payload").get("payload").get("transaction").asText();
    byte[] original = Base64.getDecoder().decode(base64);
    DecodedCardanoTransaction tx = CardanoTransactionDecoder.decode(base64);
    Cbor.Item witness = Cbor.decode(original).items().get(1).get(0).untagSet().items().get(0);

    List<PaymentTransactionBuilder.Output> outputs = new ArrayList<>();
    for (DecodedCardanoTransaction.Output o : tx.outputs()) {
      outputs.add(
          new PaymentTransactionBuilder.Output(
              o.address(), o.coin(), o.assets(), o.datum() == null ? null : HexFormat.of().parseHex(o.datum())));
    }
    byte[] rebuilt =
        PaymentTransactionBuilder.encode(
            tx.inputs(), outputs, tx.fee(), tx.ttlSlot(), witness.items().get(0).bytes(), witness.items().get(1).bytes());

    assertThat(HexFormat.of().formatHex(rebuilt)).isEqualTo(HexFormat.of().formatHex(original));
  }
}
