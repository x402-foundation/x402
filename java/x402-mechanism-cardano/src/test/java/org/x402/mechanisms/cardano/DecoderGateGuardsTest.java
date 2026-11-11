package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.transaction.util.TransactionUtil;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.Cbor;

/**
 * The strict reader in front of untrusted transactions: hostile lengths and nesting fail as
 * ordinary decode errors (never as JVM errors), also inside an inline datum, and the transaction
 * id is the hash of the body's raw bytes.
 */
class DecoderGateGuardsTest {

  private static final byte[] HUGE_BYTE_STRING = HexFormat.of().parseHex("5a7fffffff");

  private static byte[] nested(int depth) {
    byte[] b = new byte[depth + 1];
    Arrays.fill(b, 0, depth, (byte) 0x81);
    b[depth] = 0x00;
    return b;
  }

  private static String withDatum(byte[] datum) {
    return TxBuilder.create()
        .input(TxBuilder.hash32(1), 0)
        .output(TxBuilder.walletAddress(), 2_000_000, Map.of(), datum, false)
        .fee(200_000)
        .ttl(1000L)
        .signWith(TxBuilder.WALLET)
        .build();
  }

  @Test
  void aHugeDeclaredLengthIsADecodeError() {
    String tx = Base64.getEncoder().encodeToString(HUGE_BYTE_STRING);
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).isInstanceOf(RuntimeException.class);
  }

  @Test
  void aHugeDeclaredLengthInAnInlineDatumIsADecodeError() {
    String tx = withDatum(HUGE_BYTE_STRING);
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).isInstanceOf(RuntimeException.class);
  }

  @Test
  void deepNestingIsADecodeError() {
    String tx = Base64.getEncoder().encodeToString(nested(20_000));
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).isInstanceOf(RuntimeException.class);
  }

  @Test
  void deepNestingInAnInlineDatumIsADecodeError() {
    String tx = withDatum(nested(20_000));
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).isInstanceOf(RuntimeException.class);
  }

  @Test
  void theTransactionIdHashesTheRawBodyBytes() {
    TxBuilder builder = TxBuilder.create()
        .input(TxBuilder.hash32(1), 0)
        .output(TxBuilder.walletAddress(), 2_000_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(1000L)
        .signWith(TxBuilder.WALLET);
    String tx = builder.build();

    assertThat(CardanoTransactionDecoder.decode(tx).txHash())
        .isEqualTo(builder.txHash())
        .isEqualTo(TransactionUtil.getTxHash(Base64.getDecoder().decode(tx)));
  }

  @Test
  void aTagThatOnlyMatches24InItsLow32BitsIsNotAnInlineDatum() {
    // [1, #6.(2^32 + 24)(h'00')] in place of [1, #6.24(h'00')]
    byte[] output = new Cbor.Writer()
        .header(5, 3)
        .header(0, 0).bytes(CardanoAddresses.toBytes(TxBuilder.walletAddress()))
        .header(0, 1).header(0, 2_000_000)
        .header(0, 2).header(4, 2).header(0, 1).header(6, (1L << 32) + 24).bytes(new byte[] {0})
        .toByteArray();
    String tx = TxBuilder.create()
        .input(TxBuilder.hash32(1), 0)
        .rawOutput(output)
        .fee(200_000)
        .ttl(1000L)
        .signWith(TxBuilder.WALLET)
        .build();
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).isInstanceOf(RuntimeException.class);
  }
}
