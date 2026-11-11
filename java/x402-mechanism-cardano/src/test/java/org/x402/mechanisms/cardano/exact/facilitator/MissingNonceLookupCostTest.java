package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoErrors;

/** A fabricated nonce is refused after one lookup, not after resolving every other input. */
class MissingNonceLookupCostTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";

  private static final class Counting extends StubBackend {
    final AtomicInteger lookups = new AtomicInteger();

    @Override
    public UtxoSnapshot getUtxo(String ref, String network) {
      lookups.incrementAndGet();
      return super.getUtxo(ref, network);
    }
  }

  private static PaymentRequirements requirements() {
    return new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, Map.of());
  }

  private static PaymentPayload payload(String tx) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    return new PaymentPayload(2, null, requirements(), p, null);
  }

  private static String withInputs(Counting backend, int others, boolean spendOne) {
    backend.utxos.put(NONCE.toLowerCase(java.util.Locale.ROOT), UtxoSnapshot.spent(null));
    TxBuilder tx = TxBuilder.create().input(NONCE_HASH, 0);
    for (int i = 0; i < others; i++) {
      String hash = TxBuilder.hash32(i + 1);
      if (spendOne && i == 0) {
        backend.utxos.put((hash + "#0").toLowerCase(java.util.Locale.ROOT), UtxoSnapshot.spent(null));
      } else {
        backend.unspent(hash + "#0", PAYER, 2_000_000, Map.of());
      }
      tx.input(hash, 0);
    }
    return tx.output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET)
        .build();
  }

  @Test
  void aFabricatedNonceCostsOneLookup() {
    Counting backend = new Counting();
    String tx = withInputs(backend, 20, false);
    VerifyResponse verdict = new ExactCardanoFacilitatorScheme(backend)
        .verify(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.NONCE_NOT_ON_CHAIN);
    assertThat(backend.lookups).hasValue(1);
  }

  @Test
  void theFirstMissingInputStopsTheLookups() {
    Counting backend = new Counting();
    String tx = withInputs(backend, 20, true);
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    VerifyResponse verdict = new ExactCardanoFacilitatorScheme(backend)
        .verify(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.INPUT_NOT_AVAILABLE);
    assertThat(backend.lookups.get()).isLessThan(21);
  }

  /** How many lookups a verification that stops at {@code ref} makes: the nonce, then each input up to it. */
  private static int lookupsUpTo(String tx, String ref) {
    int count = 1;
    for (String input : org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder.decode(tx).inputs()) {
      if (input.equalsIgnoreCase(NONCE)) {
        continue;
      }
      count++;
      if (input.equalsIgnoreCase(ref)) {
        return count;
      }
    }
    throw new AssertionError(ref + " is not an input");
  }

  @Test
  void theLookupsStopExactlyAtTheFirstMissingInputAndNameTheNonceOwner() {
    Counting backend = new Counting();
    String tx = withInputs(backend, 20, true);
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());

    VerifyResponse verdict = new ExactCardanoFacilitatorScheme(backend)
        .verify(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.INPUT_NOT_AVAILABLE);
    assertThat(verdict.payer()).isEqualTo(PAYER);
    assertThat(backend.lookups).hasValue(lookupsUpTo(tx, TxBuilder.hash32(1) + "#0"));
  }

  @Test
  void aMissingInputLateInTheListStillStopsBeforeTheInputsAfterIt() {
    Counting backend = new Counting();
    String tx = withInputs(backend, 20, false);
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    String late = TxBuilder.hash32(10) + "#0";
    backend.utxos.put(late.toLowerCase(java.util.Locale.ROOT), UtxoSnapshot.spent(null));

    VerifyResponse verdict = new ExactCardanoFacilitatorScheme(backend)
        .verify(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.INPUT_NOT_AVAILABLE);
    assertThat(backend.lookups).hasValue(lookupsUpTo(tx, late));
    assertThat(backend.lookups.get()).isLessThan(21);
  }

  @Test
  void aFabricatedNonceWithTheMaximumOfLookupsStillCostsOne() {
    Counting backend = new Counting();
    String tx = withInputs(backend, ExactCardanoFacilitatorOptions.DEFAULT_MAX_INPUT_LOOKUPS - 1, false);

    VerifyResponse verdict = new ExactCardanoFacilitatorScheme(backend)
        .verify(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.NONCE_NOT_ON_CHAIN);
    assertThat(backend.lookups).hasValue(1);
  }
}
