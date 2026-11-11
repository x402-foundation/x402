package org.x402.mechanisms.cardano.testing;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;

/**
 * A chain backend that replays the chain-stub snapshot exported with each fixture
 * (see {@code java/tools/ts-vectors}). It answers every chain read from that snapshot, as the
 * stub the fixture was originally verified against did, and records every submission.
 */
public final class SnapshotChainBackend implements CardanoChainBackend {

  private final JsonNode chain;
  private final List<String> submissions = Collections.synchronizedList(new ArrayList<>());
  private volatile boolean submitted;
  private ProtocolParams protocolParametersOverride;

  /**
   * Creates the backend.
   *
   * @param chain the fixture's {@code chain} object
   */
  public SnapshotChainBackend(JsonNode chain) {
    this.chain = chain;
  }

  /**
   * Replaces the snapshot's protocol parameters (a replacement backend's view).
   *
   * @param parameters the parameters to serve
   * @return this backend
   */
  public SnapshotChainBackend withProtocolParameters(ProtocolParams parameters) {
    this.protocolParametersOverride = parameters;
    return this;
  }

  /**
   * Every transaction passed to {@link #submitTransaction}, in order.
   *
   * @return the submitted base64 transactions
   */
  public List<String> submissions() {
    return List.copyOf(submissions);
  }

  @Override
  public UtxoSnapshot getUtxo(String ref, String network) {
    JsonNode entry = chain.path("utxos").get(ref.toLowerCase(java.util.Locale.ROOT));
    if (entry == null) {
      throw new IllegalStateException("stub chain has no utxo " + ref);
    }
    if (entry.has("error")) {
      throw new IllegalStateException(entry.get("error").asText());
    }
    Map<String, BigInteger> assets = null;
    if (entry.has("assets")) {
      assets = new LinkedHashMap<>();
      var fields = entry.get("assets").fields();
      while (fields.hasNext()) {
        var field = fields.next();
        assets.put(field.getKey(), new BigInteger(field.getValue().asText()));
      }
    }
    return new UtxoSnapshot(
        entry.get("exists").asBoolean(),
        entry.has("address") ? entry.get("address").asText() : null,
        entry.has("coin") ? new BigInteger(entry.get("coin").asText()) : null,
        assets,
        entry.has("paymentKeyHash") ? entry.get("paymentKeyHash").asText() : null);
  }

  @Override
  public long getCurrentSlot(String network) {
    if (chain.has("slotError")) {
      throw new IllegalStateException(chain.get("slotError").asText());
    }
    return Long.parseLong(chain.get("currentSlot").asText());
  }

  @Override
  public ProtocolParams getProtocolParameters(String network) {
    if (chain.has("protocolParametersError")) {
      throw new IllegalStateException(chain.get("protocolParametersError").asText());
    }
    if (protocolParametersOverride != null) {
      return protocolParametersOverride;
    }
    JsonNode params = chain.get("protocolParameters");
    if (params == null || params.isNull()) {
      return null;
    }
    return Ccl.params(
        new BigInteger(params.get("coinsPerUtxoByte").asText()),
        new BigInteger(params.get("minFeeCoefficient").asText()),
        new BigInteger(params.get("minFeeConstant").asText()));
  }

  @Override
  public SubmissionResult submitTransaction(String signedTransactionBase64, String network) {
    submissions.add(signedTransactionBase64);
    JsonNode spec = chain.get("submit");
    if (spec != null && spec.has("error")) {
      throw new IllegalStateException(spec.get("error").asText());
    }
    submitted = true;
    String status = spec == null ? "confirmed" : spec.get("status").asText();
    return new SubmissionResult(
        CardanoTransactionDecoder.decode(signedTransactionBase64).txHash(),
        SettlementEvidence.Status.fromWire(status));
  }

  @Override
  public boolean isDefinitiveSubmissionRejection(Throwable error) {
    JsonNode spec = chain.get("submit");
    return spec != null && spec.has("error") && spec.get("definitive").asBoolean();
  }

  @Override
  public boolean supportsTransactionEvidence() {
    return chain.get("transactionEvidence").asBoolean();
  }

  @Override
  public SettlementEvidence getTransactionEvidence(String txHash, String network) {
    if (chain.has("evidenceError")) {
      throw new IllegalStateException(chain.get("evidenceError").asText());
    }
    if (submitted && chain.has("evidenceAfterSubmit")) {
      return evidence(chain.get("evidenceAfterSubmit"));
    }
    JsonNode known = chain.path("evidence").get(txHash);
    return known == null ? SettlementEvidence.unknown() : evidence(known);
  }

  @Override
  public boolean supportsPhase1Validation() {
    return chain.has("phase1Validator");
  }

  @Override
  public void validatePhase1Transaction(String signedTransactionBase64, String network) {
    JsonNode spec = chain.get("phase1Validator");
    if (spec != null && spec.has("error")) {
      throw new IllegalStateException(spec.get("error").asText());
    }
  }

  @Override
  public void evaluateTransaction(String signedTransactionBase64, String network) {
    JsonNode spec = chain.get("evaluate");
    if (spec != null && spec.has("error")) {
      throw new IllegalStateException(spec.get("error").asText());
    }
  }

  private static SettlementEvidence evidence(JsonNode node) {
    return new SettlementEvidence(
        SettlementEvidence.Status.fromWire(node.get("status").asText()),
        node.get("confirmations").asInt());
  }
}
