package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoErrors;

/**
 * A backend that answers no snapshot for an input is no verdict on the payment
 * ({@code verification_error}), but a later input that is spent, or whose lookup fails, keeps its
 * own reason, as before the input checks were folded into the lookup loop.
 */
class UnansweredInputSnapshotTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final String SILENT = TxBuilder.hash32(0xbb) + "#1";
  private static final String LATER = TxBuilder.hash32(0xcc) + "#2";

  private final StubBackend backend = new StubBackend();

  private String tx() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .input(TxBuilder.hash32(0xbb), 1)
        .input(TxBuilder.hash32(0xcc), 2)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET)
        .build();
  }

  private VerifyResponse verify(StubBackend answering, String tx) {
    PaymentRequirements req = new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, Map.of());
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    return new ExactCardanoFacilitatorScheme(answering)
        .verify(new PaymentPayload(2, null, req, p, null), req, FacilitatorContext.EMPTY);
  }

  /** The stub, except that the {@link #SILENT} input is answered with {@code null}. */
  private StubBackend silentOn() {
    return new StubBackend() {
      @Override
      public UtxoSnapshot getUtxo(String ref, String network) {
        return ref.equalsIgnoreCase(SILENT) ? null : backend.getUtxo(ref, network);
      }
    };
  }

  @Test
  void anUnansweredInputIsAVerificationError() {
    String tx = tx();
    backend.unspent(LATER, PAYER, 0, Map.of());
    VerifyResponse verdict = verify(silentOn(), tx);
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.INVALID_PAYLOAD + "_verification_error");
  }

  @Test
  void aLaterSpentInputKeepsItsReason() {
    String tx = tx();
    backend.utxos.put(LATER, UtxoSnapshot.spent(PAYER));
    VerifyResponse verdict = verify(silentOn(), tx);
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.INPUT_NOT_AVAILABLE);
    assertThat(verdict.payer()).isEqualTo(PAYER);
  }

  @Test
  void aLaterFailedLookupKeepsItsReason() {
    String tx = tx();
    // LATER is unknown to the stub: its lookup throws.
    VerifyResponse verdict = verify(silentOn(), tx);
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.CHAIN_LOOKUP_FAILED);
  }
}
