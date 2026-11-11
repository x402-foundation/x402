package org.x402.mechanisms.cardano.utils;

import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.api.model.Utxo;
import java.math.BigInteger;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Small helpers shared by client, server and facilitator. */
public final class CardanoUtils {

  private CardanoUtils() {}

  /**
   * A parsed UTxO reference.
   *
   * @param txHash lowercase transaction hash
   * @param index output index
   */
  public record UtxoRef(String txHash, BigInteger index) {

    /**
     * The canonical {@code txHash#index} form.
     *
     * @return the reference
     */
    @Override
    public String toString() {
      return txHash + "#" + index;
    }
  }

  /**
   * A parsed asset unit.
   *
   * @param policyId lowercase policy id, empty for lovelace
   * @param assetNameHex lowercase asset name, empty for lovelace
   */
  public record AssetUnit(String policyId, String assetNameHex) {}

  /**
   * The {@code transaction} and {@code nonce} of a Cardano payload.
   *
   * @param transaction base64 signed transaction
   * @param nonce UTxO reference
   */
  public record ExactCardanoPayload(String transaction, String nonce) {}

  /**
   * Parses {@code txHashHex#index}.
   *
   * @param ref the reference
   * @return the parsed reference
   * @throws IllegalArgumentException when malformed
   */
  public static UtxoRef parseUtxoRef(String ref) {
    if (ref == null || !CardanoConstants.UTXO_REF.matcher(ref).matches()) {
      throw new IllegalArgumentException("Invalid Cardano UTXO reference: " + ref);
    }
    int hash = ref.indexOf('#');
    return new UtxoRef(ref.substring(0, hash).toLowerCase(Locale.ROOT), new BigInteger(ref.substring(hash + 1)));
  }

  /**
   * Splits {@code policyId.assetNameHex}; lovelace yields empty parts.
   *
   * @param asset the unit
   * @return the parts
   * @throws IllegalArgumentException when malformed
   */
  public static AssetUnit parseAssetUnit(String asset) {
    if (asset == null || !CardanoConstants.ASSET.matcher(asset).matches()) {
      throw new IllegalArgumentException("Invalid Cardano asset unit: " + asset);
    }
    if (asset.equalsIgnoreCase(CardanoConstants.LOVELACE)) {
      return new AssetUnit("", "");
    }
    int dot = asset.indexOf('.');
    return new AssetUnit(
        asset.substring(0, dot).toLowerCase(Locale.ROOT), asset.substring(dot + 1).toLowerCase(Locale.ROOT));
  }

  /**
   * Protocol minimum lovelace for an output of a serialized size: {@code (160 + size) *
   * coinsPerUtxoByte}.
   *
   * @param serializedSize the output's byte length
   * @param coinsPerUtxoByte the protocol parameter
   * @return the minimum
   */
  public static BigInteger minUtxoLovelace(int serializedSize, BigInteger coinsPerUtxoByte) {
    return BigInteger.valueOf(CardanoConstants.MIN_UTXO_OVERHEAD_BYTES + (long) serializedSize)
        .multiply(coinsPerUtxoByte);
  }

  /**
   * Reads {@code transaction} and {@code nonce} out of a payload map; other keys are ignored.
   *
   * @param raw the payload map
   * @return the typed payload
   * @throws IllegalArgumentException when a field is missing or too large
   */
  public static ExactCardanoPayload decodePayload(Map<String, ?> raw) {
    Object transaction = raw == null ? null : raw.get("transaction");
    Object nonce = raw == null ? null : raw.get("nonce");
    if (!(transaction instanceof String tx) || tx.isEmpty()) {
      throw new IllegalArgumentException("Cardano payload is missing a transaction string");
    }
    if (tx.length() > CardanoTransactionDecoder.maxBase64Length()) {
      throw new IllegalArgumentException("Cardano payload transaction exceeds the decode limit");
    }
    if (!(nonce instanceof String n) || n.isEmpty()) {
      throw new IllegalArgumentException("Cardano payload is missing a nonce string");
    }
    return new ExactCardanoPayload(tx, n);
  }

  /**
   * The lovelace of a UTxO.
   *
   * @param utxo the UTxO
   * @return the lovelace (0 when it lists none)
   */
  public static BigInteger lovelace(Utxo utxo) {
    BigInteger coin = BigInteger.ZERO;
    for (Amount a : utxo.getAmount() == null ? java.util.List.<Amount>of() : utxo.getAmount()) {
      if ("lovelace".equals(a.getUnit())) {
        coin = coin.add(a.getQuantity());
      }
    }
    return coin;
  }

  /**
   * The native assets of a UTxO, keyed {@code policy.assetName} in lowercase hex.
   *
   * @param utxo the UTxO
   * @return the assets
   */
  public static Map<String, BigInteger> assets(Utxo utxo) {
    Map<String, BigInteger> assets = new LinkedHashMap<>();
    for (Amount a : utxo.getAmount() == null ? java.util.List.<Amount>of() : utxo.getAmount()) {
      String unit = a.getUnit();
      if (unit != null && !"lovelace".equals(unit) && unit.length() >= 56) {
        String key = unit.substring(0, 56).toLowerCase(Locale.ROOT) + "."
            + unit.substring(56).toLowerCase(Locale.ROOT);
        assets.merge(key, a.getQuantity(), BigInteger::add);
      }
    }
    return assets;
  }

  /**
   * A UTxO's {@code txHash#index} reference.
   *
   * @param utxo the UTxO
   * @return the reference
   */
  public static String ref(Utxo utxo) {
    return utxo.getTxHash() + "#" + utxo.getOutputIndex();
  }

  /**
   * Checks that protocol parameters carry the fee and min-UTxO values, none negative.
   *
   * @param parameters the protocol parameters
   * @return the same parameters
   * @throws IllegalArgumentException when a value is missing, malformed or negative
   */
  public static ProtocolParams requireComplete(ProtocolParams parameters) {
    BigInteger coinsPerUtxoByte = coinsPerUtxoByte(parameters);
    if (coinsPerUtxoByte == null) {
      throw new IllegalArgumentException("protocol parameters lack coinsPerUtxoSize");
    }
    if (coinsPerUtxoByte.signum() < 0 || minFeeA(parameters).signum() < 0
        || minFeeB(parameters).signum() < 0) {
      throw new IllegalArgumentException("protocol parameters hold a negative fee or min-UTxO value");
    }
    return parameters;
  }

  /**
   * The {@code coinsPerUTxOByte} parameter.
   *
   * @param parameters the protocol parameters
   * @return the value, or {@code null} when the backend does not supply it
   */
  public static BigInteger coinsPerUtxoByte(ProtocolParams parameters) {
    String value = parameters.getCoinsPerUtxoSize();
    return value == null ? null : new BigInteger(value);
  }

  /**
   * The fee coefficient per byte ({@code minFeeA}).
   *
   * @param parameters the protocol parameters
   * @return the coefficient
   * @throws IllegalArgumentException when absent
   */
  public static BigInteger minFeeA(ProtocolParams parameters) {
    if (parameters.getMinFeeA() == null) {
      throw new IllegalArgumentException("protocol parameters lack minFeeA");
    }
    return BigInteger.valueOf(parameters.getMinFeeA());
  }

  /**
   * The constant fee ({@code minFeeB}).
   *
   * @param parameters the protocol parameters
   * @return the constant
   * @throws IllegalArgumentException when absent
   */
  public static BigInteger minFeeB(ProtocolParams parameters) {
    if (parameters.getMinFeeB() == null) {
      throw new IllegalArgumentException("protocol parameters lack minFeeB");
    }
    return BigInteger.valueOf(parameters.getMinFeeB());
  }
}
