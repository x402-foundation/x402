package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.Ccl;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Pre-broadcast checks beyond the base rules: the payee and every output on the requirements'
 * network, min-UTxO on every output, witnessed required signers, a plain body, the protocol's
 * maximum size, committed auxiliary data, a positive timeout, and the nonce owner's witness
 * before any other input is looked up.
 */
class VerifyHardeningRulesTest {

  private static final String MNEMONIC = "test walk nut penalty hip pave soap entry language right filter choice";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO = new Account(Networks.testnet(), MNEMONIC, 1).baseAddress();
  private static final Account OTHER = new Account(Networks.testnet(), MNEMONIC, 2);
  private static final String MAINNET_ADDRESS = new Account(Networks.mainnet(), MNEMONIC, 1).baseAddress();
  private static final String HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = HASH + "#0";
  private static final String DECODE_FAILED = CardanoErrors.TRANSACTION_DECODE_FAILED;

  private final StubBackend backend = new StubBackend();

  private static PaymentRequirements requirements(String payTo, int maxTimeoutSeconds) {
    return new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000", payTo, maxTimeoutSeconds,
        Map.of());
  }

  private TxBuilder plain() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .isValid(true);
  }

  private VerifyResponse verify(String tx, PaymentRequirements req) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build());
    return scheme.verify(new PaymentPayload(2, null, req, p, null), req, FacilitatorContext.EMPTY);
  }

  private VerifyResponse verify(String tx) {
    return verify(tx, requirements(PAY_TO, 600));
  }

  // ---------------------------------------------------------------- requirements (A3, A16)

  @Test
  void aPayeeOnAnotherNetworkIsInvalidRequirements() {
    String tx = plain().signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx, requirements(MAINNET_ADDRESS, 600)).invalidReason())
        .isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
  }

  @Test
  void aNonPositiveTimeoutIsInvalidRequirements() {
    String tx = plain().signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx, requirements(PAY_TO, 0)).invalidReason()).isEqualTo(CardanoErrors.REQUIREMENTS_INVALID);
  }

  @Test
  void anOverlongNonceIsInvalid() {
    String tx = plain().signWith(TxBuilder.WALLET).build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", HASH + "#" + "0".repeat(20));
    PaymentRequirements req = requirements(PAY_TO, 600);
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.defaults());
    assertThat(scheme.verify(new PaymentPayload(2, null, req, p, null), req, FacilitatorContext.EMPTY).invalidReason())
        .isEqualTo(CardanoErrors.NONCE_INVALID);
  }

  // ---------------------------------------------------------------- outputs (A4)

  @Test
  void aChangeOutputOnAnotherNetworkIsRefused() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    String tx = TxBuilder.create().input(HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(MAINNET_ADDRESS, 7_800_000, Map.of(), null, false)
        .fee(200_000).ttl(backend.slot + 300).isValid(true).signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.NETWORK_ID_MISMATCH);
  }

  @Test
  void aChangeOutputBelowMinUtxoIsRefused() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    backend.unspent(HASH + "#1", PAYER, 0, Map.of());
    String tx = TxBuilder.create().input(HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_000_000, Map.of(), null, false)
        .output(PAYER, 800_000 - 799_000, Map.of(), null, false)
        .fee(200_000 + 799_000).ttl(backend.slot + 300).isValid(true).signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.MIN_UTXO_INSUFFICIENT);
  }

  // ---------------------------------------------------------------- body (A5, A6, N4, A7)

  @Test
  void anUnwitnessedRequiredSignerIsRefused() {
    byte[] signers = new Cbor.Writer().header(4, 1).bytes(HexFormat.of().parseHex(TxBuilder.hash28(0x01)))
        .toByteArray();
    String tx = plain().bodyField(14, signers).signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  @Test
  void aWitnessedRequiredSignerIsFine() {
    byte[] own = Blake2bUtil.blake2bHash224(TxBuilder.WALLET.publicKeyBytes());
    byte[] signers = new Cbor.Writer().header(4, 1).bytes(own).toByteArray();
    String tx = plain().bodyField(14, signers).signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx).isValid()).isTrue();
  }

  @Test
  void collateralNeedsACompletePhase1Validator() {
    byte[] collateral = new Cbor.Writer().header(4, 1).header(4, 2).bytes(HexFormat.of().parseHex(HASH))
        .header(0, 0).toByteArray();
    String tx = plain().bodyField(13, collateral).signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  @Test
  void aTaggedBodyKeyIsADecodeFailure() {
    byte[] body = plain().body();
    int entries = (body[0] & 0xff) - 0xa0;
    byte[] tagged = new Cbor.Writer().header(5, entries + 1).raw(Arrays.copyOfRange(body, 1, body.length))
        .header(6, 1).header(0, 9).header(5, 0).toByteArray();
    byte[] tx = new Cbor.Writer().header(4, 4).raw(tagged).header(5, 0).raw(0xf5).raw(0xf6).toByteArray();
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(Base64.getEncoder().encodeToString(tx)))
        .isInstanceOf(RuntimeException.class);
  }

  @Test
  void aTransactionOverTheProtocolMaximumIsRefused() {
    backend.parameters = Ccl.params(4310, 44, 155381);
    backend.parameters.setMaxTxSize(100);
    String tx = plain().signWith(TxBuilder.WALLET).build();
    assertThat(verify(tx).invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  @Test
  void aConfiguredSizeLimitAppliesAlsoWithoutProtocolParameters() {
    backend.parameters = null;
    String tx = plain().signWith(TxBuilder.WALLET).build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    PaymentRequirements req = requirements(PAY_TO, 600);
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .maxTransactionBytes(100).build());
    assertThat(scheme.verify(new PaymentPayload(2, null, req, p, null), req, FacilitatorContext.EMPTY).invalidReason())
        .isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  // ---------------------------------------------------------------- auxiliary data (A14)

  private static byte[] metadata(String text) {
    return new Cbor.Writer().header(5, 1).header(0, 674).text(text).toByteArray();
  }

  private String withAux(byte[] aux, byte[] committedHash) {
    TxBuilder b = plain();
    if (committedHash != null) {
      b.bodyField(7, new Cbor.Writer().bytes(committedHash).toByteArray());
    }
    if (aux != null) {
      b.auxiliaryData(aux);
    }
    return b.signWith(TxBuilder.WALLET).build();
  }

  @Test
  void correctlyCommittedMetadataIsFine() {
    byte[] aux = metadata("hello");
    assertThat(verify(withAux(aux, Blake2bUtil.blake2bHash256(aux))).isValid()).isTrue();
  }

  @Test
  void taggedAlonzoMetadataIsFine() {
    byte[] aux = new Cbor.Writer().header(6, 259).header(5, 1).header(0, 0).raw(metadata("hi")).toByteArray();
    assertThat(verify(withAux(aux, Blake2bUtil.blake2bHash256(aux))).isValid()).isTrue();
  }

  @Test
  void aCommitmentWithoutAuxiliaryDataIsADecodeFailure() {
    assertThat(verify(withAux(null, new byte[32])).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void auxiliaryDataWithoutACommitmentIsADecodeFailure() {
    assertThat(verify(withAux(metadata("hello"), null)).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void aMismatchedCommitmentIsADecodeFailure() {
    assertThat(verify(withAux(metadata("hello"), new byte[32])).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void oversizedMetadataTextIsADecodeFailure() {
    byte[] aux = metadata("x".repeat(65));
    assertThat(verify(withAux(aux, Blake2bUtil.blake2bHash256(aux))).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void aBooleanMetadatumIsADecodeFailure() {
    byte[] aux = new Cbor.Writer().header(5, 1).header(0, 674).raw(0xf5).toByteArray();
    assertThat(verify(withAux(aux, Blake2bUtil.blake2bHash256(aux))).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void anAuxiliaryScriptBundleIsADecodeFailure() {
    byte[] aux = new Cbor.Writer().header(4, 2).raw(metadata("hi")).header(4, 1).header(4, 2).header(0, 0)
        .header(4, 0).toByteArray();
    assertThat(verify(withAux(aux, Blake2bUtil.blake2bHash256(aux))).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  // ---------------------------------------------------------------- nonce owner first (N2)

  @Test
  void anUnwitnessedNonceOwnerIsRefusedBeforeOtherInputsAreLookedUp() {
    AtomicInteger lookups = new AtomicInteger();
    StubBackend counting = new StubBackend() {
      @Override
      public UtxoSnapshot getUtxo(String ref, String network) {
        lookups.incrementAndGet();
        return super.getUtxo(ref, network);
      }
    };
    counting.unspent(NONCE, PAYER, 10_000_000, Map.of());
    counting.unspent(HASH + "#1", OTHER.baseAddress(), 5_000_000, Map.of());
    String tx = TxBuilder.create().input(HASH, 0).input(HASH, 1)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(OTHER.baseAddress(), 12_800_000, Map.of(), null, false)
        .fee(200_000).ttl(counting.slot + 300).isValid(true).signWith(OTHER).build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    PaymentRequirements req = requirements(PAY_TO, 600);
    var scheme = new ExactCardanoFacilitatorScheme(counting, null, ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build());

    VerifyResponse verdict = scheme.verify(new PaymentPayload(2, null, req, p, null), req, FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
    assertThat(lookups.get()).isEqualTo(1);
  }

  @Test
  void theBaselineIsValid() {
    assertThat(verify(plain().signWith(TxBuilder.WALLET).build()).isValid()).isTrue();
    assertThat(CardanoAddresses.parse(MAINNET_ADDRESS).networkId()).isEqualTo(1);
    assertThat("x".repeat(65).getBytes(StandardCharsets.UTF_8)).hasSize(65);
  }
}
