package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Output indexes are carried exactly: an input {@code X#4294967296} is never read as {@code X#0},
 * as a 32-bit index would.
 */
class InputIndexRangeTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO = new Account(Networks.testnet(),
      "test walk nut penalty hip pave soap entry language right filter choice", 1).baseAddress();
  private static final String HASH = TxBuilder.hash32(0xaa);
  private static final long PAST_32_BITS = 4_294_967_296L;

  private final StubBackend backend = new StubBackend();

  private static PaymentRequirements requirements() {
    return new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, Map.of());
  }

  private VerifyResponse verify(long inputIndex, String nonce) {
    String tx = TxBuilder.create()
        .input(HASH, inputIndex)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET)
        .build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", nonce);
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .build());
    return scheme.verify(new PaymentPayload(2, null, requirements(), p, null), requirements(),
        FacilitatorContext.EMPTY);
  }

  @Test
  void anInputPast32BitsIsNotTheNonceAtIndexZero() {
    backend.unspent(HASH + "#0", PAYER, 10_000_000, Map.of());

    assertThat(verify(PAST_32_BITS, HASH + "#0").invalidReason())
        .isEqualTo(CardanoErrors.NONCE_NOT_IN_INPUTS);
  }

  @Test
  void aNonceAndInputPast32BitsAreNotLookedUpAsIndexZero() {
    backend.unspent(HASH + "#0", PAYER, 10_000_000, Map.of());
    backend.utxos.put(HASH + "#" + PAST_32_BITS, UtxoSnapshot.spent(null));

    assertThat(verify(PAST_32_BITS, HASH + "#" + PAST_32_BITS).invalidReason())
        .isEqualTo(CardanoErrors.NONCE_NOT_ON_CHAIN);
  }
}
