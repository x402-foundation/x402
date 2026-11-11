package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.math.BigInteger;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.Cbor;

/**
 * Verification and settlement branches the exported fixtures do not reach, on hand-built signed
 * transactions.
 */
class VerifyBranchesTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";

  private final StubBackend backend = new StubBackend();

  private TxBuilder plain() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET);
  }

  private static PaymentRequirements requirements(Map<String, Object> extra) {
    return new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, extra);
  }

  private static PaymentPayload payload(PaymentRequirements req, String tx, String nonce) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", nonce);
    return new PaymentPayload(2, null, req, p, null);
  }

  private VerifyResponse verify(String tx, Map<String, Object> extra) {
    PaymentRequirements req = requirements(extra);
    return new ExactCardanoFacilitatorScheme(backend).verify(payload(req, tx, NONCE), req, FacilitatorContext.EMPTY);
  }

  private VerifyResponse verify(String tx) {
    return verify(tx, Map.of());
  }

  @Test
  void aPlainSignedPaymentIsValid() {
    assertThat(verify(plain().build()).isValid()).isTrue();
    assertThat(verify(plain().isValid(null).build()).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_transaction_decode_failed");
    assertThat(verify(plain().inputsAsSet().build()).isValid()).isTrue();
  }

  @Test
  void bodyRulesRejectWithTypeScriptReasons() {
    assertThat(verify(plain().networkId(1).build()).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_network_id_mismatch");
    assertThat(verify(plain().networkId(0).build()).isValid()).isTrue();

    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    String unsigned =
        TxBuilder.create().input(NONCE_HASH, 0).output(PAY_TO, 2_000_000, Map.of(), null, false).fee(200_000).build();
    assertThat(verify(unsigned).invalidReason()).isEqualTo("invalid_exact_cardano_payload_unsigned");

    VerifyResponse duplicate = verify(plain().input(NONCE_HASH, 0).build());
    assertThat(duplicate.invalidReason()).isEqualTo("invalid_exact_cardano_payload_phase1_invalid");
    assertThat(duplicate.invalidMessage()).isEqualTo("transaction contains duplicate inputs");

    assertThat(verify(plain().isValid(false).build()).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_phase2_invalid");
    assertThat(verify(plain().validityStart(backend.slot + 10).build()).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_not_yet_valid");
    // A TTL is required (spec rule 7 bounds it); a validity start alone is not enough.
    assertThat(verify(plain().ttl(null).validityStart(backend.slot - 10).build()).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_ttl_too_far");
  }

  @Test
  void tooManyInputsAreRefusedBeforeAnyLookup() {
    TxBuilder tx = plain();
    for (int i = 1; i <= 256; i++) {
      tx.input(TxBuilder.hash32(0x11), i);
    }
    VerifyResponse response = verify(tx.build());
    assertThat(response.invalidReason()).isEqualTo("invalid_exact_cardano_payload_phase1_invalid");
    assertThat(response.invalidMessage()).isEqualTo("transaction has 257 inputs; verification permits at most 256");
  }

  @Test
  void providerFailuresAreChainLookupFailures() {
    String tx = plain().build();
    backend.slotError = new IllegalStateException("slot down");
    VerifyResponse slot = verify(tx);
    assertThat(slot.invalidReason()).isEqualTo("exact_cardano_facilitator_chain_lookup_failed");
    assertThat(slot.invalidMessage()).isEqualTo("slot down");
    backend.slotError = null;

    backend.parametersError = new IllegalStateException("params down");
    VerifyResponse params = verify(tx);
    assertThat(params.invalidReason()).isEqualTo("exact_cardano_facilitator_chain_lookup_failed");
    assertThat(params.payer()).isEqualTo(PAYER);
    backend.parametersError = null;

    backend.evaluateError = new IllegalStateException("script failed");
    assertThat(verify(tx).invalidMessage()).isEqualTo("script failed");
    backend.evaluateError = null;

    backend.evidenceError = new IllegalStateException("evidence down");
    assertThat(verify(tx).isValid()).isTrue();
  }

  @Test
  void withoutProtocolParametersTheFeeAndMinUtxoChecksAreSkipped() {
    backend.parameters = null;
    assertThat(verify(plain().fee(1).output(PAYER, 199_999, Map.of(), null, false).build()).isValid()).isTrue();
  }

  @Test
  void inputAvailabilityAndPayerResolution() {
    String second = TxBuilder.hash32(0xbb) + "#1";
    String tx = plain().input(TxBuilder.hash32(0xbb), 1).build();
    backend.utxos.put(second, UtxoSnapshot.spent(PAYER));
    assertThat(verify(tx).invalidReason()).isEqualTo("invalid_exact_cardano_payload_input_not_available");

    backend.unspent(second, PAYER, 0, Map.of());
    backend.utxos.put(NONCE, new UtxoSnapshot(true, null, BigInteger.valueOf(10_000_000), Map.of(), null));
    VerifyResponse noOwner = verify(tx);
    assertThat(noOwner.invalidReason()).isEqualTo("invalid_exact_cardano_payload_nonce_not_on_chain");
    assertThat(noOwner.invalidMessage()).isEqualTo("could not resolve the owner of the nonce UTXO");

    StubBackend broken =
        new StubBackend() {
          @Override
          public UtxoSnapshot getUtxo(String ref, String network) {
            // The nonce resolves; the second input answers nothing, so verification fails.
            return ref.startsWith(NONCE_HASH) ? backend.getUtxo(ref, network) : null;
          }
        };
    PaymentRequirements req = requirements(Map.of());
    VerifyResponse crashed = new ExactCardanoFacilitatorScheme(broken).verify(payload(req, tx, NONCE), req);
    assertThat(crashed.invalidReason()).isEqualTo("invalid_exact_cardano_payload_verification_error");
  }

  @Test
  void balanceChangingBodiesNeedACompletePhase1Validator() {
    byte[] mint =
        new Cbor.Writer()
            .header(5, 1)
            .bytes(java.util.HexFormat.of().parseHex(TxBuilder.hash28(0x01)))
            .header(5, 1)
            .bytes(new byte[] {0x41})
            .header(0, 1)
            .toByteArray();
    String tx = plain().bodyField(9, mint).bodyField(5, new byte[] {(byte) 0xa0}).bodyField(22, TxBuilder.uint(1)).build();
    VerifyResponse refused = verify(tx);
    assertThat(refused.invalidMessage())
        .isEqualTo(
            "transaction carries mint, withdrawals, donation; without a complete phase-1 validator only plain payments are accepted");

    backend.phase1Validator = true;
    assertThat(verify(tx).isValid()).isTrue();
    backend.phase1Error = new IllegalStateException("ledger says no");
    assertThat(verify(tx).invalidMessage()).isEqualTo("ledger says no");
  }

  @Test
  void envelopeAndMethodRules() {
    String tx = plain().build();
    PaymentRequirements req = requirements(Map.of());
    var scheme = new ExactCardanoFacilitatorScheme(backend);

    assertThat(scheme.verify(new PaymentPayload(1, null, req, Map.of(), null), req).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_unsupported_version");
    PaymentRequirements upto = new PaymentRequirements("upto", NETWORK, "lovelace", "1", PAY_TO, 600, null);
    assertThat(scheme.verify(payload(upto, tx, NONCE), upto).invalidReason()).isEqualTo("unsupported_scheme");
    PaymentRequirements evm = new PaymentRequirements("exact", "eip155:8453", "lovelace", "1", PAY_TO, 600, null);
    assertThat(scheme.verify(payload(evm, tx, NONCE), evm).invalidReason()).isEqualTo("network_mismatch");
    assertThat(scheme.verify(new PaymentPayload(2, null, req, Map.of("nonce", NONCE), null), req).invalidMessage())
        .isEqualTo("Cardano payload is missing a transaction string");
    assertThat(scheme.verify(payload(req, tx, "nope"), req).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_nonce_invalid");
    assertThat(verify(tx, Map.of("confirmationPolicy", Map.of("l1Confirmations", 1.5))).invalidReason())
        .isEqualTo("invalid_exact_cardano_requirements_policy");
    assertThat(verify(tx, Map.of("assetTransferMethod", "barter")).invalidReason()).isEqualTo("unsupported_scheme");
    assertThat(verify(tx, Map.of("assetTransferMethod", "script")).invalidReason())
        .isEqualTo("invalid_exact_cardano_payload_script_address_mismatch");
    assertThat(verify(tx, Map.of("assetTransferMethod", "default", "confirmationPolicy", Map.of("l1Confirmations", 1.0)))
            .isValid())
        .isTrue();
  }

  @Test
  void legacyOutputsAndAssetsDecode() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    String tx =
        TxBuilder.create()
            .input(NONCE_HASH, 0)
            .legacyOutput(PAY_TO, 2_000_000, null)
            .legacyOutput(PAYER, 7_800_000, java.util.HexFormat.of().parseHex(TxBuilder.hash32(0x05)))
            .fee(200_000)
            .ttl(backend.slot + 300)
            .signWith(TxBuilder.WALLET)
            .build();
    assertThat(verify(tx).isValid()).isTrue();
  }

  // ---------------------------------------------------------------- settle branches

  private ExactCardanoFacilitatorScheme fast() {
    return new ExactCardanoFacilitatorScheme(
        backend,
        null,
        ExactCardanoFacilitatorOptions.builder()
            .confirmationTimeout(Duration.ofMillis(3))
            .confirmationPoll(Duration.ofMillis(1))
            .build());
  }

  @Test
  void settleRefusesUndecodablePayloadsWithoutClaiming() {
    PaymentRequirements req = requirements(Map.of());
    var scheme = fast();
    SettleResponse missing = scheme.settle(new PaymentPayload(2, null, req, Map.of(), null), req);
    assertThat(missing.errorReason()).isEqualTo("invalid_exact_cardano_payload");
    assertThat(missing.transaction()).isEmpty();
    SettleResponse garbage = scheme.settle(payload(req, "AAAA", NONCE), req);
    assertThat(garbage.errorReason()).isEqualTo("invalid_exact_cardano_payload_transaction_decode_failed");
    PaymentRequirements badPolicy = requirements(Map.of("confirmationPolicy", "soon"));
    assertThat(scheme.settle(payload(badPolicy, plain().build(), NONCE), badPolicy).errorReason())
        .isEqualTo("invalid_exact_cardano_requirements_policy");
  }

  @Test
  void aResumedSettlementReportsRecheckOutcomes() {
    String tx = plain().build();
    PaymentRequirements req = requirements(Map.of());
    var scheme = fast();
    assertThat(scheme.settle(payload(req, tx, NONCE), req).isPending()).isTrue();

    backend.utxos.put(NONCE, UtxoSnapshot.spent(PAYER));
    PaymentRequirements more = new PaymentRequirements("exact", NETWORK, "lovelace", "3000000", PAY_TO, 600, Map.of());
    // Deliberate requirement change (I8, user-approved 2026-10-14): the claim is bound to its
    // requirements, so a settle under other requirements is a duplicate before any re-check.
    assertThat(scheme.settle(payload(more, tx, NONCE), more).errorReason()).isEqualTo("duplicate_settlement");
    // The re-check itself still runs for a claim stored without a binding.
    var unbound = new InMemorySettlementClaimStore();
    String hash = CardanoTransactionDecoder.decode(tx).txHash();
    unbound.claimSettlement(new SettlementClaim(hash, "earlier", null, null));
    unbound.markSubmitted(hash, "earlier");
    var unboundScheme = new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .settlementStore(unbound).confirmationTimeout(Duration.ofMillis(3)).confirmationPoll(Duration.ofMillis(1))
        .build());
    SettleResponse underpaid = unboundScheme.settle(payload(more, tx, NONCE), more);
    assertThat(underpaid.errorReason()).isEqualTo("invalid_exact_cardano_payload_amount_insufficient");

    backend.slotError = new IllegalStateException("tip unknown");
    SettleResponse lookup = scheme.settle(payload(req, tx, NONCE), req);
    assertThat(lookup.isPending()).isTrue();
    assertThat(lookup.errorMessage())
        .isEqualTo("the chain lookup failed while resuming a broadcast transaction: tip unknown");
    backend.slotError = null;

    backend.evidence.put(CardanoTransactionDecoder.decode(tx).txHash(),
        new SettlementEvidence(SettlementEvidence.Status.MEMPOOL, -1));
    assertThat(scheme.settle(payload(req, tx, NONCE), req).isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void withoutEvidenceTheSubmittersStatusDecides() {
    backend.evidenceCapable = false;
    Map<String, Object> zero = Map.of("confirmationPolicy", Map.of("l1Confirmations", 0));
    PaymentRequirements req = requirements(zero);
    SettleResponse mempool = fast().settle(payload(req, plain().build(), NONCE), req);
    assertThat(mempool.errorReason()).isEqualTo("exact_cardano_settlement_not_confirmed");
    assertThat(mempool.extra()).containsEntry("status", "mempool");

    StubBackend confirming =
        new StubBackend() {
          @Override
          public org.x402.mechanisms.cardano.chain.SubmissionResult submitTransaction(String tx, String network) {
            return new org.x402.mechanisms.cardano.chain.SubmissionResult(
                CardanoTransactionDecoder.decode(tx).txHash(),
                SettlementEvidence.Status.CONFIRMED);
          }
        };
    confirming.evidenceCapable = false;
    confirming.unspent(NONCE, PAYER, 10_000_000, Map.of());
    TxBuilder other =
        TxBuilder.create()
            .input(NONCE_HASH, 0)
            .output(PAY_TO, 2_000_000, Map.of(), null, false)
            .output(PAYER, 7_790_000, Map.of(), null, false)
            .fee(210_000)
            .ttl(confirming.slot + 300)
            .signWith(TxBuilder.WALLET);
    SettleResponse confirmed =
        new ExactCardanoFacilitatorScheme(confirming).settle(payload(req, other.build(), NONCE), req);
    assertThat(confirmed.success()).isTrue();
    assertThat(confirmed.extra()).containsEntry("confirmations", 0);
  }

  @Test
  void evidenceErrorsDuringTheWaitKeepThePaymentPending() {
    String tx = plain().build();
    PaymentRequirements req = requirements(Map.of());
    StubBackend flaky =
        new StubBackend() {
          private int calls;

          @Override
          public SettlementEvidence getTransactionEvidence(String txHash, String network) {
            if (++calls > 1) {
              throw new IllegalStateException("blip");
            }
            return SettlementEvidence.unknown();
          }
        };
    flaky.utxos.putAll(backend.utxos);
    SettleResponse response =
        new ExactCardanoFacilitatorScheme(
                flaky,
                null,
                ExactCardanoFacilitatorOptions.builder()
                    .confirmationTimeout(Duration.ofMillis(3))
                    .confirmationPoll(Duration.ofMillis(1))
                    .build())
            .settle(payload(req, tx, NONCE), req);
    assertThat(response.isPending()).isTrue();
    assertThat(response.extra()).containsEntry("status", "pending").containsEntry("confirmations", -1);
    assertThat(new HashMap<>(response.extra())).containsKey("transactionId");
    assertThat(List.of(response.transaction())).hasSize(1);
  }
}
