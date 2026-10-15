package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.common.model.Networks;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/** Protocol parameters missing a value the checks need are a lookup failure, not a skipped check. */
class ProtocolParamsValidationTest {

  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO = new Account(Networks.testnet(),
      "test walk nut penalty hip pave soap entry language right filter choice", 1).baseAddress();
  private static final String HASH = TxBuilder.hash32(0xaa);

  private String verifyWith(ProtocolParams parameters) {
    StubBackend backend = new StubBackend();
    backend.parameters = parameters;
    backend.unspent(HASH + "#0", PAYER, 10_000_000, Map.of());
    String tx = TxBuilder.create()
        .input(HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET)
        .build();
    PaymentRequirements req =
        new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000", PAY_TO, 600, Map.of());
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", HASH + "#0");
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build());
    return scheme.verify(new PaymentPayload(2, null, req, p, null), req, FacilitatorContext.EMPTY)
        .invalidReason();
  }

  @Test
  void parametersWithoutCoinsPerUtxoByteAreALookupFailure() {
    ProtocolParams p = ProtocolParams.builder().minFeeA(44).minFeeB(155381).build();
    assertThat(verifyWith(p)).isEqualTo(CardanoErrors.CHAIN_LOOKUP_FAILED);
  }

  @Test
  void negativeParametersAreALookupFailure() {
    ProtocolParams p = ProtocolParams.builder().minFeeA(44).minFeeB(-1).coinsPerUtxoSize("4310").build();
    assertThat(verifyWith(p)).isEqualTo(CardanoErrors.CHAIN_LOOKUP_FAILED);
  }
}
