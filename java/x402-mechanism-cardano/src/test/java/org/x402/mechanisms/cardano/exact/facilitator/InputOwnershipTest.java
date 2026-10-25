package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.math.BigInteger;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Spec rule 6: before broadcast, every input must be authorised by its owner. Key-owned inputs
 * need their key's witness; script-owned or unresolvable inputs need a complete phase-1 validator.
 */
class InputOwnershipTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO = new Account(Networks.testnet(), MNEMONIC, 1).baseAddress();
  private static final Account OTHER = new Account(Networks.testnet(), MNEMONIC, 2);
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final String SECOND_HASH = TxBuilder.hash32(0xbb);
  private static final String SECOND = SECOND_HASH + "#0";
  private static final String BYRON = "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi";

  private final StubBackend backend = new StubBackend();

  /** Pays 2 ADA from the wallet's nonce (10 ADA) plus a second 5 ADA input. */
  private TxBuilder twoInputs(UtxoSnapshot second) {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    backend.utxos.put(SECOND, second);
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .input(SECOND_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 12_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300);
  }

  private static UtxoSnapshot owned(String address, String keyHash) {
    return new UtxoSnapshot(true, address, BigInteger.valueOf(5_000_000), Map.of(), keyHash);
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

  private ExactCardanoFacilitatorScheme scheme() {
    return new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .build());
  }

  private VerifyResponse verify(String tx) {
    return scheme().verify(payload(tx), requirements(), FacilitatorContext.EMPTY);
  }

  @Test
  void anInputOwnedByAnotherKeyNeedsItsWitness() {
    String tx = twoInputs(owned(OTHER.baseAddress(), null)).signWith(TxBuilder.WALLET).build();

    VerifyResponse verdict = verify(tx);
    SettleResponse settled = scheme().settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
    assertThat(verdict.invalidMessage()).contains(SECOND).contains("witness");
    assertThat(settled.success()).isFalse();
    assertThat(backend.submitted).isEmpty();
  }

  @Test
  void aMultiKeyWalletWithAllWitnessesIsValid() {
    String tx = twoInputs(owned(OTHER.baseAddress(), null)).signWith(TxBuilder.WALLET).signWith(OTHER).build();
    assertThat(verify(tx).isValid()).isTrue();
  }

  @Test
  void scriptWitnessesAloneDoNotAuthorizeKeyInputs() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    byte[] keyHash = HexFormat.of().parseHex(TxBuilder.hash28(0x01));
    byte[] nativeScripts = new byte[4 + keyHash.length];
    nativeScripts[0] = (byte) 0x81; // [ script ]
    nativeScripts[1] = (byte) 0x82; // script = [0, keyhash]
    nativeScripts[2] = 0x00;
    nativeScripts[3] = 0x58;
    byte[] withLength = new byte[nativeScripts.length + 1];
    System.arraycopy(nativeScripts, 0, withLength, 0, 4);
    withLength[4] = 0x1c;
    System.arraycopy(keyHash, 0, withLength, 5, keyHash.length);
    String tx = TxBuilder.create()
        .input(NONCE_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .witnessField(1, withLength)
        .build();

    VerifyResponse verdict = verify(tx);

    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  @Test
  void aScriptOwnedInputNeedsACompletePhase1Validator() {
    String scriptAddress = CardanoAddresses.enterpriseScriptAddress(NETWORK, TxBuilder.hash28(0x02));
    String tx = twoInputs(owned(scriptAddress, null)).signWith(TxBuilder.WALLET).build();

    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
    backend.phase1Validator = true;
    assertThat(verify(tx).isValid()).isTrue();
  }

  @Test
  void anUnresolvableOwnerFailsClosed() {
    String unknown = twoInputs(owned(null, null)).signWith(TxBuilder.WALLET).build();
    assertThat(verify(unknown).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);

    String byron = twoInputs(owned(BYRON, null)).signWith(TxBuilder.WALLET).build();
    assertThat(verify(byron).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);

    String hinted = twoInputs(owned(null, CardanoAddresses.paymentKeyHash(PAYER))).signWith(TxBuilder.WALLET).build();
    assertThat(verify(hinted).isValid()).isTrue();
  }

  @Test
  void ownershipIsNotRecheckedOnResume() {
    String tx = twoInputs(owned(OTHER.baseAddress(), null)).signWith(TxBuilder.WALLET).signWith(OTHER).build();
    ExactCardanoFacilitatorScheme scheme = scheme();
    SettleResponse first = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(first.isPending()).as("%s", first).isTrue();

    backend.utxos.put(SECOND, UtxoSnapshot.spent(null));
    SettleResponse retry = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(retry.isPending()).as("%s", retry).isTrue();
    assertThat(backend.submitted).hasSize(1);
  }
}
