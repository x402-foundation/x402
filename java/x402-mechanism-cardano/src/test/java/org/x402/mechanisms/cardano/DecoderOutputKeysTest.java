package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.Cbor;

/** Map-form outputs: only keys 0..3 exist, and an inline datum comes back in canonical form. */
class DecoderOutputKeysTest {

  private static String txWith(byte[] output) {
    return TxBuilder.create()
        .input(TxBuilder.hash32(1), 0)
        .rawOutput(output)
        .fee(200_000)
        .ttl(1000L)
        .signWith(TxBuilder.WALLET)
        .build();
  }

  @Test
  void aMapOutputWithAKeyOutside0To3IsRefused() {
    byte[] output = new Cbor.Writer()
        .header(5, 3)
        .header(0, 0).bytes(CardanoAddresses.toBytes(TxBuilder.walletAddress()))
        .header(0, 1).header(0, 2_000_000)
        .header(0, 4).header(0, 7)
        .toByteArray();
    String tx = txWith(output);
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void aMapOutputWithKeys0To3IsStillRead() {
    byte[] output = new Cbor.Writer()
        .header(5, 2)
        .header(0, 0).bytes(CardanoAddresses.toBytes(TxBuilder.walletAddress()))
        .header(0, 1).header(0, 2_000_000)
        .toByteArray();
    assertThat(CardanoTransactionDecoder.decode(txWith(output)).outputs()).hasSize(1);
  }

  @Test
  void anInlineDatumByteStringOver64BytesIsRechunkedLikeTheTypeScriptDecoder() {
    byte[] definite = new Cbor.Writer().bytes(new byte[100]).toByteArray();
    String tx = TxBuilder.create()
        .input(TxBuilder.hash32(1), 0)
        .output(TxBuilder.walletAddress(), 2_000_000, Map.of(), definite, false)
        .fee(200_000)
        .ttl(1000L)
        .signWith(TxBuilder.WALLET)
        .build();
    String datum = CardanoTransactionDecoder.decode(tx).outputs().get(0).datum();
    assertThat(datum).isEqualTo("5f5840" + "00".repeat(64) + "5824" + "00".repeat(36) + "ff");
  }
}
