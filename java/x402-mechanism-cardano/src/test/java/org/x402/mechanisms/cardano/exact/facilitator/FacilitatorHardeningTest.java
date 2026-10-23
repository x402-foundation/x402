package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
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
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * Hardening cases: duplicate CBOR map keys fail closed (readers disagree on which duplicate entry wins, the last or the
 * first, so the two would judge different transactions); verify/settle cannot be overridden
 * apart; a backend answering {@code null} evidence is read as unknown.
 */
class FacilitatorHardeningTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String ATTACKER =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 7)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final String DECODE_FAILED = "invalid_exact_cardano_payload_transaction_decode_failed";

  private final StubBackend backend = new StubBackend();

  private TxBuilder plain() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300);
  }

  private static PaymentRequirements requirements(Map<String, Object> extra) {
    return new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, extra);
  }

  private static PaymentPayload payload(PaymentRequirements req, String tx) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    return new PaymentPayload(2, null, req, p, null);
  }

  private VerifyResponse verify(String tx) {
    PaymentRequirements req = requirements(Map.of());
    return new ExactCardanoFacilitatorScheme(backend).verify(payload(req, tx), req, FacilitatorContext.EMPTY);
  }

  private static byte[] vkeyWitnesses(byte[] body) {
    byte[] hash = Blake2bUtil.blake2bHash256(body);
    byte[] sig =
        new EdDSASigningProvider()
            .signExtended(hash, TxBuilder.WALLET.privateKeyBytes(), TxBuilder.WALLET.publicKeyBytes());
    return new Cbor.Writer().header(4, 1).header(4, 2).bytes(TxBuilder.WALLET.publicKeyBytes()).bytes(sig).toByteArray();
  }

  private static String envelope(byte[] body, byte[] witnessSet) {
    byte[] tx = new Cbor.Writer().header(4, 4).raw(body).raw(witnessSet).raw(0xf5).raw(0xf6).toByteArray();
    return Base64.getEncoder().encodeToString(tx);
  }

  @Test
  void theUntamperedBaselineIsValid() {
    byte[] body = plain().body();
    byte[] ws = new Cbor.Writer().header(5, 1).header(0, 0).raw(vkeyWitnesses(body)).toByteArray();
    assertThat(verify(envelope(body, ws)).isValid()).isTrue();
  }

  @Test
  void aDuplicateBodyKeyIsADecodeFailure() {
    byte[] body = plain().body();
    assertThat(body[0] & 0xff).isEqualTo(0xa4);
    byte[] attackerOutputs =
        new Cbor.Writer().header(4, 1).header(4, 2).bytes(CardanoAddresses.toBytes(ATTACKER)).header(0, 9_800_000)
            .toByteArray();
    Cbor.Writer dup = new Cbor.Writer().raw(0xa5).raw(Arrays.copyOfRange(body, 1, body.length));
    byte[] tampered = dup.header(0, 1).raw(attackerOutputs).toByteArray();
    byte[] ws = new Cbor.Writer().header(5, 1).header(0, 0).raw(vkeyWitnesses(tampered)).toByteArray();
    String tx = envelope(tampered, ws);

    assertThat(verify(tx).invalidReason()).isEqualTo(DECODE_FAILED);
    assertThatThrownBy(() -> CardanoTransactionDecoder.decode(tx)).hasMessageContaining("duplicate map key");
  }

  @Test
  void aDuplicateOutputKeyIsADecodeFailure() {
    byte[] output =
        new Cbor.Writer()
            .header(5, 3)
            .header(0, 0).bytes(CardanoAddresses.toBytes(PAY_TO))
            .header(0, 1).header(0, 2_000_000)
            .header(0, 0).bytes(CardanoAddresses.toBytes(ATTACKER))
            .toByteArray();
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    String tx =
        TxBuilder.create()
            .input(NONCE_HASH, 0)
            .rawOutput(output)
            .output(PAYER, 7_800_000, Map.of(), null, false)
            .fee(200_000)
            .ttl(backend.slot + 300)
            .signWith(TxBuilder.WALLET)
            .build();

    assertThat(verify(tx).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void aDuplicateWitnessSetKeyIsADecodeFailure() {
    byte[] body = plain().body();
    byte[] bogus =
        new Cbor.Writer().header(4, 1).header(4, 2).bytes(TxBuilder.WALLET.publicKeyBytes()).bytes(new byte[64])
            .toByteArray();
    byte[] ws =
        new Cbor.Writer().header(5, 2).header(0, 0).raw(vkeyWitnesses(body)).header(0, 0).raw(bogus).toByteArray();

    assertThat(verify(envelope(body, ws)).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void theSpiEntryPointsCannotBeOverriddenApart() throws Exception {
    for (Method m : ExactCardanoFacilitatorScheme.class.getDeclaredMethods()) {
      if (Modifier.isPublic(m.getModifiers()) && (m.getName().equals("verify") || m.getName().equals("settle"))) {
        assertThat(Modifier.isFinal(m.getModifiers())).as(m.toString()).isTrue();
      }
    }
    // Deliberate change (user-approved 2026-10-14): was a lookup of the two-argument form; A11
    // added the recorded payer, so every verifyBroadcast must stay internal, whatever its parameters.
    int found = 0;
    for (Method m : ExactCardanoFacilitatorScheme.class.getDeclaredMethods()) {
      if (m.getName().equals("verifyBroadcast")) {
        found++;
        assertThat(m.getModifiers() & (Modifier.PUBLIC | Modifier.PROTECTED)).as(m.toString()).isZero();
      }
    }
    assertThat(found).isPositive();
  }

  /** A custom evidence-capable backend that answers {@code null} instead of "unknown". */
  private static final class NullEvidenceBackend extends StubBackend {
    RuntimeException submitError;

    NullEvidenceBackend() {
      evidenceCapable = true;
    }

    @Override
    public SettlementEvidence getTransactionEvidence(String txHash, String network) {
      return null;
    }

    @Override
    public SubmissionResult submitTransaction(String tx, String network) {
      if (submitError != null) {
        submitted.add(tx);
        throw submitError;
      }
      return super.submitTransaction(tx, network);
    }
  }

  private static ExactCardanoFacilitatorScheme fast(StubBackend b) {
    return new ExactCardanoFacilitatorScheme(
        b,
        null,
        ExactCardanoFacilitatorOptions.builder()
            .confirmationTimeout(Duration.ofMillis(5))
            .confirmationPoll(Duration.ofMillis(1))
            .build());
  }

  @Test
  void nullEvidenceIsReadAsUnknown() {
    NullEvidenceBackend nulls = new NullEvidenceBackend();
    nulls.unspent(NONCE, PAYER, 10_000_000, Map.of());
    String tx =
        TxBuilder.create()
            .input(NONCE_HASH, 0)
            .output(PAY_TO, 2_000_000, Map.of(), null, false)
            .output(PAYER, 7_800_000, Map.of(), null, false)
            .fee(200_000)
            .ttl(nulls.slot + 300)
            .signWith(TxBuilder.WALLET)
            .build();
    PaymentRequirements req = requirements(Map.of("confirmationPolicy", Map.of("l1Confirmations", 1)));

    SettleResponse pending = fast(nulls).settle(payload(req, tx), req, FacilitatorContext.EMPTY);

    assertThat(pending.isPending()).isTrue();

    NullEvidenceBackend failing = new NullEvidenceBackend();
    failing.unspent(NONCE, PAYER, 10_000_000, Map.of());
    failing.submitError = new IllegalStateException("node unreachable");

    SettleResponse failed = fast(failing).settle(payload(req, tx), req, FacilitatorContext.EMPTY);

    assertThat(failed.success()).isFalse();
    // Deliberate requirement change (D2, user-approved 2026-10-14): an unknown submit outcome was
    // exact_cardano_settlement_failed; it is pending.
    assertThat(failed.errorReason()).isEqualTo("settlement_pending");
  }

  /** A lovelace payment whose first output also carries the given multi-asset map. */
  private String withAssets(byte[] multiAsset) {
    byte[] value = new Cbor.Writer().header(4, 2).header(0, 2_000_000).raw(multiAsset).toByteArray();
    byte[] output = new Cbor.Writer()
        .header(5, 2)
        .header(0, 0).bytes(CardanoAddresses.toBytes(PAY_TO))
        .header(0, 1).raw(value)
        .toByteArray();
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .rawOutput(output)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET)
        .build();
  }

  private static final byte[] POLICY = HexFormat.of().parseHex(TxBuilder.hash28(0x07));

  @Test
  void aDuplicateAssetNameIsADecodeFailure() {
    byte[] assets = new Cbor.Writer()
        .header(5, 1).bytes(POLICY)
        .header(5, 2).bytes(new byte[] {1}).header(0, 1).bytes(new byte[] {1}).header(0, 1000)
        .toByteArray();

    assertThat(verify(withAssets(assets)).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void aChunkedAssetNameEqualToADefiniteOneIsADecodeFailure() {
    byte[] assets = new Cbor.Writer()
        .header(5, 1).bytes(POLICY)
        .header(5, 2)
        .raw(0x5f).bytes(new byte[] {1}).raw(0xff).header(0, 1)
        .bytes(new byte[] {1}).header(0, 1000)
        .toByteArray();

    assertThat(verify(withAssets(assets)).invalidReason()).isEqualTo(DECODE_FAILED);
  }

  @Test
  void aDuplicatePolicyIdIsADecodeFailure() {
    byte[] assets = new Cbor.Writer()
        .header(5, 2)
        .bytes(POLICY).header(5, 1).bytes(new byte[] {1}).header(0, 1)
        .bytes(POLICY).header(5, 1).bytes(new byte[] {1}).header(0, 1000)
        .toByteArray();

    assertThat(verify(withAssets(assets)).invalidReason()).isEqualTo(DECODE_FAILED);
  }
}
