package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.common.model.SlotConfig;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/** A per-network slot configuration replaces the built-in one in every time check. */
class SlotConfigOverrideTest {

  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO = new Account(Networks.testnet(),
      "test walk nut penalty hip pave soap entry language right filter choice", 1).baseAddress();
  private static final String HASH = TxBuilder.hash32(0xaa);
  private static final PaymentRequirements REQ =
      new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000", PAY_TO, 600, Map.of());

  private static String verify(SlotConfig slotConfig) {
    StubBackend backend = new StubBackend();
    backend.unspent(HASH + "#0", PAYER, 10_000_000, Map.of());
    String tx = TxBuilder.create()
        .input(HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 400)
        .signWith(TxBuilder.WALLET)
        .build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", HASH + "#0");
    var options = ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1))
        .slotConfig(slotConfig).build();
    return new ExactCardanoFacilitatorScheme(backend, null, options)
        .verify(new PaymentPayload(2, null, REQ, p, null), REQ, FacilitatorContext.EMPTY)
        .invalidReason();
  }

  @Test
  void theBuiltInConfigAcceptsATtl400SlotsAhead() {
    assertThat(verify(null)).isNull();
  }

  @Test
  void aSlowerSlotConfigMakesTheSameTtlTooFar() {
    SlotConfig preprod = CardanoNetworks.slotConfig("cardano:preprod");
    SlotConfig twoSecondSlots = new SlotConfig(2000, preprod.getZeroSlot(), preprod.getZeroTime());

    assertThat(verify(twoSecondSlots)).isEqualTo(CardanoErrors.TTL_TOO_FAR);
  }

  @org.junit.jupiter.api.Test
  void aNonPositiveSlotLengthFailsAtConstruction() {
    for (int length : new int[] {0, -1}) {
      var slots = new com.bloxbean.cardano.client.common.model.SlotConfig(length, 100, 1_000_000L);
      org.assertj.core.api.Assertions.assertThatThrownBy(
              () -> ExactCardanoFacilitatorOptions.builder().slotConfig(slots).build())
          .isInstanceOf(IllegalArgumentException.class);
      org.assertj.core.api.Assertions.assertThatThrownBy(
              () -> org.x402.mechanisms.cardano.chain.BlockfrostChainBackend.Config.builder()
                  .network("cardano:preprod").projectId("k").slotConfig(slots).build())
          .isInstanceOf(IllegalArgumentException.class);
    }
  }
}
