package org.x402.mechanisms.cardano.exact.facilitator;

import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import java.math.BigInteger;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoUtils;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;

/** Built-in phase-1 checks. */
public final class Phase1Checks {

  private Phase1Checks() {}

  /**
   * A check outcome.
   *
   * @param ok whether it passed
   * @param reason the error code when failed
   * @param detail the detail when failed
   */
  public record Result(boolean ok, String reason, String detail) {
    /** Success. */
    public static final Result OK = new Result(true, null, null);
  }

  /**
   * Value conservation over authenticated input values: every lovelace and native asset of the
   * inputs reappears in the outputs plus the fee. Only for plain payments.
   *
   * @param decoded the transaction
   * @param inputs snapshots of every input, in input order
   * @return the outcome
   */
  public static Result checkValueConservation(DecodedCardanoTransaction decoded, List<UtxoSnapshot> inputs) {
    BigInteger inputCoin = BigInteger.ZERO;
    Map<String, BigInteger> inputAssets = new LinkedHashMap<>();
    for (int i = 0; i < inputs.size(); i++) {
      UtxoSnapshot snapshot = inputs.get(i);
      if (snapshot.coin() == null) {
        String ref = i < decoded.inputs().size() ? decoded.inputs().get(i) : String.valueOf(i);
        return new Result(
            false, CardanoErrors.INPUT_VALUE_UNAVAILABLE, "the chain layer reported no value for input " + ref);
      }
      inputCoin = inputCoin.add(snapshot.coin());
      if (snapshot.assets() != null) {
        snapshot.assets().forEach((unit, quantity) -> add(inputAssets, unit, quantity));
      }
    }
    BigInteger outputCoin = decoded.fee();
    Map<String, BigInteger> outputAssets = new LinkedHashMap<>();
    for (DecodedCardanoTransaction.Output output : decoded.outputs()) {
      outputCoin = outputCoin.add(output.coin());
      output.assets().forEach((unit, quantity) -> add(outputAssets, unit, quantity));
    }
    if (!inputCoin.equals(outputCoin)) {
      return new Result(
          false,
          CardanoErrors.VALUE_NOT_CONSERVED,
          "inputs carry " + inputCoin + " lovelace but outputs and fee total " + outputCoin);
    }
    Set<String> units = new LinkedHashSet<>(inputAssets.keySet());
    units.addAll(outputAssets.keySet());
    for (String unit : units) {
      BigInteger consumed = inputAssets.getOrDefault(unit, BigInteger.ZERO);
      BigInteger produced = outputAssets.getOrDefault(unit, BigInteger.ZERO);
      if (!consumed.equals(produced)) {
        return new Result(
            false,
            CardanoErrors.VALUE_NOT_CONSERVED,
            "inputs carry " + consumed + " of " + unit + " but outputs carry " + produced);
      }
    }
    return Result.OK;
  }

  /**
   * The fee floor {@code minFeeConstant + minFeeCoefficient * size}.
   *
   * @param decoded the transaction
   * @param parameters live protocol parameters
   * @return the outcome
   */
  public static Result checkMinimumFee(DecodedCardanoTransaction decoded, ProtocolParams parameters) {
    BigInteger minimum =
        CardanoUtils.minFeeB(parameters).add(CardanoUtils.minFeeA(parameters).multiply(BigInteger.valueOf(decoded.sizeBytes())));
    if (decoded.fee().compareTo(minimum) < 0) {
      return new Result(
          false,
          CardanoErrors.FEE_BELOW_MINIMUM,
          "fee " + decoded.fee() + " is below the protocol minimum " + minimum + " for " + decoded.sizeBytes() + " bytes");
    }
    return Result.OK;
  }

  private static void add(Map<String, BigInteger> target, String unit, BigInteger quantity) {
    if (quantity.signum() == 0) {
      return;
    }
    target.merge(unit.toLowerCase(Locale.ROOT), quantity, BigInteger::add);
  }

  /**
   * Every input is authorised by its owner (spec rule 6). The owner comes from
   * the input's address, or from its key hash when the address is unknown. A key-owned input
   * needs a witness of that key. Script witnesses, and inputs owned by a script or by an owner
   * that cannot be resolved (Byron, unparsable, unknown), need a complete phase-1 validator,
   * which checks what this method cannot.
   *
   * @param decoded the transaction
   * @param inputs snapshots of every input, in input order
   * @param fullValidator whether a complete phase-1 validator runs afterwards
   * @return the outcome
   */
  public static Result checkWitnessCoverage(
      DecodedCardanoTransaction decoded, List<UtxoSnapshot> inputs, boolean fullValidator) {
    if (!fullValidator && decoded.scriptWitnessCount() > 0) {
      return new Result(false, CardanoErrors.TRANSACTION_PHASE1_INVALID,
          "transaction carries script witnesses; without a complete phase-1 validator only "
              + "key-witnessed payments are accepted");
    }
    Set<String> witnessed = new HashSet<>(decoded.vkeyHashes());
    for (int i = 0; i < inputs.size(); i++) {
      String ref = decoded.inputs().get(i);
      Credential owner = owner(inputs.get(i));
      if (owner != null && !CardanoAddresses.isScript(owner)) {
        String keyHash = CardanoAddresses.hashHex(owner);
        if (!witnessed.contains(keyHash)) {
          return new Result(false, CardanoErrors.TRANSACTION_PHASE1_INVALID,
              "input " + ref + " is owned by key hash " + keyHash
                  + " but the transaction carries no witness for it");
        }
      } else if (!fullValidator) {
        return new Result(false, CardanoErrors.TRANSACTION_PHASE1_INVALID,
            "input " + ref + " has a script or unresolvable owner; spending it requires a complete "
                + "phase-1 validator");
      }
    }
    return Result.OK;
  }

  /** The payment credential owning an input, or {@code null} when it cannot be resolved. */
  private static Credential owner(UtxoSnapshot snapshot) {
    try {
      if (snapshot.address() != null) {
        return CardanoAddresses.parse(snapshot.address()).payment();
      }
      String keyHash = snapshot.paymentKeyHash();
      return keyHash == null ? null : Credential.fromKey(keyHash);
    } catch (RuntimeException e) {
      return null;
    }
  }
}
